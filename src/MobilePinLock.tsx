import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { ReactNode } from "react";
import { useI18n } from "./i18n";
import { pinOperation, pinSnapshot, pinSubscribe, smartphone } from "./pinLock";

function usePin() { return useSyncExternalStore(pinSubscribe, pinSnapshot); }
function useCooldown(until: number) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    setNow(Date.now());
    if (!until) return;
    const timer = window.setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, [until]);
  return Math.max(0, Math.ceil((until - now) / 1000));
}
function PinHelp() {
  const { t } = useI18n();
  return <details className="pin-help"><summary>{t("PINを忘れた場合")}</summary><p>{t("この端末のブラウザ設定からMyKeepのサイトデータを削除するとPINを初期化できます。表示設定などのローカル設定も失われます。クラウドのメモは削除されません。")}</p></details>;
}
export function PinGate({ children }: { children: ReactNode }) {
  const state = usePin();
  const { t } = useI18n();
  const [digits, setDigits] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const cooldown = useCooldown(state.blockedUntil);
  const attempt = useRef(false);
  useEffect(() => { setDigits(""); setError(""); }, [state.epoch]);
  async function unlock(pin: string) {
    if (attempt.current || cooldown) return;
    attempt.current = true;
    setBusy(true);
    const result = await pinOperation("unlock", pin);
    setDigits("");
    setError(result === "incorrect" ? t("PINが正しくありません") : result === "wait" ? t("しばらく待ってから再試行してください。") : result === "ok" ? "" : t("PIN設定を読み書きできません。"));
    setBusy(false);
    attempt.current = false;
  }
  function enter(value: string) {
    if (busy || cooldown) return;
    const pin = value.replace(/\D/g, "").slice(0, 4);
    setDigits(pin);
    setError("");
    if (pin.length === 4) void unlock(pin);
  }
  return <>
    <div id="pin-privacy-shield" aria-hidden="true" />
    {state.phase === "unlocked" ? <div id="pin-content">{children}</div> : <main className="pin-screen">
      <section className="pin-panel" aria-label={t("PINロック")}>
        <h1>MyKeep</h1><div className="pin-symbol" aria-hidden="true">🔒</div>
        {state.phase === "error" ? <p role="alert">{t("PIN設定を読み書きできません。")}</p> : <>
          <p>{t("4桁のPINを入力してください")}</p>
          <div className="pin-dots" aria-hidden="true">{[0, 1, 2, 3].map((index) => <span key={index}>{index < digits.length ? "●" : "○"}</span>)}</div>
          <input ref={input} className="pin-native-input" type="password" inputMode="numeric" pattern="[0-9]{4}" maxLength={4} autoComplete="off"
            aria-label={t("4桁のPINを入力してください")} value={digits} disabled={busy || cooldown > 0} onChange={(event) => enter(event.target.value)} />
          <div className="pin-keypad">{[1, 2, 3, 4, 5, 6, 7, 8, 9].map((digit) => <button type="button" key={digit} disabled={busy || cooldown > 0} onClick={() => enter(digits + digit)}>{digit}</button>)}
            <button type="button" onClick={() => input.current?.focus()} aria-label={t("数字キーボード")} disabled={busy || cooldown > 0}>⌨</button>
            <button type="button" disabled={busy || cooldown > 0} onClick={() => enter(digits + "0")}>0</button>
            <button type="button" disabled={busy || cooldown > 0} aria-label={t("1桁削除")} onClick={() => enter(digits.slice(0, -1))}>⌫</button>
          </div>
          {cooldown > 0 && <p role="status">{t("{0}秒後に再試行できます。", { 0: cooldown })}</p>}
          {error && <p className="error" role="alert">{error}</p>}
        </>}
        <PinHelp />
      </section>
    </main>}
  </>;
}

export function PinSettings() {
  const state = usePin();
  const { t } = useI18n();
  const [mode, setMode] = useState<"enable" | "change" | "disable" | null>(null);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const cooldown = useCooldown(state.blockedUntil);
  if (!smartphone) return null;
  function start(value: typeof mode) { setMode(value); setCurrent(""); setNext(""); setConfirm(""); setMessage(""); }
  async function save() {
    if (!mode || busy) return;
    if (mode !== "disable" && next !== confirm) { setMessage(t("PINが一致しません")); return; }
    setBusy(true);
    const result = await pinOperation(mode, mode === "enable" ? next : current, next);
    setCurrent(""); setNext(""); setConfirm("");
    if (result === "ok") { start(null); setMessage(t("PIN設定を更新しました。")); }
    else setMessage(result === "incorrect" ? t("PINが正しくありません") : result === "wait" ? t("しばらく待ってから再試行してください。") : t("PIN設定を読み書きできません。"));
    setBusy(false);
  }
  const valid = mode === "enable" ? /^\d{4}$/.test(next) && /^\d{4}$/.test(confirm)
    : /^\d{4}$/.test(current) && (mode === "disable" || /^\d{4}$/.test(next) && /^\d{4}$/.test(confirm));
  return <section className="pin-settings" aria-label={t("PINロック")}>
    <label className="setting-row"><input type="checkbox" checked={state.enabled} disabled={busy || mode !== null} onChange={() => start(state.enabled ? "disable" : "enable")} />{t("PINロック")}</label>
    <p>{t("スマホでMyKeepを開く際に4桁のPINで画面を保護します。")}</p>
    {state.enabled && !mode && <button type="button" onClick={() => start("change")}>{t("PINを変更")}</button>}
    {mode && <div className="pin-setup">
      <h3>{mode === "enable" ? t("PINを設定") : mode === "change" ? t("PINを変更") : t("PINロックを解除")}</h3>
      {mode !== "enable" && <label>{t("現在のPIN")}<input type="password" inputMode="numeric" autoComplete="off" maxLength={4} value={current} disabled={busy} onChange={(event) => setCurrent(event.target.value.replace(/\D/g, ""))} /></label>}
      {mode !== "disable" && <>
        <label>{t("新しいPIN")}<input type="password" inputMode="numeric" autoComplete="off" maxLength={4} value={next} disabled={busy} onChange={(event) => setNext(event.target.value.replace(/\D/g, ""))} /></label>
        <label>{t("PINを再入力")}<input type="password" inputMode="numeric" autoComplete="off" maxLength={4} value={confirm} disabled={busy} onChange={(event) => setConfirm(event.target.value.replace(/\D/g, ""))} /></label>
      </>}
      <div className="pin-setup-actions"><button type="button" disabled={busy} onClick={() => start(null)}>{t("キャンセル")}</button>
        <button type="button" className="primary" disabled={busy || !valid || cooldown > 0} onClick={() => void save()}>{mode === "disable" ? t("PINロックを解除") : t("保存")}</button></div>
    </div>}
    {cooldown > 0 && <p role="status">{t("{0}秒後に再試行できます。", { 0: cooldown })}</p>}
    {message && <p role="status">{message}</p>}
    <PinHelp />
  </section>;
}
