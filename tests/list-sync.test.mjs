import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, readdir } from 'node:fs/promises';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

async function moduleFrom(path) {
  const result = await build({ entryPoints: [path], bundle: true, write: false, format: 'esm', platform: 'node', target: 'node24' });
  return import(`data:text/javascript;base64,${Buffer.from(`${result.outputFiles[0].text}\n//# sourceURL=mykeep-list-sync-test-${path}\n`).toString('base64')}`);
}

const { default: worker } = await moduleFrom('worker/index.ts');
const SECRET = 'local-list-sync-key';

test('list sync metadata, snapshot barriers and note versions', async (t) => {
  const mf = new Miniflare(convertV4MiniflareOptions({ workers: [{ name: 'list-sync', modules: true,
    script: 'export default {fetch(){return new Response("test")}}', compatibilityDate: '2026-09-28', d1Databases: ['DB'], r2Buckets: ['IMAGES'] }] }));
  t.after(() => mf.dispose());
  const DB = await mf.getD1Database('DB');
  const IMAGES = await mf.getR2Bucket('IMAGES');
  const env = { DB, IMAGES, CAPTURE_API_KEY: SECRET };
  for (const file of (await readdir('migrations')).filter((name) => name.endsWith('.sql')).sort()) {
    const sql = (await readFile(`migrations/${file}`, 'utf8')).replace(/--[^\n]*/g, '').replace(/\r?\n/g, ' ');
    await DB.exec(sql);
  }

  const call = (path, init = {}, bindings = env) => worker.fetch(new Request(`https://local.test${path}`, init), bindings);
  const jsonCall = (path, method, body, bindings = env) => call(path, {
    method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }, bindings);
  async function createNote(fields = {}) {
    const response = await jsonCall('/api/notes', 'POST', { title: 'sync note', body: 'body', url: '', ...fields });
    assert.equal(response.status, 201, await response.clone().text());
    return (await response.json()).note;
  }
  async function insertNote({ id, title, pinned = 0, archived = 0, created, updated, deleted = null }) {
    await DB.prepare(`INSERT INTO notes (id,title,body,url,pinned,archived,created_at,updated_at,deleted_at)
      VALUES (?,?,?,?,?,?,?,?,?)`).bind(id, title, `${title} body`, '', pinned, archived, created, updated, deleted).run();
  }
  async function currentRevision() {
    return (await DB.prepare('SELECT revision FROM data_revision WHERE id = 1').first()).revision;
  }
  async function syncVersion(id) {
    return (await DB.prepare('SELECT sync_version FROM note_sync_versions WHERE note_id = ?').bind(id).first()).sync_version;
  }
  async function clearData() {
    await DB.exec('DELETE FROM note_deletions; DELETE FROM notes; DELETE FROM labels; DELETE FROM label_groups;');
  }

  await t.test('filtered list and check share stable order, lightweight metadata and page bounds', async () => {
    await clearData();
    const a = '00000000-0000-4000-8000-000000000001';
    const b = '00000000-0000-4000-8000-000000000002';
    const c = '00000000-0000-4000-8000-000000000003';
    const outside = '00000000-0000-4000-8000-000000000004';
    await insertNote({ id: a, title: 'needle alpha', created: '2026-01-02T00:00:00.000Z', updated: '2026-02-01T00:00:00.000Z' });
    await insertNote({ id: b, title: 'needle beta', pinned: 1, created: '2026-01-01T00:00:00.000Z', updated: '2026-02-02T00:00:00.000Z' });
    await insertNote({ id: c, title: 'needle gamma', created: '2026-01-03T00:00:00.000Z', updated: '2026-02-03T00:00:00.000Z' });
    await insertNote({ id: outside, title: 'needle outside', created: '2026-01-04T00:00:00.000Z', updated: '2026-02-04T00:00:00.000Z' });
    await DB.prepare("INSERT INTO labels (name_key,name) VALUES ('focus','Focus')").run();
    await DB.batch([a, b, c].map((id) => DB.prepare('INSERT INTO note_labels (note_id,label_key) VALUES (?,?)').bind(id, 'focus')));

    const params = new URLSearchParams({ q: 'needle', label: 'focus', sort: 'created_asc', date_field: 'created',
      from: '2026-01-01T00:00:00.000Z', before: '2026-01-04T00:00:00.000Z', limit: '2' });
    const metadataResponse = await call(`/api/notes/check?${params}`);
    assert.equal(metadataResponse.status, 200);
    const metadata = await metadataResponse.json();
    const listResponse = await call(`/api/notes?${params}`);
    const page = await listResponse.json();
    assert.equal(listResponse.status, 200);
    assert.deepEqual(metadata.notes.map((note) => note.id), [b, a]);
    assert.deepEqual(page.notes.map((note) => note.id), metadata.notes.map((note) => note.id));
    assert.equal(metadata.hasMore, true);
    assert.equal(page.hasMore, true);
    assert.deepEqual(Object.keys(metadata.notes[0]).sort(), ['id', 'sync_version', 'updated_at']);
    assert.ok(Number.isInteger(page.notes[0].sync_version));

    const offset = await (await call(`/api/notes?${params}&offset=1`)).json();
    assert.deepEqual(offset.notes.map((note) => note.id), [a, c]);
    const fullWindowParams = new URLSearchParams(params);
    fullWindowParams.set('limit', '500');
    const fullWindow = await (await call(`/api/notes/check?${fullWindowParams}`)).json();
    assert.deepEqual(fullWindow.notes.map((note) => note.id), [b, a, c]);
    assert.equal((await call('/api/notes?limit=51')).status, 400, 'full relation reads stay within D1 binding limits');
    for (const invalid of ['limit=0', 'limit=501', 'limit=abc', 'offset=-1', 'offset=1.5', 'revision=-1']) {
      assert.equal((await call(`/api/notes?${invalid}`)).status, 400);
      assert.equal((await call(`/api/notes/check?${invalid}`)).status, 400);
    }
    assert.equal((await call('/api/notes/check?since=nope')).status, 400);
  });

  await t.test('unchanged check reads only the global revision row', async () => {
    const revision = await currentRevision();
    const statements = [];
    const countedDb = new Proxy(DB, { get(target, key) {
      if (key === 'prepare') return (sql) => { statements.push(String(sql)); return target.prepare(sql); };
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    const response = await call(`/api/notes/check?since=${revision}`, {}, { ...env, DB: countedDb });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { unchanged: true, revision });
    assert.equal(statements.length, 1);
    assert.match(statements[0], /FROM data_revision/);
  });

  await t.test('global changes preserve unrelated versions and stale page or batch snapshots are rejected', async () => {
    await clearData();
    const first = await createNote({ title: 'first' });
    const second = await createNote({ title: 'second' });
    const initial = await (await call('/api/notes/check')).json();
    const firstVersion = initial.notes.find((note) => note.id === first.id).sync_version;
    const secondVersion = initial.notes.find((note) => note.id === second.id).sync_version;
    const firstPage = await (await call('/api/notes?limit=1')).json();
    assert.equal(firstPage.hasMore, true);
    assert.equal(firstPage.revision, initial.revision);

    await DB.prepare("UPDATE notes SET body = 'changed elsewhere' WHERE id = ?").bind(first.id).run();
    const current = await (await call(`/api/notes/check?since=${initial.revision}`)).json();
    assert.equal(current.revision, await currentRevision());
    assert.ok(current.notes.find((note) => note.id === first.id).sync_version > firstVersion);
    assert.equal(current.notes.find((note) => note.id === second.id).sync_version, secondVersion);
    const pageConflict = await call(`/api/notes?limit=1&offset=1&revision=${firstPage.revision}`);
    assert.equal(pageConflict.status, 409);
    assert.equal((await pageConflict.json()).code, 'list_changed');

    const staleBatch = await jsonCall('/api/notes/batch', 'POST', { ids: [second.id], revision: initial.revision });
    assert.equal(staleBatch.status, 409);
    assert.equal((await staleBatch.json()).code, 'list_changed');
    const freshBatch = await jsonCall('/api/notes/batch', 'POST', { ids: [second.id, first.id], revision: current.revision });
    assert.equal(freshBatch.status, 200);
    const batch = await freshBatch.json();
    assert.deepEqual(batch.notes.map((note) => note.id), [second.id, first.id]);
    assert.equal(batch.notes.find((note) => note.id === first.id).body, 'changed elsewhere');

    const missing = await jsonCall('/api/notes/batch', 'POST', { ids: [crypto.randomUUID()], revision: current.revision });
    assert.deepEqual((await missing.json()).notes, []);
    const invalidBodies = [
      { ids: ['bad'], revision: current.revision },
      { ids: [second.id, second.id], revision: current.revision },
      { ids: Array.from({ length: 51 }, () => crypto.randomUUID()), revision: current.revision },
      { ids: [second.id], revision: String(current.revision) },
      { ids: [second.id], revision: -1 },
    ];
    for (const body of invalidBodies) assert.equal((await jsonCall('/api/notes/batch', 'POST', body)).status, 400);
  });

  await t.test('in-flight list and batch reads fail their after-read revision barrier', async () => {
    await clearData();
    const note = await createNote({ title: 'racing note' });
    const revision = await currentRevision();
    function databaseThatMutatesAfterNoteRead() {
      let changed = false;
      const wrap = (statement, sql) => new Proxy(statement, { get(target, key) {
        if (key === 'bind') return (...values) => wrap(target.bind(...values), sql);
        if (key === 'all') return async (...args) => {
          const result = await target.all(...args);
          if (!changed && sql.startsWith('SELECT notes.id, title')) {
            changed = true;
            await DB.prepare("UPDATE notes SET body = body || ' race' WHERE id = ?").bind(note.id).run();
          }
          return result;
        };
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      } });
      return new Proxy(DB, { get(target, key) {
        if (key === 'prepare') return (sql) => wrap(target.prepare(sql), String(sql));
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      } });
    }
    const racingEnv = { ...env, DB: databaseThatMutatesAfterNoteRead() };
    const listResponse = await call(`/api/notes?revision=${revision}`, {}, racingEnv);
    assert.equal(listResponse.status, 409);
    assert.equal((await listResponse.json()).code, 'list_changed');

    const nextRevision = await currentRevision();
    const racingBatchEnv = { ...env, DB: databaseThatMutatesAfterNoteRead() };
    const batchResponse = await jsonCall('/api/notes/batch', 'POST', { ids: [note.id], revision: nextRevision }, racingBatchEnv);
    assert.equal(batchResponse.status, 409);
    assert.equal((await batchResponse.json()).code, 'list_changed');
  });

  await t.test('attachment, checklist, label relation and label-name changes bump note versions', async () => {
    await clearData();
    const note = await createNote({ title: 'versioned note' });
    const checked = await call('/api/notes/check');
    const initial = (await checked.json()).notes.find((entry) => entry.id === note.id).sync_version;
    const assertBump = async (write) => {
      const before = await syncVersion(note.id);
      await write();
      const after = await syncVersion(note.id);
      assert.ok(after > before, `${before} should be less than ${after}`);
      return after;
    };

    await assertBump(() => DB.prepare('INSERT INTO checklist_items (id,note_id,position,text,checked) VALUES (?,?,?,?,?)')
      .bind(crypto.randomUUID(), note.id, 0, 'item', 0).run());
    const checklistId = (await DB.prepare('SELECT id FROM checklist_items WHERE note_id = ?').bind(note.id).first()).id;
    await assertBump(() => DB.prepare('UPDATE checklist_items SET checked = 1 WHERE id = ?').bind(checklistId).run());
    await assertBump(() => DB.prepare('DELETE FROM checklist_items WHERE id = ?').bind(checklistId).run());

    const attachmentId = crypto.randomUUID();
    await assertBump(() => DB.prepare(`INSERT INTO attachments (id,note_id,filename,mime_type,r2_key,created_at)
      VALUES (?,?,?,?,?,?)`).bind(attachmentId, note.id, 'image.png', 'image/png', 'test-key', new Date().toISOString()).run());
    await assertBump(() => DB.prepare('UPDATE attachments SET filename = ? WHERE id = ?').bind('renamed.png', attachmentId).run());
    await assertBump(() => DB.prepare('DELETE FROM attachments WHERE id = ?').bind(attachmentId).run());

    await DB.batch([
      DB.prepare("INSERT INTO labels (name_key,name) VALUES ('first-label','First label')"),
      DB.prepare("INSERT INTO labels (name_key,name) VALUES ('second-label','Second label')"),
    ]);
    await assertBump(() => DB.prepare('INSERT INTO note_labels (note_id,label_key) VALUES (?,?)').bind(note.id, 'first-label').run());
    await assertBump(() => DB.prepare('UPDATE note_labels SET label_key = ? WHERE note_id = ?').bind('second-label', note.id).run());
    const beforeRename = await syncVersion(note.id);
    await DB.prepare("UPDATE labels SET name = 'Renamed label' WHERE name_key = 'second-label'").run();
    assert.ok(await syncVersion(note.id) > beforeRename);

    const groupId = crypto.randomUUID();
    await DB.prepare('INSERT INTO label_groups (id,name_key,name) VALUES (?,?,?)').bind(groupId, 'group', 'Group').run();
    const linkedVersion = await syncVersion(note.id);
    await DB.prepare('UPDATE labels SET group_id = ? WHERE name_key = ?').bind(groupId, 'second-label').run();
    assert.equal(await syncVersion(note.id), linkedVersion);
    await assertBump(() => DB.prepare('DELETE FROM note_labels WHERE note_id = ?').bind(note.id).run());

    const afterRelations = await syncVersion(note.id);
    assert.ok(afterRelations > initial);
  });
});
