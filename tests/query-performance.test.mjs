import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { test } from 'node:test';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

const NOTES = 1600;
const REPEATED_URL = 'https://example.com/repeated-capture';
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

async function applyMigrations(DB, files) {
  for (const file of files) {
    const sql = (await readFile(`migrations/${file}`, 'utf8')).replace(/--[^\n]*/g, '').replace(/\r?\n/g, ' ');
    await DB.exec(sql);
  }
}

async function seedNotes(DB) {
  await DB.prepare("INSERT INTO labels (name_key, name) VALUES ('performance', 'Performance')").run();
  const unixStart = 1577836800;
  await DB.prepare(`WITH RECURSIVE numbers(i) AS (
      SELECT 0 UNION ALL SELECT i + 1 FROM numbers WHERE i < ${NOTES - 1}
    )
    INSERT INTO notes (id, title, body, url, pinned, archived, deleted_at, created_at, updated_at)
    SELECT printf('perf-%04d', i),
      CASE WHEN i % 97 = 0 THEN printf('needle title %d', i) ELSE printf('note %d', i) END,
      CASE WHEN i % 193 = 0 THEN printf('body with needle %d', i) ELSE printf('body %d', i) END,
      CASE WHEN i % 17 = 0 THEN '${REPEATED_URL}' ELSE printf('https://example.com/note/%d', i) END,
      i % 3 = 0, i % 7 = 0,
      CASE WHEN i % 19 = 0 THEN strftime('%Y-%m-%dT%H:%M:%fZ', ${unixStart} + i * 3600 + (i % 12) * 3600 + 1, 'unixepoch') END,
      strftime('%Y-%m-%dT%H:%M:%fZ', ${unixStart} + i * 3600, 'unixepoch'),
      strftime('%Y-%m-%dT%H:%M:%fZ', ${unixStart} + i * 3600 + (i % 12) * 3600, 'unixepoch')
    FROM numbers`).run();
  await DB.prepare(`WITH RECURSIVE numbers(i) AS (
      SELECT 0 UNION ALL SELECT i + 1 FROM numbers WHERE i < ${NOTES - 1}
    )
    INSERT INTO note_labels (note_id, label_key)
    SELECT printf('perf-%04d', i), 'performance' FROM numbers WHERE i % 10 = 0`).run();
  await DB.prepare(`WITH RECURSIVE numbers(i) AS (
      SELECT 0 UNION ALL SELECT i + 1 FROM numbers WHERE i < ${NOTES - 1}
    )
    INSERT INTO note_deletions (note_id, r2_keys)
    SELECT printf('perf-%04d', i), '[]' FROM numbers WHERE i % 34 = 0`).run();
}

