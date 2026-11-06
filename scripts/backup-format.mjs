export const TABLE_NAMES = Object.freeze([
  "notes",
  "attachments",
  "checklist_items",
  "labels",
  "label_groups",
  "note_labels",
]);

export const TABLE_PAGE_SIZE = 200;
export const LEGACY_TABLE_PAGE_SIZE = 20;
export const MAX_NOTES_JSON_BYTES = 64 * 1024 * 1024;
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export const MAX_ZIP_BYTES = 4 * 1024 * 1024 * 1024;
export const MAX_EXPANDED_BYTES = 8 * 1024 * 1024 * 1024;
export const MAX_ARCHIVE_ENTRIES = 100_000;

const MAX_ATTACHMENTS = MAX_ARCHIVE_ENTRIES - 1; // The other entry is notes.json.
const MAX_NOTES = 100_000;
const MAX_LABELS = 100_000;
const MAX_GROUPS = 100_000;
const MAX_CHECKLIST_ROWS = 500_000;
const MAX_NOTE_LABEL_ROWS = 1_000_000;
const SNAPSHOT_PATTERN = /^\d{4}-\d{2}-\d{2}-[a-f0-9-]{36}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MIME_PATTERN = /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i;
const COLORS = new Set(["default", "red", "orange", "yellow", "green", "blue", "purple"]);
const CARD_IMAGE_MIMES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif", "image/avif"]);

const TABLE_COLUMNS = Object.freeze({
  notes: ["id", "title", "body", "url", "pinned", "archived", "created_at", "updated_at", "color", "deleted_at",
    "preview_title", "preview_description", "preview_image", "preview_hostname", "card_image"],
  attachments: ["id", "note_id", "filename", "mime_type", "r2_key", "created_at"],
  checklist_items: ["id", "note_id", "position", "text", "checked"],
  labels: ["name_key", "name", "group_id"],
  label_groups: ["id", "name_key", "name"],
  note_labels: ["note_id", "label_key"],
});

function invalid(message) {
  throw new Error(message);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonNegativeInteger(value, path) {
  if (!Number.isSafeInteger(value) || value < 0) invalid(`Invalid ${path}.`);
  return value;
}

function isoDate(value, path) {
  if (typeof value !== "string") invalid(`Invalid ${path}.`);
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) invalid(`Invalid ${path}.`);
  return value;
}

export function validateSnapshotId(value) {
  if (typeof value !== "string" || !SNAPSHOT_PATTERN.test(value)) invalid("Invalid snapshot ID.");
  return value;
}

export function validateBucketName(value) {
  if (typeof value !== "string" || !/^[a-z0-9](?:[a-z0-9.-]{1,61}[a-z0-9])$/i.test(value)) {
    invalid("Invalid R2 bucket name.");
  }
  return value;
}

export function validateLatest(value) {
  if (!isRecord(value)) invalid("Invalid latest backup pointer.");
  return {
    snapshot: validateSnapshotId(value.snapshot),
    completed_at: isoDate(value.completed_at, "latest completed_at"),
  };
}

export function validateScheduledManifest(value, expectedSnapshot, latestCompletedAt = null) {
  if (!isRecord(value) || value.format !== "mykeep-scheduled-backup" || value.version !== 1
    || value.status !== "complete") invalid("Scheduled backup is incomplete or unsupported.");
  const snapshot = validateSnapshotId(value.snapshot);
  if (snapshot !== expectedSnapshot) invalid("Snapshot ID does not match the selected backup.");
  const started_at = isoDate(value.started_at, "manifest started_at");
  const completed_at = isoDate(value.completed_at, "manifest completed_at");
  if (Date.parse(completed_at) < Date.parse(started_at)
    || (latestCompletedAt !== null && completed_at !== latestCompletedAt)) {
    invalid("Backup completion metadata is inconsistent.");
  }
  const revision = nonNegativeInteger(value.revision, "manifest revision");
  const attachments = nonNegativeInteger(value.attachments, "manifest attachments");
  const attachment_bytes = nonNegativeInteger(value.attachment_bytes, "manifest attachment_bytes");
  if (attachments > MAX_ATTACHMENTS || attachment_bytes > MAX_EXPANDED_BYTES) {
    invalid("Backup exceeds the restore limits.");
  }
  if (!Array.isArray(value.tables) || value.tables.length !== TABLE_NAMES.length) invalid("Invalid table manifest.");
  const tables = value.tables.map((table, index) => {
    const name = TABLE_NAMES[index];
    if (!isRecord(table) || table.name !== name) invalid("Invalid table manifest order.");
    const parts = nonNegativeInteger(table.parts, `manifest ${name} parts`);
    const rows = nonNegativeInteger(table.rows, `manifest ${name} rows`);
    const maxRows = name === "notes" ? MAX_NOTES
      : name === "attachments" ? MAX_ATTACHMENTS
      : name === "checklist_items" ? MAX_CHECKLIST_ROWS
      : name === "labels" || name === "label_groups" ? MAX_LABELS
      : MAX_NOTE_LABEL_ROWS;
    // A deployment can change batch size while a snapshot is in progress.
    // Accept old, new, and mixed pages; the downloader still verifies every row count.
    if (rows > maxRows || parts < Math.ceil(rows / TABLE_PAGE_SIZE)
      || parts > Math.ceil(rows / LEGACY_TABLE_PAGE_SIZE)) invalid(`Invalid ${name} page counts.`);
    return { name, parts, rows };
  });
  if (tables[1].rows !== attachments) invalid("Attachment count does not match the table manifest.");
  return { format: value.format, version: value.version, status: value.status, snapshot, started_at,
    completed_at, revision, tables, attachments, attachment_bytes };
}

