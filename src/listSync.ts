import { api, ApiError } from "./api";
import type { Note } from "./types";

export type NoteList = { notes: Note[]; hasMore: boolean; revision: number };
export type NoteCheck = {
  notes: Pick<Note, "id" | "updated_at" | "sync_version">[];
  hasMore: boolean; revision: number; unchanged?: boolean;
};
export const listChanged = (cause: unknown) => cause instanceof ApiError && cause.code === "list_changed";
const invalid = () => new Error("メモ一覧の応答が正しくありません。");

// Assemble off-screen; publish only a complete, consistent result. Retry one
// snapshot race, never restart indefinitely while another client keeps writing.
export async function syncNoteList(params: URLSearchParams, cached: Note[], count: number, signal: AbortSignal): Promise<NoteList> {
  for (let attempt = 0; ; attempt++) {
    try { return await snapshot(params, cached, count, signal); }
    catch (cause) { if (attempt >= 1 || !listChanged(cause) || signal.aborted) throw cause; }
  }
}

async function snapshot(params: URLSearchParams, cached: Note[], count: number, signal: AbortSignal): Promise<NoteList> {
  if (!cached.length && count <= 50) return api<NoteList>(`/api/notes?${params}`, { signal });
  const metadata: NoteCheck["notes"] = [];
  const ids = new Set<string>();
  let revision: number | null = null;
  let hasMore = false;
  for (let offset = 0; offset < count; offset += 500) {
    const query = new URLSearchParams(params);
    const limit = Math.min(500, count - offset);
    query.set("offset", String(offset)); query.set("limit", String(limit));
    if (revision !== null) query.set("revision", String(revision));
    const page = await api<NoteCheck>(`/api/notes/check?${query}`, { signal });
    if (!Array.isArray(page.notes) || page.notes.length > limit || !Number.isSafeInteger(page.revision)
      || typeof page.hasMore !== "boolean" || (revision !== null && page.revision !== revision)) throw invalid();
    revision = page.revision;
    for (const note of page.notes) {
      if (!note.id || ids.has(note.id)) throw invalid();
      ids.add(note.id); metadata.push(note);
    }
    hasMore = page.hasMore;
    if (!hasMore) break;
    if (page.notes.length !== limit) throw invalid();
  }
  const reusable = new Map(cached.map(note => [note.id, note]));
  const missing = metadata.filter(item => {
    const note = reusable.get(item.id);
    return !note || item.sync_version === undefined || note.sync_version !== item.sync_version || note.updated_at !== item.updated_at;
  });
  for (let offset = 0; offset < missing.length; offset += 50) {
    const requested = missing.slice(offset, offset + 50);
    const result = await api<{ notes: Note[]; revision: number }>("/api/notes/batch", {
      method: "POST", signal, body: JSON.stringify({ ids: requested.map(note => note.id), revision }),
    });
    if (!Array.isArray(result.notes) || result.notes.length !== requested.length || result.revision !== revision) throw invalid();
    const received = new Map(result.notes.map(note => [note.id, note]));
    for (const item of requested) {
      const note = received.get(item.id);
      if (!note || note.sync_version !== item.sync_version || note.updated_at !== item.updated_at) throw invalid();
      reusable.set(note.id, note);
    }
  }
  const finalQuery = new URLSearchParams(params);
  finalQuery.set("since", String(revision)); finalQuery.set("revision", String(revision));
  const final = await api<NoteCheck>(`/api/notes/check?${finalQuery}`, { signal });
  if (final.revision !== revision || !final.unchanged) throw invalid();
  return { notes: metadata.map(item => reusable.get(item.id)!), hasMore, revision: revision! };
}
