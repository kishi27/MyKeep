// Small, resumable batches: never build a ZIP or buffer attachment bodies in a Worker.
const DAY = 86_400_000;
const STATE_KEY = "progress.json";
const LEASE_MS = 16 * 60_000; // Longer than the 15-minute Cron invocation limit.
const TABLES = ["notes", "attachments", "checklist_items", "labels", "label_groups", "note_labels"] as const;
const PAGE_SIZE = 200;
const FILE_BATCH = 15;

interface BackupEnv {
  DB: D1Database;
  IMAGES: R2Bucket;
  BACKUPS?: R2Bucket;
  AUTOMATIC_BACKUP_ENABLED?: string;
}
interface TableProgress { name: string; parts: number; rows: number }
interface Progress {
  version: 1;
  day: string;
  snapshot: string;
  started_at: string;
  phase: "start" | "tables" | "files" | "complete" | "failed";
  revision: number;
  table: number;
  after: number;
  tables: TableProgress[];
  attachments: number;
  attachment_bytes: number;
  attempts: number;
  errors: number;
  retryAt: number;
  leaseUntil: number;
  cleaned: boolean;
  cleanupCursor?: string;
}
interface Latest { snapshot: string; completed_at: string }
const snapshotPattern = /^\d{4}-\d{2}-\d{2}-[a-f0-9-]{36}$/;
const root = (snapshot: string) => `daily/${snapshot}/`;
const partKey = (state: Progress, name: string, part: number) => `${root(state.snapshot)}${name}/${String(part).padStart(6, "0")}.json`;

export const automaticBackupEnabled = (env: BackupEnv): boolean => env.AUTOMATIC_BACKUP_ENABLED === "true";

async function jsonObject<T>(bucket: R2Bucket, key: string): Promise<{ value: T; etag: string } | null> {
  const object = await bucket.get(key);
  if (!object) return null;
  if (object.size > 64 * 1024) { await object.body.cancel(); throw new Error("backup_control_object_too_large"); }
  return { value: await object.json<T>(), etag: object.etag };
}

async function checkpoint(env: BackupEnv): Promise<number> {
  const row = await env.DB.prepare(`SELECT revision,
    EXISTS(SELECT 1 FROM note_deletions) AS deleting FROM data_revision WHERE id = 1`)
    .first<{ revision: number; deleting: number }>();
  if (!row || !Number.isSafeInteger(row.revision) || row.revision < 0 || row.deleting) {
    throw new Error("backup_waiting_for_consistent_data");
  }
  return row.revision;
}

function validProgress(value: Progress): boolean {
  return value?.version === 1 && snapshotPattern.test(value.snapshot)
    && /^\d{4}-\d{2}-\d{2}$/.test(value.day)
    && ["start", "tables", "files", "complete", "failed"].includes(value.phase)
    && Array.isArray(value.tables) && value.tables.length === TABLES.length
    && value.tables.every((table, i) => table.name === TABLES[i]
      && Number.isSafeInteger(table.parts) && table.parts >= 0 && Number.isSafeInteger(table.rows) && table.rows >= 0)
    && [value.table, value.after, value.revision, value.attachments, value.attachment_bytes, value.attempts,
      value.errors, value.retryAt, value.leaseUntil].every(n => Number.isSafeInteger(n) && n >= 0)
    && value.table <= TABLES.length
    && (value.cleanupCursor === undefined || typeof value.cleanupCursor === "string");
}

function newProgress(day: string, now: number, attempts: number): Progress {
  return { version: 1, day, snapshot: `${day}-${crypto.randomUUID()}`, started_at: new Date(now).toISOString(),
    phase: "start", revision: 0, table: 0, after: 0,
    tables: TABLES.map(name => ({ name, parts: 0, rows: 0 })), attachments: 0, attachment_bytes: 0,
    attempts, errors: 0, retryAt: 0, leaseUntil: 0, cleaned: false };
}

