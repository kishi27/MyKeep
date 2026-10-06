const messages = {
  ja: {
    "popup.title": "MyKeepに保存",
    "popup.openMyKeep": "MyKeepで表示",
    "popup.save": "保存",
    "popup.field.title": "タイトル",
    "popup.field.url": "URL",
    "popup.field.note": "メモ",
    "popup.notePlaceholder": "任意のメモ",
    "popup.field.labels": "ラベル",
    "popup.selectLabels": "ラベルを選択",
    "popup.selectedLabelsOne": "ラベル（{count}件）",
    "popup.selectedLabelsMany": "ラベル（{count}件）",
    "popup.removeLabel": "{label}を解除",
    "popup.pinned": "ピン留め",
    "popup.field.image": "画像",
    "popup.pasteImage": "画像はここで Ctrl+V でも貼り付けできます",
    "popup.imagePreviewAlt": "添付画像のプレビュー",
    "popup.removeImage": "画像を外す",
    "popup.noLabels": "既存ラベルはありません。",
    "popup.labelsLoadFailed": "既存ラベルを読み込めませんでした。",
    "popup.pageUnreadable": "現在のページを読み取れませんでした。",
    "popup.imageTypeError": "JPEG・PNG・WebP・GIF・AVIF の画像を選んでください。",
    "popup.imageSizeError": "画像は1枚20MB以下にしてください。",
    "popup.pastedImageName": "貼り付けた画像",
    "popup.saving": "保存中…",
    "popup.saved": "保存しました。",
    "popup.error.apiKeyRequired": "設定で API URL と API KEY を保存してください。",
    "popup.error.invalidPageUrl": "このページのURLは保存できません。",
    "popup.error.openFailed": "MyKeepを開けませんでした。",
    "popup.error.saveFailed": "保存できませんでした。",
    "popup.error.sendFailed": "送信できませんでした。",
    "options.title": "MyKeepの設定",
    "options.apiUrl": "API URL",
    "options.apiKey": "API KEY",
    "options.language": "言語",
    "options.save": "設定を保存",
    "options.settingsSaved": "設定を保存しました。",
    "options.settingsLoadFailed": "設定を読み込めませんでした。",
    "options.apiKeyRequired": "API KEYを入力してください。",
    "options.apiPermissionRequired": "API URLへの接続許可が必要です。",
    "options.settingsSaveFailed": "設定を保存できませんでした。",
    "repair.title": "サムネイル補完",
    "repair.intro": "画像がないメモのURLをChromeで1件ずつ開いて補完します。通常メモとアーカイブが対象です。",
    "repair.permissionInfo": "開始時にサイトへのアクセス許可を確認します。設定画面を閉じても処理は続きます。",
    "repair.countUnknown": "未取得件数：未確認",
    "repair.count": "未取得件数：{count}件",
    "repair.checkCount": "未取得件数を確認",
    "repair.start": "サムネイル補完を開始",
    "repair.pause": "一時停止",
    "repair.resume": "続きから再開",
    "repair.cancel": "中止",
    "repair.retry": "失敗分だけ再試行",
    "repair.clear": "結果をクリア",
    "repair.status.running": "処理中",
    "repair.status.paused": "一時停止",
    "repair.status.cancelled": "中止しました",
    "repair.status.completed": "処理完了",
    "repair.progress": "{state}：{processed} / {total}\n成功：{success}　失敗：{failed}{finishing}",
    "repair.finishing": "\n現在の1件を終了しています。",
    "repair.notConfigured": "先にAPI URLとAPI KEYを設定してください。",
    "repair.sitePermissionRequired": "サムネイル補完にはサイトへのアクセス許可が必要です。",
    "repair.startFailed": "処理を開始できませんでした。",
    "repair.checkFailed": "処理を確認できませんでした。",
    "repair.extensionReload": "拡張を再読み込みしてから設定を開き直してください。",
    "repair.error.paused": "処理を一時停止しました。API設定・接続・作業タブを確認して再開してください。",
    "repair.error.closeTab": "作業タブを閉じられません。タブを閉じてから再開してください。",
    "repair.error.closePreviousTab": "前回の作業タブを閉じてから再開してください。",
    "repair.error.apiPermission": "API URLへの接続許可を設定画面で保存してください。",
    "repair.error.apiChanged": "API設定が変更されました。",
    "repair.error.listUnavailable": "一覧を確認できません。",
    "repair.error.cursorUnavailable": "一覧のカーソルを確認できません。",
    "repair.error.clearWhileRunning": "処理中は結果をクリアできません。現在の1件が終了するまでお待ちください。",
    "repair.error.cancelBeforeClear": "中止してから結果をクリアしてください。",
    "repair.error.countUnavailable": "未取得件数を確認できません。",
    "repair.error.invalidAction": "操作を確認してください。",
    "repair.error.waitForCurrent": "処理中です。現在の1件が終了するまでお待ちください。",
    "repair.error.sitePermission": "サイトへのアクセス許可が必要です。",
    "repair.error.nothingToResume": "再開する処理がありません。",
    "repair.error.sameApiToResume": "前回と同じAPI URLを設定してから再開してください。",
    "repair.error.nothingToRetry": "再試行する失敗はありません。",
    "repair.error.sameApiToRetry": "前回と同じAPI URLを設定してください。",
    "repair.error.apiConnection": "APIへの接続を確認してください。",
    "repair.error.generic": "処理を確認できませんでした。",
    "api.error.invalidList": "一覧の指定が正しくありません。",
    "api.error.invalidLabel": "ラベル名を確認してください。",
    "api.error.invalidLabelLength": "ラベル名は1〜100文字で入力してください。",
    "api.error.labelNotFound": "ラベルが見つかりません。",
    "api.error.invalidLabels": "ラベルの指定が正しくありません。",
    "api.error.invalidLabelsCount": "削除するラベルを1〜50件指定してください。",
    "api.error.labelExists": "変更先のラベルは既に存在します。",
    "api.error.invalidNote": "メモの内容を確認してください。",
    "api.error.invalidCardImage": "カード画像を確認してください。",
    "api.error.noteNotFound": "メモが見つかりません。",
    "api.error.invalidImport": "インポートするメモを確認してください。",
    "api.error.invalidTrash": "ゴミ箱の指定が正しくありません。",
    "api.error.invalidDate": "日時を確認してください。",
    "api.error.invalidTrashDate": "ゴミ箱日時を確認してください。",
    "api.error.invalidAttachment": "添付ファイルの形式を確認してください。",
    "api.error.invalidFilename": "ファイル名を確認してください。",
    "api.error.attachmentTooLarge": "添付ファイルは20MB以下にしてください。",
    "api.error.emptyAttachment": "添付ファイルが空です。",
    "api.error.invalidMissingPreviews": "未取得プレビューの指定が正しくありません。",
    "api.error.invalidPreview": "プレビューの内容を確認してください。",
    "api.error.invalidPreviewRequest": "プレビューの指定が正しくありません。",
    "api.error.invalidPreviewImage": "プレビュー画像URLを確認してください。",
    "api.error.invalidSourceUrl": "元URLを確認してください。",
    "api.error.noteChangedOrTrashed": "対象メモが見つからないか、ゴミ箱にあります。",
    "api.error.noteUrlChanged": "メモのURLが変更されています。",
    "api.error.noteMissingOrUrlChanged": "対象メモが見つからないか、URLが変更されています。",
    "api.error.apiNotConfigured": "保存APIが設定されていません。",
    "api.error.invalidApiKey": "API KEYが正しくありません。",
    "api.error.unsupportedMode": "このモードには対応していません。",
    "api.error.unsupportedMethod": "このメソッドには対応していません。",
    "api.error.invalidFormat": "送信形式が正しくありません。",
    "api.error.requestTooLarge": "送信サイズが大きすぎます。",
    "api.error.invalidRequest": "送信内容を確認してください。",
    "api.error.invalidTitle": "タイトルを確認してください。",
    "api.error.invalidUrl": "URLを確認してください。",
    "api.error.invalidBody": "本文を確認してください。",
    "api.error.invalidPin": "ピン留めの指定を確認してください。",
    "api.error.invalidLabelsInput": "ラベルを確認してください。",
    "api.error.unregisteredLabels": "登録済みのラベルだけを選択してください。",
    "api.error.tooManyImages": "画像は1枚だけ選んでください。",
    "api.error.invalidImage": "画像を確認してください。",
    "api.error.unsupportedImage": "対応していない画像形式です。",
    "api.error.emptyImage": "画像が空です。",
    "api.error.imageTooLarge": "画像は20MB以下にしてください。",
    "api.error.imageNotFound": "画像が見つかりません。",
    "api.error.notFound": "見つかりません。",
    "api.error.forbidden": "この操作は許可されていません。",
    "api.error.failed": "処理に失敗しました。",
    "api.error.localApiUrl": "API URLはHTTPSを指定してください。ローカル開発時のみHTTPを使えます。",
    "api.error.capturePath": "API URLは /api/capture まで含めて指定してください。",
    "api.error.noteId": "保存したメモのIDを確認できませんでした。",
  },
  en: {
    "popup.title": "Save to MyKeep",
    "popup.openMyKeep": "Open in MyKeep",
    "popup.save": "Save",
    "popup.field.title": "Title",
    "popup.field.url": "URL",
    "popup.field.note": "Note",
    "popup.notePlaceholder": "Optional note",
    "popup.field.labels": "Labels",
    "popup.selectLabels": "Select labels",
    "popup.selectedLabelsOne": "{count} label",
    "popup.selectedLabelsMany": "{count} labels",
    "popup.removeLabel": "Remove {label}",
    "popup.pinned": "Pin",
    "popup.field.image": "Image",
    "popup.pasteImage": "You can also paste an image here with Ctrl+V",
    "popup.imagePreviewAlt": "Attached image preview",
    "popup.removeImage": "Remove image",
    "popup.noLabels": "There are no existing labels.",
    "popup.labelsLoadFailed": "Could not load existing labels.",
    "popup.pageUnreadable": "Could not read the current page.",
    "popup.imageTypeError": "Choose a JPEG, PNG, WebP, GIF, or AVIF image.",
    "popup.imageSizeError": "Choose one image no larger than 20 MB.",
    "popup.pastedImageName": "Pasted image",
    "popup.saving": "Saving…",
    "popup.saved": "Saved.",
    "popup.error.apiKeyRequired": "Save your API URL and API key in Settings first.",
    "popup.error.invalidPageUrl": "This page URL cannot be saved.",
    "popup.error.openFailed": "Could not open MyKeep.",
    "popup.error.saveFailed": "Could not save the note.",
    "popup.error.sendFailed": "Could not send the note.",
    "options.title": "MyKeep Settings",
    "options.apiUrl": "API URL",
    "options.apiKey": "API KEY",
    "options.language": "Language",
    "options.save": "Save settings",
    "options.settingsSaved": "Settings saved.",
    "options.settingsLoadFailed": "Could not load settings.",
    "options.apiKeyRequired": "Enter an API key.",
    "options.apiPermissionRequired": "Permission to connect to the API URL is required.",
    "options.settingsSaveFailed": "Could not save settings.",
    "repair.title": "Thumbnail repair",
    "repair.intro": "This opens URLs for notes without images in Chrome, one at a time, to find thumbnails. Regular notes and archived notes are included.",
    "repair.permissionInfo": "You will be asked to allow site access when repair starts. Repair continues if you close this settings page.",
    "repair.countUnknown": "Missing thumbnails: Not checked",
    "repair.count": "Missing thumbnails: {count}",
    "repair.checkCount": "Check missing count",
    "repair.start": "Start thumbnail repair",
    "repair.pause": "Pause",
    "repair.resume": "Resume",
    "repair.cancel": "Cancel",
    "repair.retry": "Retry failed",
    "repair.clear": "Clear results",
    "repair.status.running": "Processing",
    "repair.status.paused": "Paused",
    "repair.status.cancelled": "Cancelled",
    "repair.status.completed": "Completed",
    "repair.progress": "{state}: {processed} / {total}\nSucceeded: {success}  Failed: {failed}{finishing}",
    "repair.finishing": "\nFinishing the current note.",
    "repair.notConfigured": "Set your API URL and API key first.",
    "repair.sitePermissionRequired": "Site access permission is required for thumbnail repair.",
    "repair.startFailed": "Could not start the repair.",
    "repair.checkFailed": "Could not check the repair status.",
    "repair.extensionReload": "Reload the extension, then reopen Settings.",
    "repair.error.paused": "Repair paused. Check the API settings, connection, and task tab, then resume.",
    "repair.error.closeTab": "Could not close the task tab. Close it and resume again.",
    "repair.error.closePreviousTab": "Close the previous task tab before resuming.",
    "repair.error.apiPermission": "Save permission to connect to the API URL in Settings.",
    "repair.error.apiChanged": "The API settings changed.",
    "repair.error.listUnavailable": "Could not read the note list.",
    "repair.error.cursorUnavailable": "Could not verify the note list cursor.",
    "repair.error.clearWhileRunning": "Wait until the current note finishes before clearing results.",
    "repair.error.cancelBeforeClear": "Cancel the repair before clearing results.",
    "repair.error.countUnavailable": "Could not check the missing count.",
    "repair.error.invalidAction": "Could not verify this action.",
    "repair.error.waitForCurrent": "A repair is already running. Wait until the current note finishes.",
    "repair.error.sitePermission": "Site access permission is required.",
    "repair.error.nothingToResume": "There is no repair to resume.",
    "repair.error.sameApiToResume": "Set the same API URL used previously before resuming.",
    "repair.error.nothingToRetry": "There are no failed notes to retry.",
    "repair.error.sameApiToRetry": "Set the same API URL used previously before retrying.",
    "repair.error.apiConnection": "Check the API connection.",
    "repair.error.generic": "Could not complete the repair action.",
    "api.error.invalidList": "The note list request is invalid.",
    "api.error.invalidLabel": "Check the label name.",
    "api.error.invalidLabelLength": "Label names must be 1 to 100 characters.",
    "api.error.labelNotFound": "The label was not found.",
    "api.error.invalidLabels": "The label selection is invalid.",
    "api.error.invalidLabelsCount": "Choose 1 to 50 labels to delete.",
    "api.error.labelExists": "A label with that name already exists.",
    "api.error.invalidNote": "Check the note content.",
    "api.error.invalidCardImage": "Check the card image.",
    "api.error.noteNotFound": "The note was not found.",
    "api.error.invalidImport": "Check the note to import.",
    "api.error.invalidTrash": "The trash selection is invalid.",
    "api.error.invalidDate": "Check the date and time.",
    "api.error.invalidTrashDate": "Check the trash date.",
    "api.error.invalidAttachment": "The attachment format is invalid.",
    "api.error.invalidFilename": "Check the file name.",
    "api.error.attachmentTooLarge": "Attachments must be 20 MB or smaller.",
    "api.error.emptyAttachment": "The attachment is empty.",
    "api.error.invalidMissingPreviews": "The missing preview request is invalid.",
    "api.error.invalidPreview": "Check the preview content.",
    "api.error.invalidPreviewRequest": "The preview request is invalid.",
    "api.error.invalidPreviewImage": "Check the preview image URL.",
    "api.error.invalidSourceUrl": "Check the source URL.",
    "api.error.noteChangedOrTrashed": "The note was not found or is in Trash.",
    "api.error.noteUrlChanged": "The note URL has changed.",
    "api.error.noteMissingOrUrlChanged": "The note was not found or its URL has changed.",
    "api.error.apiNotConfigured": "The capture API is not configured.",
    "api.error.invalidApiKey": "The API key is invalid.",
    "api.error.unsupportedMode": "This mode is not supported.",
    "api.error.unsupportedMethod": "This method is not supported.",
    "api.error.invalidFormat": "The request format is invalid.",
    "api.error.requestTooLarge": "The request is too large.",
    "api.error.invalidRequest": "Check the request content.",
    "api.error.invalidTitle": "Check the title.",
    "api.error.invalidUrl": "Check the URL.",
    "api.error.invalidBody": "Check the note body.",
    "api.error.invalidPin": "The pin value is invalid.",
    "api.error.invalidLabelsInput": "Check the labels.",
    "api.error.unregisteredLabels": "Choose labels that already exist.",
    "api.error.tooManyImages": "Choose only one image.",
    "api.error.invalidImage": "Check the image.",
    "api.error.unsupportedImage": "This image format is not supported.",
    "api.error.emptyImage": "The image is empty.",
    "api.error.imageTooLarge": "Images must be 20 MB or smaller.",
    "api.error.imageNotFound": "The image was not found.",
    "api.error.notFound": "Not found.",
    "api.error.forbidden": "This action is not allowed.",
    "api.error.failed": "The operation failed.",
    "api.error.localApiUrl": "Use HTTPS for the API URL. HTTP is allowed only for local development.",
    "api.error.capturePath": "The API URL must include /api/capture.",
    "api.error.noteId": "Could not verify the saved note ID.",
  },
};

