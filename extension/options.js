import { captureEndpoint, hostPermissionPattern } from "./shared.js";
import { getLanguage, initializeI18n, localizeError, onLanguageChange, t } from "./i18n.js";

const form = document.getElementById("optionsForm");
const apiUrl = document.getElementById("apiUrl");
const apiKey = document.getElementById("apiKey");
const status = document.getElementById("status");
const repairProgress = document.getElementById("repairProgress");
const repairStatus = document.getElementById("repairStatus");
const repairCount = document.getElementById("repairCount");
const repairButtons = Object.fromEntries(["Check", "Start", "Pause", "Resume", "Cancel", "Retry", "Clear"]
  .map(name => [name.toLowerCase(), document.getElementById(`repair${name}`)]));
let repairState = { status: "idle", failures: [] };
let repairRequestPending = false;
let configured = false;
let statusMessage = "";
let statusIsError = false;
let repairCountValue = null;
let repairCommandError = "";

function showStatus(message, error = false) {
  statusMessage = message;
  statusIsError = error;
  renderStatus();
}

function renderStatus() {
  status.textContent = !statusMessage ? "" : statusIsError
    ? localizeError(statusMessage, "options.settingsSaveFailed")
    : t(statusMessage);
  status.classList.toggle("error", statusIsError);
}

function renderRepairCount() {
  repairCount.textContent = repairCountValue === null
    ? t("repair.countUnknown")
    : t("repair.count", { count: new Intl.NumberFormat(getLanguage() === "en" ? "en-US" : "ja-JP").format(repairCountValue) });
}

async function loadSettings() {
  try {
    const settings = await chrome.storage.local.get(["apiUrl", "apiKey"]);
    apiUrl.value = settings.apiUrl ?? "";
    apiKey.value = settings.apiKey ?? "";
    configured = Boolean(settings.apiUrl && settings.apiKey);
    renderRepair();
  } catch {
    showStatus("options.settingsLoadFailed", true);
  }
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  showStatus("");
  try {
    const endpoint = captureEndpoint(apiUrl.value);
    const key = apiKey.value.trim();
    if (!key) throw new Error("options.apiKeyRequired");
    const granted = await chrome.permissions.request({ origins: [hostPermissionPattern(endpoint)] });
    if (!granted) throw new Error("options.apiPermissionRequired");
    await chrome.storage.local.set({ apiUrl: endpoint, apiKey: key });
    configured = true;
    renderRepair();
    showStatus("options.settingsSaved");
  } catch (error) {
    showStatus(error instanceof Error ? error.message : "options.settingsSaveFailed", true);
  }
});

function renderRepair() {
  const running = repairState.status === "running";
  const finishing = Boolean(repairState.currentNoteId);
  const paused = repairState.status === "paused";
  repairButtons.pause.hidden = !running;
  repairButtons.cancel.hidden = !running && !paused;
  repairButtons.resume.hidden = !paused;
  repairButtons.retry.hidden = running || paused || !repairState.failures?.length;
  repairButtons.start.hidden = running || paused;
  for (const button of Object.values(repairButtons)) button.disabled = repairRequestPending || !configured;
  repairButtons.clear.disabled = repairRequestPending || running || paused || finishing;
  repairButtons.start.disabled ||= finishing;
  repairButtons.resume.disabled ||= finishing;
  repairButtons.retry.disabled ||= finishing;
  repairButtons.check.disabled ||= running;
  const stateKey = `repair.status.${repairState.status}`;
  const formatter = new Intl.NumberFormat(getLanguage() === "en" ? "en-US" : "ja-JP");
  repairProgress.textContent = repairState.status === "idle" ? "" :
    t("repair.progress", {
      state: t(stateKey),
      processed: formatter.format(repairState.processed ?? 0),
      total: formatter.format(repairState.total ?? 0),
      success: formatter.format(repairState.success ?? 0),
      failed: formatter.format(repairState.failed ?? 0),
      finishing: finishing ? t("repair.finishing") : "",
    });
  renderRepairCount();
  const repairError = repairCommandError || repairState.error;
  repairStatus.textContent = !configured ? t("repair.notConfigured") : repairError
    ? localizeError(repairError, "repair.error.generic")
    : "";
  repairStatus.classList.toggle("error", Boolean(repairCommandError || repairState.error));
}

async function repairCommand(action) {
  if (repairRequestPending) return;
  repairRequestPending = true;
  renderRepair();
  try {
    if (["start", "resume", "retry"].includes(action)) {
      // Only explicit repair actions request broad access; ordinary capture stays activeTab-based.
      const granted = await chrome.permissions.request({ origins: ["https://*/*", "http://*/*"] });
      if (!granted) throw new Error("repair.sitePermissionRequired");
    }
    const result = await chrome.runtime.sendMessage({ type: "thumbnail-repair", action });
    if (!result?.ok) throw new Error(result?.error || "repair.startFailed");
    if (result.state) repairState = result.state;
    repairCommandError = "";
    if (action === "clear") repairCountValue = null;
    if (Number.isSafeInteger(result.count)) repairCountValue = result.count;
    repairRequestPending = false;
    renderRepair();
  } catch (error) {
    repairRequestPending = false;
    repairCommandError = error instanceof Error ? error.message : "repair.checkFailed";
    renderRepair();
  }
}

repairButtons.check.addEventListener("click", () => void repairCommand("count"));
for (const action of ["start", "pause", "resume", "cancel", "retry", "clear"]) {
  repairButtons[action].addEventListener("click", () => void repairCommand(action));
}
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.thumbnailRepairState) {
    repairState = changes.thumbnailRepairState.newValue ?? { status: "idle", failures: [] };
    repairCommandError = "";
    if (repairState.status === "idle") repairCountValue = null;
  }
  if (changes.apiUrl || changes.apiKey) {
    void chrome.storage.local.get(["apiUrl", "apiKey"]).then(config => {
      configured = Boolean(config.apiUrl && config.apiKey); renderRepair();
    });
  }
  renderRepair();
});
renderRepair();
void chrome.runtime.sendMessage({ type: "thumbnail-repair", action: "state" }).then(result => {
  if (result?.ok && result.state) { repairState = result.state; renderRepair(); }
}).catch(() => {
  repairCommandError = "repair.extensionReload";
  renderRepair();
});

onLanguageChange(() => {
  renderStatus();
  renderRepair();
});
await initializeI18n();
void loadSettings();
