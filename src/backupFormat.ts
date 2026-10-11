import { NOTE_COLORS } from "./types";
import type { NoteColor } from "./types";

export const MYKEEP_BACKUP_FORMAT = "mykeep-backup" as const;
export const MYKEEP_BACKUP_VERSION = 1 as const;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MIME_TYPE_PATTERN = /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i;
const URL_PROTOCOLS = new Set(["http:", "https:"]);
const CARD_IMAGE_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif", "image/avif"]);
const MAX_NOTES = 100_000;
const MAX_LABELS = 50;
const MAX_CHECKLIST_ITEMS = 500;
const MAX_ATTACHMENTS_PER_NOTE = 5_000;
const MAX_GROUPS = 100_000;
const MAX_MEMBERSHIPS = 100_000;

export interface BackupChecklistItem {
  id: string;
  text: string;
  checked: boolean;
  order: number;
}

export interface BackupAttachment {
  id: string;
  filename: string;
  mime_type: string;
  created_at: string;
  zip_path: string | null;
}

export interface BackupNote {
  id: string;
  title: string;
  body: string;
  url: string;
  color: NoteColor;
  preview_title: string;
  preview_description: string;
  preview_image: string;
  preview_hostname: string;
  card_image: "auto" | "preview" | `attachment:${string}`;
  pinned: boolean;
  archived: boolean;
  trashed: boolean;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
  checklist: BackupChecklistItem[];
  labels: string[];
  attachments: BackupAttachment[];
  markdown_path?: string;
}

export interface BackupGroup {
  id: string;
  name: string;
}

export interface BackupMembership {
  label_name: string;
  group_id: string | null;
}

export interface BackupManifest {
  format: typeof MYKEEP_BACKUP_FORMAT;
  version: typeof MYKEEP_BACKUP_VERSION;
  exported_at: string;
  notes: BackupNote[];
  groups: BackupGroup[];
  memberships: BackupMembership[];
}

export class BackupFormatError extends Error {
  readonly code: string;
  readonly path: string;

  constructor(code: string, path: string, message: string) {
    super(message);
    this.name = "BackupFormatError";
    this.code = code;
    this.path = path;
  }
}

function invalid(path: string, message: string): never {
  throw new BackupFormatError("invalid_backup", path, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requiredString(value: unknown, path: string, maxLength: number): string {
  if (typeof value !== "string" || value.length > maxLength) invalid(path, "文字列を確認してください。");
  return value;
}

function optionalString(record: Record<string, unknown>, key: string, path: string, maxLength: number): string {
  const value = record[key];
  if (value === undefined) return "";
  return requiredString(value, `${path}.${key}`, maxLength);
}

function uuid(value: unknown, path: string): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) invalid(path, "IDの形式を確認してください。");
  return value.toLowerCase();
}

function isoDate(value: unknown, path: string): string {
  if (typeof value !== "string") invalid(path, "日時を確認してください。");
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) {
    invalid(path, "日時はISO 8601形式で指定してください。");
  }
  return value;
}

function optionalIsoDate(value: unknown, fallback: string, path: string): string {
  return value === undefined ? fallback : isoDate(value, path);
}

function labelName(value: unknown, path: string): string {
  const name = requiredString(value, path, 100).trim().normalize("NFC");
  if (!name || /[\u0000-\u001f\u007f-\u009f]/u.test(name)) invalid(path, "ラベル名を確認してください。");
  return name;
}

function groupName(value: unknown, path: string): string {
  const name = requiredString(value, path, 100).trim().normalize("NFC");
  if (!name || /[\u0000-\u001f\u007f-\u009f]/u.test(name)) invalid(path, "グループ名を確認してください。");
  return name;
}

function normalizedName(value: string): string {
  return value.normalize("NFC").toLowerCase();
}

function validWebUrl(value: string, path: string): void {
  try {
    if (!URL_PROTOCOLS.has(new URL(value).protocol)) invalid(path, "URLはHTTPまたはHTTPSにしてください。");
  } catch (error) {
    if (error instanceof BackupFormatError) throw error;
    invalid(path, "URLを確認してください。");
  }
}

function safeArchivePath(value: string, prefix: "attachments/" | "markdown/", path: string): void {
  if (value.length > 1024 || value.startsWith("/") || value.includes("\\") || /[\u0000-\u001f\u007f:]/u.test(value)
    || !value.startsWith(prefix) || value.split("/").some((part) => part === "" || part === "." || part === "..")) {
    invalid(path, "ZIP内のファイルパスを確認してください。");
  }
}