const errorKeys = new Map(Object.entries({
  "API URLはHTTPSを指定してください。ローカル開発時のみHTTPを使えます。": "api.error.localApiUrl",
  "API URLは /api/capture まで含めて指定してください。": "api.error.capturePath",
  "保存したメモのIDを確認できませんでした。": "api.error.noteId",
  "API KEYを入力してください。": "options.apiKeyRequired",
  "API URLへの接続許可が必要です。": "options.apiPermissionRequired",
  "既存ラベルはありません。": "popup.noLabels",
  "既存ラベルを読み込めませんでした。": "popup.labelsLoadFailed",
  "現在のページを読み取れませんでした。": "popup.pageUnreadable",
  "JPEG・PNG・WebP・GIF・AVIF の画像を選んでください。": "popup.imageTypeError",
  "画像は1枚20MB以下にしてください。": "popup.imageSizeError",
  "設定で API URL と API KEY を保存してください。": "popup.error.apiKeyRequired",
  "このページのURLは保存できません。": "popup.error.invalidPageUrl",
  "MyKeepを開けませんでした。": "popup.error.openFailed",
  "設定を読み込めませんでした。": "options.settingsLoadFailed",
  "設定を保存しました。": "options.settingsSaved",
  "設定を保存できませんでした。": "options.settingsSaveFailed",
  "サムネイル補完にはサイトへのアクセス許可が必要です。": "repair.sitePermissionRequired",
  "処理を開始できませんでした。": "repair.startFailed",
  "処理を確認できませんでした。": "repair.checkFailed",
  "拡張を再読み込みしてから設定を開き直してください。": "repair.extensionReload",
  "作業タブを閉じられません。タブを閉じてから再開してください。": "repair.error.closeTab",
  "処理を一時停止しました。API設定・接続・作業タブを確認して再開してください。": "repair.error.paused",
  "前回の作業タブを閉じてから再開してください。": "repair.error.closePreviousTab",
  "先にAPI URLとAPI KEYを設定してください。": "repair.notConfigured",
  "API URLへの接続許可を設定画面で保存してください。": "repair.error.apiPermission",
  "API設定が変更されました。": "repair.error.apiChanged",
  "一覧を確認できません。": "repair.error.listUnavailable",
  "一覧のカーソルを確認できません。": "repair.error.cursorUnavailable",
  "処理中は結果をクリアできません。現在の1件が終了するまでお待ちください。": "repair.error.clearWhileRunning",
  "中止してから結果をクリアしてください。": "repair.error.cancelBeforeClear",
  "未取得件数を確認できません。": "repair.error.countUnavailable",
  "操作を確認してください。": "repair.error.invalidAction",
  "処理中です。現在の1件が終了するまでお待ちください。": "repair.error.waitForCurrent",
  "サイトへのアクセス許可が必要です。": "repair.error.sitePermission",
  "再開する処理がありません。": "repair.error.nothingToResume",
  "前回と同じAPI URLを設定してから再開してください。": "repair.error.sameApiToResume",
  "再試行する失敗はありません。": "repair.error.nothingToRetry",
  "前回と同じAPI URLを設定してください。": "repair.error.sameApiToRetry",
  "APIへの接続を確認してください。": "repair.error.apiConnection",
  "一覧の指定が正しくありません。": "api.error.invalidList",
  "ラベル名を確認してください。": "api.error.invalidLabel",
  "ラベル名は1〜100文字で入力してください。": "api.error.invalidLabelLength",
  "ラベルが見つかりません。": "api.error.labelNotFound",
  "ラベルの指定が正しくありません。": "api.error.invalidLabels",
  "削除するラベルを1〜50件指定してください。": "api.error.invalidLabelsCount",
  "変更先のラベルは既に存在します。": "api.error.labelExists",
  "メモの内容を確認してください。": "api.error.invalidNote",
  "カード画像を確認してください。": "api.error.invalidCardImage",
  "メモが見つかりません。": "api.error.noteNotFound",
  "インポートするメモを確認してください。": "api.error.invalidImport",
  "ゴミ箱の指定が正しくありません。": "api.error.invalidTrash",
  "日時を確認してください。": "api.error.invalidDate",
  "ゴミ箱日時を確認してください。": "api.error.invalidTrashDate",
  "添付ファイルの形式を確認してください。": "api.error.invalidAttachment",
  "ファイル名を確認してください。": "api.error.invalidFilename",
  "添付ファイルは20MB以下にしてください。": "api.error.attachmentTooLarge",
  "添付ファイルが空です。": "api.error.emptyAttachment",
  "未取得プレビューの指定が正しくありません。": "api.error.invalidMissingPreviews",
  "プレビューの内容を確認してください。": "api.error.invalidPreview",
  "プレビューの指定が正しくありません。": "api.error.invalidPreviewRequest",
  "プレビュー画像URLを確認してください。": "api.error.invalidPreviewImage",
  "元URLを確認してください。": "api.error.invalidSourceUrl",
  "対象メモが見つからないか、ゴミ箱にあります。": "api.error.noteChangedOrTrashed",
  "メモのURLが変更されています。": "api.error.noteUrlChanged",
  "対象メモが見つからないか、URLが変更されています。": "api.error.noteMissingOrUrlChanged",
  "保存APIが設定されていません。": "api.error.apiNotConfigured",
  "API KEYが正しくありません。": "api.error.invalidApiKey",
  "このモードには対応していません。": "api.error.unsupportedMode",
  "このメソッドには対応していません。": "api.error.unsupportedMethod",
  "送信形式が正しくありません。": "api.error.invalidFormat",
  "送信サイズが大きすぎます。": "api.error.requestTooLarge",
  "送信内容を確認してください。": "api.error.invalidRequest",
  "タイトルを確認してください。": "api.error.invalidTitle",
  "URLを確認してください。": "api.error.invalidUrl",
  "本文を確認してください。": "api.error.invalidBody",
  "ピン留めの指定を確認してください。": "api.error.invalidPin",
  "ラベルを確認してください。": "api.error.invalidLabelsInput",
  "登録済みのラベルだけを選択してください。": "api.error.unregisteredLabels",
  "画像は1枚だけ選んでください。": "api.error.tooManyImages",
  "画像を確認してください。": "api.error.invalidImage",
  "対応していない画像形式です。": "api.error.unsupportedImage",
  "画像が空です。": "api.error.emptyImage",
  "画像は20MB以下にしてください。": "api.error.imageTooLarge",
  "画像が見つかりません。": "api.error.imageNotFound",
  "見つかりません。": "api.error.notFound",
  "この操作は許可されていません。": "api.error.forbidden",
  "処理に失敗しました。": "api.error.failed",
  "api_update_failed": "repair.error.apiConnection",
}));