function exactRow(value, table, index) {
  if (!isRecord(value)) invalid(`Invalid ${table} row ${index + 1}.`);
  const expected = TABLE_COLUMNS[table];
  const keys = Object.keys(value);
  if (keys.length !== expected.length || expected.some((key) => !Object.hasOwn(value, key))) {
    invalid(`Invalid ${table} row columns at row ${index + 1}.`);
  }
  return value;
}

function string(value, path, maxLength = Number.MAX_SAFE_INTEGER) {
  if (typeof value !== "string" || value.length > maxLength) invalid(`Invalid ${path}.`);
  return value;
}

function uuid(value, path) {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) invalid(`Invalid ${path}.`);
  return value;
}

function flag(value, path) {
  if (value !== 0 && value !== 1) invalid(`Invalid ${path}.`);
  return value === 1;
}

function nullableDate(value, path) {
  return value === null ? null : isoDate(value, path);
}

function cleanName(value, path) {
  const name = string(value, path, 100).trim().normalize("NFC");
  if (!name || /[\u0000-\u001f\u007f-\u009f]/u.test(name)) invalid(`Invalid ${path}.`);
  return name;
}

function nameKey(value) {
  return value.normalize("NFC").toLowerCase();
}

function webUrl(value, path) {
  if (!value) return;
  try {
    if (!["http:", "https:"].includes(new URL(value).protocol)) invalid(`Invalid ${path}.`);
  } catch {
    invalid(`Invalid ${path}.`);
  }
}

function safeExtension(filename) {
  const base = filename.split(/[\\/]/u).at(-1) ?? "";
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return "";
  const extension = base.slice(dot);
  return /^\.[a-z0-9_-]{1,20}$/i.test(extension) ? extension : "";
}

export function attachmentZipPath(id, filename) {
  return `attachments/${uuid(id, "attachment ID")}${safeExtension(string(filename, "attachment filename", 255))}`;
}

function assertRows(tableRows) {
  if (!isRecord(tableRows)) invalid("Invalid table rows.");
  for (const name of TABLE_NAMES) {
    if (!Array.isArray(tableRows[name])) invalid(`Missing ${name} table rows.`);
  }
}