async function copyTable(env: BackupEnv, state: Progress): Promise<void> {
  const table = TABLES[state.table];
  if (!table) throw new Error("backup_invalid_table");
  // Table names are constants; rowid avoids OFFSET scans and also handles composite keys.
  const rows = (await env.DB.prepare(`SELECT rowid AS __backup_rowid, * FROM ${table}
    WHERE rowid > ? ORDER BY rowid LIMIT ?`).bind(state.after, PAGE_SIZE).all<Record<string, unknown>>()).results;
  if (rows.length) {
    const after = rows[rows.length - 1].__backup_rowid;
    if (!Number.isSafeInteger(after) || (after as number) <= state.after) throw new Error("backup_invalid_cursor");
    const page = rows.map(({ __backup_rowid: _rowid, ...row }) => row);
    const info = state.tables[state.table];
    await env.BACKUPS!.put(partKey(state, table, info.parts + 1), JSON.stringify(page), {
      httpMetadata: { contentType: "application/json" },
    });
    info.parts++;
    info.rows += rows.length;
    state.after = after as number;
  }
  if (rows.length < PAGE_SIZE) {
    state.table++;
    state.after = 0;
    if (state.table === TABLES.length) state.phase = "files";
  }
}

async function copyFiles(env: BackupEnv, state: Progress): Promise<boolean> {
  const rows = (await env.DB.prepare(`SELECT rowid AS cursor, id, r2_key FROM attachments
    WHERE rowid > ? ORDER BY rowid LIMIT ?`).bind(state.after, FILE_BATCH)
    .all<{ cursor: number; id: string; r2_key: string }>()).results;
  for (const row of rows) {
    if (!/^[a-f0-9-]{36}$/i.test(row.id)) throw new Error("backup_invalid_attachment_id");
    const object = await env.IMAGES.get(row.r2_key);
    if (!object) throw new Error("backup_attachment_missing");
    // An R2 body carries its known length and streams directly into the private backup bucket.
    await env.BACKUPS!.put(`${root(state.snapshot)}files/${row.id}`, object.body, {
      httpMetadata: object.httpMetadata, customMetadata: { sourceEtag: object.etag },
    });
    state.attachments++;
    state.attachment_bytes += object.size;
    state.after = row.cursor;
  }
  return rows.length < FILE_BATCH;
}

async function pruneOldCopies(bucket: R2Bucket, state: Progress): Promise<void> {
  const latest = (await jsonObject<Latest>(bucket, "latest.json"))?.value;
  if (latest && !snapshotPattern.test(latest.snapshot)) throw new Error("backup_invalid_latest");
  const cutoff = new Date(Date.parse(`${state.day}T00:00:00Z`) - 6 * DAY).toISOString().slice(0, 10);
  // Date-prefixed keys sort oldest first. Only this feature's namespace is eligible.
  const page = await bucket.list({ prefix: "daily/", limit: 100, cursor: state.cleanupCursor });
  let expired = page.objects.filter(o => {
    const snapshot = o.key.split("/")[1];
    return snapshotPattern.test(snapshot) && snapshot.slice(0, 10) < cutoff
      && snapshot !== latest?.snapshot && snapshot !== state.snapshot;
  }).map(o => o.key);
  if (!latest) {
    // Publishing latest.json can fail after the complete manifest was written.
    // Without the pointer, preserve completed snapshots rather than guess which is newest.
    const complete = new Set(page.objects.filter(o => o.key.endsWith('/manifest.json')).map(o => o.key.split('/')[1]));
    for (const snapshot of new Set(expired.map(key => key.split('/')[1]))) {
      if (!complete.has(snapshot) && await bucket.head(`${root(snapshot)}manifest.json`)) complete.add(snapshot);
    }
    expired = expired.filter(key => !complete.has(key.split('/')[1]));
  }
  if (expired.length) await bucket.delete(expired);
  // Continue past a protected latest snapshot; it may fill more than one listing page.
  state.cleanupCursor = page.truncated ? page.cursor : undefined;
  state.cleaned = !page.truncated;
}

export async function hasRecentBackup(env: BackupEnv, now = Date.now()): Promise<boolean> {
  if (!automaticBackupEnabled(env)) return true;
  if (!env.BACKUPS) return false;
  try {
    const latest = (await jsonObject<Latest>(env.BACKUPS, "latest.json"))?.value;
    const completed = Date.parse(latest?.completed_at ?? "");
    if (!latest || !snapshotPattern.test(latest.snapshot) || !Number.isFinite(completed)
      || completed > now || now - completed > 25 * 60 * 60_000) return false;
    const manifest = (await jsonObject<{ status: string; snapshot: string }>(env.BACKUPS, `${root(latest.snapshot)}manifest.json`))?.value;
    return manifest?.status === "complete" && manifest.snapshot === latest.snapshot;
  } catch { return false; }
}

