import {
  BackupFormatError,
  parseBackupNote,
} from "../src/backupFormat";
import type { BackupAttachment, BackupGroup, BackupMembership, BackupNote } from "../src/backupFormat";

const MAX_METADATA_BYTES = 128 * 1024;
const MAX_NOTE_BYTES = 8 * 1024 * 1024;
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const MAX_ATTACHMENT_REQUEST_BYTES = MAX_NOTE_BYTES + MAX_ATTACHMENT_BYTES + 256 * 1024;
const MAX_GROUP_BATCH = 10;
const MAX_MEMBERSHIP_BATCH = 50;
const TRASH_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MIME_TYPE_PATTERN = /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i;
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif", "image/avif"]);
const RECEIPT_PREFIX = "backup-restore-receipts";

interface RestoreNoteRow {
  id: string;
  title: string;
  body: string;
  url: string;
  pinned: number;
  archived: number;
  color: string;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
  preview_title: string;
  preview_description: string;
  preview_image: string;
  preview_hostname: string;
  card_image: string;
}

interface RestoreChecklistRow {
  id: string;
  position: number;
  text: string;
  checked: number;
}

interface RestoreLabelRow {
  name_key: string;
  name: string;
  group_id: string | null;
}

interface RestoreAttachmentRow {
  id: string;
  note_id: string;
  filename: string;
  mime_type: string;
  r2_key: string;
  created_at: string;
}

interface RestoreReceipt {
  version: 1;
  note_id: string;
  fingerprint: string;
  card_image: string;
}

function isRestoreReceipt(value: unknown): value is RestoreReceipt {
  return isRecord(value) && value.version === 1 && typeof value.note_id === "string"
    && typeof value.fingerprint === "string" && typeof value.card_image === "string";
}

const SELECT_NOTE = `SELECT id, title, body, url, pinned, archived, color, deleted_at,
  created_at, updated_at, preview_title, preview_description, preview_image, preview_hostname, card_image
  FROM notes WHERE id = ?`;

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

function labelKey(value: string): string {
  return value.trim().normalize("NFC").toLowerCase();
}

function groupName(value: unknown): string | null {
  if (typeof value !== "string" || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) return null;
  const name = value.trim().normalize("NFC");
  return name && name.length <= 100 ? name : null;
}

function labelName(value: unknown): string | null {
  if (typeof value !== "string" || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) return null;
  const name = value.trim().normalize("NFC");
  return name && name.length <= 100 ? name : null;
}

async function readBytes(request: Request, maxBytes: number): Promise<Uint8Array> {
  const reader = request.body?.getReader();
  if (!reader) throw new Error("empty_body");
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new Error("body_too_large");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function readJson(request: Request, limit = MAX_METADATA_BYTES): Promise<unknown> {
  const declared = Number(request.headers.get("Content-Length") ?? "0");
  if (Number.isFinite(declared) && declared > limit) throw new Error("body_too_large");
  const bytes = await readBytes(request, limit);
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    throw new Error("invalid_json");
  }
}

function parseGroups(value: unknown): BackupGroup[] {
  if (!isRecord(value) || !Array.isArray(value.groups) || value.groups.length > MAX_GROUP_BATCH) throw new Error("invalid_groups");
  const ids = new Set<string>();
  const names = new Set<string>();
  return value.groups.map((entry) => {
    if (!isRecord(entry) || !isUuid(entry.id)) throw new Error("invalid_groups");
    const name = groupName(entry.name);
    if (!name || ids.has(entry.id.toLowerCase()) || names.has(labelKey(name))) throw new Error("invalid_groups");
    ids.add(entry.id.toLowerCase());
    names.add(labelKey(name));
    return { id: entry.id.toLowerCase(), name };
  });
}

function parseMemberships(value: unknown): BackupMembership[] {
  if (!isRecord(value) || !Array.isArray(value.memberships) || value.memberships.length > MAX_MEMBERSHIP_BATCH) {
    throw new Error("invalid_memberships");
  }
  const names = new Set<string>();
  return value.memberships.map((entry) => {
    if (!isRecord(entry)) throw new Error("invalid_memberships");
    const name = labelName(entry.label_name);
    if (!name || names.has(labelKey(name))) throw new Error("invalid_memberships");
    const groupId = entry.group_id;
    if (groupId !== null && !isUuid(groupId)) throw new Error("invalid_memberships");
    names.add(labelKey(name));
    return { label_name: name, group_id: groupId === null ? null : groupId.toLowerCase() };
  });
}

