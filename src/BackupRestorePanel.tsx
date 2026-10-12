import { useEffect, useRef, useState } from "react";
import type { ChangeEvent } from "react";
import { useI18n } from "./i18n";
import { readBackupZip, restoreBackup } from "./restoreBackup";
import type { RestoreArchive, RestoreProgress } from "./restoreBackup";
import { pinSnapshot } from "./pinLock";

export function BackupRestorePanel({ busy, onBusy, onComplete }: {
  busy: boolean; onBusy: (busy: boolean) => void; onComplete: () => void;
}) {
  const { t, uiMessage } = useI18n();
  const archiveRef = useRef<RestoreArchive | null>(null);
  const [archive, setArchive] = useState<RestoreArchive | null>(null);
  const [message, setMessage] = useState("");
  const [progress, setProgress] = useState<RestoreProgress | null>(null);
  useEffect(() => () => {
    // Retain the selected ZIP when PIN locking suspends this panel's effects.
    if (pinSnapshot().phase === "unlocked") void archiveRef.current?.close();
  }, []);

  async function selectZip(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file || busy) return;
    onBusy(true);
    setMessage("ZIPを解析中…");
    setProgress(null);
    setArchive(null);
    try {
      await archiveRef.current?.close();
      archiveRef.current = null;
      const extracted = await readBackupZip(file);
      archiveRef.current = extracted;
      setArchive(extracted);
      setMessage("");
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "バックアップZIPを読み取れませんでした。");
    } finally { onBusy(false); }
  }

  async function startRestore() {
    if (!archive || busy) return;
    onBusy(true);
    setMessage("追加復元中…");
    setProgress(null);
    try {
      const result = await restoreBackup(archive, setProgress);
      setMessage(result.partial ? "追加復元が終了しました。一部のデータは復元されていません。" : "追加復元が完了しました。");
    } catch {
      setMessage("追加復元が中断しました。同じZIPから再試行できます。");
    } finally {
      onComplete();
      onBusy(false);
    }
  }

  return <div className="import-content restore-backup">
    <h3>{t("MyKeepバックアップから復元")}</h3>
    <p>{t("既存データは削除・上書きされません。")}</p>
    <label>{t("MyKeepバックアップZIPを選択")}
      <input type="file" accept=".zip,application/zip" disabled={busy} onChange={selectZip} />
    </label>
    {archive && <>
      <p>{t("復元対象：メモ {0}件／ラベル {1}件／親グループ {2}件／添付 {3}件", {
        0: archive.manifest.notes.length, 1: archive.manifest.memberships.length,
        2: archive.manifest.groups.length, 3: archive.attachmentTotal,
      })}</p>
      {archive.missingAttachments > 0 && <p>{t("ZIP内にない添付：{0}件。メモ本体は復元できます。", { 0: archive.missingAttachments })}</p>}
      <button type="button" className="primary" disabled={busy} onClick={() => void startRestore()}>{t("追加復元を開始")}</button>
    </>}
    {message && <p role="status">{uiMessage(message)}</p>}
    {progress && <div className="restore-results" aria-live="polite">
      <p>{t("メモ")}: {progress.notes.done} / {progress.notes.total}<br />
        {t("新規追加 {0}件／既存のためスキップ {1}件／失敗 {2}件", { 0: progress.notes.added, 1: progress.notes.skipped, 2: progress.notes.failed })}</p>
      <p>{t("ラベル追加 {0}件／親グループ追加 {1}件／既存利用 {2}件／失敗 {3}件", {
        0: progress.labels.added, 1: progress.groups.added, 2: progress.labels.skipped + progress.groups.skipped,
        3: progress.labels.failed + progress.groups.failed,
      })}</p>
      <p>{t("画像・添付")}: {progress.attachments.done} / {progress.attachments.total}<br />
        {t("復元成功 {0}件／スキップ {1}件／失敗 {2}件", {
          0: progress.attachments.added, 1: progress.attachments.skipped, 2: progress.attachments.failed,
        })}<br />
        {t("添付欠損 {0}件／同一性を確認できず添付を保留 {1}件", { 0: progress.attachments.missing, 1: progress.attachments.blocked })}</p>
      <p>{t("既存データを優先した競合 {0}件／ゴミ箱状態を解除 {1}件／代表画像の復元失敗 {2}件", {
        0: progress.conflicts, 1: progress.trashReset, 2: progress.imageFailed,
      })}</p>
      {progress.imageFailed > 0 && <p>{t("代表画像は安全のため自動選択のままになる場合があります。復元後に編集画面で選び直せます。")}</p>}
    </div>}
    <p className="restore-hint">{t("同じZIPで再試行できます。既存IDのメモは増えず、同一性を確認できたメモの不足添付だけを追加します。")}</p>
    <p className="restore-hint">{t("外部プレビュー画像はURLのみ復元します。画像本体はZIPに含まれません。")}</p>
  </div>;
}