let language = "ja";
let initPromise = null;
const languageListeners = new Set();

function normalizeLanguage(value) {
  return value === "en" ? "en" : "ja";
}

function applyTranslations() {
  if (typeof document === "undefined") return;
  document.documentElement.lang = language;
  document.querySelectorAll("[data-i18n]").forEach((element) => {
    element.textContent = t(element.dataset.i18n);
  });
  for (const [attribute, datasetKey] of [["placeholder", "i18nPlaceholder"], ["title", "i18nTitle"], ["alt", "i18nAlt"], ["aria-label", "i18nAriaLabel"]]) {
    document.querySelectorAll(`[data-${datasetKey.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)}]`).forEach((element) => {
      element.setAttribute(attribute, t(element.dataset[datasetKey]));
    });
  }
  const selector = document.getElementById("language");
  if (selector) selector.value = language;
}

function updateLanguage(value) {
  const next = normalizeLanguage(value);
  const changed = next !== language;
  language = next;
  applyTranslations();
  if (changed) languageListeners.forEach((listener) => listener(language));
}

export function t(key, values = {}) {
  const template = messages[language][key] ?? messages.ja[key] ?? key;
  return template.replace(/\{(\w+)\}/g, (match, name) => values[name] === undefined ? match : String(values[name]));
}