async function restoreGroups(request: Request, env: Env): Promise<Response> {
  const groups = parseGroups(await readJson(request));
  const groupMap: Record<string, string> = {};
  let created = 0;
  let reused = 0;
  let conflicts = 0;

  for (const group of groups) {
    const nameKey = labelKey(group.name);
    const sameId = await env.DB.prepare("SELECT name_key FROM label_groups WHERE id = ?")
      .bind(group.id).first<{ name_key: string }>();
    if (sameId && sameId.name_key !== nameKey) conflicts += 1;
    const sameName = await env.DB.prepare("SELECT id FROM label_groups WHERE name_key = ?")
      .bind(nameKey).first<{ id: string }>();
    if (sameName) {
      groupMap[group.id] = sameName.id;
      reused += 1;
      continue;
    }

    const destinationId = sameId ? crypto.randomUUID() : group.id;
    const result = await env.DB.prepare(
      "INSERT OR IGNORE INTO label_groups (id, name_key, name) VALUES (?, ?, ?)",
    ).bind(destinationId, nameKey, group.name).run();
    const resolved = await env.DB.prepare("SELECT id FROM label_groups WHERE name_key = ?")
      .bind(nameKey).first<{ id: string }>();
    if (!resolved) throw new Error("group_insert_failed");
    groupMap[group.id] = resolved.id;
    if (result.meta.changes > 0) created += 1;
    else reused += 1;
  }

  return json({ groupMap, created, reused, conflicts });
}

async function restoreLabels(request: Request, env: Env): Promise<Response> {
  const memberships = parseMemberships(await readJson(request));
  if (!memberships.length) return json({ labelsCreated: 0, labelsReused: 0, membershipConflicts: 0 });

  const groupIds = [...new Set(memberships.flatMap((item) => item.group_id ? [item.group_id] : []))];
  if (groupIds.length) {
    const groups = await env.DB.prepare(`SELECT id FROM label_groups WHERE id IN (${groupIds.map(() => "?").join(",")})`)
      .bind(...groupIds).all<{ id: string }>();
    const existingGroups = new Set((groups.results ?? []).map((row) => row.id));
    if (groupIds.some((id) => !existingGroups.has(id))) return json({ error: "group_not_found" }, 409);
  }

  const keys = memberships.map((item) => labelKey(item.label_name));
  const placeholders = keys.map(() => "?").join(",");
  const before = await env.DB.prepare(`SELECT name_key, name, group_id FROM labels WHERE name_key IN (${placeholders})`)
    .bind(...keys).all<RestoreLabelRow>();
  const beforeByKey = new Map((before.results ?? []).map((row) => [row.name_key, row]));
  const missing = memberships.filter((item) => !beforeByKey.has(labelKey(item.label_name)));
  if (missing.length) {
    const statements = missing.map((item) => env.DB.prepare(
      "INSERT OR IGNORE INTO labels (name_key, name, group_id) VALUES (?, ?, ?)",
    ).bind(labelKey(item.label_name), item.label_name, item.group_id));
    await env.DB.batch(statements);
  }

  const after = await env.DB.prepare(`SELECT name_key, name, group_id FROM labels WHERE name_key IN (${placeholders})`)
    .bind(...keys).all<RestoreLabelRow>();
  const afterByKey = new Map((after.results ?? []).map((row) => [row.name_key, row]));
  if (memberships.some((item) => !afterByKey.has(labelKey(item.label_name)))) throw new Error("label_insert_failed");

  let labelsCreated = 0;
  let membershipConflicts = 0;
  for (const item of memberships) {
    const key = labelKey(item.label_name);
    const prior = beforeByKey.get(key);
    const current = afterByKey.get(key)!;
    if (!prior && current.name === item.label_name && current.group_id === item.group_id) labelsCreated += 1;
    if (current.group_id !== item.group_id) membershipConflicts += 1;
  }
  return json({ labelsCreated, labelsReused: memberships.length - labelsCreated, membershipConflicts });
}