function listCases({ addPinnedDateGuard = false } = {}) {
  const start = Date.parse('2020-01-01T00:00:00.000Z');
  const narrowFrom = new Date(start + 800 * HOUR_MS).toISOString().slice(0, 10) + 'T00:00:00.000Z';
  const narrowBefore = new Date(Date.parse(narrowFrom) + DAY_MS).toISOString();
  const wideFrom = '2019-01-01T00:00:00.000Z';
  const wideBefore = '2030-01-01T00:00:00.000Z';
  const views = {
    active: { where: 'deleted_at IS NULL AND archived = ?', bindings: [0], pinSort: true },
    pinned: { where: 'deleted_at IS NULL AND archived = 0 AND pinned = 1', bindings: [], pinSort: false },
    unpinned: { where: 'deleted_at IS NULL AND archived = 0 AND pinned = 0', bindings: [], pinSort: false },
    archived: { where: 'deleted_at IS NULL AND archived = ?', bindings: [1], pinSort: true },
    trash: { where: 'deleted_at IS NOT NULL', bindings: [], pinSort: false },
  };
  const sorts = [
    { column: 'created_at', direction: 'ASC' }, { column: 'created_at', direction: 'DESC' },
    { column: 'updated_at', direction: 'ASC' }, { column: 'updated_at', direction: 'DESC' },
  ];
  const cases = [];
  for (const [view, config] of Object.entries(views)) {
    for (const sort of sorts) {
      for (const [range, from, before] of [['narrow', narrowFrom, narrowBefore], ['wide', wideFrom, wideBefore]]) {
        const where = [config.where, `${sort.column} >= ?`, `${sort.column} < ?`];
        if (addPinnedDateGuard && (view === 'active' || view === 'archived')) where.push('pinned IN (0, 1)');
        const bindings = [...config.bindings, from, before];
        const order = `${config.pinSort ? 'pinned DESC, ' : ''}${sort.column} ${sort.direction}, id ${sort.direction}`;
        cases.push({
          key: `${view}-${sort.column}-${sort.direction.toLowerCase()}-${range}`,
          sql: `SELECT id, updated_at FROM notes WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT 51`,
          bindings,
        });
      }
    }
  }

  for (const [range, from, before] of [['narrow', narrowFrom, narrowBefore], ['wide', wideFrom, wideBefore]]) {
    cases.push({
      key: `active-created-filter-updated-desc-${range}`,
      sql: `SELECT id, updated_at FROM notes WHERE deleted_at IS NULL AND archived = ?
        AND created_at >= ? AND created_at < ? ORDER BY pinned DESC, updated_at DESC, id DESC LIMIT 51`,
      bindings: [0, from, before],
    });
    cases.push({
      key: `active-updated-filter-created-desc-${range}`,
      sql: `SELECT id, updated_at FROM notes WHERE deleted_at IS NULL AND archived = ?
        AND updated_at >= ? AND updated_at < ? ORDER BY pinned DESC, created_at DESC, id DESC LIMIT 51`,
      bindings: [0, from, before],
    });
  }

  cases.push({
    key: 'active-updated_at-desc-no-date',
    sql: `SELECT id, updated_at FROM notes WHERE deleted_at IS NULL AND archived = ?
      ORDER BY pinned DESC, updated_at DESC, id DESC LIMIT 51`,
    bindings: [0],
  });
  cases.push({
    key: 'active-created_at-desc-no-date',
    sql: `SELECT id, updated_at FROM notes WHERE deleted_at IS NULL AND archived = ?
      ORDER BY pinned DESC, created_at DESC, id DESC LIMIT 51`,
    bindings: [0],
  });

  const activeWhere = 'deleted_at IS NULL AND archived = 0';
  const narrowBounds = [`created_at >= ?`, `created_at < ?`];
  for (const [key, extra, extraBindings] of [
    ['search', '(instr(lower(title), lower(?)) > 0 OR instr(lower(body), lower(?)) > 0 OR instr(lower(url), lower(?)) > 0)', ['needle', 'needle', 'needle']],
    ['label', 'EXISTS (SELECT 1 FROM note_labels nl WHERE nl.note_id = notes.id AND nl.label_key = ?)', ['performance']],
  ]) {
    const conditions = [activeWhere, ...narrowBounds];
    if (addPinnedDateGuard) conditions.push('pinned IN (0, 1)');
    conditions.push(extra);
    const bindings = [narrowFrom, narrowBefore, ...extraBindings];
    cases.push({
      key: `active-created-desc-narrow-${key}`,
      sql: `SELECT id, updated_at FROM notes WHERE ${conditions.join(' AND ')} ORDER BY pinned DESC, created_at DESC, id DESC LIMIT 51`,
      bindings,
    });
  }

  // A label filter intentionally includes archived notes in noteListFilter.
  cases.push({
    key: 'labeled-created-desc-narrow',
    sql: `SELECT id, updated_at FROM notes WHERE deleted_at IS NULL AND created_at >= ? AND created_at < ?
      ${addPinnedDateGuard ? 'AND pinned IN (0, 1)' : ''}
      AND EXISTS (SELECT 1 FROM note_labels nl WHERE nl.note_id = notes.id AND nl.label_key = ?)
      ORDER BY pinned DESC, created_at DESC, id DESC LIMIT 51`,
    bindings: [narrowFrom, narrowBefore, 'performance'],
  });

  return cases;
}

async function measureAll(DB, cases) {
  const measurements = [];
  for (let offset = 0; offset < cases.length; offset += 15) {
    const chunk = cases.slice(offset, offset + 15);
    const statements = chunk.flatMap(({ sql, bindings }) => [
      DB.prepare(sql).bind(...bindings),
      DB.prepare(`EXPLAIN QUERY PLAN ${sql}`).bind(...bindings),
    ]);
    const results = await DB.batch(statements);
    for (let index = 0; index < chunk.length; index += 1) {
      const result = results[index * 2];
      const plan = results[index * 2 + 1];
      measurements.push({
        key: chunk[index].key,
        results: result.results,
        rowsRead: result.meta?.rows_read,
        plan: (plan.results ?? []).map((row) => row.detail),
      });
    }
  }
  return measurements;
}