export async function advanceScheduledBackup(env: BackupEnv, now = Date.now()): Promise<void> {
  if (!automaticBackupEnabled(env)) return;
  if (!env.BACKUPS) throw new Error("backup_bucket_not_configured");
  const bucket = env.BACKUPS;
  const saved = await jsonObject<Progress>(bucket, STATE_KEY);
  if (saved && !validProgress(saved.value)) throw new Error("backup_invalid_progress");
  // The daily backup cycle starts at 17:00 UTC (02:00 JST).
  const day = new Date(now - 17 * 60 * 60_000).toISOString().slice(0, 10);
  let state = saved?.value;
  if (state && (state.leaseUntil > now || state.retryAt > now)) return;
  if (!state || state.day !== day || (state.phase === "failed" && state.attempts < 3)) {
    state = newProgress(day, now, state?.day === day ? state.attempts + 1 : 1);
  } else if ((state.phase === "failed" || state.phase === "complete") && state.cleaned) return;
  // An expired lease means the previous invocation did not save progress (e.g. CPU limit).
  if (state.leaseUntil) state.errors++;
  const prior = structuredClone(state);
  state.leaseUntil = now + LEASE_MS;
  const claim = await bucket.put(STATE_KEY, JSON.stringify(state), {
    onlyIf: saved ? { etagMatches: saved.etag } : { etagDoesNotMatch: "*" },
    httpMetadata: { contentType: "application/json" },
  });
  if (!claim) return; // Another Cron invocation owns this batch.
  try {
    if (state.phase === "complete" || state.phase === "failed") {
      await pruneOldCopies(bucket, state);
    } else {
      if (state.errors >= 3) throw new Error("backup_batch_retry_limit");
      const revision = await checkpoint(env);
      if (state.phase === "start") {
        state.revision = revision;
        state.phase = "tables";
      } else {
        if (revision !== state.revision) throw new Error("backup_data_changed");
        let complete = false;
        if (state.phase === "tables") await copyTable(env, state);
        else complete = await copyFiles(env, state);
        if (await checkpoint(env) !== state.revision) throw new Error("backup_data_changed");
        if (complete) {
          if (state.attachments !== state.tables[1].rows) throw new Error("backup_attachment_count_mismatch");
          if (Date.now() > state.leaseUntil - 60_000 || (await bucket.head(STATE_KEY))?.etag !== claim.etag) {
            throw new Error("backup_lease_lost");
          }
          const completed_at = new Date(now).toISOString();
          await bucket.put(`${root(state.snapshot)}manifest.json`, JSON.stringify({
            format: "mykeep-scheduled-backup", version: 1, status: "complete", snapshot: state.snapshot,
            started_at: state.started_at, completed_at, revision: state.revision, tables: state.tables,
            attachments: state.attachments, attachment_bytes: state.attachment_bytes,
          }), { httpMetadata: { contentType: "application/json" } });
          await bucket.put("latest.json", JSON.stringify({ snapshot: state.snapshot, completed_at }), {
            httpMetadata: { contentType: "application/json" },
          });
          state.phase = "complete";
          console.log("scheduled_backup_complete", state.snapshot, state.tables[0].rows, state.attachments);
        }
      }
    }
    state.errors = 0;
    state.retryAt = 0;
  } catch (error) {
    // Retry the entire batch, not only its tail, when its writes succeeded but progress did not.
    state = prior;
    state.errors++;
    if (prior.phase !== "complete" && prior.phase !== "failed"
      && ((error instanceof Error && error.message === "backup_data_changed") || state.errors >= 3)) state.phase = "failed";
    state.retryAt = now + 5 * 60_000;
    console.error("scheduled_backup_incomplete", state.snapshot, error instanceof Error ? error.message : "storage_error");
  }
  state.leaseUntil = 0;
  await bucket.put(STATE_KEY, JSON.stringify(state), {
    onlyIf: { etagMatches: claim.etag }, httpMetadata: { contentType: "application/json" },
  });
}