function staleTrash(note: BackupNote, now = Date.now()): boolean {
  return note.trashed && note.deleted_at !== null && Date.parse(note.deleted_at) <= now - TRASH_RETENTION_MS;
}

function effectiveDeletedAt(note: BackupNote, now = Date.now()): string | null {
  return staleTrash(note, now) ? null : note.deleted_at;
}

function imageChoice(note: BackupNote): string | null {
  return note.card_image.startsWith("attachment:") ? note.card_image.slice("attachment:".length) : null;
}

function semanticSnapshot(note: BackupNote): unknown {
  return {
    id: note.id,
    title: note.title,
    body: note.body,
    url: note.url,
    color: note.color,
    preview_title: note.preview_title,
    preview_description: note.preview_description,
    preview_image: note.preview_image,
    preview_hostname: note.preview_hostname,
    card_image: note.card_image,
    pinned: note.pinned,
    archived: note.archived,
    trashed: note.trashed,
    deleted_at: note.deleted_at,
    created_at: note.created_at,
    updated_at: note.updated_at,
    checklist: [...note.checklist].sort((a, b) => a.order - b.order).map((item) => ({
      id: item.id, text: item.text, checked: item.checked, order: item.order,
    })),
    labels: [...note.labels].map(labelKey).sort(),
    attachments: [...note.attachments].sort((a, b) => a.id.localeCompare(b.id)).map((attachment) => ({
      id: attachment.id,
      filename: attachment.filename,
      mime_type: attachment.mime_type.toLowerCase(),
      created_at: attachment.created_at,
      zip_path: attachment.zip_path,
    })),
  };
}

async function noteFingerprint(note: BackupNote): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(semanticSnapshot(note)));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function receiptKey(note: BackupNote, fingerprint: string): string {
  return `${RECEIPT_PREFIX}/${note.id}/${fingerprint}.json`;
}

async function readReceipt(note: BackupNote, fingerprint: string, env: Env): Promise<RestoreReceipt | null> {
  const object = await env.IMAGES.get(receiptKey(note, fingerprint));
  if (!object) return null;
  try {
    const value: unknown = JSON.parse(await object.text());
    if (!isRestoreReceipt(value) || value.note_id !== note.id
      || value.fingerprint !== fingerprint || value.card_image !== note.card_image) return null;
    return value;
  } catch {
    return null;
  }
}

async function writeReceipt(note: BackupNote, fingerprint: string, env: Env): Promise<boolean> {
  const key = receiptKey(note, fingerprint);
  const existing = await env.IMAGES.get(key);
  if (existing) return !!await readReceipt(note, fingerprint, env);
  const receipt: RestoreReceipt = { version: 1, note_id: note.id, fingerprint, card_image: note.card_image };
  await env.IMAGES.put(key, JSON.stringify(receipt), { httpMetadata: { contentType: "application/json" } });
  return !!await readReceipt(note, fingerprint, env);
}

async function getExistingNote(id: string, env: Env): Promise<RestoreNoteRow | null> {
  return await env.DB.prepare(SELECT_NOTE).bind(id).first<RestoreNoteRow>();
}

async function currentRelations(noteId: string, env: Env): Promise<{
  checklist: RestoreChecklistRow[];
  labels: RestoreLabelRow[];
  attachments: RestoreAttachmentRow[];
}> {
  const [checklist, labels, attachments] = await Promise.all([
    env.DB.prepare("SELECT id, position, text, checked FROM checklist_items WHERE note_id = ? ORDER BY position, id")
      .bind(noteId).all<RestoreChecklistRow>(),
    env.DB.prepare("SELECT l.name_key, l.name, l.group_id FROM note_labels nl JOIN labels l ON l.name_key = nl.label_key WHERE nl.note_id = ?")
      .bind(noteId).all<RestoreLabelRow>(),
    env.DB.prepare("SELECT id, note_id, filename, mime_type, r2_key, created_at FROM attachments WHERE note_id = ? ORDER BY created_at, id")
      .bind(noteId).all<RestoreAttachmentRow>(),
  ]);
  return {
    checklist: checklist.results ?? [],
    labels: labels.results ?? [],
    attachments: attachments.results ?? [],
  };
}

function equalStrings(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  const a = [...left].sort();
  const b = [...right].sort();
  return a.every((value, index) => value === b[index]);
}

