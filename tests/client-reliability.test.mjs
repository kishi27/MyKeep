import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';

async function moduleFrom(path) {
  const result = await build({ entryPoints: [path], bundle: true, write: false, format: 'esm', platform: 'node' });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
}
const { api, TIMEOUT_ERROR } = await moduleFrom('src/api.ts');
const { syncNoteList } = await moduleFrom('src/listSync.ts');
const response = (body, status = 200) => Response.json(body, { status });

test('timeouts cover the response body and keep caller cancellation distinct', async t => {
  const originalFetch = globalThis.fetch, originalTimer = globalThis.setTimeout, originalWindow = globalThis.window;
  globalThis.window = { location: { origin: 'https://local.test' } };
  const durations = [];
  globalThis.setTimeout = (fn, ms, ...args) => { durations.push(ms); return originalTimer(fn, ms >= 30_000 ? 10 : ms, ...args); };
  t.after(() => { globalThis.fetch = originalFetch; globalThis.setTimeout = originalTimer; globalThis.window = originalWindow; });
  globalThis.fetch = async (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
  await assert.rejects(api('/api/notes'), { message: TIMEOUT_ERROR });
  globalThis.fetch = async (_url, { signal }) => new Response(new ReadableStream({
    start(controller) { signal.addEventListener('abort', () => controller.error(signal.reason), { once: true }); },
  }), { headers: { 'Content-Type': 'application/json' } });
  await assert.rejects(api('/api/notes', { method: 'POST', body: '{}' }), { message: TIMEOUT_ERROR });
  assert.ok(durations.includes(30_000)); assert.ok(durations.includes(60_000));
  const controller = new AbortController();
  const pending = api('/api/notes', { signal: controller.signal }); controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
});

test('large list reconciles unchanged notes without downloading their bodies', async t => {
  const originalFetch = globalThis.fetch, originalWindow = globalThis.window;
  globalThis.window = { location: { origin: 'https://local.test' } };
  t.after(() => { globalThis.fetch = originalFetch; globalThis.window = originalWindow; });
  const cached = Array.from({ length: 650 }, (_, i) => ({ id: `n${i}`, updated_at: String(i), sync_version: 1, body: 'large body' }));
  let notes = [...cached], revision = 2, race = false, continuous = false;
  const calls = [];
  globalThis.fetch = async (path, init) => {
    const url = new URL(path, 'https://local.test');
    const q = url.searchParams;
    calls.push({ path: url.pathname, query: q, body: init.body && JSON.parse(init.body) });
    if (url.pathname === '/api/notes/batch') {
      const body = JSON.parse(init.body);
      if (body.revision !== revision) return response({ code: 'list_changed', error: 'changed' }, 409);
      return response({ notes: body.ids.map(id => notes.find(note => note.id === id)), revision });
    }
    const offset = Number(q.get('offset') || 0), limit = Number(q.get('limit') || 50);
    if (offset > 0 && (race || continuous)) {
      race = false; revision++;
      notes = [{ id: `new${revision}`, updated_at: String(revision), sync_version: 1, body: 'new' }, ...notes];
    }
    if (q.has('revision') && Number(q.get('revision')) !== revision) return response({ code: 'list_changed', error: 'changed' }, 409);
    if (Number(q.get('since')) === revision) return response({ unchanged: true, revision });
    return response({ notes: notes.slice(offset, offset + limit).map(({ id, updated_at, sync_version }) => ({ id, updated_at, sync_version })),
      revision, hasMore: notes.length > offset + limit });
  };
  const sync = () => syncNoteList(new URLSearchParams({ view: 'active' }), cached, 650, new AbortController().signal);
  let result = await sync();
  assert.deepEqual(result.notes, cached);
  assert.equal(calls.filter(call => call.path === '/api/notes/batch').length, 0, 'unrelated global changes need no bodies');
  assert.equal(calls.filter(call => call.query.has('limit')).length, 2, 'metadata is bounded at 500 per request');
  notes[400] = { ...notes[400], sync_version: 2, body: 'new attachment/content' }; revision++;
  calls.length = 0; result = await sync();
  assert.equal(result.notes[400].body, 'new attachment/content');
  assert.deepEqual(calls.filter(call => call.body).map(call => call.body.ids), [['n400']]);
  assert.equal(result.notes[0], cached[0], 'unchanged objects stay reusable');
  race = true; calls.length = 0; result = await sync();
  assert.deepEqual(result.notes.map(note => note.id), notes.slice(0, 650).map(note => note.id), 'race restarts the snapshot without duplicates or omissions');
  assert.equal(new Set(result.notes.map(note => note.id)).size, 650);
  continuous = true;
  await assert.rejects(sync(), /changed/, 'continuous writes fail boundedly, leaving the displayed list untouched');
});
