export const VIEWS = ["active", "pinned", "unpinned", "unlabeled", "imageless", "archived", "trash"] as const;
export type View = typeof VIEWS[number];
export const NOTE_SORTS = ["updated_desc", "updated_asc", "created_desc", "created_asc"] as const;
export type NoteSort = typeof NOTE_SORTS[number];
export type DateRange = { field: "created" | "updated"; from: string; to: string };
export type ListCriteria = { view: View; search: string; label: string; sort: NoteSort; dates: DateRange };
export type SavedSearch = ListCriteria & { id: string; name: string };
export const EMPTY_DATES: DateRange = { field: "created", from: "", to: "" };
export const SAVED_SEARCHES_KEY = "mykeep.savedSearches";
export const MAX_SAVED_SEARCHES = 20;

export function validCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value < "0001-01-01" || value > "9998-12-31") return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function validDateRange(value: DateRange): boolean {
  return (value.field === "created" || value.field === "updated")
    && (!value.from || validCalendarDate(value.from)) && (!value.to || validCalendarDate(value.to))
    && (!value.from || !value.to || value.from <= value.to);
}

export function addDateParams(params: URLSearchParams, range: DateRange) {
  if (!validDateRange(range)) throw new Error("invalid_date_range");
  if (!range.from && !range.to) return;
  params.set("date_field", range.field);
  if (range.from) params.set("from", new Date(`${range.from}T00:00:00`).toISOString());
  if (range.to) {
    const end = new Date(`${range.to}T00:00:00`);
    end.setDate(end.getDate() + 1); // Next local midnight, including DST days.
    params.set("before", end.toISOString());
  }
}

export function readSavedSearches(raw: string | null): SavedSearch[] {
  try {
    const values: unknown = JSON.parse(raw ?? "[]");
    if (!Array.isArray(values)) return [];
    const ids = new Set<string>();
    return values.filter((entry): entry is SavedSearch => {
      if (!entry || typeof entry !== "object") return false;
      const s = entry as SavedSearch;
      if (typeof s.id !== "string" || !s.id || s.id.length > 100 || ids.has(s.id)
        || typeof s.name !== "string" || !s.name.trim() || s.name.length > 60
        || !VIEWS.includes(s.view) || !NOTE_SORTS.includes(s.sort)
        || typeof s.search !== "string" || s.search.length > 200 || typeof s.label !== "string" || s.label.length > 100
        || !s.dates || typeof s.dates.from !== "string" || typeof s.dates.to !== "string" || !validDateRange(s.dates)) return false;
      ids.add(s.id);
      return true;
    }).slice(0, MAX_SAVED_SEARCHES);
  } catch { return []; }
}