interface SnapshotMatch {
  matches: boolean;
  existingAttachmentIds: string[];
}

async function matchSnapshot(note: BackupNote, row: RestoreNoteRow, env: Env, now = Date.now()): Promise<SnapshotMatch> {
  const expectedDeletedAt = effectiveDeletedAt(note, now);
  const deletedAtMatches = row.deleted_at === expectedDeletedAt
    || (note.deleted_at !== null && staleTrash(note, now) && row.deleted_at === note.deleted_at);
  const expectedImage = imageChoice(note);
  const cardImageMatches = row.card_image === note.card_image || (expectedImage !== null && row.card_image === "auto");
  if (row.id !== note.id || row.title !== note.title || row.body !== note.body || row.url !== note.url
    || row.color !== note.color || row.preview_title !== note.preview_title
    || row.preview_description !== note.preview_description || row.preview_image !== note.preview_image
    || row.preview_hostname !== note.preview_hostname || !cardImageMatches
    || row.pinned !== Number(note.pinned) || row.archived !== Number(note.archived)
    || !deletedAtMatches || row.created_at !== note.created_at || row.updated_at !== note.updated_at) {
    return { matches: false, existingAttachmentIds: [] };
  }

  const relations = await currentRelations(note.id, env);
  if (relations.checklist.length !== note.checklist.length
    || relations.checklist.some((item, index) => {
      const source = note.checklist[index];
      return item.id !== source.id || item.position !== source.order || item.text !== source.text || item.checked !== Number(source.checked);
    })) return { matches: false, existingAttachmentIds: [] };
  if (!equalStrings(relations.labels.map((item) => labelKey(item.name)), note.labels.map(labelKey))) {
    return { matches: false, existingAttachmentIds: [] };
  }

  const expectedAttachments = new Map(note.attachments.map((attachment) => [attachment.id, attachment]));
  if (relations.attachments.some((attachment) => {
    const source = expectedAttachments.get(attachment.id);
    return !source || attachment.note_id !== note.id || attachment.filename !== source.filename
      || attachment.mime_type.toLowerCase() !== source.mime_type.toLowerCase()
      || attachment.created_at !== source.created_at;
  })) return { matches: false, existingAttachmentIds: [] };
  return {
    matches: true,
    existingAttachmentIds: relations.attachments.map((attachment) => attachment.id),
  };
}

async function labelsExist(note: BackupNote, env: Env): Promise<boolean> {
  if (!note.labels.length) return true;
  const keys = note.labels.map(labelKey);
  const rows = await env.DB.prepare(`SELECT name_key FROM labels WHERE name_key IN (${keys.map(() => "?").join(",")})`)
    .bind(...keys).all<{ name_key: string }>();
  const found = new Set((rows.results ?? []).map((row) => row.name_key));
  return keys.every((key) => found.has(key));
}

function noteResponse(status: "restored" | "skipped_existing", conflict: boolean, canRestoreAttachments: boolean,
  trashReset: boolean, cardImagePending: boolean, existingAttachmentIds: string[] = []): Response {
  return json({ status, conflict, canRestoreAttachments, trashReset, cardImagePending, existingAttachmentIds });
}

async function responseForExisting(note: BackupNote, row: RestoreNoteRow, env: Env): Promise<Response> {
  const snapshot = await matchSnapshot(note, row, env);
  const cardImagePending = imageChoice(note) !== null && row.card_image !== note.card_image;
  return noteResponse("skipped_existing", !snapshot.matches, snapshot.matches, false,
    snapshot.matches && cardImagePending, snapshot.matches ? snapshot.existingAttachmentIds : []);
}

function checklistStatements(note: BackupNote, env: Env): D1PreparedStatement[] {
  const statements: D1PreparedStatement[] = [];
  for (let start = 0; start < note.checklist.length; start += 20) {
    const items = note.checklist.slice(start, start + 20);
    const values = items.map(() => "(?, ?, ?, ?, ?)").join(",");
    const bindings = items.flatMap((item) => [item.id, note.id, item.order, item.text, Number(item.checked)]);
    statements.push(env.DB.prepare(
      `INSERT INTO checklist_items (id, note_id, position, text, checked) VALUES ${values}`,
    ).bind(...bindings));
  }
  return statements;
}