function parseAttachment(value: unknown, path: string, noteCreatedAt: string): BackupAttachment {
  if (!isRecord(value)) invalid(path, "添付ファイル情報を確認してください。");
  const id = uuid(value.id, `${path}.id`);
  const filename = requiredString(value.filename, `${path}.filename`, 255);
  if (!filename.trim() || /[\u0000-\u001f\u007f]/u.test(filename)) invalid(`${path}.filename`, "ファイル名を確認してください。");
  const mime_type = requiredString(value.mime_type, `${path}.mime_type`, 100).toLowerCase();
  if (!MIME_TYPE_PATTERN.test(mime_type)) invalid(`${path}.mime_type`, "MIMEタイプを確認してください。");
  const created_at = optionalIsoDate(value.created_at, noteCreatedAt, `${path}.created_at`);
  const zipPathValue = value.zip_path;
  if (zipPathValue !== undefined && zipPathValue !== null && typeof zipPathValue !== "string") {
    invalid(`${path}.zip_path`, "ZIP内のファイルパスを確認してください。");
  }
  const zip_path = zipPathValue == null ? null : zipPathValue;
  if (zip_path !== null) safeArchivePath(zip_path, "attachments/", `${path}.zip_path`);
  return { id, filename, mime_type, created_at, zip_path };
}

function parseChecklist(value: unknown, path: string): BackupChecklistItem[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_CHECKLIST_ITEMS) invalid(path, "チェックリストの件数を確認してください。");
  const ids = new Set<string>();
  const orders = new Set<number>();
  return value.map((entry, index) => {
    const itemPath = `${path}[${index}]`;
    if (!isRecord(entry)) invalid(itemPath, "チェックリスト項目を確認してください。");
    const id = uuid(entry.id, `${itemPath}.id`);
    if (ids.has(id)) invalid(`${itemPath}.id`, "チェックリストIDが重複しています。");
    ids.add(id);
    const text = requiredString(entry.text, `${itemPath}.text`, 10_000);
    if (typeof entry.checked !== "boolean") invalid(`${itemPath}.checked`, "チェック状態を確認してください。");
    const orderValue = entry.order;
    if (!Number.isSafeInteger(orderValue) || (orderValue as number) < 0 || (orderValue as number) >= MAX_CHECKLIST_ITEMS) {
      invalid(`${itemPath}.order`, "並び順を確認してください。");
    }
    const order = orderValue as number;
    if (orders.has(order)) invalid(`${itemPath}.order`, "チェックリストの並び順が重複しています。");
    orders.add(order);
    return { id, text, checked: entry.checked, order };
  }).sort((a, b) => a.order - b.order);
}

function parseLabels(value: unknown, path: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_LABELS) invalid(path, "ラベルの件数を確認してください。");
  const labels: string[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < value.length; index += 1) {
    const labelPath = `${path}[${index}]`;
    const name = labelName(value[index], labelPath);
    const key = normalizedName(name);
    if (seen.has(key)) invalid(labelPath, "ラベルが重複しています。");
    labels.push(name);
    seen.add(key);
  }
  return labels;
}

