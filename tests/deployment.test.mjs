import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { checkMigrations, verifyMigrations } from '../scripts/check-migrations.mjs';

const expected = ['0001_notes.sql', '0002_attachments.sql'];
const result = names => JSON.stringify([{ success: true, results: names.map(name => ({ name })) }]);

test('matching production schema passes regardless of row order', () => {
  assert.equal(verifyMigrations(expected, result([...expected].reverse())), 2);
});

test('missing migrations and older checkouts stop deployment', () => {
  assert.throws(() => verifyMigrations(expected, result([expected[0]])), /Not applied: 0002_attachments.sql/);
  assert.throws(() => verifyMigrations([expected[0]], result(expected)), /Only in production: 0002_attachments.sql/);
});

test('failed, missing, malformed or duplicate responses fail closed', () => {
  for (const output of ['not JSON', 'null', '[]', '{}', '[{"success":false,"results":[]}]',
    '[{"success":true,"results":[{}]}]', result([expected[0], expected[0]]), result([])]) {
    assert.throws(() => verifyMigrations(expected, output));
  }
  assert.throws(() => verifyMigrations([], result([])));
});

test('check issues one read-only SELECT against the configured production DB', async () => {
  let calls = 0;
  const message = await checkMigrations(async (program, args, options) => {
    calls++;
    assert.equal(program, process.execPath);
    assert.equal(args[0].replaceAll('\\', '/').endsWith('/node_modules/wrangler/bin/wrangler.js'), true);
    assert.deepEqual(args.slice(1, 4), ['d1', 'execute', 'DB']);
    assert.equal(args[args.indexOf('--command') + 1], 'SELECT name FROM d1_migrations ORDER BY name');
    assert.ok(args.includes('--remote') && args.includes('--json'));
    assert.equal(args.includes('apply'), false);
    assert.equal(options.timeout, 60_000);
    assert.equal(options.env.CI, 'true');
    return { stdout: result(expected) };
  }, async () => [...expected, 'README.md']);
  assert.equal(calls, 1);
  assert.match(message, /all 2 migrations match/);
});

test('network and auth failures stop the check without leaking CLI output', async () => {
  await assert.rejects(checkMigrations(async () => { throw new Error('private output'); }, async () => expected),
    error => /Deployment stopped/.test(error.message) && !error.message.includes('private output'));
});

test('supported deployment commands cannot reach Wrangler after a failed check', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.scripts['deploy:checked'], 'npm run db:check && wrangler deploy');
  assert.equal(pkg.scripts.deploy, 'npm run build && npm run deploy:checked');
});