async function restoreNote(request: Request, env: Env): Promise<Response> {
  const value = await readJson(request, MAX_NOTE_BYTES);
  if (!isRecord(value) || !Object.hasOwn(value, "note")) return json({ error: "invalid_note" }, 400);
  let note: BackupNote;
  try { note = parseBackupNote(value.note); }
  catch (error) {
    if (error instanceof BackupFormatError) return json({ error: "invalid_note", path: error.path }, 400);
    throw error;
  }

  const existing = await getExistingNote(note.id, env);
  if (existing) return await responseForExisting(note, existing, env);
  if (!await labelsExist(note, env)) return json({ error: "missing_labels" }, 409);

  const resetTrash = staleTrash(note);
  const deletedAt = effectiveDeletedAt(note);
  const pendingImage = imageChoice(note) !== null;
  const cardImage = pendingImage ? "auto" : note.card_image;
  const statements: D1PreparedStatement[] = [env.DB.prepare(
    `INSERT INTO notes (id, title, body, url, pinned, archived, color, deleted_at, created_at, updated_at,
      preview_title, preview_description, preview_image, preview_hostname, card_image)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(note.id, note.title, note.body, note.url, Number(note.pinned), Number(note.archived), note.color,
    deletedAt, note.created_at, note.updated_at, note.preview_title, note.preview_description,
    note.preview_image, note.preview_hostname, cardImage),
  ...checklistStatements(note, env)];
  if (note.labels.length) {
    const values = note.labels.map(() => "(?, ?)").join(",");
    statements.push(env.DB.prepare(`INSERT INTO note_labels (note_id, label_key) VALUES ${values}`)
      .bind(...note.labels.flatMap((name) => [note.id, labelKey(name)])));
  }
  try {
    await env.DB.batch(statements);
  } catch (error) {
    // Another restore may have inserted this ID while our request was in flight.
    const raced = await getExistingNote(note.id, env);
    if (raced) return await responseForExisting(note, raced, env);
    throw error;
  }

  if (pendingImage) {
    try {
      const fingerprint = await noteFingerprint(note);
      await writeReceipt(note, fingerprint, env);
    } catch (error) {
      // The note and its attachments remain retryable; without a receipt the
      // finalizer refuses to change card_image.
      console.error("backup_restore_receipt_write_failed", note.id, error);
    }
  }
  return noteResponse("restored", false, true, resetTrash, pendingImage);
}

function formString(form: FormData, key: string, maxLength: number): string | null {
  const value = form.get(key);
  return typeof value === "string" && value.length <= maxLength ? value : null;
}

function attachmentFromForm(value: unknown, note: BackupNote): BackupAttachment | null {
  if (!isRecord(value) || !isUuid(value.id) || typeof value.filename !== "string"
    || typeof value.mime_type !== "string" || typeof value.created_at !== "string"
    || !(value.zip_path === null || typeof value.zip_path === "string")) return null;
  const attachmentId = value.id;
  const source = note.attachments.find((item) => item.id === attachmentId.toLowerCase());
  if (!source || source.filename !== value.filename || source.mime_type !== value.mime_type.toLowerCase()
    || source.created_at !== value.created_at || source.zip_path !== value.zip_path) return null;
  return source;
}

function sameAttachment(row: RestoreAttachmentRow, noteId: string, attachment: BackupAttachment): boolean {
  return row.note_id === noteId && row.id === attachment.id && row.filename === attachment.filename
    && row.mime_type.toLowerCase() === attachment.mime_type.toLowerCase() && row.created_at === attachment.created_at;
}

function noteRelationGuard(alias: "n" | "notes"): string {
  return `AND (SELECT COUNT(*) FROM checklist_items c WHERE c.note_id = ${alias}.id) = json_array_length(?)
    AND NOT EXISTS (SELECT 1 FROM json_each(?) expected WHERE NOT EXISTS (
      SELECT 1 FROM checklist_items c WHERE c.note_id = ${alias}.id
        AND c.id = json_extract(expected.value, '$.id')
        AND c.position = json_extract(expected.value, '$.position')
        AND c.text = json_extract(expected.value, '$.text')
        AND c.checked = json_extract(expected.value, '$.checked')))
    AND (SELECT COUNT(*) FROM note_labels nl WHERE nl.note_id = ${alias}.id) = json_array_length(?)
    AND NOT EXISTS (SELECT 1 FROM json_each(?) expected WHERE NOT EXISTS (
      SELECT 1 FROM note_labels nl JOIN labels l ON l.name_key = nl.label_key
      WHERE nl.note_id = ${alias}.id AND l.name_key = expected.value))
    AND NOT EXISTS (SELECT 1 FROM attachments a WHERE a.note_id = ${alias}.id AND NOT EXISTS (
      SELECT 1 FROM json_each(?) expected WHERE a.id = json_extract(expected.value, '$.id')
        AND a.filename = json_extract(expected.value, '$.filename')
        AND lower(a.mime_type) = lower(json_extract(expected.value, '$.mime_type'))
        AND a.created_at = json_extract(expected.value, '$.created_at')))`;
}

function noteRelationGuardBindings(note: BackupNote): string[] {
  const checklist = JSON.stringify(note.checklist.map((item) => ({
    id: item.id, position: item.order, text: item.text, checked: Number(item.checked),
  })));
  const labels = JSON.stringify(note.labels.map(labelKey));
  const attachments = JSON.stringify(note.attachments.map((item) => ({
    id: item.id, filename: item.filename, mime_type: item.mime_type, created_at: item.created_at,
  })));
  return [checklist, checklist, labels, labels, attachments];
}

function conditionalAttachmentInsert(note: BackupNote, attachment: BackupAttachment, r2Key: string, env: Env): D1PreparedStatement {
  const pendingImage = imageChoice(note) !== null;
  const deletedAt = effectiveDeletedAt(note);
  const query = `INSERT INTO attachments (id, note_id, filename, mime_type, r2_key, created_at)
    SELECT ?, ?, ?, ?, ?, ?
    WHERE EXISTS (SELECT 1 FROM notes n WHERE n.id = ? AND n.title = ? AND n.body = ? AND n.url = ?
      AND n.pinned = ? AND n.archived = ? AND n.color = ? AND n.created_at = ? AND n.updated_at = ?
      AND n.preview_title = ? AND n.preview_description = ? AND n.preview_image = ? AND n.preview_hostname = ?
      AND ((n.deleted_at IS ?) OR (? = 1 AND n.deleted_at IS NULL))
      AND (n.card_image = ? OR (? = 1 AND n.card_image = 'auto'))
      ${noteRelationGuard("n")})
      AND NOT EXISTS (SELECT 1 FROM attachments a WHERE a.id = ?)`;
  const bindings: unknown[] = [attachment.id, note.id, attachment.filename, attachment.mime_type, r2Key, attachment.created_at,
    note.id, note.title, note.body, note.url, Number(note.pinned), Number(note.archived), note.color,
    note.created_at, note.updated_at, note.preview_title, note.preview_description, note.preview_image, note.preview_hostname,
    deletedAt, Number(note.deleted_at !== null && staleTrash(note)), note.card_image, Number(pendingImage),
    ...noteRelationGuardBindings(note), attachment.id];
  return env.DB.prepare(query).bind(...bindings);
}

async function conditionalAttachmentRequest(request: Request): Promise<FormData> {
  const contentType = request.headers.get("Content-Type") ?? "";
  if (!/^multipart\/form-data\s*;/i.test(contentType)) throw new Error("invalid_multipart");
  const declared = Number(request.headers.get("Content-Length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_ATTACHMENT_REQUEST_BYTES) throw new Error("body_too_large");
  const bytes = await readBytes(request, MAX_ATTACHMENT_REQUEST_BYTES);
  return await new Request(request.url, {
    method: "POST",
    headers: { "Content-Type": contentType },
    body: new Blob([bytes.buffer as ArrayBuffer]),
  }).formData();
}

async function restoreAttachment(request: Request, env: Env): Promise<Response> {
  let form: FormData;
  try { form = await conditionalAttachmentRequest(request); }
  catch (error) {
    if (error instanceof Error && error.message === "body_too_large") return json({ error: "attachment_too_large" }, 413);
    return json({ error: "invalid_multipart" }, 400);
  }
  const noteJson = formString(form, "note", MAX_NOTE_BYTES);
  const attachmentJson = formString(form, "attachment", 16 * 1024);
  const fileValue = form.get("file");
  if (!noteJson || !attachmentJson || !fileValue || typeof fileValue === "string"
    || typeof fileValue.arrayBuffer !== "function") return json({ error: "invalid_attachment" }, 400);

  let note: BackupNote;
  let attachment: BackupAttachment | null;
  try {
    note = parseBackupNote(JSON.parse(noteJson) as unknown);
    attachment = attachmentFromForm(JSON.parse(attachmentJson) as unknown, note);
  } catch (error) {
    if (error instanceof BackupFormatError || error instanceof SyntaxError) return json({ error: "invalid_attachment" }, 400);
    throw error;
  }
  if (!attachment || attachment.zip_path === null) return json({ error: "invalid_attachment" }, 400);
  const file = fileValue as File;
  if (file.size <= 0) return json({ error: "empty_attachment" }, 400);
  if (file.size > MAX_ATTACHMENT_BYTES) return json({ error: "attachment_too_large" }, 413);
  if (!MIME_TYPE_PATTERN.test(attachment.mime_type) || attachment.mime_type.length > 100) {
    return json({ error: "invalid_mime_type" }, 415);
  }

  const noteRow = await getExistingNote(note.id, env);
  if (!noteRow || !(await matchSnapshot(note, noteRow, env)).matches) {
    return json({ status: "skipped_existing", conflict: true }, 409);
  }
  const prior = await env.DB.prepare(
    "SELECT id, note_id, filename, mime_type, r2_key, created_at FROM attachments WHERE id = ?",
  ).bind(attachment.id).first<RestoreAttachmentRow>();
  if (prior) {
    return json({ status: "skipped_existing", conflict: !sameAttachment(prior, note.id, attachment) },
      sameAttachment(prior, note.id, attachment) ? 200 : 409);
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.byteLength !== file.size || bytes.byteLength > MAX_ATTACHMENT_BYTES) return json({ error: "attachment_too_large" }, 413);
  const r2Key = `backup-restores/${note.id}/${attachment.id}/${crypto.randomUUID()}`;
  await env.IMAGES.put(r2Key, bytes, { httpMetadata: { contentType: attachment.mime_type } });
  try {
    await conditionalAttachmentInsert(note, attachment, r2Key, env).run();
  } catch (error) {
    let current: RestoreAttachmentRow | null;
    try {
      current = await env.DB.prepare(
        "SELECT id, note_id, filename, mime_type, r2_key, created_at FROM attachments WHERE id = ?",
      ).bind(attachment.id).first<RestoreAttachmentRow>();
    } catch (readError) {
      // Keep the unique object if D1 cannot confirm whether it references it.
      console.error("backup_restore_attachment_state_unknown", attachment.id, readError);
      return json({ error: "restore_failed" }, 500);
    }
    if (current?.r2_key === r2Key && sameAttachment(current, note.id, attachment)) {
      return json({ status: "restored", conflict: false });
    }
    await env.IMAGES.delete(r2Key);
    if (current) {
      const same = sameAttachment(current, note.id, attachment);
      return json({ status: "skipped_existing", conflict: !same }, same ? 200 : 409);
    }
    const latestNote = await getExistingNote(note.id, env);
    if (!latestNote || !(await matchSnapshot(note, latestNote, env)).matches) {
      return json({ status: "skipped_existing", conflict: true }, 409);
    }
    console.error("backup_restore_attachment_insert_failed", attachment.id, error);
    return json({ error: "restore_failed" }, 500);
  }

  const inserted = await env.DB.prepare(
    "SELECT id, note_id, filename, mime_type, r2_key, created_at FROM attachments WHERE id = ?",
  ).bind(attachment.id).first<RestoreAttachmentRow>();
  if (inserted?.r2_key === r2Key && sameAttachment(inserted, note.id, attachment)) {
    return json({ status: "restored", conflict: false }, 201);
  }
  if (inserted) {
    await env.IMAGES.delete(r2Key);
    const same = sameAttachment(inserted, note.id, attachment);
    return json({ status: "skipped_existing", conflict: !same }, same ? 200 : 409);
  }
  // The D1 insert did not persist. Remove only the object created by this request.
  await env.IMAGES.delete(r2Key);
  return json({ error: "restore_failed" }, 500);
}

async function finalizeCardImage(request: Request, env: Env): Promise<Response> {
  const value = await readJson(request, MAX_NOTE_BYTES);
  if (!isRecord(value) || !Object.hasOwn(value, "note")) return json({ error: "invalid_note" }, 400);
  let note: BackupNote;
  try { note = parseBackupNote(value.note); }
  catch (error) {
    if (error instanceof BackupFormatError) return json({ error: "invalid_note", path: error.path }, 400);
    throw error;
  }
  const attachmentId = imageChoice(note);
  if (!attachmentId) return json({ cardImageRestored: false, cardImageMissing: false });

  const fingerprint = await noteFingerprint(note);
  if (!await readReceipt(note, fingerprint, env)) {
    return json({ cardImageRestored: false, cardImageMissing: true });
  }
  const row = await getExistingNote(note.id, env);
  if (!row || !(await matchSnapshot(note, row, env)).matches) return json({ cardImageRestored: false, cardImageMissing: true });
  const attachment = await env.DB.prepare("SELECT mime_type, r2_key FROM attachments WHERE id = ? AND note_id = ?")
    .bind(attachmentId, note.id).first<{ mime_type: string; r2_key: string }>();
  if (!attachment || !IMAGE_TYPES.has(attachment.mime_type.toLowerCase()) || !await env.IMAGES.head(attachment.r2_key)) {
    return json({ cardImageRestored: false, cardImageMissing: true });
  }
  if (row.card_image === note.card_image) return json({ cardImageRestored: true, cardImageMissing: false });
  if (row.card_image !== "auto") return json({ cardImageRestored: false, cardImageMissing: true });

  const deletedAt = effectiveDeletedAt(note);
  const stale = Number(note.deleted_at !== null && staleTrash(note));
  const update = await env.DB.prepare(`UPDATE notes SET card_image = ?
    WHERE id = ? AND title = ? AND body = ? AND url = ? AND pinned = ? AND archived = ? AND color = ?
      AND created_at = ? AND updated_at = ? AND preview_title = ? AND preview_description = ?
      AND preview_image = ? AND preview_hostname = ? AND card_image = 'auto'
      AND ((deleted_at IS ?) OR (? = 1 AND deleted_at IS NULL))
      ${noteRelationGuard("notes")}
      AND EXISTS (SELECT 1 FROM attachments WHERE id = ? AND note_id = ? AND mime_type IN ('image/jpeg','image/png','image/webp','image/gif','image/avif'))`)
    .bind(note.card_image, note.id, note.title, note.body, note.url, Number(note.pinned), Number(note.archived), note.color,
      note.created_at, note.updated_at, note.preview_title, note.preview_description, note.preview_image, note.preview_hostname,
      deletedAt, stale, ...noteRelationGuardBindings(note), attachmentId, note.id).run();
  if (update.meta.changes > 0) return json({ cardImageRestored: true, cardImageMissing: false });

  const after = await getExistingNote(note.id, env);
  const restored = after?.card_image === note.card_image && (await matchSnapshot(note, after, env)).matches;
  return json({ cardImageRestored: restored, cardImageMissing: !restored });
}

export async function handleBackupRestore(request: Request, env: Env): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  if (!path.startsWith("/api/backup/restore/")) return null;
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  try {
    if (path === "/api/backup/restore/groups") return await restoreGroups(request, env);
    if (path === "/api/backup/restore/labels") return await restoreLabels(request, env);
    if (path === "/api/backup/restore/notes") return await restoreNote(request, env);
    if (path === "/api/backup/restore/attachments") return await restoreAttachment(request, env);
    if (path === "/api/backup/restore/finalize") return await finalizeCardImage(request, env);
    return json({ error: "not_found" }, 404);
  } catch (error) {
    if (error instanceof Error && error.message === "body_too_large") return json({ error: "request_too_large" }, 413);
    if (error instanceof Error && ["empty_body", "invalid_json", "invalid_groups", "invalid_memberships", "invalid_multipart"].includes(error.message)) {
      return json({ error: "invalid_request" }, 400);
    }
    console.error("backup_restore_failed", error);
    return json({ error: "restore_failed" }, 500);
  }
}
