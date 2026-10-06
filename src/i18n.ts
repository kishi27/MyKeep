import { createContext, useContext } from "react";

export type Language = "ja" | "en";
export const LANGUAGE_SETTING = "mykeep.language";
export function savedLanguage(): Language {
  try { return localStorage.getItem(LANGUAGE_SETTING) === "en" ? "en" : "ja"; }
  catch { return "ja"; }
}

// Japanese keys also serve as the original text for messages kept in component state.
const english = {
  "画像ビューア": "Image viewer", "元画像を開く": "Open original image", "画像ビューアを閉じる": "Close image viewer",
  "閉じる": "Close", "前の画像": "Previous image", "次の画像": "Next image", "← 前": "← Previous", "次 →": "Next →",
  "📌 ピン留め": "📌 Pinned", "📦 アーカイブ": "📦 Archived", "📎 添付ファイル {0}件": "📎 Attachments: {0}",
  "ラベル名は1〜100文字で入力してください。": "Enter a label name of 1–100 characters.",
  "ラベルを作成できませんでした。": "Could not create the label.", "＋ 新規ラベルを作成": "+ Create new label",
  "新しいラベル名": "New label name", "追加": "Add", "メモが見つかりません。": "Note not found.",
  "読み込みに失敗しました。": "Could not load the data.", "ラベルは50件まで選択できます。": "You can select up to 50 labels.",
  "ラベル名を変更できませんでした。": "Could not rename the label.", "ラベルを削除できませんでした。": "Could not delete the labels.",
  "保存に失敗しました。": "Could not save the note.", "アーカイブから戻しました。": "Moved back from Archive.",
  "アーカイブしました。": "Archived.", "ピンを解除しました。": "Unpinned.", "更新に失敗しました。": "Could not update the note.",
  "ゴミ箱に移動しました。": "Moved to Trash.", "削除に失敗しました。": "Could not delete the note.",
  "取り消しに失敗しました。": "Could not undo the action.", "メモに戻しました。": "Moved back to Notes.",
  "復元しました。": "Restored.", "完全削除しました。": "Permanently deleted.", "ラベルを追加しました。": "Labels added.",
  "追加する既存ラベルを選び直してください。": "Select existing labels to add again.", "1メモのラベルは50件までです。": "A note can have up to 50 labels.",
  "処理に失敗しました。": "The operation failed.", "このメモをゴミ箱に移動しますか？": "Move this note to Trash?",
  "復元に失敗しました。": "Could not restore the note.",
  "このメモと添付画像を完全に削除しますか？元に戻せません。": "Permanently delete this note and its attachments? This cannot be undone.",
  "完全削除に失敗しました。": "Could not permanently delete the note.", "ゴミ箱を空にしました。": "Trash emptied.",
  "ゴミ箱を空にできませんでした。": "Could not empty Trash.", "この画像を削除しますか？": "Delete this image?",
  "画像の削除に失敗しました。": "Could not delete the image.", "ZIPを解析中…": "Reading ZIP…", "インポート中…": "Importing…",
  "インポート完了": "Import complete", "インポートに失敗しました。": "Import failed.", "エクスポート完了": "Export complete",
  "エクスポートに失敗しました。": "Export failed.", "サムネイル": "Thumbnail", "無題のメモ": "Untitled note",
  "まもなく完全削除": "Permanent deletion soon", "復元": "Restore", "完全削除": "Delete permanently", "ピン解除": "Unpin",
  "ピン留め": "Pin", "戻す": "Unarchive", "アーカイブ": "Archive", "ゴミ箱": "Trash", "メニューを開く": "Open menu",
  "メモへ戻る": "Go to Notes", "検索": "Search", "タイトル・本文・URL": "Title, body or URL", "検索をクリア": "Clear search",
  "選択モードを終了": "Exit selection mode", "メモを選択": "Select notes", "選択を終了": "Exit selection", "選択": "Select",
  "更新": "Refresh", "設定メニュー": "Settings menu", "設定": "Settings", "新規メモ": "New note", "メニューを閉じる": "Close menu",
  "サイドバー": "Sidebar", "メモの表示": "Note views", "メモ": "Notes", "ピンあり": "Pinned", "ピンなし": "Unpinned",
  "ラベルなし": "Unlabeled", "画像なし": "Without images", "ラベル": "Labels", "ラベル整理": "Manage labels",
  "更新中…": "Refreshing…", "離して更新": "Release to refresh", "引っ張って更新": "Pull to refresh",
  "ゴミ箱内のメモは7日後に削除されます。": "Notes in Trash are permanently deleted after 7 days.", "ゴミ箱を空にする": "Empty Trash",
  "該当するメモはありません。": "No matching notes.", "メモはまだありません。": "No notes yet.", "ピンありのメモはありません。": "No pinned notes.",
  "ピンなしのメモはありません。": "No unpinned notes.", "ラベルなしのメモはありません。": "No unlabeled notes.",
  "画像なしのメモはありません。": "No notes without images.", "アーカイブはありません。": "Archive is empty.", "ゴミ箱は空です。": "Trash is empty.",
  "ゴミ箱一覧": "Trash notes", "ピン留めメモ": "Pinned notes", "メモ一覧": "Notes", "ピンなしメモ一覧": "Unpinned notes",
  "ラベルなしメモ一覧": "Unlabeled notes", "画像なしメモ一覧": "Notes without images", "アーカイブ一覧": "Archived notes",
  "読み込み中…": "Loading…", "一括操作": "Bulk actions", "全選択": "Select all", "全解除": "Deselect all", "終了": "Done",
  "このラベルを外す": "Remove this label", "メモに戻す": "Move to Notes", "他のラベルを付ける": "Add other labels", "処理中…": "Working…",
  "取り消す": "Undo", "一括ラベル追加": "Add labels to selected notes", "ラベルを追加": "Add labels",
  "登録済みラベルはありません。": "No saved labels.", "キャンセル": "Cancel", "適用": "Apply",
  "リッチリンクプレビュー": "Rich link previews", "タイトル表示": "Show titles", "本文表示": "Show body text", "ダークモード": "Dark mode",
  "自動更新間隔": "Auto-refresh interval", "言語": "Language", "インポート": "Import", "エクスポート": "Export",
  "これらのラベルはメモからも外れます。メモ本体は削除されません。": "These labels will also be removed from notes. The notes themselves will remain.",
  "ラベル名を変更": "Rename label", "変更後のラベル名": "New label name", "保存": "Save", "ラベルはありません。": "No labels.",
  "削除": "Delete", "選択したラベルを削除": "Delete selected labels", "Google Keep インポート": "Google Keep Import",
  "Takeout ZIPを選択": "Choose Takeout ZIP", "成功": "Succeeded", "ゴミ箱として取込": "Imported to Trash", "失敗": "Failed", "スキップ": "Skipped",
  "画像・添付": "Images / attachments", "メモ取得": "Fetching notes", "添付取得": "Fetching attachments", "添付成功": "Attachments saved",
  "添付失敗": "Attachments failed", "ZIP作成中...": "Creating ZIP…", "メモ取得中...": "Fetching notes…", "添付取得中...": "Fetching attachments…",
  "メモを編集": "Edit note", "タイトル": "Title", "本文": "Body", "チェックリスト": "Checklist", "＋ 項目を追加": "+ Add item", "項目": "Item",
  "ラベルを選択": "Select labels", "新しいラベル": "New label", "色": "Color", "メモの色": "Note color", "添付ファイル": "Attachments",
  "画像を追加": "Add images", "ファイルを選択": "Choose files", "Ctrl+Vで貼り付け / ここへドラッグ＆ドロップ": "Paste with Ctrl+V / drag and drop here",
  "保存済み": "Saved", "カードに表示する画像": "Image shown on card", "自動": "Auto", "カード表示": "Show on card",
  "サムネイルを拡大表示": "Enlarge thumbnail", "リンクサムネイル": "Link thumbnail", "サムネイルをカードに表示": "Show thumbnail on card",
  "追加予定": "Pending", "ゴミ箱へ": "Move to Trash", "保存中…": "Saving…",
  "「{0}」を作成しました。": "Created “{0}”.", "「{0}」は既に存在します。": "“{0}” already exists.",
  "{0} 更新ボタンで再試行してください。": "{0} Try again with Refresh.",
  "メモは保存しました。画像のアップロードに失敗: {0}。保存を押すと再試行できます。": "Note saved. Images failed to upload: {0}. Press Save to retry.",
  "選択した{0}件を完全に削除しますか？\nこの操作は元に戻せません。": "Permanently delete the {0} selected notes?\nThis cannot be undone.",
  "「{0}」を外しました。": "Removed “{0}”.", "成功 {0}件 / 失敗 {1}件{2}": "Succeeded: {0} / Failed: {1}{2}",
  "取り消し成功 {0}件 / 失敗 {1}件": "Undo succeeded: {0} / Failed: {1}",
  "ゴミ箱内の{0}件のメモを完全に削除しますか？\nこの操作は取り消せません。": "Permanently delete all {0} notes in Trash?\nThis cannot be undone.",
  "{0}件を完全削除しました。{1}件の削除に失敗しました。残ったメモは再試行できます。": "Deleted {0} notes permanently. {1} failed. You can retry the remaining notes.",
  "{0}: JPEG・PNG・WebP・GIF・AVIF のみ対応しています。": "{0}: Only JPEG, PNG, WebP, GIF and AVIF are supported.",
  "{0}: 1枚20MB以下にしてください。": "{0}: Each image must be 20 MB or smaller.",
  "完全削除まで あと{0}日": "{0} days until permanent deletion", "{0}件選択": "{0} selected", "{0}秒": "{0} seconds",
  "「{0}」を削除しますか？": "Delete “{0}”?", "選択した{0}件のラベルを削除しますか？": "Delete the {0} selected labels?",
  "{0}のラベル名を変更": "Rename label {0}", "{0}番目の項目をチェック": "Check item {0}", "{0}番目の項目": "Item {0}",
  "{0}番目の項目を削除": "Delete item {0}", "{0}を解除": "Remove {0}", "{0}を拡大表示": "Enlarge {0}", "{0}を削除": "Delete {0}",
  "{0}をカードに表示": "Show {0} on card", "{0}を取り消す": "Cancel {0}", "{0}を編集": "Edit {0}",
  "{0}を選択": "Select {0}", "{0}の選択を解除": "Deselect {0}", "{0}件: {1}": "{0} notes: {1}",
  "応答を読み取れませんでした。ページを再読み込みしてください。": "Could not read the response. Reload the page.",
  "一覧の指定が正しくありません。": "Invalid list filters.", "ラベル名を確認してください。": "Check the label name.",
  "ラベルが見つかりません。": "Label not found.", "ラベルの指定が正しくありません。": "Invalid labels.",
  "削除するラベルを1〜50件指定してください。": "Choose 1–50 labels to delete.", "変更先のラベルは既に存在します。": "That label name already exists.",
  "メモの内容を確認してください。": "Check the note contents.", "カード画像を確認してください。": "Check the card image.",
  "インポートするメモを確認してください。": "Check the note to import.", "ゴミ箱の指定が正しくありません。": "Invalid Trash option.",
  "日時を確認してください。": "Check the dates.", "ゴミ箱日時を確認してください。": "Check the Trash date.",
  "添付ファイルの形式を確認してください。": "Check the attachment format.", "ファイル名を確認してください。": "Check the filename.",
  "添付ファイルは20MB以下にしてください。": "Attachments must be 20 MB or smaller.", "添付ファイルが空です。": "The attachment is empty.",
  "画像が見つかりません。": "Image not found.", "見つかりません。": "Not found.", "この操作は許可されていません。": "This operation is not allowed.",
  "送信内容を確認してください。": "Check the submitted data.", "ZIP内にGoogle KeepのJSONが見つかりません。": "No Google Keep JSON files found in the ZIP.",
  "メモ一覧の応答が正しくありません。": "Invalid note list response.", "データ取得に失敗しました（HTTP {0}）。": "Could not fetch data (HTTP {0}).",
} as const;

