import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, readdir, writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { runDownload } from '../scripts/download-backup.mjs';

async function load(path) {
  const b = await build({ entryPoints: [path], bundle: true, write: false, format: 'esm', platform: 'node', target: 'node24' });
  return import(`data:text/javascript;base64,${Buffer.from(b.outputFiles[0].text).toString('base64')}`);
}
const { advanceScheduledBackup: advanceInNode, hasRecentBackup } = await load('worker/scheduledBackup.ts');
const { default: worker } = await load('worker/index.ts');
const { readBackupZip, restoreBackup } = await load('src/restoreBackup.ts');
const day = 86_400_000;
const bytes = new Uint8Array([10, 20, 30, 40]);

test('scheduled backups preserve data, resume safely, and gate automatic deletion', async t => {
  // Exercise R2-to-R2 streaming inside workerd: a Node RPC proxy loses the stream's known length.
  const bundled = await build({ stdin: { resolveDir: process.cwd(), contents: `
    import { advanceScheduledBackup } from './worker/scheduledBackup.ts';
    export default { async fetch(request, env) {
      await advanceScheduledBackup(env, Number(new URL(request.url).searchParams.get('now')));
      return new Response('ok');
    }};` }, bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022' });
  const mf = new Miniflare(convertV4MiniflareOptions({ workers: [{ name: 'backup-test', modules: true,
    script: bundled.outputFiles[0].text, compatibilityDate: '2026-09-28',
    bindings: { AUTOMATIC_BACKUP_ENABLED: 'true' },
    d1Databases: ['DB'], r2Buckets: ['IMAGES', 'BACKUPS'] }] }));
  t.after(() => mf.dispose());
  const DB = await mf.getD1Database('DB');
  const IMAGES = await mf.getR2Bucket('IMAGES');
  const BACKUPS = await mf.getR2Bucket('BACKUPS');
  const env = { DB, IMAGES, BACKUPS, AUTOMATIC_BACKUP_ENABLED: 'true' };
  const advanceScheduledBackup = async (bindings, at) => {
    if (bindings.AUTOMATIC_BACKUP_ENABLED !== 'true') return advanceInNode(bindings, at);
    const response = await mf.dispatchFetch(`http://local.test/?now=${at}`);
    assert.equal(response.status, 200, await response.text());
  };
  for (const file of (await readdir('migrations')).filter(f => f.endsWith('.sql')).sort()) {
    await DB.exec((await readFile(`migrations/${file}`, 'utf8')).replace(/--[^\n]*/g, '').replace(/\r?\n/g, ' '));
  }
  const now = Date.now();
  const progress = async () => (await BACKUPS.get('progress.json'))?.json();
  async function runToDone(start = now, bindings = env) {
    for (let tick = 0; tick < 250; tick++) {
      await advanceScheduledBackup(bindings, start + tick * 60_000);
      const p = await progress();
      if (p.phase === 'complete') return p;
      assert.notEqual(p.phase, 'failed', JSON.stringify(p));
    }
    assert.fail('backup failed to finish within bounded invocations');
  }
  const notes = Array.from({ length: 225 }, () => crypto.randomUUID());
  for (const [i, id] of notes.entries()) {
    await DB.prepare(`INSERT INTO notes (id,title,body,url,pinned,archived,color,deleted_at,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).bind(id, `日本語 ${i}`, '本文', 'https://example.com', i === 0 ? 1 : 0,
        i === 1 ? 1 : 0, 'default', i === 2 ? new Date(now - 10 * day).toISOString() : null,
        new Date(now).toISOString(), new Date(now).toISOString()).run();
  }
  const attachmentIds = Array.from({ length: 31 }, () => crypto.randomUUID());
  for (const id of attachmentIds) {
    await IMAGES.put(`notes/original/${id}`, bytes, { httpMetadata: { contentType: 'image/png' } });
    await DB.prepare('INSERT INTO attachments VALUES (?,?,?,?,?,?)').bind(id, notes[0], '日本語.png',
      'image/png', `notes/original/${id}`, new Date(now).toISOString()).run();
  }
  const group = crypto.randomUUID();
  await DB.prepare('INSERT INTO label_groups VALUES (?,?,?)').bind(group, 'empty', '空グループ').run();
  await DB.prepare('INSERT INTO labels (name_key,name,group_id) VALUES (?,?,?)').bind('unused', '未使用', group).run();
  await DB.prepare('INSERT INTO labels (name_key,name,group_id) VALUES (?,?,?)').bind('used', '復元用ラベル', group).run();
  await DB.prepare('INSERT INTO note_labels VALUES (?,?)').bind(notes[0], 'used').run();
  await DB.prepare('INSERT INTO checklist_items (id,note_id,position,text,checked) VALUES (?,?,?,?,?)')
    .bind(crypto.randomUUID(), notes[0], 0, '完了済み', 1).run();
  await DB.prepare('UPDATE notes SET preview_image = ?, card_image = ? WHERE id = ?')
    .bind('https://example.com/preview.png', `attachment:${attachmentIds[0]}`, notes[0]).run();

  await t.test('disabled flag never reads or writes any service', async () => {
    await advanceScheduledBackup({ AUTOMATIC_BACKUP_ENABLED: 'false' });
    assert.equal(await hasRecentBackup({ AUTOMATIC_BACKUP_ENABLED: 'false' }), true);
    assert.equal(await hasRecentBackup({ AUTOMATIC_BACKUP_ENABLED: 'true' }), false);
  });
  let done;
  await t.test('an in-progress 20-row snapshot resumes with 200 rows and 15 streamed files per invocation', async () => {
    const before = await DB.prepare('SELECT revision FROM data_revision').first();
    await advanceScheduledBackup(env, now);
    const prior = await progress();
    const legacyRows = (await DB.prepare('SELECT rowid AS __backup_rowid, * FROM notes ORDER BY rowid LIMIT 20').all()).results;
    await BACKUPS.put(`daily/${prior.snapshot}/notes/000001.json`, JSON.stringify(
      legacyRows.map(({ __backup_rowid, ...row }) => row)));
    prior.tables[0].parts = 1;
    prior.tables[0].rows = 20;
    prior.after = legacyRows.at(-1).__backup_rowid;
    await BACKUPS.put('progress.json', JSON.stringify(prior));
    await advanceScheduledBackup(env, now + 60_000);
    let p = await progress();
    assert.equal(p.snapshot, prior.snapshot);
    assert.equal(p.tables[0].rows, 220);
    assert.equal(p.tables[0].parts, 2);
    let sawFullFileBatch = false;
    for (let tick = 2; tick < 30; tick++) {
      const filesBefore = p.attachments;
      await advanceScheduledBackup(env, now + tick * 60_000);
      p = await progress();
      assert.equal(p.snapshot, prior.snapshot);
      assert.equal(p.attempts, 1);
      assert.equal(p.errors, 0);
      assert.ok(p.attachments - filesBefore <= 15);
      if (p.attachments - filesBefore === 15) sawFullFileBatch = true;
      if (p.phase === 'complete') break;
    }
    assert.equal(p.phase, 'complete');
    assert.equal(sawFullFileBatch, true);
    done = p;
    const manifest = await (await BACKUPS.get(`daily/${done.snapshot}/manifest.json`)).json();
    assert.equal(manifest.status, 'complete');
    assert.equal(manifest.tables.find(x => x.name === 'notes').rows, notes.length);
    assert.equal(manifest.tables.find(x => x.name === 'notes').parts, 3);
    assert.equal(manifest.attachments, attachmentIds.length);
    assert.equal(manifest.attachment_bytes, bytes.length * attachmentIds.length);
    for (const id of attachmentIds) {
      const object = await BACKUPS.get(`daily/${done.snapshot}/files/${id}`);
      assert.deepEqual(new Uint8Array(await object.arrayBuffer()), bytes);
      assert.equal(object.httpMetadata.contentType, 'image/png');
      assert.ok(await IMAGES.head(`notes/original/${id}`));
    }
    assert.deepEqual(await DB.prepare('SELECT revision FROM data_revision').first(), before);
    assert.equal(await hasRecentBackup(env, now + 60 * 60_000), true);
    assert.equal(await hasRecentBackup(env, now + 3 * day), false);
  });
  await t.test('actual scheduled output restores through the existing API into isolated D1 and R2', async () => {
    const output = join(tmpdir(), `mykeep-backup-roundtrip-${crypto.randomUUID()}.zip`);
    try {
      const result = await runDownload(['latest', output], { downloadObject: async (_bucket, key, destination) => {
        const object = await BACKUPS.get(key);
        assert.ok(object, key);
        await writeFile(destination, new Uint8Array(await object.arrayBuffer()), { flag: 'wx' });
      } });
      assert.equal(result.notes, notes.length);
      assert.equal(result.attachments, attachmentIds.length);
      const zip = await readBackupZip(new Blob([await readFile(output)]));
      try {
        assert.equal(zip.manifest.notes.length, notes.length);
        assert.equal(zip.missingAttachments, 0);
        assert.ok(zip.manifest.groups.some(g => g.id === group));
        assert.ok(zip.manifest.memberships.some(m => m.label_name === '未使用' && m.group_id === group));
        const first = zip.manifest.notes.find(n => n.id === notes[0]);
        assert.equal(first.title, '日本語 0');
        assert.equal(first.pinned, true);
        const file = await zip.readAttachment(first.attachments[0]);
        assert.deepEqual(new Uint8Array(await file.arrayBuffer()), bytes);

        const destination = new Miniflare(convertV4MiniflareOptions({ workers: [{ name: 'restore-target', modules: true,
          script: 'export default {fetch(){return new Response("test")}}', compatibilityDate: '2026-09-28',
          d1Databases: ['DB'], r2Buckets: ['IMAGES'] }] }));
        try {
          const restoreEnv = { DB: await destination.getD1Database('DB'), IMAGES: await destination.getR2Bucket('IMAGES') };
          for (const name of (await readdir('migrations')).filter(f => f.endsWith('.sql')).sort()) {
            await restoreEnv.DB.exec((await readFile(`migrations/${name}`, 'utf8')).replace(/--[^\n]*/g, '').replace(/\r?\n/g, ' '));
          }
          const preserved = crypto.randomUUID();
          await restoreEnv.DB.prepare('INSERT INTO notes (id,title,body,created_at,updated_at) VALUES (?,?,?,?,?)')
            .bind(preserved, '既存メモを保持', '上書きしない', new Date(now).toISOString(), new Date(now).toISOString()).run();
          const sourceBefore = await DB.prepare('SELECT revision FROM data_revision').first();
          const fetcher = (path, init) => worker.fetch(new Request(`https://local.test${path}`, init), restoreEnv);
          const result = await restoreBackup(zip, () => {}, fetcher);
          assert.equal(result.partial, false, JSON.stringify(result));
          assert.equal(result.notes.added, notes.length);
          assert.equal(result.attachments.added, attachmentIds.length);
          assert.equal(result.groups.added, 1);
          assert.equal(result.labels.added, 2);
          assert.equal((await restoreEnv.DB.prepare('SELECT count(*) AS n FROM notes').first()).n, notes.length + 1);
          assert.equal((await restoreEnv.DB.prepare('SELECT body FROM notes WHERE id = ?').bind(preserved).first()).body, '上書きしない');
          const restored = (await (await fetcher(`/api/notes/${notes[0]}`)).json()).note;
          assert.equal(restored.title, first.title);
          assert.equal(restored.body, first.body);
          assert.equal(restored.url, first.url);
          assert.equal(restored.created_at, first.created_at);
          assert.equal(restored.updated_at, first.updated_at);
          assert.equal(restored.pinned, true);
          assert.deepEqual(restored.labels, ['復元用ラベル']);
          assert.equal(restored.checklist[0].checked, true);
          assert.equal(restored.preview_image, first.preview_image);
          assert.equal(restored.card_image, `attachment:${attachmentIds[0]}`);
          assert.equal((await restoreEnv.DB.prepare('SELECT archived FROM notes WHERE id = ?').bind(notes[1]).first()).archived, 1);
          assert.equal((await restoreEnv.DB.prepare('SELECT deleted_at FROM notes WHERE id = ?').bind(notes[2]).first()).deleted_at,
            zip.manifest.notes.find(n => n.id === notes[2]).deleted_at);
          assert.equal((await restoreEnv.DB.prepare('SELECT group_id FROM labels WHERE name = ?').bind('復元用ラベル').first()).group_id, group);
          for (const attachment of (await restoreEnv.DB.prepare('SELECT r2_key FROM attachments').all()).results) {
            const saved = await restoreEnv.IMAGES.get(attachment.r2_key);
            assert.deepEqual(new Uint8Array(await saved.arrayBuffer()), bytes);
          }
          const repeated = await restoreBackup(zip, () => {}, fetcher);
          assert.equal(repeated.partial, false, JSON.stringify(repeated));
          assert.equal(repeated.notes.added, 0);
          assert.equal(repeated.notes.skipped, notes.length);
          assert.equal(repeated.attachments.added, 0);
          assert.equal(repeated.attachments.skipped, attachmentIds.length);
          assert.deepEqual(await DB.prepare('SELECT revision FROM data_revision').first(), sourceBefore);
        } finally { await destination.dispose(); }
      } finally { await zip.close(); }
    } finally { await unlink(output).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  });
  await t.test('overlapping invocations cannot both advance a batch', async () => {
    await BACKUPS.delete('progress.json');
    let reads = 0;
    let release;
    const bothRead = new Promise(resolve => { release = resolve; });
    const bucket = new Proxy(BACKUPS, { get(target, property) {
      if (property === 'get') return async key => {
        const object = await target.get(key);
        if (key === 'progress.json') {
          if (++reads === 2) release();
          await bothRead;
        }
        return object;
      };
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    await Promise.all([advanceInNode({ ...env, BACKUPS: bucket }, now), advanceInNode({ ...env, BACKUPS: bucket }, now)]);
    const p = await progress();
    assert.equal(p.phase, 'tables');
    assert.equal(p.tables[0].rows, 0);
    assert.equal(p.leaseUntil, 0);
  });
  await t.test('a changed revision rejects the incomplete snapshot and keeps the last completed backup', async () => {
    const p = await progress();
    await DB.prepare('UPDATE notes SET body = ? WHERE id = ?').bind('変更', notes[0]).run();
    await advanceScheduledBackup(env, now + 60_000);
    assert.equal((await progress()).phase, 'failed');
    assert.equal(await BACKUPS.head(`daily/${p.snapshot}/manifest.json`), null);
    assert.equal((await (await BACKUPS.get('latest.json')).json()).snapshot, done.snapshot);
  });
  await t.test('missing attachment retries but never publishes an incomplete backup', async () => {
    await BACKUPS.delete('progress.json');
    await IMAGES.delete(`notes/original/${attachmentIds[0]}`);
    let p;
    for (let i = 0; i < 50; i++) {
      await advanceScheduledBackup(env, now + i * 5 * 60_000);
      p = await progress();
      if (p.phase === 'failed') break;
    }
    assert.equal(p.phase, 'failed');
    assert.equal(await BACKUPS.head(`daily/${p.snapshot}/manifest.json`), null);
    assert.equal((await (await BACKUPS.get('latest.json')).json()).snapshot, done.snapshot);
    await IMAGES.put(`notes/original/${attachmentIds[0]}`, bytes, { httpMetadata: { contentType: 'image/png' } });
  });
  await t.test('3-day cleanup preserves today and two preceding days, latest and unrelated objects', async () => {
    await BACKUPS.delete('progress.json');
    done = await runToDone();
    const old = `2000-01-01-${crypto.randomUUID()}`;
    await BACKUPS.put(`daily/${old}/manifest.json`, '{}');
    await BACKUPS.put(`daily/${old}/files/${crypto.randomUUID()}`, bytes);
    await BACKUPS.put('unrelated/keep', bytes);
    const boundaryKeys = [];
    for (const daysAgo of [1, 2, 3]) {
      const date = new Date(Date.parse(`${done.day}T00:00:00Z`) - daysAgo * day).toISOString().slice(0, 10);
      const key = `daily/${date}-${crypto.randomUUID()}/manifest.json`;
      boundaryKeys.push(key);
      await BACKUPS.put(key, '{}');
    }
    await advanceScheduledBackup(env, now + 60 * 60_000);
    assert.equal(await BACKUPS.head(`daily/${old}/manifest.json`), null);
    assert.ok(await BACKUPS.head(`daily/${done.snapshot}/manifest.json`));
    assert.ok(await BACKUPS.head('unrelated/keep'));
    assert.ok(await BACKUPS.head(boundaryKeys[0]));
    assert.ok(await BACKUPS.head(boundaryKeys[1]));
    assert.equal(await BACKUPS.head(boundaryKeys[2]), null);
  });
  await t.test('exhausted backups prune expired partials beyond a protected listing page, even without any success', async () => {
    const savedLatest = await (await BACKUPS.get('latest.json')).text();
    const savedProgress = await progress();
    const before = await DB.prepare('SELECT revision FROM data_revision').first();
    const protectedSnapshot = `2000-01-01-${crypto.randomUUID()}`;
    const expiredSnapshot = `2001-01-01-${crypto.randomUUID()}`;
    const protectedKeys = Array.from({ length: 105 }, (_, i) => `daily/${protectedSnapshot}/files/${i}`);
    for (const key of protectedKeys) await BACKUPS.put(key, bytes);
    const expiredKey = `daily/${expiredSnapshot}/notes/000001.json`;
    await BACKUPS.put(expiredKey, '[]');
    await BACKUPS.put('latest.json', JSON.stringify({ snapshot: protectedSnapshot, completed_at: new Date(now).toISOString() }));
    const exhausted = { ...savedProgress, phase: 'failed', attempts: 3, errors: 3,
      retryAt: 0, leaseUntil: 0, cleaned: false, cleanupCursor: undefined };
    await BACKUPS.put('progress.json', JSON.stringify(exhausted));
    async function finishCleanup() {
      for (let i = 0; i < 10; i++) {
        await advanceScheduledBackup(env, now + i * 60_000);
        if ((await progress()).cleaned) return;
      }
      assert.fail('bounded cleanup did not finish');
    }
    await finishCleanup();
    assert.equal((await progress()).phase, 'failed');
    assert.equal(await BACKUPS.head(expiredKey), null);
    for (const key of protectedKeys) assert.ok(await BACKUPS.head(key));
    // No completed snapshot yet: failed older attempts still must not accumulate forever.
    await BACKUPS.delete('latest.json');
    // A complete manifest whose latest-pointer write was lost must also remain safe.
    await BACKUPS.put(`daily/${protectedSnapshot}/manifest.json`, JSON.stringify({ status: 'complete' }));
    await BACKUPS.put(expiredKey, '[]');
    await BACKUPS.put('progress.json', JSON.stringify(exhausted));
    await finishCleanup();
    assert.equal(await BACKUPS.head(expiredKey), null);
    assert.equal(await BACKUPS.head('latest.json'), null);
    for (const key of protectedKeys) assert.ok(await BACKUPS.head(key));
    assert.deepEqual(await DB.prepare('SELECT revision FROM data_revision').first(), before);
    await BACKUPS.put('latest.json', savedLatest);
    await BACKUPS.put('progress.json', JSON.stringify(savedProgress));
  });
  await t.test('30-day cutoff preserves recent trash and active notes; expired attachments are removed', async () => {
    const oldest = notes[3];
    await DB.prepare('UPDATE notes SET deleted_at = ? WHERE id = ?').bind(new Date(now - 31 * day).toISOString(), oldest).run();
    await DB.prepare('UPDATE notes SET deleted_at = ? WHERE id = ?').bind(new Date(now - 29 * day).toISOString(), notes[4]).run();
    const a = crypto.randomUUID();
    await IMAGES.put(`expired/${a}`, bytes);
    await DB.prepare('INSERT INTO attachments VALUES (?,?,?,?,?,?)').bind(a, oldest, 'old.png', 'image/png', `expired/${a}`, new Date(now).toISOString()).run();
    await BACKUPS.delete('latest.json');
    await worker.scheduled({ cron: '0 18 * * *' }, env);
    assert.ok(await DB.prepare('SELECT id FROM notes WHERE id = ?').bind(oldest).first());
    await BACKUPS.delete('progress.json');
    done = await runToDone();
    const latest = await (await BACKUPS.get('latest.json')).json();
    latest.completed_at = new Date(Date.now()).toISOString();
    await BACKUPS.put('latest.json', JSON.stringify(latest));
    await worker.scheduled({ cron: '0 18 * * *' }, env);
    assert.equal(await DB.prepare('SELECT id FROM notes WHERE id = ?').bind(oldest).first(), null);
    assert.equal(await IMAGES.head(`expired/${a}`), null);
    for (const id of [notes[0], notes[2], notes[4]]) assert.ok(await DB.prepare('SELECT id FROM notes WHERE id = ?').bind(id).first());
  });
  await t.test('an explicit pending deletion still completes when no backup exists', async () => {
    await BACKUPS.delete('latest.json');
    const id = notes[5];
    await DB.prepare('UPDATE notes SET deleted_at = ? WHERE id = ?').bind(new Date(now).toISOString(), id).run();
    await DB.prepare('INSERT INTO note_deletions (note_id,r2_keys) VALUES (?,?)').bind(id, '[]').run();
    await worker.scheduled({ cron: '0 18 * * *' }, env);
    assert.equal(await DB.prepare('SELECT id FROM notes WHERE id = ?').bind(id).first(), null);
  });
  await t.test('additive restore uses the same 30-day retention rule', async () => {
    for (const age of [10, 29, 31]) {
      const deleted_at = new Date(now - age * day).toISOString();
      const note = { id: crypto.randomUUID(), title: '復元', body: '本文を保持', url: '', color: 'default',
        pinned: true, archived: true, trashed: true, deleted_at, created_at: deleted_at, updated_at: deleted_at,
        checklist: [], labels: [], attachments: [] };
      const response = await worker.fetch(new Request('https://local.test/api/backup/restore/notes', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ note }),
      }), env);
      assert.equal(response.status, 200, await response.clone().text());
      const row = await DB.prepare('SELECT body,pinned,archived,deleted_at FROM notes WHERE id = ?').bind(note.id).first();
      assert.deepEqual(row, { body: note.body, pinned: 1, archived: 1, deleted_at: age < 30 ? deleted_at : null });
    }
  });
  await t.test('corrupt progress fails closed without changing source data or publishing completion', async () => {
    const before = await DB.prepare('SELECT revision FROM data_revision').first();
    await BACKUPS.put('progress.json', JSON.stringify({ version: 1, phase: 'complete' }));
    await assert.rejects(advanceInNode(env, now), /backup_invalid_progress/);
    assert.deepEqual(await DB.prepare('SELECT revision FROM data_revision').first(), before);
    assert.equal(await BACKUPS.head('latest.json'), null);
    assert.equal(await hasRecentBackup(env, now), false);
  });
  await t.test('one minute Cron cleans trash only on the 18:00 UTC tick', async () => {
    const id = crypto.randomUUID();
    const timestamp = new Date(now - 31 * day).toISOString();
    await DB.prepare('INSERT INTO notes (id,title,body,url,pinned,archived,created_at,updated_at,deleted_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .bind(id, '期限経過', '', '', 0, 0, timestamp, timestamp, timestamp).run();
    const bindings = { ...env, AUTOMATIC_BACKUP_ENABLED: 'false' };
    for (const [hour, minute] of [[17, 59], [18, 1]]) {
      await worker.scheduled({ cron: '* * * * *', scheduledTime: Date.UTC(2026, 10, 6, hour, minute) }, bindings);
      assert.ok(await DB.prepare('SELECT id FROM notes WHERE id = ?').bind(id).first());
    }
    await worker.scheduled({ cron: '* * * * *', scheduledTime: Date.UTC(2026, 10, 6, 18, 0) }, bindings);
    assert.equal(await DB.prepare('SELECT id FROM notes WHERE id = ?').bind(id).first(), null);
  });
});