export function getLanguage() {
  return language;
}

export function onLanguageChange(listener) {
  languageListeners.add(listener);
  return () => languageListeners.delete(listener);
}

export function localizeError(value, fallbackKey) {
  if (typeof value !== "string" || !value) return t(fallbackKey);
  const key = Object.hasOwn(messages.ja, value) ? value : errorKeys.get(value);
  if (key) return t(key);
  if (language === "ja" || !/[ぁ-んァ-ヶ一-龠]/u.test(value)) return value;
  return t(fallbackKey);
}

export async function setLanguage(value) {
  const next = normalizeLanguage(value);
  await chrome.storage.local.set({ language: next });
  updateLanguage(next);
  return next;
}

export async function initializeI18n() {
  if (!initPromise) {
    initPromise = (async () => {
      let savedLanguage = "ja";
      try {
        const settings = await chrome.storage.local.get("language");
        savedLanguage = normalizeLanguage(settings.language);
        if (settings.language !== savedLanguage) await chrome.storage.local.set({ language: savedLanguage });
      } catch {
        savedLanguage = "ja";
      }
      updateLanguage(savedLanguage);
      if (chrome.storage.onChanged?.addListener) {
        chrome.storage.onChanged.addListener((changes, area) => {
          if (area === "local" && changes.language) updateLanguage(changes.language.newValue);
        });
      }
      if (typeof document !== "undefined") {
        const selector = document.getElementById("language");
        if (selector && !selector.dataset.i18nBound) {
          selector.dataset.i18nBound = "true";
          selector.addEventListener("change", () => {
            void setLanguage(selector.value).catch(() => {
              selector.value = language;
            });
          });
        }
      }
      applyTranslations();
      return language;
    })();
  }
  return initPromise;
}