export type MessageKey = keyof typeof english;
type Values = Record<string, string | number>;
const numberFormats = { ja: new Intl.NumberFormat("ja-JP"), en: new Intl.NumberFormat("en-US") };
export function formatMessage(key: MessageKey, values: Values = {}, language: Language = "ja"): string {
  let text: string = language === "en" ? english[key] : key;
  if (language === "en" && String(values[0]) === "1") {
    text = text.replace("{0} days", "{0} day").replace("{0} notes", "{0} note").replace("{0} selected notes", "{0} selected note");
  }
  return text.replace(/\{(\d+)\}/g, (_, name: string) => {
    const value = values[name];
    return typeof value === "number" ? numberFormats[language].format(value) : String(value ?? "");
  });
}

// Only use this for UI status/error strings, never for saved note data.
const patterns = (Object.keys(english) as MessageKey[]).filter((key) => key.includes("{0}")).map((key) => ({
  key,
  regex: new RegExp("^" + key.split(/\{\d+\}/).map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("([^\\n]*?)") + "$"),
}));
export function translateMessage(text: string, language: Language): string {
  if (language === "ja") return text;
  if (Object.hasOwn(english, text)) return english[text as MessageKey];
  for (const { key, regex } of patterns) {
    const match = regex.exec(text);
    if (match) return formatMessage(key, Object.fromEntries(match.slice(1).map((value, i) => {
      // Names and filenames are data. Only nested UI messages are translated again.
      const nested = (key === "{0} 更新ボタンで再試行してください。" && i === 0)
        || (key === "{0}件: {1}" && i === 1) || (key === "成功 {0}件 / 失敗 {1}件{2}" && i === 2);
      return [i, nested ? translateMessage(value, language) : value];
    })), language);
  }
  if (text.includes("\n")) return text.split("\n").map((line) => translateMessage(line, language)).join("\n");
  // Multiple attachment errors are joined with newlines; known API errors can also be nested in a bulk result.
  let translated = text;
  for (const key of Object.keys(english) as MessageKey[]) {
    if (!key.includes("{0}") && /[。…]$/.test(key)) translated = translated.split(key).join(english[key]);
  }
  return translated;
}

export const LanguageContext = createContext<{ language: Language; setLanguage: (language: Language) => void }>({ language: "ja", setLanguage: () => {} });
export function useI18n() {
  const { language, setLanguage } = useContext(LanguageContext);
  const locale = language === "en" ? "en-US" : "ja-JP";
  return { language, setLanguage, locale, t: (key: MessageKey, values?: Values) => formatMessage(key, values, language),
    uiMessage: (text: string) => translateMessage(text, language) };
}
