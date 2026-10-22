import { useEffect, useState } from "react";
import { useI18n } from "./i18n";
import type { MessageKey } from "./i18n";
import { EMPTY_DATES, MAX_SAVED_SEARCHES, SAVED_SEARCHES_KEY, readSavedSearches, validDateRange } from "./listFilters";
import type { DateRange, ListCriteria, SavedSearch } from "./listFilters";

export function ListFilters({ criteria, onDates, onLoad }: {
  criteria: ListCriteria; onDates: (range: DateRange) => void; onLoad: (criteria: ListCriteria) => void;
}) {
  const { t } = useI18n();
  const [dates, setDates] = useState(criteria.dates);
  const [name, setName] = useState("");
  const [selected, setSelected] = useState("");
  const [message, setMessage] = useState<MessageKey | "">("");
  const [saved, setSaved] = useState<SavedSearch[]>(() => {
    try { return readSavedSearches(localStorage.getItem(SAVED_SEARCHES_KEY)); } catch { return []; }
  });
  useEffect(() => { setDates(criteria.dates); }, [criteria.dates]);
  function persist(next: SavedSearch[]): boolean {
    try { localStorage.setItem(SAVED_SEARCHES_KEY, JSON.stringify(next)); setSaved(next); return true; }
    catch { setMessage("このブラウザに設定を保存できませんでした。"); return false; }
  }
  return <details className="list-filters">
    <summary>{t("日付絞り込み・保存した条件")}{(criteria.dates.from || criteria.dates.to) && <span className="filter-active">{t("日付絞り込み中")}</span>}</summary>
    <form className="date-filter" onSubmit={(event) => { event.preventDefault(); if (validDateRange(dates)) onDates({ ...dates }); }}>
      <label>{t("対象の日付")}<select aria-label={t("対象の日付")} value={dates.field} onChange={(event) => setDates({ ...dates, field: event.target.value as DateRange["field"] })}>
        <option value="created">{t("作成日時")}</option><option value="updated">{t("更新日時")}</option>
      </select></label>
      <label>{t("開始日")}<input type="date" min="0001-01-01" max="9998-12-31" value={dates.from} onChange={(event) => setDates({ ...dates, from: event.target.value })} /></label>
      <label>{t("終了日")}<input type="date" min="0001-01-01" max="9998-12-31" value={dates.to} onChange={(event) => setDates({ ...dates, to: event.target.value })} /></label>
      <button type="submit" disabled={!validDateRange(dates)}>{t("適用")}</button>
      <button type="button" onClick={() => { setDates(EMPTY_DATES); onDates(EMPTY_DATES); }}>{t("日付をクリア")}</button>
      {!validDateRange(dates) && <p role="alert">{t("開始日は終了日以前にしてください。")}</p>}
    </form>
    <small>{t("端末のタイムゾーンで、終了日を含めて絞り込みます。")}</small>
    <form className="saved-search-create" onSubmit={(event) => {
      event.preventDefault();
      if (!name.trim() || saved.length >= MAX_SAVED_SEARCHES) return;
      const entry = { ...criteria, id: crypto.randomUUID(), name: name.trim() };
      if (persist([...saved, entry])) { setName(""); setSelected(entry.id); setMessage("条件を保存しました。"); }
    }}>
      <label>{t("条件の名前")}<input value={name} maxLength={60} onChange={(event) => setName(event.target.value)} /></label>
      <button type="submit" disabled={!name.trim() || saved.length >= MAX_SAVED_SEARCHES}>{t("現在の条件を保存")}</button>
    </form>
    <div className="saved-search-load">
      <label>{t("保存した条件")}<select aria-label={t("保存した条件")} value={selected} onChange={(event) => setSelected(event.target.value)}>
        <option value="">{t("条件を選択")}</option>{saved.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
      </select></label>
      <button type="button" disabled={!selected} onClick={() => { const item = saved.find((s) => s.id === selected); if (item) { onLoad(item); setMessage("条件を適用しました。"); } }}>{t("呼び出す")}</button>
      <button type="button" disabled={!selected} onClick={() => { if (persist(saved.filter((s) => s.id !== selected))) { setSelected(""); setMessage("保存した条件を削除しました。"); } }}>{t("条件を削除")}</button>
    </div>
    <small>{t("現在適用中の一覧・検索・ラベル・日付・並び順を、このブラウザに最大20件保存します。")}</small>
    {message && <p role="status">{t(message)}</p>}
  </details>;
}