export function parseBackupNote(value: unknown, path = "note"): BackupNote {
  if (!isRecord(value)) invalid(path, "メモ情報を確認してください。");
  const id = uuid(value.id, `${path}.id`);
  const title = requiredString(value.title, `${path}.title`, 300);
  const body = requiredString(value.body, `${path}.body`, 100_000);
  const url = requiredString(value.url, `${path}.url`, 2_000);
  if (url) validWebUrl(url, `${path}.url`);
  const color = value.color;
  if (typeof color !== "string" || !(NOTE_COLORS as readonly string[]).includes(color)) invalid(`${path}.color`, "メモの色を確認してください。");
  const created_at = isoDate(value.created_at, `${path}.created_at`);
  const updated_at = isoDate(value.updated_at, `${path}.updated_at`);
  const deleted_at = value.deleted_at === undefined || value.deleted_at === null
    ? null : isoDate(value.deleted_at, `${path}.deleted_at`);
  const trashedValue = value.trashed;
  if (trashedValue !== undefined && typeof trashedValue !== "boolean") invalid(`${path}.trashed`, "ゴミ箱の状態を確認してください。");
  const trashed = trashedValue === undefined ? deleted_at !== null : trashedValue;
  if (deleted_at !== null && !trashed) invalid(`${path}.deleted_at`, "ゴミ箱の状態と日時が一致しません。");
  // Some earlier V1 archives carried only the trash flag. Keep those notes in trash
  // using the best available original timestamp; the restore API will reset stale ones.
  const restoredDeletedAt = trashed && deleted_at === null ? updated_at : deleted_at;

  const preview_title = optionalString(value, "preview_title", path, 300);
  const preview_description = optionalString(value, "preview_description", path, 500);
  const preview_image = optionalString(value, "preview_image", path, 2_000);
  const preview_hostname = optionalString(value, "preview_hostname", path, 255);
  if (preview_image) validWebUrl(preview_image, `${path}.preview_image`);
  const cardImageValue = value.card_image;
  let card_image = cardImageValue === undefined ? "auto" : cardImageValue;
  if (card_image !== "auto" && card_image !== "preview"
    && !(typeof card_image === "string" && card_image.startsWith("attachment:") && UUID_PATTERN.test(card_image.slice(11)))) {
    invalid(`${path}.card_image`, "代表画像の指定を確認してください。");
  }
  if (typeof card_image === "string" && card_image.startsWith("attachment:")) {
    card_image = `attachment:${card_image.slice("attachment:".length).toLowerCase()}`;
  }
  if (card_image === "preview" && !preview_image) invalid(`${path}.card_image`, "代表画像のプレビュー参照がありません。");
  if (typeof value.pinned !== "boolean" || typeof value.archived !== "boolean") invalid(path, "ピン留め・アーカイブの状態を確認してください。");

  const checklist = parseChecklist(value.checklist, `${path}.checklist`);
  const labels = parseLabels(value.labels, `${path}.labels`);
  const attachmentValue = value.attachments;
  if (attachmentValue !== undefined && (!Array.isArray(attachmentValue) || attachmentValue.length > MAX_ATTACHMENTS_PER_NOTE)) {
    invalid(`${path}.attachments`, "添付ファイルの件数を確認してください。");
  }
  const attachments = (attachmentValue === undefined ? [] : attachmentValue)
    .map((attachment, index) => parseAttachment(attachment, `${path}.attachments[${index}]`, created_at));
  const attachmentIds = new Set<string>();
  const attachmentPaths = new Set<string>();
  for (const [index, attachment] of attachments.entries()) {
    if (attachmentIds.has(attachment.id)) invalid(`${path}.attachments[${index}].id`, "添付ファイルIDが重複しています。");
    attachmentIds.add(attachment.id);
    if (attachment.zip_path !== null) {
      if (attachmentPaths.has(attachment.zip_path)) invalid(`${path}.attachments[${index}].zip_path`, "添付ファイルのZIPパスが重複しています。");
      attachmentPaths.add(attachment.zip_path);
    }
  }
  const cardAttachmentId = typeof card_image === "string" && card_image.startsWith("attachment:")
    ? card_image.slice("attachment:".length).toLowerCase() : null;
  const cardAttachment = cardAttachmentId
    ? attachments.find((attachment) => attachment.id === cardAttachmentId)
    : undefined;
  if (cardAttachmentId && !cardAttachment) {
    invalid(`${path}.card_image`, "代表画像が添付ファイルを参照していません。");
  }
  if (cardAttachment && !CARD_IMAGE_MIME_TYPES.has(cardAttachment.mime_type)) {
    invalid(`${path}.card_image`, "代表画像には画像ファイルを指定してください。");
  }
  const markdownPathValue = value.markdown_path;
  if (markdownPathValue !== undefined && typeof markdownPathValue !== "string") invalid(`${path}.markdown_path`, "Markdownファイルのパスを確認してください。");
  if (typeof markdownPathValue === "string") safeArchivePath(markdownPathValue, "markdown/", `${path}.markdown_path`);
  return {
    id, title, body, url, color: color as NoteColor,
    preview_title, preview_description, preview_image, preview_hostname,
    card_image: card_image as BackupNote["card_image"], pinned: value.pinned, archived: value.archived,
    trashed, deleted_at: restoredDeletedAt, created_at, updated_at, checklist, labels, attachments,
    ...(typeof markdownPathValue === "string" ? { markdown_path: markdownPathValue } : {}),
  };
}

function parseGroups(value: unknown): BackupGroup[] {
  if (!Array.isArray(value) || value.length > MAX_GROUPS) invalid("label_groups", "グループ一覧を確認してください。");
  const ids = new Set<string>();
  const names = new Set<string>();
  return value.map((entry, index) => {
    const path = `label_groups[${index}]`;
    if (!isRecord(entry)) invalid(path, "グループ情報を確認してください。");
    const id = uuid(entry.id, `${path}.id`);
    const name = groupName(entry.name, `${path}.name`);
    if (ids.has(id) || names.has(normalizedName(name))) invalid(path, "グループIDまたは名前が重複しています。");
    ids.add(id);
    names.add(normalizedName(name));
    return { id, name };
  });
}

