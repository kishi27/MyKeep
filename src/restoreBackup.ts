import { BlobReader, ZipReader } from "@zip.js/zip.js";
import type { FileEntry } from "@zip.js/zip.js";
import { parseBackupManifest } from "./backupFormat";
import type { BackupManifest, BackupAttachment } from "./backupFormat";

const MIB = 1024 * 1024;
const MAX_JSON = 64 * MIB;
const MAX_FILE = 20 * MIB;

export interface RestoreArchive {
  manifest: BackupManifest;
  attachmentTotal: number;
  missingAttachments: number;
  readAttachment: (attachment: BackupAttachment) => Promise<Blob | null>;
  close: () => Promise<void>;
}

function safePath(path: string): boolean {
  return !!path && !/[\\\x00-\x1f\x7f:]/.test(path) && !path.startsWith("/")
    && path.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

async function readEntry(entry: FileEntry, limit: number): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  await entry.getData(new WritableStream<Uint8Array>({
    write(chunk) {
      size += chunk.byteLength;
      if (size > limit || size > entry.uncompressedSize) throw new Error("バックアップの展開サイズが上限を超えています。");
      chunks.push(chunk.slice());
    },
  }), { checkCrc32: true });
  if (size !== entry.uncompressedSize) throw new Error("バックアップZIPを読み取れませんでした。");
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

export async function readBackupZip(file: Blob): Promise<RestoreArchive> {
  if (file.size > 4 * 1024 * MIB) throw new Error("バックアップZIPは4GB以下にしてください。");
  const reader = new ZipReader(new BlobReader(file), { useWebWorkers: false });
  try {
    const entries = new Map<string, FileEntry>();
    const names = new Set<string>();
    let expanded = 0;
    for await (const entry of reader.getEntriesGenerator()) {
      const path = entry.directory ? entry.filename.replace(/\/$/, "") : entry.filename;
      if (!safePath(path) || names.has(path) || entry.symlink || entry.encrypted) throw new Error("バックアップZIPのファイル構成が不正です。");
      names.add(path);
      if (names.size > 100_000) throw new Error("バックアップZIPのファイル数が上限を超えています。");
      if (entry.directory) continue;
      const limit = path === "notes.json" ? MAX_JSON : MAX_FILE;
      if (!Number.isSafeInteger(entry.uncompressedSize) || entry.uncompressedSize < 0 || entry.uncompressedSize > limit) {
        throw new Error("バックアップの展開サイズが上限を超えています。");
      }
      expanded += entry.uncompressedSize;
      if (expanded > 8 * 1024 * MIB) throw new Error("バックアップの展開サイズが上限を超えています。");
      entries.set(path, entry);
    }
    const jsonEntry = entries.get("notes.json");
    if (!jsonEntry) throw new Error("ZIP内にnotes.jsonがありません。");
    let manifest: BackupManifest;
    try {
      const bytes = await readEntry(jsonEntry, MAX_JSON);
      manifest = parseBackupManifest(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
    } catch {
      throw new Error("MyKeepバックアップの形式・バージョン・データを確認してください。");
    }
    const attachments = manifest.notes.flatMap((note) => note.attachments);
    // References are exact ZIP paths, never decoded or resolved against a filesystem.
    for (const attachment of attachments) {
      if (attachment.zip_path !== null && (!safePath(attachment.zip_path) || !attachment.zip_path.startsWith("attachments/"))) {
        throw new Error("バックアップZIPのファイル構成が不正です。");
      }
    }
    return {
      manifest,
      attachmentTotal: attachments.length,
      missingAttachments: attachments.filter((attachment) => !attachment.zip_path || !entries.has(attachment.zip_path)).length,
      async readAttachment(attachment) {
        const entry = attachment.zip_path ? entries.get(attachment.zip_path) : undefined;
        if (!entry) return null;
        const bytes = await readEntry(entry, MAX_FILE);
        if (!bytes.length) throw new Error("添付ファイルが空です。");
        return new Blob([bytes.buffer as ArrayBuffer], { type: attachment.mime_type });
      },
      close: () => reader.close(),
    };
  } catch (error) {
    await reader.close();
    const message = error instanceof Error ? error.message : "";
    if (/^(バックアップ|ZIP内に|MyKeepバックアップ)/.test(message)) throw error;
    throw new Error("バックアップZIPを読み取れませんでした。");
  }
}

type RestoreCounts = { total: number; done: number; added: number; skipped: number; failed: number };
export interface RestoreProgress {
  notes: RestoreCounts;
  groups: RestoreCounts;
  labels: RestoreCounts;
  attachments: RestoreCounts & { missing: number; blocked: number };
  conflicts: number;
  trashReset: number;
  imageFailed: number;
  partial: boolean;
}
type RestoreFetch = (path: string, init?: RequestInit) => Promise<Response>;

export async function restoreBackup(
  archive: RestoreArchive,
  onProgress: (progress: RestoreProgress) => void,
  fetcher: RestoreFetch = fetch,
): Promise<RestoreProgress> {
  const counts = (total: number): RestoreCounts => ({ total, done: 0, added: 0, skipped: 0, failed: 0 });
  const progress: RestoreProgress = {
    notes: counts(archive.manifest.notes.length), groups: counts(archive.manifest.groups.length),
    labels: counts(archive.manifest.memberships.length),
    attachments: { ...counts(archive.attachmentTotal), missing: 0, blocked: 0 },
    conflicts: 0, trashReset: 0, imageFailed: 0, partial: false,
  };
  function report() {
    progress.partial = !!(progress.notes.failed + progress.groups.failed + progress.labels.failed + progress.attachments.failed
      + progress.attachments.missing + progress.attachments.blocked + progress.conflicts + progress.imageFailed);
    onProgress({ ...progress, notes: { ...progress.notes }, groups: { ...progress.groups },
      labels: { ...progress.labels }, attachments: { ...progress.attachments } });
  }
  async function request<T>(endpoint: string, body: unknown | FormData): Promise<T> {
    const form = body instanceof FormData;
    const response = await fetcher(`/api/backup/restore/${endpoint}`, {
      method: "POST", headers: form ? undefined : { "Content-Type": "application/json" },
      body: form ? body : JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`restore_${response.status}`);
    return response.json() as Promise<T>;
  }
  report();
  const groupMap = new Map<string, string>();
  const readyLabels = new Set<string>();
  const labelKey = (name: string) => name.trim().normalize("NFC").toLowerCase();
  for (let start = 0; start < archive.manifest.groups.length; start += 10) {
    const groups = archive.manifest.groups.slice(start, start + 10);
    try {
      const result = await request<{ groupMap: Record<string, string>; created: number; reused: number; conflicts: number }>("groups", { groups });
      for (const [source, destination] of Object.entries(result.groupMap)) groupMap.set(source, destination);
      progress.groups.added += result.created;
      progress.groups.skipped += result.reused;
      progress.conflicts += result.conflicts;
    } catch { progress.groups.failed += groups.length; }
    progress.groups.done += groups.length;
    report();
  }
  for (let start = 0; start < archive.manifest.memberships.length; start += 50) {
    const source = archive.manifest.memberships.slice(start, start + 50);
    const memberships = source.flatMap((item) => {
      if (item.group_id !== null && !groupMap.has(item.group_id)) { progress.labels.failed += 1; return []; }
      return [{ ...item, group_id: item.group_id === null ? null : groupMap.get(item.group_id)! }];
    });
    if (memberships.length) {
      try {
        const result = await request<{ labelsCreated: number; labelsReused: number; membershipConflicts: number }>("labels", { memberships });
        progress.labels.added += result.labelsCreated;
        progress.labels.skipped += result.labelsReused;
        progress.conflicts += result.membershipConflicts;
        for (const item of memberships) readyLabels.add(labelKey(item.label_name));
      } catch { progress.labels.failed += memberships.length; }
    }
    progress.labels.done += source.length;
    report();
  }
  for (const note of archive.manifest.notes) {
    let eligible = false;
    let cardImagePending = false;
    const existingAttachmentIds = new Set<string>();
    try {
      if (note.labels.some((name) => !readyLabels.has(labelKey(name)))) throw new Error("restore_labels_incomplete");
      const result = await request<{ status: "restored" | "skipped_existing"; conflict: boolean;
        canRestoreAttachments: boolean; trashReset: boolean; cardImagePending: boolean; existingAttachmentIds?: string[] }>("notes", { note });
      if (result.status === "restored") progress.notes.added += 1;
      else progress.notes.skipped += 1;
      if (result.conflict) progress.conflicts += 1;
      if (result.trashReset) progress.trashReset += 1;
      eligible = result.canRestoreAttachments;
      cardImagePending = result.cardImagePending;
      for (const id of result.existingAttachmentIds ?? []) existingAttachmentIds.add(id);
    } catch { progress.notes.failed += 1; }
    progress.notes.done += 1;
    report();
    for (const attachment of note.attachments) {
      if (!eligible) {
        progress.attachments.skipped += 1;
        progress.attachments.blocked += 1;
      } else if (existingAttachmentIds.has(attachment.id)) {
        progress.attachments.skipped += 1;
      } else {
        try {
          const blob = await archive.readAttachment(attachment);
          if (!blob) {
            progress.attachments.skipped += 1;
            progress.attachments.missing += 1;
          } else {
            const form = new FormData();
            form.set("note", JSON.stringify(note));
            form.set("attachment", JSON.stringify(attachment));
            form.set("file", blob, attachment.filename);
            const result = await request<{ status: "restored" | "skipped_existing"; conflict: boolean }>("attachments", form);
            if (result.conflict) { progress.attachments.failed += 1; progress.conflicts += 1; }
            else if (result.status === "restored") progress.attachments.added += 1;
            else progress.attachments.skipped += 1;
          }
        } catch { progress.attachments.failed += 1; }
      }
      progress.attachments.done += 1;
      report();
    }
    if (eligible && cardImagePending) {
      try {
        const result = await request<{ cardImageRestored: boolean; cardImageMissing: boolean }>("finalize", { note });
        if (result.cardImageMissing) progress.imageFailed += 1;
      } catch { progress.imageFailed += 1; }
      report();
    }
  }
  return progress;
}
