import { useEffect, useRef, useState } from "react";
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
  const [rename, setRename] = useState<string | null>(null);
  const renameRef = useRef<HTMLInputElement>(null);
  const [message, setMessage] = useState<MessageKey | "">("");
  const [saved, setSaved] = useState<SavedSearch[]>(() => {
    try { return readSavedSearches(localStorage.getItem(SAVED_SEARCHES_KEY)); } catch { return []; }
  });
  useEffect(() => { setDates(criteria.dates); }, [criteria.dates]);
  useEffect(() => { if (rename !== null) renameRef.current?.focus(); }, [rename !== null]);
  function persist(next: SavedSearch[]): boolean {
    try { localStorage.setItem(SAVED_SEARCHES_KEY, JSON.stringify(next)); setSaved(next); return true; }
    catch { setMessage("このブラウザに設定を保存できませんでした。"); return false; }
  }
  return <div className="list-filters">
    {(criteria.dates.from || criteria.dates.to) && <div className="filter-active" role="status">
      <span>{t(criteria.dates.field === "created" ? "作成日時" : "更新日時")}: {criteria.dates.from || "…"} ～ {criteria.dates.to || "…"}</span>
      <button type="button" aria-label={t("日付をクリア")} title={t("日付をクリア")} onClick={() => { setDates(EMPTY_DATES); onDates(EMPTY_DATES); }}>×</button>
    </div>}
    <details className="date-filter-panel">
    <summary>{t("日付絞り込み")}</summary>
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
    </details>
    <details className="saved-search-panel">
    <summary>{t("保存した条件")}</summary>
    <form className="saved-search-create" onSubmit={(event) => {
      event.preventDefault();
      if (!name.trim() || saved.length >= MAX_SAVED_SEARCHES) return;
      const entry = { ...criteria, id: crypto.randomUUID(), name: name.trim() };
      if (persist([...saved, entry])) { setName(""); setSelected(entry.id); setRename(null); setMessage("条件を保存しました。"); }
    }}>
      <label>{t("条件の名前")}<input value={name} maxLength={60} onChange={(event) => setName(event.target.value)} /></label>
      <button type="submit" disabled={!name.trim() || saved.length >= MAX_SAVED_SEARCHES}>{t("現在の条件を保存")}</button>
    </form>
    <div className="saved-search-load">
      <label>{t("保存した条件")}<select aria-label={t("保存した条件")} value={selected} onChange={(event) => { setSelected(event.target.value); setRename(null); }}>
        <option value="">{t("条件を選択")}</option>{saved.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
      </select></label>
      <button type="button" disabled={!selected} onClick={() => { const item = saved.find((s) => s.id === selected); if (item) { onLoad(item); setMessage("条件を適用しました。"); } }}>{t("呼び出す")}</button>
      <button type="button" disabled={!selected} onClick={() => setRename(saved.find((s) => s.id === selected)?.name ?? null)}>{t("名前変更")}</button>
      <button type="button" disabled={!selected} onClick={() => { if (persist(saved.filter((s) => s.id !== selected))) { setSelected(""); setRename(null); setMessage("保存した条件を削除しました。"); } }}>{t("条件を削除")}</button>
    </div>
    {rename !== null && <form className="saved-search-create" onSubmit={(event) => {
      event.preventDefault();
      if (rename.trim() && selected && persist(saved.map((item) => item.id === selected ? { ...item, name: rename.trim() } : item))) {
        setRename(null); setMessage("条件の名前を変更しました。");
      }
    }}>
      <label>{t("新しい条件名")}<input ref={renameRef} value={rename} maxLength={60} onChange={(event) => setRename(event.target.value)} /></label>
      <button type="submit" disabled={!rename.trim()}>{t("保存")}</button>
      <button type="button" onClick={() => setRename(null)}>{t("キャンセル")}</button>
    </form>}
    <small>{t("現在適用中の一覧・検索・ラベル・日付・並び順を、このブラウザに最大20件保存します。")}</small>
    </details>
    {message && <p role="status">{t(message)}</p>}
  </div>;
}