test('D1 note-list date and exact-URL indexes reduce selective reads without changing results', async (t) => {
  const mf = new Miniflare(convertV4MiniflareOptions({ workers: [{
    name: 'query-performance', modules: true,
    script: 'export default {fetch(){return new Response("test")}}',
    compatibilityDate: '2026-09-28', d1Databases: ['DB'],
  }] }));
  t.after(() => mf.dispose());
  const DB = await mf.getD1Database('DB');
  const migrationFiles = (await readdir('migrations')).filter((file) => /^\d{4}_.*\.sql$/.test(file)
    && Number(file.slice(0, 4)) >= 1 && Number(file.slice(0, 4)) <= 8).sort();
  await applyMigrations(DB, migrationFiles);
  await seedNotes(DB);

  const currentCases = listCases();
  const indexedCases = listCases({ addPinnedDateGuard: true });
  for (const cases of [currentCases, indexedCases]) {
    cases.push({
      key: 'exact-url',
      sql: `SELECT id, title, archived, deleted_at FROM notes WHERE url = ?
        AND NOT EXISTS (SELECT 1 FROM note_deletions WHERE note_id = notes.id)
        ORDER BY updated_at DESC, id DESC LIMIT 6`,
      bindings: [REPEATED_URL],
    });
  }
  const before = await measureAll(DB, currentCases);

  await applyMigrations(DB, ['0009_query_indexes.sql']);

  const after = await measureAll(DB, indexedCases);
  const beforeByKey = new Map(before.map((result) => [result.key, result]));
  const afterByKey = new Map(after.map((result) => [result.key, result]));
  const diagnostics = currentCases.map(({ key }) => {
    const oldResult = beforeByKey.get(key);
    const newResult = afterByKey.get(key);
    return [key, oldResult.rowsRead, newResult.rowsRead];
  });
  t.diagnostic(`rows_read [query, current, indexed]: ${JSON.stringify(diagnostics)}`);
  const keyPlans = ['active-created_at-desc-narrow', 'active-updated_at-desc-narrow', 'archived-created_at-desc-narrow', 'archived-updated_at-desc-narrow', 'active-created-filter-updated-desc-narrow', 'active-created-filter-updated-desc-wide', 'active-updated_at-desc-no-date', 'active-created_at-desc-no-date', 'exact-url'];
  t.diagnostic(`selected plans: ${JSON.stringify(keyPlans.map((key) => [key, beforeByKey.get(key).plan, afterByKey.get(key).plan]))}`);
  for (const query of currentCases) {
    const oldResult = beforeByKey.get(query.key);
    const newResult = afterByKey.get(query.key);
    assert.deepEqual(newResult.results, oldResult.results, `${query.key} result order/content changed`);
    assert.equal(typeof oldResult.rowsRead, 'number', `${query.key} did not report baseline rows_read`);
    assert.equal(typeof newResult.rowsRead, 'number', `${query.key} did not report indexed rows_read`);
  }

  for (const [key, indexName] of [
    ['active-created_at-desc-narrow', 'notes_created_range_idx'],
    ['active-updated_at-desc-narrow', 'notes_trash_idx'],
    ['archived-created_at-desc-narrow', 'notes_created_range_idx'],
    ['archived-updated_at-desc-narrow', 'notes_trash_idx'],
    ['exact-url', 'notes_url_recent_idx'],
  ]) {
    const oldResult = beforeByKey.get(key);
    const newResult = afterByKey.get(key);
    assert.ok(newResult.plan.some((detail) => detail.includes(indexName)), `${key} did not choose ${indexName}: ${newResult.plan}`);
    assert.ok(newResult.rowsRead < oldResult.rowsRead,
      `${key} rows_read did not fall: ${oldResult.rowsRead} -> ${newResult.rowsRead}`);
  }

  const defaultListBefore = beforeByKey.get('active-updated_at-desc-no-date');
  const defaultListAfter = afterByKey.get('active-updated_at-desc-no-date');
  assert.ok(defaultListAfter.rowsRead <= defaultListBefore.rowsRead,
    `default active list rows_read regressed: ${defaultListBefore.rowsRead} -> ${defaultListAfter.rowsRead}`);
  const createdListBefore = beforeByKey.get('active-created_at-desc-no-date');
  const createdListAfter = afterByKey.get('active-created_at-desc-no-date');
  assert.ok(createdListAfter.rowsRead <= createdListBefore.rowsRead,
    `no-date created-sorted list rows_read regressed: ${createdListBefore.rowsRead} -> ${createdListAfter.rowsRead}`);
  const crossSortWideBefore = beforeByKey.get('active-created-filter-updated-desc-wide');
  const crossSortWideAfter = afterByKey.get('active-created-filter-updated-desc-wide');
  assert.ok(crossSortWideAfter.rowsRead <= crossSortWideBefore.rowsRead + 4,
    `wide created-filter/updated-sort rows_read regressed: ${crossSortWideBefore.rowsRead} -> ${crossSortWideAfter.rowsRead}`);
  for (const query of currentCases.filter(({ key }) => key.endsWith('-wide'))) {
    const oldResult = beforeByKey.get(query.key);
    const newResult = afterByKey.get(query.key);
    assert.ok(newResult.rowsRead <= oldResult.rowsRead + 4,
      `${query.key} broad-range rows_read regressed: ${oldResult.rowsRead} -> ${newResult.rowsRead}`);
  }
});
