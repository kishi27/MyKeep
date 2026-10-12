import { flushSync } from "react-dom";

// Device-local screen privacy only. This never participates in API authentication.
export const PIN_KEY = "mykeep.pinLock";
const ITERATIONS = 120_000;
const GRACE_MS = 60_000;
type PinRecord = { version: 1; salt: string; hash: string; iterations: number; failures: number; blockedUntil: number };
type PinState = { phase: "unlocked" | "locked" | "error"; enabled: boolean; blockedUntil: number; epoch: number };

export function isSmartphone(nav: Pick<Navigator, "userAgent" | "platform"> = navigator): boolean {
  // Width and pointer type alone also match narrow/touch-enabled PCs and tablets.
  if (/Windows|MacIntel|MacPPC/.test(nav.platform) && !/iPhone/.test(nav.userAgent)) return false;
  return /iPhone/.test(nav.userAgent) || (/Android/.test(nav.userAgent) && /Mobile/.test(nav.userAgent));
}
export const smartphone = isSmartphone();
let record: PinRecord | null = null;
let state: PinState = { phase: "unlocked", enabled: false, blockedUntil: 0, epoch: 0 };
let hiddenAt: number | null = null;
let busy = false;
const listeners = new Set<() => void>();
export const pinSubscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export const pinSnapshot = () => state;

function publish(update: Partial<PinState>) {
  state = { ...state, ...update };
  document.documentElement.dataset.pinPhase = state.phase;
  listeners.forEach((listener) => listener());
}
function readRecord(): PinRecord | null {
  const raw = localStorage.getItem(PIN_KEY);
  if (raw === null) return null;
  const value = JSON.parse(raw) as PinRecord;
  if (!value || value.version !== 1 || value.iterations !== ITERATIONS
    || !/^[a-f0-9]{32}$/.test(value.salt) || !/^[a-f0-9]{64}$/.test(value.hash)
    || !Number.isSafeInteger(value.failures) || value.failures < 0
    || !Number.isSafeInteger(value.blockedUntil) || value.blockedUntil < 0) throw new Error("PIN storage");
  return value;
}
function failClosed() { publish({ phase: "error", enabled: true, epoch: state.epoch + 1 }); }
function persist(value: PinRecord | null) {
  if (value) localStorage.setItem(PIN_KEY, JSON.stringify(value));
  else localStorage.removeItem(PIN_KEY);
  record = value;
  publish({ enabled: Boolean(value), blockedUntil: value?.blockedUntil ?? 0 });
}
function load() {
  try {
    record = readRecord();
    if (record && !crypto.subtle) throw new Error("Web Crypto unavailable");
    publish({ phase: record ? "locked" : "unlocked", enabled: Boolean(record), blockedUntil: record?.blockedUntil ?? 0, epoch: state.epoch + 1 });
  } catch { failClosed(); }
}
function sameRecord(a: PinRecord | null, b: PinRecord | null) { return JSON.stringify(a) === JSON.stringify(b); }
function hide() {
  if (!state.enabled) return;
  // Synchronous CSS shield precedes React updates and the browser's next paint.
  document.documentElement.dataset.pinHidden = "true";
  if (hiddenAt === null) hiddenAt = Date.now();
}
function resume() {
  if (document.visibilityState !== "visible") return;
  try {
    if (!sameRecord(record, readRecord())) load();
    if (state.enabled && hiddenAt !== null && (Date.now() - hiddenAt >= GRACE_MS || Date.now() < hiddenAt)) {
      publish({ phase: state.phase === "error" ? "error" : "locked", epoch: state.epoch + 1 });
    }
  } catch { failClosed(); }
  hiddenAt = null;
  // pinPhase already hides app content, even before React renders the lock screen.
  delete document.documentElement.dataset.pinHidden;
}

// Called by the entry module before createRoot: no app or note API has run yet.
export function initializePinLock() {
  if (!smartphone) return;
  try { document.documentElement.dataset.theme = localStorage.getItem("mykeep.darkMode") === "true" ? "dark" : "light"; } catch { /* load() below fails closed. */ }
  load();
  if (document.visibilityState !== "visible") hide();
  // Finish lock/unmount before existing app focus/visibility listeners can fetch.
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") hide(); else flushSync(resume); });
  window.addEventListener("pagehide", hide);
  window.addEventListener("pageshow", () => flushSync(resume));
  window.addEventListener("focus", () => flushSync(resume));
  window.addEventListener("storage", (event) => { if (event.key === PIN_KEY || event.key === null) flushSync(load); });
}
const hex = (bytes: Uint8Array) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
async function hashPin(pin: string, salt: string) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(pin), "PBKDF2", false, ["deriveBits"]);
  const bytes = Uint8Array.from(salt.match(/../g)!, (pair) => parseInt(pair, 16));
  return hex(new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: bytes, iterations: ITERATIONS }, key, 256)));
}

type PinResult = "ok" | "invalid" | "incorrect" | "wait" | "error";
export async function pinOperation(action: "unlock" | "enable" | "change" | "disable", pin: string, nextPin = ""): Promise<PinResult> {
  if (!smartphone || busy) return "wait";
  if (!/^\d{4}$/.test(pin) || (action === "change" && !/^\d{4}$/.test(nextPin))) return "invalid";
  busy = true;
  const epoch = state.epoch;
  try {
    if (!sameRecord(record, readRecord())) { load(); return "error"; }
    if (state.phase === "error" || !crypto.subtle) throw new Error("Unavailable");
    if (action === "enable") {
      if (record || state.phase !== "unlocked") return "error";
    } else {
      if (!record) return "error";
      if (record.blockedUntil > Date.now()) return "wait";
      // Persist attempts before hashing so reload/aborted requests cannot erase them.
      const failures = record.failures + 1;
      persist({ ...record, failures, blockedUntil: failures % 5 === 0 ? Date.now() + 30_000 * 2 ** Math.min(3, Math.floor(failures / 5) - 1) : 0 });
      const expected = record!;
      const hash = await hashPin(pin, expected.salt);
      if (state.epoch !== epoch || !sameRecord(expected, readRecord())) { load(); return "error"; }
      if (hash !== expected.hash) return "incorrect";
    }
    const verified = record;
    if (action === "enable" || action === "change") {
      const salt = hex(crypto.getRandomValues(new Uint8Array(16)));
      const hash = await hashPin(action === "enable" ? pin : nextPin, salt);
      if (state.epoch !== epoch || !sameRecord(verified, readRecord())) { load(); return "error"; }
      persist({ version: 1, salt, hash, iterations: ITERATIONS, failures: 0, blockedUntil: 0 });
    } else if (action === "disable") persist(null);
    else persist({ ...record!, failures: 0, blockedUntil: 0 });
    publish({ phase: "unlocked" });
    // If authentication completed after the app went into the background,
    // do not extend the grace period or remove its privacy shield.
    if (document.visibilityState !== "visible") hide();
    return "ok";
  } catch { failClosed(); return "error"; }
  finally { busy = false; }
}
