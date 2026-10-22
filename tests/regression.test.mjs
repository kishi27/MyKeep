import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, readdir } from 'node:fs/promises';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { BlobWriter, BlobReader, ZipReader, TextWriter } from '@zip.js/zip.js';

// Uses the project's existing Wrangler dependencies; no production bindings.
async function moduleFrom(path) {
  const result = await build({ entryPoints: [path], bundle: true, write: false, format: 'esm', platform: 'node', target: 'node24' });
  return import(`data:text/javascript;base64,${Buffer.from(`${result.outputFiles[0].text}\n//# sourceURL=mykeep-test-${path}\n`).toString('base64')}`);
}
const { default: worker } = await moduleFrom('worker/index.ts');
const { createBackup } = await moduleFrom('src/exportBackup.ts');
const SECRET = 'local-regression-key';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9t8AAAAASUVORK5CYII=', 'base64');

test('Worker, D1, R2 and backup regressions (isolated local data)', async (t) => {
  const mf = new Miniflare(convertV4MiniflareOptions({ workers: [{ name: 'regression', modules: true, script: 'export default {fetch(){return new Response("test")}}',
    compatibilityDate: '2026-09-28', d1Databases: ['DB'], r2Buckets: ['IMAGES'] }] }));
  t.after(() => mf.dispose());
  const DB = await mf.getD1Database('DB');
  const IMAGES = await mf.getR2Bucket('IMAGES');
  const env = { DB, IMAGES, CAPTURE_API_KEY: SECRET };
  for (const file of (await readdir('migrations')).filter(f => f.endsWith('.sql')).sort()) {
    const sql = (await readFile(`migrations/${file}`, 'utf8')).replace(/--[^\n]*/g, '').replace(/\r?\n/g, ' ');
    await DB.exec(sql);
  }
  const call = (path, init = {}, bindings = env) => worker.fetch(new Request(`https://local.test${path}`, init), bindings);
  const jsonCall = (path, method, body) => call(path, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  async function note(fields = {}) {
    const response = await jsonCall('/api/notes', 'POST', { title: '日本語メモ', body: '本文', url: 'https://example.com', ...fields });
    assert.equal(response.status, 201, await response.clone().text());
    return (await response.json()).note;
  }
  const getNote = async id => (await (await call(`/api/notes/${id}`)).json()).note;
  const attachment = async id => {
    const response = await call(`/api/notes/${id}/attachments`, { method: 'POST', headers: {
      'Content-Type': 'image/png', 'X-File-Name': encodeURIComponent('日本語.png'),
    }, body: png });
    assert.equal(response.status, 201);
    return (await response.json()).attachment;
  };
  const reset = async () => {
    await DB.exec('DELETE FROM note_deletions; DELETE FROM notes; DELETE FROM labels; DELETE FROM label_groups;');
  };

  await t.test('restore wins before deletion: note and image survive', async () => {
    const n = await note(); const a = await attachment(n.id);
    await call(`/api/notes/${n.id}`, { method: 'DELETE' });
    assert.equal((await call(`/api/notes/${n.id}/restore`, { method: 'POST' })).status, 200);
    assert.equal((await call(`/api/notes/${n.id}/permanent`, { method: 'DELETE' })).status, 404);
    assert.equal((await call(a.url)).status, 200);
  });
  await t.test('deletion wins: concurrent restore/upload rejected, R2 removed before D1', async () => {
    const n = await note({ labels: ['保護'], checklist: [{ text: 'item', checked: false }] });
    const a = await attachment(n.id);
    await call(`/api/notes/${n.id}`, { method: 'DELETE' });
    let raced = false;
    const images = new Proxy(IMAGES, { get(target, key) {
      if (key === 'delete') return async keys => {
        raced = true;
        assert.ok(await DB.prepare('SELECT id FROM notes WHERE id = ?').bind(n.id).first());
        assert.equal((await call(`/api/notes/${n.id}/restore`, { method: 'POST' })).status, 409);
        await assert.rejects(DB.prepare('INSERT INTO attachments (id,note_id,filename,mime_type,r2_key,created_at) VALUES (?,?,?,?,?,?)')
          .bind(crypto.randomUUID(), n.id, 'late.png', 'image/png', 'late', new Date().toISOString()).run(), /note_deletion_in_progress/);
        return target.delete(keys);
      };
      const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
    } });
    assert.equal((await call(`/api/notes/${n.id}/permanent`, { method: 'DELETE' }, { ...env, IMAGES: images })).status, 200);
    assert.ok(raced);
    assert.equal((await call(a.url)).status, 404);
    for (const table of ['attachments', 'checklist_items', 'note_labels', 'note_deletions']) {
      assert.equal((await DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE note_id = ?`).bind(n.id).first()).n, 0);
    }
  });
  await t.test('R2 failure leaves durable claim; daily scheduled retry completes deletion', async () => {
    const n = await note(); await attachment(n.id); await call(`/api/notes/${n.id}`, { method: 'DELETE' });
    const images = new Proxy(IMAGES, { get(target, key) {
      if (key === 'delete') return async () => { throw new Error('injected R2 failure'); };
      const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
    } });
    assert.equal((await call(`/api/notes/${n.id}/permanent`, { method: 'DELETE' }, { ...env, IMAGES: images })).status, 500);
    assert.ok(await DB.prepare('SELECT id FROM notes WHERE id = ?').bind(n.id).first());
    assert.equal((await call('/api/export/counts')).status, 409);
    await worker.scheduled({}, env);
    assert.equal(await DB.prepare('SELECT id FROM notes WHERE id = ?').bind(n.id).first(), null);
    assert.equal((await call('/api/export/counts')).status, 200);
  });
  await t.test('cleanup retains recent trash and active notes, deletes expired trash', async () => {
    const active = await note(); const recent = await note(); const expired = await note();
    await call(`/api/notes/${recent.id}`, { method: 'DELETE' });
    await DB.prepare('UPDATE notes SET deleted_at = ? WHERE id = ?').bind('2020-01-01T00:00:00.000Z', expired.id).run();
    await worker.scheduled({}, env);
    assert.ok(await getNote(active.id)); assert.ok(await getNote(recent.id));
    assert.equal((await call(`/api/notes/${expired.id}`)).status, 404);
  });
  await t.test('empty trash protects a concurrently restored note and removes only claimed notes', async () => {
    await reset();
    const kept = await note(); const removed = await note();
    const a = await attachment(kept.id);
    await call(`/api/notes/${kept.id}`, { method: 'DELETE' });
    await call(`/api/notes/${removed.id}`, { method: 'DELETE' });
    await call(`/api/notes/${kept.id}/restore`, { method: 'POST' });
    const response = await call('/api/trash', { method: 'DELETE' });
    assert.equal(response.status, 200); assert.equal((await response.json()).deleted, 1);
    assert.equal((await call(a.url)).status, 200);
    assert.equal((await call(`/api/notes/${removed.id}`)).status, 404);
  });
  await t.test('label deletion/rename invalidates stale editor without losing body/image/checklist', async () => {
    const n = await note({ labels: ['旧ラベル', '維持'], checklist: [{ text: 'check', checked: true }] });
    const a = await attachment(n.id);
    await jsonCall('/api/labels', 'PATCH', { oldName: '旧ラベル', newName: '新ラベル' });
    const stale = await jsonCall(`/api/notes/${n.id}`, 'PATCH', { ...n, expected_updated_at: n.updated_at });
    assert.equal(stale.status, 409);
    const renamed = await getNote(n.id);
    assert.deepEqual(new Set(renamed.labels), new Set(['新ラベル', '維持']));
    await jsonCall('/api/labels', 'DELETE', { labels: ['新ラベル'] });
    assert.equal((await jsonCall(`/api/notes/${n.id}`, 'PATCH', { ...renamed, expected_updated_at: renamed.updated_at })).status, 409);
    const after = await getNote(n.id);
    assert.deepEqual(after.labels, ['維持']); assert.equal(after.body, n.body);
    assert.equal(after.checklist[0].checked, true); assert.equal((await call(a.url)).status, 200);
  });
  await t.test('concurrent editor saves allow one winner and preserve its relations', async () => {
    const n = await note();
    const saves = await Promise.all(['first', 'second'].map(title => jsonCall(`/api/notes/${n.id}`, 'PATCH', {
      ...n, title, labels: [title], checklist: [{ text: title, checked: true }], expected_updated_at: n.updated_at,
    })));
    assert.deepEqual(saves.map(r => r.status).sort(), [200, 409]);
    const current = await getNote(n.id);
    assert.deepEqual(current.labels, [current.title]); assert.equal(current.checklist[0].text, current.title);
  });
  await t.test('all four sorts, pinned sections, search, 50-item pages and check share order', async () => {
    await reset();
    await DB.batch(Array.from({ length: 65 }, (_, i) => DB.prepare('INSERT INTO notes (id,title,pinned,created_at,updated_at) VALUES (?,?,?,?,?)')
      .bind(crypto.randomUUID(), `sort-${i}`, Number(i % 4 === 0), new Date(2020, 0, i + 1).toISOString(), new Date(2021, 0, 65 - i).toISOString())));
    for (const sort of ['created_asc', 'created_desc', 'updated_asc', 'updated_desc']) {
      const first = await (await call(`/api/notes?sort=${sort}&q=sort-`)).json();
      const second = await (await call(`/api/notes?sort=${sort}&q=sort-&offset=50`)).json();
      const check = await (await call(`/api/notes/check?sort=${sort}&q=sort-`)).json();
      assert.equal(first.notes.length, 50); assert.equal(second.notes.length, 15);
      assert.deepEqual(check.notes.map(n => n.id), first.notes.map(n => n.id));
      const notes = [...first.notes, ...second.notes];
      assert.equal(new Set(notes.map(n => n.id)).size, 65);
      const field = sort.startsWith('created') ? 'created_at' : 'updated_at';
      const direction = sort.endsWith('asc') ? 1 : -1;
      const sorted = [...notes].sort((a, b) => Number(b.pinned) - Number(a.pinned)
        || direction * a[field].localeCompare(b[field]) || direction * a.id.localeCompare(b.id));
      assert.deepEqual(notes.map(n => n.id), sorted.map(n => n.id));
    }
    assert.equal((await call('/api/notes?sort=bad')).status, 400);
    assert.equal((await call('/api/notes/check?sort=bad')).status, 400);
  });
  await t.test('global revision detects image, thumbnail and group changes without reordering dates', async () => {
    const n = await note();
    const check = async () => (await (await call('/api/notes/check?sort=created_asc')).json()).revision;
    let revision = await check();
    await attachment(n.id); assert.ok(await check() > revision); revision = await check();
    await DB.prepare("UPDATE notes SET preview_image = 'https://example.com/image.png' WHERE id = ?").bind(n.id).run();
    assert.ok(await check() > revision); revision = await check();
    await jsonCall('/api/labels', 'POST', { name: '未使用ラベル' });
    assert.ok(await check() > revision);
    assert.equal((await getNote(n.id)).created_at, n.created_at);
  });
  await t.test('Chrome multipart and iOS urlencoded capture retain auth, pin and blank-title support', async () => {
    for (const form of [new FormData(), new URLSearchParams()]) {
      form.set('title', ''); form.set('url', 'https://example.com/capture'); form.set('pinned', 'true');
      const response = await call('/api/capture', { method: 'POST', headers: { Authorization: `Bearer ${SECRET}` }, body: form });
      assert.equal(response.status, 201, await response.clone().text());
      assert.equal((await response.json()).note.pinned, true);
    }
    assert.equal((await call('/api/capture', { method: 'POST', body: new URLSearchParams() })).status, 401);
    assert.equal((await call('/api/capture', { method: 'POST', headers: { Authorization: 'Bearer wrong' }, body: new URLSearchParams() })).status, 401);
  });
  await t.test('Export rejects same-count content/label changes during ZIP construction', async () => {
    const n = await note(); let changed = false;
    await assert.rejects(createBackup(new BlobWriter('application/zip'), () => {}, async path => {
      const response = await call(path);
      if (!changed && path.startsWith('/api/export/notes')) {
        changed = true;
        await DB.prepare("UPDATE notes SET body = 'changed' WHERE id = ?").bind(n.id).run();
      }
      return response;
    }), /データが変更/);
  });
  await t.test('Keep import preserves original creation date and trashed state', async () => {
    const response = await jsonCall('/api/import/keep', 'POST', {
      title: 'Takeout', body: '本文', url: 'https://example.com', pinned: true, archived: false,
      labels: ['Keep'], checklist: [{ text: 'チェック', checked: true }],
      created_at: '2019-01-02T03:04:05.000Z', updated_at: '2020-02-03T04:05:06.000Z', isTrashed: true,
    });
    assert.equal(response.status, 201, await response.clone().text());
    const n = (await response.json()).note;
    assert.equal(n.created_at, '2019-01-02T03:04:05.000Z');
    assert.ok(n.deleted_at); assert.equal(n.checklist[0].checked, true); assert.deepEqual(n.labels, ['Keep']);
  });
  await t.test('ZIP can be opened; JSON, Markdown, image and additional restore are intact', async () => {
    await reset();
    const n = await note({ title: '復元テスト', labels: ['テスト'], checklist: [{ text: '完了', checked: true }] });
    await attachment(n.id);
    const result = await createBackup(new BlobWriter('application/zip'), () => {}, call);
    assert.equal(result.notes, 1); assert.equal(result.attachmentsSucceeded, 1);
    const zip = new ZipReader(new BlobReader(result.blob));
    const entries = await zip.getEntries();
    const backup = JSON.parse(await entries.find(e => e.filename === 'notes.json').getData(new TextWriter()));
    const saved = backup.notes[0];
    const markdown = await entries.find(e => e.filename === saved.markdown_path).getData(new TextWriter());
    assert.match(markdown, /復元テスト/); assert.match(markdown, /\[x\] 完了/);
    const image = await entries.find(e => e.filename === saved.attachments[0].zip_path).getData(new BlobWriter());
    assert.deepEqual(Buffer.from(await image.arrayBuffer()), png);
    await reset();
    await jsonCall('/api/labels', 'POST', { name: 'テスト' });
    const restored = await jsonCall('/api/backup/restore/notes', 'POST', { note: saved });
    assert.equal(restored.status, 200, await restored.clone().text());
    assert.equal((await restored.json()).status, 'restored');
    const form = new FormData(); form.set('note', JSON.stringify(saved)); form.set('attachment', JSON.stringify(saved.attachments[0]));
    form.set('file', new File([image], '日本語.png', { type: 'image/png' }));
    assert.equal((await call('/api/backup/restore/attachments', { method: 'POST', body: form })).status, 201);
    const current = await getNote(n.id);
    assert.equal(current.created_at, n.created_at); assert.deepEqual(current.labels, ['テスト']);
    assert.equal(current.checklist[0].checked, true); assert.equal(current.attachments.length, 1);
    await zip.close();
  });
});
