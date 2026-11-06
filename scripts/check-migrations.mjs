import { execFile } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function verifyMigrations(expected, output) {
  let response;
  try { response = JSON.parse(output); } catch {
    throw new Error('Could not read the production D1 migration list. Deployment stopped.');
  }
  if (!Array.isArray(response) || response.length !== 1 || response[0]?.success !== true
    || !Array.isArray(response[0].results)
    || !response[0].results.every(row => typeof row?.name === 'string' && row.name.endsWith('.sql'))) {
    throw new Error('Invalid production D1 migration response. Deployment stopped.');
  }
  const applied = response[0].results.map(row => row.name);
  if (!expected.length || new Set(applied).size !== applied.length) {
    throw new Error('Empty local migration list or duplicate production migrations. Deployment stopped.');
  }
  const missing = expected.filter(name => !applied.includes(name));
  const extra = applied.filter(name => !expected.includes(name));
  if (missing.length || extra.length) {
    throw new Error(`D1 schema does not match this checkout. Deployment stopped.\n`
      + (missing.length ? `Not applied: ${missing.join(', ')}\n` : '')
      + (extra.length ? `Only in production: ${extra.join(', ')}\n` : '')
      + 'Review migrations and obtain approval before changing production D1; then retry deployment.');
  }
  return applied.length;
}

export async function checkMigrations(execute = run, list = readdir) {
  const files = (await list(resolve(root, 'migrations'))).filter(name => name.endsWith('.sql')).sort();
  // SELECT only: never apply migrations or create the migrations table here.
  let stdout;
  try {
    ({ stdout } = await execute(process.execPath, [
      resolve(root, 'node_modules/wrangler/bin/wrangler.js'),
      'd1', 'execute', 'DB', '--config', resolve(root, 'wrangler.jsonc'), '--remote',
      '--command', 'SELECT name FROM d1_migrations ORDER BY name', '--json',
    ], { cwd: root, timeout: 60_000, maxBuffer: 1024 * 1024, windowsHide: true,
      env: { ...process.env, CI: 'true', WRANGLER_SEND_METRICS: 'false' } }));
  } catch {
    // Do not print CLI output which may contain account details or credentials.
    throw new Error('Production D1 check failed (credentials, network, or migration table). Deployment stopped; no migration was applied.');
  }
  const count = verifyMigrations(files, stdout);
  return `D1 check passed: all ${count} migrations match. No database changes were made.`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { console.log(await checkMigrations()); } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
