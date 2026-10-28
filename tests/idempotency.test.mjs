import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, readdir } from 'node:fs/promises';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

async function moduleFrom(path) {
  const result = await build({ entryPoints: [path], bundle: true, write: false, format: 'esm', platform: 'node', target: 'node24' });
  return import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].text).toString('base64'));
}

async function withoutExpectedWorkerErrorLog(operation) {
  const original = console.error;
  console.error = (...args) => {
    if (args[0] !== 'note_api_failed') original(...args);
  };
  try {
    return await operation();
  } finally {
    console.error = original;
  }
}

const { default: worker } = await moduleFrom('worker/index.ts');
const SECRET = 'local-idempotency-test-key';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9t8AAAAASUVORK5CYII=', 'base64');

test('POST save idempotency protects retries while preserving intentional duplicate saves', async (t) => {
  const mf = new Miniflare(convertV4MiniflareOptions({
    workers: [{
      name: 'idempotency',
      modules: true,
      script: 'export default {fetch(){return new Response("test")}}',
      compatibilityDate: '2026-09-28',
      d1Databases: ['DB'],
      r2Buckets: ['IMAGES'],
    }],
  }));
  t.after(() => mf.dispose());
  const DB = await mf.getD1Database('DB');
  const IMAGES = await mf.getR2Bucket('IMAGES');
  const env = { DB, IMAGES, CAPTURE_API_KEY: SECRET };
  for (const file of (await readdir('migrations')).filter((name) => name.endsWith('.sql')).sort()) {
    const sql = (await readFile('migrations/' + file, 'utf8')).replace(/--[^\n]*/g, '').replace(/\r?\n/g, ' ');
    await DB.exec(sql);
  }
  const call = (path, init = {}, bindings = env) =>
    worker.fetch(new Request('https://local.test' + path, init), bindings);
  const jsonCall = (path, method, body, key, bindings = env) => call(path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(key === undefined ? {} : { 'Idempotency-Key': key }),
    },
    body: JSON.stringify(body),
  }, bindings);
  const count = async (table) => (await DB.prepare('SELECT COUNT(*) AS count FROM ' + table).first()).count;
  const reset = async () => {
    await DB.exec('DELETE FROM api_idempotency; DELETE FROM note_deletions; DELETE FROM notes; DELETE FROM labels; DELETE FROM label_groups;');
  };
  const attachmentCall = (noteId, key, fileBytes = png, filename = 'image.png', bindings = env) =>
    call('/api/notes/' + noteId + '/attachments', {
      method: 'POST',
      headers: {
        'Content-Type': 'image/png',
        'X-File-Name': encodeURIComponent(filename),
        'Idempotency-Key': key,
      },
      body: fileBytes,
    }, bindings);
  const captureForm = (withImage = false) => {
    const form = new FormData();
    form.set('title', 'Captured note');
    form.set('url', 'https://example.com/retry');
    form.set('body', 'capture body');
    form.set('pinned', 'false');
    if (withImage) form.set('image', new File([png], 'capture.png', { type: 'image/png' }));
    return form;
  };
  const captureCall = (key, form, bindings = env) => call('/api/capture', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + SECRET, 'Idempotency-Key': key },
    body: form,
  }, bindings);
  const objectCount = async (prefix) => (await IMAGES.list({ prefix })).objects.length;

  await t.test('new notes replay once, reject changed payloads, and allow new keys for intentional duplicates', async () => {
    await reset();
    const key = crypto.randomUUID();
    const payload = {
      title: 'Same URL',
      body: 'first',
      url: 'https://example.com/repeated',
      labels: ['Idempotency label'],
      checklist: [{ text: 'one item', checked: false }],
    };
    const save = () => jsonCall('/api/notes', 'POST', payload, key);
    const responses = await Promise.all([save(), save()]);
    for (const response of responses) assert.equal(response.status, 201, await response.clone().text());
    const results = await Promise.all(responses.map((response) => response.json()));
    assert.equal(results[0].note.id, results[1].note.id);
    assert.equal(await count('notes'), 1);

    const reordered = await jsonCall('/api/notes', 'POST', {
      url: payload.url,
      title: payload.title,
      body: payload.body,
      checklist: payload.checklist,
      labels: payload.labels,
    }, key);
    assert.equal(reordered.status, 201);
    assert.equal((await reordered.json()).note.id, results[0].note.id);

    const changed = await jsonCall('/api/notes', 'POST', { ...payload, body: 'changed' }, key);
    assert.equal(changed.status, 409);
    const intentionalDuplicate = await jsonCall('/api/notes', 'POST', payload, crypto.randomUUID());
    assert.equal(intentionalDuplicate.status, 201);
    assert.notEqual((await intentionalDuplicate.json()).note.id, results[0].note.id);
    assert.equal(await count('notes'), 2);
    assert.equal(await count('checklist_items'), 2);
    assert.equal(await count('note_labels'), 2);

    const invalidKey = await jsonCall('/api/notes', 'POST', payload, 'not-a-uuid');
    assert.equal(invalidKey.status, 400);
    assert.equal(await count('notes'), 2);
  });

  await t.test('attachment retries share one stable R2 object and never delete the successful upload', async () => {
    await reset();
    const noteResponse = await jsonCall('/api/notes', 'POST', {
      title: 'Attachment parent', body: 'body', url: 'https://example.com/attachment',
    });
    const noteId = (await noteResponse.json()).note.id;
    const key = crypto.randomUUID();
    const responses = await Promise.all([
      attachmentCall(noteId, key),
      attachmentCall(noteId, key),
    ]);
    for (const response of responses) assert.equal(response.status, 201, await response.clone().text());
    const results = await Promise.all(responses.map((response) => response.json()));
    assert.equal(results[0].attachment.id, results[1].attachment.id);
    assert.equal(await count('attachments'), 1);
    assert.equal(await objectCount('notes/' + noteId + '/'), 1);
    assert.equal((await call(results[0].attachment.url)).status, 200);

    const changed = await attachmentCall(noteId, key, Buffer.from('different image'), 'image.png');
    assert.equal(changed.status, 409);
    const intentionalDuplicate = await attachmentCall(noteId, crypto.randomUUID());
    assert.equal(intentionalDuplicate.status, 201);
    assert.notEqual((await intentionalDuplicate.json()).attachment.id, results[0].attachment.id);
    assert.equal(await count('attachments'), 2);
    assert.equal(await objectCount('notes/' + noteId + '/'), 2);
  });

  await t.test('late attachment puts are cleaned after the completed attachment is individually deleted', async () => {
    await reset();
    const noteResponse = await jsonCall('/api/notes', 'POST', {
      title: 'Attachment parent', body: 'body', url: 'https://example.com/late-attachment',
    });
    const noteId = (await noteResponse.json()).note.id;
    let announcePut;
    const putStarted = new Promise((resolve) => { announcePut = resolve; });
    let releasePut;
    const putGate = new Promise((resolve) => { releasePut = resolve; });
    const delayedImages = new Proxy(IMAGES, {
      get(target, property) {
        if (property === 'put') return async (key, value, options) => {
          announcePut();
          await putGate;
          return target.put(key, value, options);
        };
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const key = crypto.randomUUID();
    const delayedSave = attachmentCall(noteId, key, png, 'image.png', { ...env, IMAGES: delayedImages });
    await putStarted;

    const completed = await attachmentCall(noteId, key);
    assert.equal(completed.status, 201, await completed.clone().text());
    const attachmentId = (await completed.json()).attachment.id;
    const removed = await call(`/api/notes/${noteId}/attachments/${attachmentId}`, { method: 'DELETE' });
    assert.equal(removed.status, 200);
    assert.equal(await count('attachments'), 0);
    assert.equal(await objectCount('notes/' + noteId + '/'), 0);

    releasePut();
    const late = await delayedSave;
    assert.equal(late.status, 410, await late.clone().text());
    assert.equal(await count('attachments'), 0);
    assert.equal(await objectCount('notes/' + noteId + '/'), 0);
  });

  await t.test('capture multipart retries ignore boundary changes but retain separate saves under new keys', async () => {
    await reset();
    const key = crypto.randomUUID();
    const responses = await Promise.all([
      captureCall(key, captureForm(true)),
      captureCall(key, captureForm(true)),
    ]);
    for (const response of responses) assert.equal(response.status, 201, await response.clone().text());
    const results = await Promise.all(responses.map((response) => response.json()));
    assert.equal(results[0].note.id, results[1].note.id);
    assert.equal(results[0].note.attachments.length, 1);
    assert.equal(await count('notes'), 1);
    assert.equal(await count('attachments'), 1);
    assert.equal(await objectCount('notes/' + results[0].note.id + '/'), 1);
    assert.equal((await call(results[0].note.attachments[0].url)).status, 200);

    const changed = captureForm(true);
    changed.set('body', 'changed capture');
    assert.equal((await captureCall(key, changed)).status, 409);
    const intentionalDuplicate = await captureCall(crypto.randomUUID(), captureForm(true));
    assert.equal(intentionalDuplicate.status, 201);
    assert.notEqual((await intentionalDuplicate.json()).note.id, results[0].note.id);
    assert.equal(await count('notes'), 2);
    assert.equal(await count('attachments'), 2);
  });

  await t.test('late capture image puts are cleaned after the completed attachment is individually deleted', async () => {
    await reset();
    let announcePut;
    const putStarted = new Promise((resolve) => { announcePut = resolve; });
    let releasePut;
    const putGate = new Promise((resolve) => { releasePut = resolve; });
    const delayedImages = new Proxy(IMAGES, {
      get(target, property) {
        if (property === 'put') return async (key, value, options) => {
          announcePut();
          await putGate;
          return target.put(key, value, options);
        };
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const key = crypto.randomUUID();
    const delayedSave = captureCall(key, captureForm(true), { ...env, IMAGES: delayedImages });
    await putStarted;

    const completed = await captureCall(key, captureForm(true));
    assert.equal(completed.status, 201, await completed.clone().text());
    const note = (await completed.json()).note;
    const attachmentId = note.attachments[0].id;
    const removed = await call(`/api/notes/${note.id}/attachments/${attachmentId}`, { method: 'DELETE' });
    assert.equal(removed.status, 200);
    assert.equal(await count('attachments'), 0);
    assert.equal(await objectCount('notes/' + note.id + '/'), 0);

    releasePut();
    const late = await delayedSave;
    assert.equal(late.status, 201, await late.clone().text());
    assert.deepEqual((await late.json()).note.attachments, []);
    assert.equal(await count('notes'), 1);
    assert.equal(await count('attachments'), 0);
    assert.equal(await objectCount('notes/' + note.id + '/'), 0);
  });

  await t.test('capture resumes after an R2 write succeeds but its response is lost', async () => {
    await reset();
    let failAfterPut = true;
    const images = new Proxy(IMAGES, {
      get(target, property) {
        if (property === 'put') return async (key, value, options) => {
          const result = await target.put(key, value, options);
          if (failAfterPut) {
            failAfterPut = false;
            throw new Error('injected lost R2 response');
          }
          return result;
        };
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const failingEnv = { ...env, IMAGES: images };
    const key = crypto.randomUUID();
    const failed = await withoutExpectedWorkerErrorLog(() => captureCall(key, captureForm(true), failingEnv));
    assert.ok(failed.status >= 500, await failed.text());
    assert.equal(await count('notes'), 0);
    assert.equal(await count('attachments'), 0);
    const reservation = await DB.prepare('SELECT resource_id, secondary_resource_id, state FROM api_idempotency WHERE idempotency_key = ?')
      .bind(key).first();
    assert.equal(reservation.state, 'pending');
    assert.equal(await objectCount('notes/' + reservation.resource_id + '/'), 1);

    const retried = await captureCall(key, captureForm(true));
    assert.equal(retried.status, 201, await retried.clone().text());
    const note = (await retried.json()).note;
    assert.equal(note.id, reservation.resource_id);
    assert.equal(note.attachments[0].id, reservation.secondary_resource_id);
    assert.equal(await count('notes'), 1);
    assert.equal(await count('attachments'), 1);
    assert.equal(await objectCount('notes/' + note.id + '/'), 1);
  });

  await t.test('capture resumes after R2 succeeds and a D1 batch fails before commit', async () => {
    await reset();
    let failBatch = true;
    const database = new Proxy(DB, {
      get(target, property) {
        if (property === 'batch') return async (statements) => {
          if (failBatch) {
            failBatch = false;
            throw new Error('injected D1 batch failure');
          }
          return target.batch(statements);
        };
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const failingEnv = { ...env, DB: database };
    const key = crypto.randomUUID();
    const failed = await withoutExpectedWorkerErrorLog(() => captureCall(key, captureForm(true), failingEnv));
    assert.ok(failed.status >= 500, await failed.text());
    assert.equal(await count('notes'), 0);
    assert.equal(await count('attachments'), 0);
    const reservation = await DB.prepare('SELECT resource_id, secondary_resource_id, state FROM api_idempotency WHERE idempotency_key = ?')
      .bind(key).first();
    assert.equal(reservation.state, 'pending');
    assert.equal(await objectCount('notes/' + reservation.resource_id + '/'), 1);

    const retried = await captureCall(key, captureForm(true));
    assert.equal(retried.status, 201, await retried.clone().text());
    const note = (await retried.json()).note;
    assert.equal(note.id, reservation.resource_id);
    assert.equal(note.attachments[0].id, reservation.secondary_resource_id);
    assert.equal(await count('notes'), 1);
    assert.equal(await count('attachments'), 1);
    assert.equal(await objectCount('notes/' + note.id + '/'), 1);
  });

  await t.test('pending attachment retry after permanent parent deletion cleans its partial R2 object', async () => {
    await reset();
    const noteResponse = await jsonCall('/api/notes', 'POST', {
      title: 'Deleted parent', body: 'body', url: 'https://example.com/deleted-parent',
    });
    const noteId = (await noteResponse.json()).note.id;
    let failAfterPut = true;
    const images = new Proxy(IMAGES, {
      get(target, property) {
        if (property === 'put') return async (key, value, options) => {
          const result = await target.put(key, value, options);
          if (failAfterPut) {
            failAfterPut = false;
            throw new Error('injected lost attachment response');
          }
          return result;
        };
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const key = crypto.randomUUID();
    const failed = await withoutExpectedWorkerErrorLog(() =>
      attachmentCall(noteId, key, png, 'image.png', { ...env, IMAGES: images }));
    assert.ok(failed.status >= 500, await failed.text());
    const reservation = await DB.prepare('SELECT resource_id FROM api_idempotency WHERE idempotency_key = ?').bind(key).first();
    assert.equal(await objectCount('notes/' + noteId + '/'), 1);
    await call('/api/notes/' + noteId, { method: 'DELETE' });
    await call('/api/notes/' + noteId + '/permanent', { method: 'DELETE' });

    const retried = await attachmentCall(noteId, key);
    assert.equal(retried.status, 404);
    assert.equal(await objectCount('notes/' + noteId + '/'), 0);
    assert.equal(await count('attachments'), 0);
    assert.equal(reservation.resource_id.length, 36);
  });

  await t.test('completed note keys remain tombstoned after permanent deletion', async () => {
    await reset();
    const key = crypto.randomUUID();
    const payload = { title: 'Deleted note', body: 'body', url: 'https://example.com/deleted' };
    const created = await jsonCall('/api/notes', 'POST', payload, key);
    const noteId = (await created.json()).note.id;
    await call('/api/notes/' + noteId, { method: 'DELETE' });
    await call('/api/notes/' + noteId + '/permanent', { method: 'DELETE' });

    const retried = await jsonCall('/api/notes', 'POST', payload, key);
    assert.equal(retried.status, 410);
    assert.equal(await count('notes'), 0);
    const record = await DB.prepare('SELECT state, resource_id FROM api_idempotency WHERE idempotency_key = ?').bind(key).first();
    assert.equal(record.state, 'completed');
    assert.equal(record.resource_id, noteId);
  });
});