function parseMemberships(value: unknown, groups: BackupGroup[]): BackupMembership[] {
  if (!Array.isArray(value) || value.length > MAX_MEMBERSHIPS) invalid("label_group_memberships", "ラベル一覧を確認してください。");
  const groupIds = new Set(groups.map((group) => group.id));
  const labelNames = new Set<string>();
  return value.map((entry, index) => {
    const path = `label_group_memberships[${index}]`;
    if (!isRecord(entry)) invalid(path, "ラベル所属情報を確認してください。");
    const label_name = labelName(entry.label_name, `${path}.label_name`);
    const key = normalizedName(label_name);
    if (labelNames.has(key)) invalid(`${path}.label_name`, "ラベルが重複しています。");
    labelNames.add(key);
    const group_id = entry.group_id;
    if (group_id !== null && (typeof group_id !== "string" || !UUID_PATTERN.test(group_id))) {
      invalid(`${path}.group_id`, "グループIDを確認してください。");
    }
    const normalizedGroupId = group_id === null ? null : (group_id as string).toLowerCase();
    if (normalizedGroupId !== null && !groupIds.has(normalizedGroupId)) invalid(`${path}.group_id`, "存在しないグループが指定されています。");
    return { label_name, group_id: normalizedGroupId };
  });
}

export function parseBackupManifest(value: unknown): BackupManifest {
  if (!isRecord(value)) invalid("$", "バックアップ情報を確認してください。");
  if (value.format !== MYKEEP_BACKUP_FORMAT) invalid("format", "MyKeepバックアップではありません。");
  if (value.version !== MYKEEP_BACKUP_VERSION) invalid("version", "未対応のバックアップ形式です。");
  const exported_at = isoDate(value.exported_at, "exported_at");
  if (!Array.isArray(value.notes) || value.notes.length > MAX_NOTES) invalid("notes", "メモの件数を確認してください。");

  const notes = value.notes.map((note, index) => parseBackupNote(note, `notes[${index}]`));
  const noteIds = new Set<string>();
  const checklistIds = new Set<string>();
  const attachmentIds = new Set<string>();
  const attachmentPaths = new Set<string>();
  const noteLabels = new Set<string>();
  for (const [index, note] of notes.entries()) {
    if (noteIds.has(note.id)) invalid(`notes[${index}].id`, "メモIDが重複しています。");
    noteIds.add(note.id);
    for (const item of note.checklist) {
      if (checklistIds.has(item.id)) invalid(`notes[${index}].checklist`, "チェックリストIDが重複しています。");
      checklistIds.add(item.id);
    }
    for (const attachment of note.attachments) {
      if (attachmentIds.has(attachment.id)) invalid(`notes[${index}].attachments`, "添付ファイルIDが重複しています。");
      attachmentIds.add(attachment.id);
      if (attachment.zip_path !== null) {
        if (attachmentPaths.has(attachment.zip_path)) invalid(`notes[${index}].attachments`, "添付ファイルのZIPパスが重複しています。");
        attachmentPaths.add(attachment.zip_path);
      }
    }
    for (const label of note.labels) noteLabels.add(normalizedName(label));
  }

  const hasGroups = Object.hasOwn(value, "label_groups");
  const hasMemberships = Object.hasOwn(value, "label_group_memberships");
  if (hasGroups !== hasMemberships) invalid("label_groups", "グループとラベルの情報が揃っていません。");
  let groups: BackupGroup[];
  let memberships: BackupMembership[];
  if (hasGroups) {
    groups = parseGroups(value.label_groups);
    memberships = parseMemberships(value.label_group_memberships, groups);
    const membershipNames = new Set(memberships.map((item) => normalizedName(item.label_name)));
    for (const name of noteLabels) {
      if (!membershipNames.has(name)) invalid("label_group_memberships", "メモに含まれるラベル情報が一覧にありません。");
    }
  } else {
    groups = [];
    const names = new Map<string, string>();
    for (const note of notes) {
      for (const name of note.labels) names.set(normalizedName(name), name);
    }
    memberships = [...names.values()].map((label_name) => ({ label_name, group_id: null }));
  }

  return { format: MYKEEP_BACKUP_FORMAT, version: MYKEEP_BACKUP_VERSION, exported_at, notes, groups, memberships };
}