export function convertScheduledRows(manifest, tableRows) {
  assertRows(tableRows);
  const declared = new Map(manifest.tables.map((table) => [table.name, table.rows]));
  for (const name of TABLE_NAMES) {
    if (tableRows[name].length !== declared.get(name)) invalid(`${name} row count does not match the manifest.`);
  }

  const notes = new Map();
  for (const [index, raw] of tableRows.notes.entries()) {
    const row = exactRow(raw, "notes", index);
    const id = uuid(row.id, `notes row ${index + 1} ID`);
    if (notes.has(id)) invalid("Duplicate note ID.");
    const title = string(row.title, "note title", 300);
    const body = string(row.body, "note body", 100_000);
    const url = string(row.url, "note URL", 2_000);
    webUrl(url, "note URL");
    const color = string(row.color, "note color", 20);
    if (!COLORS.has(color)) invalid("Invalid note color.");
    const created_at = isoDate(row.created_at, "note created_at");
    const updated_at = isoDate(row.updated_at, "note updated_at");
    const deleted_at = nullableDate(row.deleted_at, "note deleted_at");
    const preview_title = string(row.preview_title, "preview title", 300);
    const preview_description = string(row.preview_description, "preview description", 500);
    const preview_image = string(row.preview_image, "preview image", 2_000);
    const preview_hostname = string(row.preview_hostname, "preview hostname", 255);
    webUrl(preview_image, "preview image URL");
    const card_image = string(row.card_image, "card image", 64);
    if (card_image !== "auto" && card_image !== "preview" && !/^attachment:[0-9a-f-]{36}$/i.test(card_image)) {
      invalid("Invalid card image.");
    }
    notes.set(id, {
      id, title, body, url, color, preview_title, preview_description, preview_image, preview_hostname,
      card_image, pinned: flag(row.pinned, "note pinned"), archived: flag(row.archived, "note archived"),
      trashed: deleted_at !== null, deleted_at, created_at, updated_at,
      checklist: [], labels: [], attachments: [],
    });
  }

  const attachmentIds = new Set();
  for (const [index, raw] of tableRows.attachments.entries()) {
    const row = exactRow(raw, "attachments", index);
    const id = uuid(row.id, `attachments row ${index + 1} ID`);
    const noteId = uuid(row.note_id, `attachments row ${index + 1} note ID`);
    const note = notes.get(noteId);
    if (!note) invalid("Attachment references a missing note.");
    if (attachmentIds.has(id)) invalid("Duplicate attachment ID.");
    attachmentIds.add(id);
    const filename = string(row.filename, "attachment filename", 255);
    if (!filename.trim() || /[\u0000-\u001f\u007f]/u.test(filename)) invalid("Invalid attachment filename.");
    const mime_type = string(row.mime_type, "attachment MIME type", 100).toLowerCase();
    if (!MIME_PATTERN.test(mime_type)) invalid("Invalid attachment MIME type.");
    const created_at = isoDate(row.created_at, "attachment created_at");
    string(row.r2_key, "attachment storage key", 1_024);
    if (note.attachments.length >= 5_000) invalid("Too many attachments on one note.");
    note.attachments.push({ id, filename, mime_type, created_at, zip_path: attachmentZipPath(id, filename) });
  }

  const checklistIds = new Set();
  for (const [index, raw] of tableRows.checklist_items.entries()) {
    const row = exactRow(raw, "checklist_items", index);
    const id = uuid(row.id, `checklist row ${index + 1} ID`);
    const noteId = uuid(row.note_id, `checklist row ${index + 1} note ID`);
    const note = notes.get(noteId);
    if (!note) invalid("Checklist item references a missing note.");
    if (checklistIds.has(id)) invalid("Duplicate checklist item ID.");
    checklistIds.add(id);
    const position = nonNegativeInteger(row.position, "checklist position");
    if (position >= 500 || note.checklist.some((item) => item.order === position)) invalid("Invalid checklist ordering.");
    note.checklist.push({ id, text: string(row.text, "checklist text", 10_000), checked: flag(row.checked, "checklist checked"), order: position });
  }

  const groups = [];
  const groupIds = new Set();
  const groupNames = new Set();
  for (const [index, raw] of tableRows.label_groups.entries()) {
    const row = exactRow(raw, "label_groups", index);
    const id = uuid(row.id, `label group row ${index + 1} ID`);
    const name = cleanName(row.name, "label group name");
    string(row.name_key, "label group key", 100);
    const normalized = nameKey(name);
    if (groupIds.has(id) || groupNames.has(normalized)) invalid("Duplicate label group.");
    groupIds.add(id);
    groupNames.add(normalized);
    groups.push({ id, name });
  }

  const labels = new Map();
  const membershipNames = new Set();
  const memberships = [];
  for (const [index, raw] of tableRows.labels.entries()) {
    const row = exactRow(raw, "labels", index);
    const key = string(row.name_key, `label row ${index + 1} key`, 100);
    const name = cleanName(row.name, "label name");
    const normalized = nameKey(name);
    const groupId = row.group_id === null ? null : uuid(row.group_id, "label group ID");
    if (!key || labels.has(key) || membershipNames.has(normalized)) invalid("Duplicate label.");
    if (groupId !== null && !groupIds.has(groupId)) invalid("Label references a missing group.");
    labels.set(key, { name, group_id: groupId, normalized });
    membershipNames.add(normalized);
    memberships.push({ label_name: name, group_id: groupId });
  }

  const labelPairs = new Set();
  for (const [index, raw] of tableRows.note_labels.entries()) {
    const row = exactRow(raw, "note_labels", index);
    const noteId = uuid(row.note_id, `note label row ${index + 1} note ID`);
    const note = notes.get(noteId);
    if (!note) invalid("Note label references a missing note.");
    const key = string(row.label_key, `note label row ${index + 1} key`, 100);
    const label = labels.get(key);
    if (!label) invalid("Note label references a missing label.");
    const pair = `${noteId}\u0000${key}`;
    if (labelPairs.has(pair) || note.labels.some((name) => nameKey(name) === label.normalized)) invalid("Duplicate note label.");
    labelPairs.add(pair);
    if (note.labels.length >= 50) invalid("Too many labels on one note.");
    note.labels.push(label.name);
  }

  for (const note of notes.values()) {
    if (note.card_image === "preview" && !note.preview_image) invalid("Preview card image has no preview URL.");
    if (note.card_image.startsWith("attachment:")) {
      const cardId = note.card_image.slice("attachment:".length).toLowerCase();
      const attachment = note.attachments.find((item) => item.id.toLowerCase() === cardId);
      if (!attachment || !CARD_IMAGE_MIMES.has(attachment.mime_type)) invalid("Card image references a non-image attachment.");
    }
  }

  const result = {
    format: "mykeep-backup",
    version: 1,
    exported_at: manifest.completed_at,
    label_groups: groups,
    label_group_memberships: memberships,
    notes: [...notes.values()],
  };
  return result;
}
