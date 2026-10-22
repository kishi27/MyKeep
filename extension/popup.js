import { captureEndpoint, IMAGE_TYPES, MAX_IMAGE_BYTES, noteUrlFromCaptureEndpoint } from "./shared.js";
import { readPageMetadata } from "./pageMetadata.js";
import { getLanguage, initializeI18n, localizeError, onLanguageChange, t } from "./i18n.js";

const MAX_LABEL_SELECTIONS = 50;
const LABEL_GROUPS_EXPANDED_STORAGE_KEY = "mykeepLabelGroupsExpanded";

const form = document.getElementById("captureForm");
const title = document.getElementById("title");
const url = document.getElementById("url");
const body = document.getElementById("body");
const pinned = document.getElementById("pinned");
const labelPicker = document.querySelector(".label-picker");
const labelToggle = document.getElementById("labelToggle");
const labelOptions = document.getElementById("labelOptions");
const selectedLabelsElement = document.getElementById("selectedLabels");
const labelStatus = document.getElementById("labelStatus");
const imageFile = document.getElementById("imageFile");
const imagePreview = document.getElementById("imagePreview");
const previewImage = document.getElementById("previewImage");
const imageName = document.getElementById("imageName");
const status = document.getElementById("status");
const save = document.getElementById("save");
const openNote = document.getElementById("openNote");
const duplicatePanel = document.getElementById("duplicatePanel");
const duplicateStatus = document.getElementById("duplicateStatus");
const saveWithoutWaiting = document.getElementById("saveWithoutWaiting");
const duplicateList = document.getElementById("duplicateList");
const duplicateMore = document.getElementById("duplicateMore");
const duplicateConfirm = document.getElementById("duplicateConfirm");
const confirmAdd = document.getElementById("confirmAdd");
const cancelAdd = document.getElementById("cancelAdd");
const DUPLICATE_CHECK_TIMEOUT_MS = 8000;
let selectedImage = null;
let previewUrl = null;
let availableLabels = [];
let availableGroups = [];
let ungroupedLabels = [];
let expandedLabelGroupIds = new Set();
let selectedLabels = [];
let savedNoteUrl = "";
let pagePreview = { title: "", description: "", image: "", hostname: "" };
let titleEdited = false;
let statusMessage = "";
let statusIsError = false;
let labelStatusMessage = "";
let duplicateCheckState = "idle";
let duplicateNotes = [];
let duplicateHasMore = false;
let duplicateSavedWithoutId = false;
let duplicateEndpoint = "";
let duplicateConfirmationOpen = false;
let duplicateCheckToken = 0;
let duplicateCheckController = null;
let duplicateCheckTimeoutId = null;
let isSaving = false;

function renderStatus() {
  status.textContent = !statusMessage ? "" : statusIsError
    ? localizeError(statusMessage, "popup.error.sendFailed")
    : t(statusMessage);
  status.classList.toggle("error", statusIsError);
}

function showLabelStatus(message) {
  labelStatusMessage = message;
  labelStatus.textContent = message ? t(message) : "";
}

function showStatus(message, error = false) {
  statusMessage = message;
  statusIsError = error;
  renderStatus();
}

function hasDuplicateMatches() {
  return duplicateNotes.length > 0 || duplicateHasMore || duplicateSavedWithoutId;
}

function renderDuplicatePanel() {
  duplicateList.replaceChildren();
  duplicateMore.hidden = true;
  saveWithoutWaiting.hidden = duplicateCheckState !== "checking";
  duplicateConfirm.hidden = !duplicateConfirmationOpen;

  if (duplicateCheckState === "idle" || (duplicateCheckState === "ready" && !hasDuplicateMatches())) {
    duplicatePanel.hidden = true;
    return;
  }

  duplicatePanel.hidden = false;
  if (duplicateCheckState === "checking") {
    duplicateStatus.textContent = t("popup.duplicatesChecking");
  } else if (duplicateCheckState === "unavailable") {
    duplicateStatus.textContent = t("popup.duplicateCheckFailed");
  } else if (duplicateCheckState === "skipped" && !hasDuplicateMatches()) {
    duplicateStatus.textContent = t("popup.duplicateCheckSkipped");
  } else {
    duplicateStatus.textContent = t("popup.duplicatesFound");
  }
  if (hasDuplicateMatches()) {
    for (const note of duplicateNotes) {
      const item = document.createElement("li");
      let label = null;
      try {
        const href = noteUrlFromCaptureEndpoint(duplicateEndpoint, note.id);
        const link = document.createElement("a");
        link.href = href;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.textContent = note.title || t("popup.duplicateUntitled");
        item.append(link);
      } catch {
        item.append(document.createTextNode(note.title || t("popup.duplicateUntitled")));
      }
      if (note.deleted_at != null) label = t("popup.duplicateTrash");
      else if (note.archived) label = t("popup.duplicateArchived");
      if (label) {
        const kind = document.createElement("span");
        kind.className = "duplicate-kind";
        kind.textContent = label;
        item.append(kind);
      }
      duplicateList.append(item);
    }
    duplicateMore.hidden = !duplicateHasMore;
  }
}

function invalidateDuplicateCheck(nextState) {
  if (duplicateCheckState !== "checking") return false;
  duplicateCheckToken += 1;
  duplicateCheckController?.abort();
  duplicateCheckController = null;
  if (duplicateCheckTimeoutId !== null) clearTimeout(duplicateCheckTimeoutId);
  duplicateCheckTimeoutId = null;
  duplicateCheckState = nextState;
  return true;
}

function checkDuplicatesForUrl(pageUrl) {
  duplicateCheckController?.abort();
  if (duplicateCheckTimeoutId !== null) clearTimeout(duplicateCheckTimeoutId);
  const checkToken = ++duplicateCheckToken;
  const controller = new AbortController();
  duplicateCheckController = controller;
  let timedOut = false;
  duplicateCheckState = "checking";
  renderDuplicatePanel();
  setSaveEnabled();

  const timeoutId = setTimeout(() => {
    timedOut = true;
    controller.abort();
    if (checkToken === duplicateCheckToken) {
      duplicateCheckController = null;
      duplicateCheckTimeoutId = null;
      duplicateCheckState = "unavailable";
      renderDuplicatePanel();
      setSaveEnabled();
    }
  }, DUPLICATE_CHECK_TIMEOUT_MS);
  duplicateCheckTimeoutId = timeoutId;

  void (async () => {
    try {
      const settings = await chrome.storage.local.get(["apiUrl", "apiKey"]);
      if (controller.signal.aborted) return;
      if (!settings.apiUrl || !settings.apiKey) throw new Error("duplicate_check_unavailable");

      const endpoint = captureEndpoint(settings.apiUrl);
      const requestUrl = new URL(endpoint);
      requestUrl.searchParams.set("mode", "duplicates");
      requestUrl.searchParams.set("url", pageUrl);
      const response = await fetch(requestUrl.href, {
        method: "GET",
        headers: { Authorization: `Bearer ${settings.apiKey}` },
        credentials: "omit",
        redirect: "error",
        signal: controller.signal,
      });
      let result = null;
      try {
        result = await response.json();
      } catch {
        result = null;
      }
      if (!response.ok || !result || !Array.isArray(result.notes)) {
        throw new Error("duplicate_check_unavailable");
      }
      if (checkToken !== duplicateCheckToken || controller.signal.aborted) return;

      duplicateEndpoint = endpoint;
      duplicateNotes = result.notes.filter((note) => note && typeof note === "object"
        && typeof note.id === "string" && note.id.trim() && note.id.length <= 200)
        .slice(0, 5)
        .map((note) => ({
          id: note.id,
          title: typeof note.title === "string" ? note.title : "",
          archived: note.archived === true,
          deleted_at: note.deleted_at ?? null,
        }));
      duplicateHasMore = result.hasMore === true;
      duplicateCheckState = "ready";
      renderDuplicatePanel();
      setSaveEnabled();
    } catch {
      if (checkToken !== duplicateCheckToken || timedOut) return;
      duplicateCheckState = "unavailable";
      renderDuplicatePanel();
      setSaveEnabled();
    } finally {
      clearTimeout(timeoutId);
      if (checkToken === duplicateCheckToken) {
        duplicateCheckController = null;
        duplicateCheckTimeoutId = null;
      }
    }
  })();
}

function bypassDuplicateCheck() {
  if (!invalidateDuplicateCheck("skipped")) return;
  if (hasDuplicateMatches()) {
    duplicateConfirmationOpen = true;
    renderDuplicatePanel();
    setSaveEnabled();
    confirmAdd.focus();
    return;
  }
  duplicateConfirmationOpen = false;
  renderDuplicatePanel();
  setSaveEnabled();
  void saveCapture();
}

function isHttpUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function pageHostname(value) {
  try {
    const parsed = new URL(value);
    return isHttpUrl(value) && parsed.hostname.length <= 255 ? parsed.hostname : "";
  } catch {
    return "";
  }
}

function setSaveEnabled() {
  const validUrl = isHttpUrl(url.value) && url.value.length <= 2000;
  save.hidden = duplicateConfirmationOpen;
  save.disabled = !validUrl || duplicateCheckState === "checking" || isSaving;
  saveWithoutWaiting.disabled = isSaving;
  confirmAdd.disabled = !validUrl || isSaving;
  cancelAdd.disabled = isSaving;
}

function limitText(value, maxLength) {
  return typeof value === "string" ? value.slice(0, maxLength) : "";
}

function previewText(value, maxLength) {
  // Use single-line metadata so multipart newline conversion cannot exceed the limit.
  return typeof value === "string" ? value.replace(/\r\n|\r|\n/g, " ").trim().slice(0, maxLength) : "";
}

function previewImageUrl(value) {
  if (typeof value !== "string") return "";
  const image = value.trim();
  return image.length <= 2000 && isHttpUrl(image) ? image : "";
}

function labelKey(value) {
  return value.trim().normalize("NFC").toLowerCase();
}

function normalizeLabels(values) {
  const result = [];
  const seen = new Set();
  for (const value of values) {
    if (typeof value !== "string") continue;
    const name = value.trim().normalize("NFC");
    if (!name || name.length > 100) continue;
    const key = labelKey(name);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(name);
  }
  return result;
}

function normalizeGroupId(value) {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

function labelNameCollator() {
  return new Intl.Collator(getLanguage() === "en" ? "en" : "ja", { numeric: true, sensitivity: "base" });
}

function sortLabelNames(values) {
  const collator = labelNameCollator();
  return [...values].sort((left, right) => collator.compare(left, right));
}

function organizeLabelData(result, labels) {
  const groups = [];
  const seenGroupIds = new Set();
  for (const value of Array.isArray(result.groups) ? result.groups : []) {
    if (!value || typeof value !== "object") continue;
    const id = normalizeGroupId(value.id);
    const name = typeof value.name === "string" ? value.name.trim().normalize("NFC") : "";
    if (!id || !name || seenGroupIds.has(id)) continue;
    seenGroupIds.add(id);
    groups.push({ id, name, labels: [] });
  }

  const groupsById = new Map(groups.map((group) => [group.id, group]));
  const groupByLabelKey = new Map();
  for (const detail of Array.isArray(result.labelDetails) ? result.labelDetails : []) {
    if (!detail || typeof detail !== "object" || typeof detail.name !== "string") continue;
    const name = detail.name.trim().normalize("NFC");
    if (!name) continue;
    groupByLabelKey.set(labelKey(name), normalizeGroupId(detail.group_id));
  }

  const ungrouped = [];
  for (const name of sortLabelNames(labels)) {
    const group = groupsById.get(groupByLabelKey.get(labelKey(name)));
    if (group) group.labels.push(name);
    else ungrouped.push(name);
  }
  for (const group of groups) group.labels = sortLabelNames(group.labels);
  const collator = labelNameCollator();
  groups.sort((left, right) => collator.compare(left.name, right.name));

  return { labels: sortLabelNames(labels), groups, ungroupedLabels: ungrouped };
}

function renderSelectedLabels() {
  selectedLabelsElement.replaceChildren();
  for (const name of selectedLabels) {
    const chip = document.createElement("span");
    chip.className = "selected-label";
    chip.append(document.createTextNode(name));
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "text-button";
    remove.setAttribute("aria-label", t("popup.removeLabel", { label: name }));
    remove.textContent = "×";
    remove.addEventListener("click", () => toggleLabel(name, false));
    chip.append(remove);
    selectedLabelsElement.append(chip);
  }
  if (selectedLabels.length) {
    const key = selectedLabels.length === 1 ? "popup.selectedLabelsOne" : "popup.selectedLabelsMany";
    labelToggle.textContent = t(key, { count: new Intl.NumberFormat(getLanguage() === "en" ? "en-US" : "ja-JP").format(selectedLabels.length) });
  } else {
    labelToggle.textContent = t("popup.selectLabels");
  }
}

function updateLabelOptionState() {
  const selected = new Set(selectedLabels.map(labelKey));
  labelOptions.querySelectorAll("input[type=checkbox]").forEach((checkbox) => {
    const input = checkbox;
    const key = labelKey(input.value);
    input.checked = selected.has(key);
    input.disabled = selectedLabels.length >= MAX_LABEL_SELECTIONS && !input.checked;
  });
}

function toggleLabel(name, checked) {
  const key = labelKey(name);
  const index = selectedLabels.findIndex((label) => labelKey(label) === key);
  if (checked) {
    if (index >= 0) return;
    if (selectedLabels.length >= MAX_LABEL_SELECTIONS) return;
    selectedLabels = [...selectedLabels, name];
  } else if (index >= 0) {
    selectedLabels = selectedLabels.filter((_, currentIndex) => currentIndex !== index);
  }
  renderSelectedLabels();
  updateLabelOptionState();
}

function createLabelOption(name) {
  const option = document.createElement("label");
  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.value = name;
  checkbox.addEventListener("change", () => toggleLabel(name, checkbox.checked));
  option.append(checkbox, document.createTextNode(name));
  return option;
}

function persistExpandedLabelGroups() {
  void chrome.storage.local.set({
    [LABEL_GROUPS_EXPANDED_STORAGE_KEY]: Array.from(expandedLabelGroupIds),
  }).catch(() => {});
}

async function loadExpandedLabelGroups() {
  try {
    const settings = await chrome.storage.local.get(LABEL_GROUPS_EXPANDED_STORAGE_KEY);
    const storedIds = settings[LABEL_GROUPS_EXPANDED_STORAGE_KEY];
    expandedLabelGroupIds = new Set(
      Array.isArray(storedIds) ? storedIds.map(normalizeGroupId).filter(Boolean) : [],
    );
  } catch {
    expandedLabelGroupIds = new Set();
  }
}

function renderLabelOptions() {
  labelOptions.replaceChildren();
  availableGroups.forEach((group, index) => {
    const section = document.createElement("div");
    section.className = "label-group";
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "label-group-toggle";
    toggle.textContent = group.name;
    toggle.setAttribute("aria-expanded", String(expandedLabelGroupIds.has(group.id)));
    toggle.setAttribute("aria-controls", `labelGroupOptions-${index}`);
    toggle.setAttribute("aria-label", t("popup.toggleLabelGroup", { group: group.name }));

    const children = document.createElement("div");
    children.id = `labelGroupOptions-${index}`;
    children.className = "label-group-options";
    children.setAttribute("role", "group");
    children.setAttribute("aria-label", group.name);
    children.hidden = !expandedLabelGroupIds.has(group.id);
    for (const name of group.labels) children.append(createLabelOption(name));

    toggle.addEventListener("click", () => {
      const expanded = !expandedLabelGroupIds.has(group.id);
      if (expanded) expandedLabelGroupIds.add(group.id);
      else expandedLabelGroupIds.delete(group.id);
      toggle.setAttribute("aria-expanded", String(expanded));
      children.hidden = !expanded;
      persistExpandedLabelGroups();
    });
    section.append(toggle, children);
    labelOptions.append(section);
  });

  if (availableGroups.length && ungroupedLabels.length) {
    const divider = document.createElement("div");
    divider.className = "label-group-divider";
    divider.setAttribute("role", "separator");
    const ungrouped = document.createElement("div");
    ungrouped.className = "label-ungrouped";
    ungrouped.setAttribute("role", "group");
    ungrouped.setAttribute("aria-label", t("popup.ungroupedLabels"));
    const heading = document.createElement("div");
    heading.className = "label-ungrouped-title";
    heading.textContent = t("popup.ungroupedLabels");
    ungrouped.append(heading);
    for (const name of ungroupedLabels) ungrouped.append(createLabelOption(name));
    labelOptions.append(divider, ungrouped);
  } else {
    for (const name of ungroupedLabels) labelOptions.append(createLabelOption(name));
  }

  const hasLabelOptions = availableLabels.length > 0 || availableGroups.length > 0;
  labelToggle.disabled = !hasLabelOptions;
  if (!hasLabelOptions) {
    labelOptions.hidden = true;
    labelToggle.setAttribute("aria-expanded", "false");
  }
  updateLabelOptionState();
  renderSelectedLabels();
}

async function loadLabels() {
  try {
    const settings = await chrome.storage.local.get(["apiUrl", "apiKey"]);
    if (!settings.apiUrl || !settings.apiKey) return;
    await loadExpandedLabelGroups();
    const endpoint = captureEndpoint(settings.apiUrl);
    const response = await fetch(endpoint, {
      method: "GET",
      headers: { Authorization: `Bearer ${settings.apiKey}` },
      credentials: "omit",
      redirect: "error",
    });
    let result = null;
    try {
      result = await response.json();
    } catch {
      result = null;
    }
    if (!response.ok || !result || !Array.isArray(result.labels)) {
      throw new Error("labels_unavailable");
    }
    const labels = normalizeLabels(result.labels.map((value) => {
      if (typeof value === "string") return value;
      if (value && typeof value === "object" && typeof value.name === "string") return value.name;
      return "";
    }));
    const labelData = organizeLabelData(result, labels);
    availableLabels = labelData.labels;
    availableGroups = labelData.groups;
    ungroupedLabels = labelData.ungroupedLabels;
    renderLabelOptions();
    showLabelStatus(!availableLabels.length && !availableGroups.length ? "popup.noLabels" : "");
  } catch {
    showLabelStatus("popup.labelsLoadFailed");
  }
}

async function loadPage() {
  titleEdited = false;
  duplicateCheckController?.abort();
  duplicateCheckController = null;
  if (duplicateCheckTimeoutId !== null) clearTimeout(duplicateCheckTimeoutId);
  duplicateCheckTimeoutId = null;
  duplicateCheckToken += 1;
  duplicateCheckState = "idle";
  duplicateNotes = [];
  duplicateHasMore = false;
  duplicateSavedWithoutId = false;
  duplicateEndpoint = "";
  duplicateConfirmationOpen = false;
  isSaving = false;
  title.value = "";
  url.value = "";
  body.value = "";
  pinned.checked = false;
  pagePreview = { title: "", description: "", image: "", hostname: "" };
  hideSavedNoteLink();
  showStatus("");
  renderDuplicatePanel();
  selectedLabels = [];
  renderSelectedLabels();
  updateLabelOptionState();
  labelOptions.hidden = true;
  labelToggle.setAttribute("aria-expanded", "false");
  clearImage();
  save.disabled = true;
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    const tabTitle = limitText(typeof tab?.title === "string" ? tab.title : "", 300);
    if (!titleEdited) title.value = tabTitle;
    url.value = typeof tab?.url === "string" ? tab.url : "";
    pagePreview = { title: tabTitle, description: "", image: "", hostname: pageHostname(url.value) };
    if (!isHttpUrl(url.value) || url.value.length > 2000) {
      setSaveEnabled();
      return;
    }

    if (tab?.id) {
      try {
        const [injected] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: readPageMetadata });
        const metadata = injected?.result;
        if (metadata && typeof metadata === "object") {
          if (isHttpUrl(metadata.href)) url.value = metadata.href;
          const metadataTitle = limitText(metadata.title, 300);
          const metadataDescription = previewText(metadata.description, 500);
          const metadataImage = previewImageUrl(metadata.image);
          const metadataHostname = pageHostname(url.value);
          if (!titleEdited && typeof metadata.title === "string") title.value = metadataTitle;
          pagePreview = {
            title: metadataTitle || pagePreview.title,
            description: metadataDescription,
            image: metadataImage,
            hostname: metadataHostname || pageHostname(url.value),
          };
        }
      } catch {
        // Restricted pages and pages that change during injection still keep the tab title and URL.
      }
    }
    setSaveEnabled();
    if (isHttpUrl(url.value) && url.value.length <= 2000) checkDuplicatesForUrl(url.value);
  } catch {
    save.disabled = true;
    showStatus("popup.pageUnreadable", true);
  }
}

function clearImage() {
  selectedImage = null;
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = null;
  previewImage.removeAttribute("src");
  imagePreview.hidden = true;
  imageFile.value = "";
}

function setImage(file) {
  if (!IMAGE_TYPES.includes(file.type.toLowerCase())) {
    showStatus("popup.imageTypeError", true);
    return;
  }
  if (!file.size || file.size > MAX_IMAGE_BYTES) {
    showStatus("popup.imageSizeError", true);
    return;
  }
  clearImage();
  selectedImage = file;
  previewUrl = URL.createObjectURL(file);
  previewImage.src = previewUrl;
  imageName.textContent = file.name || t("popup.pastedImageName");
  imagePreview.hidden = false;
  showStatus("");
}

function hideSavedNoteLink() {
  savedNoteUrl = "";
  openNote.hidden = true;
}

labelToggle.addEventListener("click", () => {
  if (labelToggle.disabled) return;
  const expanded = labelToggle.getAttribute("aria-expanded") === "true";
  labelToggle.setAttribute("aria-expanded", String(!expanded));
  labelOptions.hidden = expanded;
});
document.addEventListener("click", (event) => {
  if (!labelPicker.contains(event.target)) {
    labelToggle.setAttribute("aria-expanded", "false");
    labelOptions.hidden = true;
  }
});

title.addEventListener("input", () => { titleEdited = true; });

document.getElementById("removeImage").addEventListener("click", clearImage);
saveWithoutWaiting.addEventListener("click", bypassDuplicateCheck);
openNote.addEventListener("click", async () => {
  if (!savedNoteUrl) return;
  try {
    await chrome.tabs.create({ url: savedNoteUrl });
  } catch {
    showStatus("popup.error.openFailed", true);
  }
});
imageFile.addEventListener("change", () => {
  const file = imageFile.files?.[0];
  if (file) setImage(file);
  imageFile.value = "";
});
document.addEventListener("paste", (event) => {
  const item = Array.from(event.clipboardData?.items ?? []).find((entry) => entry.type.startsWith("image/"));
  const file = item?.getAsFile();
  if (file) {
    event.preventDefault();
    setImage(file);
  }
});

async function saveCapture() {
  if (isSaving || !isHttpUrl(url.value) || url.value.length > 2000) return;
  isSaving = true;
  setSaveEnabled();
  hideSavedNoteLink();
  showStatus("popup.saving");
  try {
    const settings = await chrome.storage.local.get(["apiUrl", "apiKey"]);
    if (!settings.apiUrl || !settings.apiKey) throw new Error("popup.error.apiKeyRequired");
    const endpoint = captureEndpoint(settings.apiUrl);
    if (!isHttpUrl(url.value) || url.value.length > 2000) {
      throw new Error("popup.error.invalidPageUrl");
    }
    duplicateEndpoint = endpoint;

    const data = new FormData();
    data.set("title", limitText(title.value, 300));
    data.set("url", url.value);
    data.set("body", body.value);
    data.set("pinned", pinned.checked ? "true" : "false");
    data.set("labels", JSON.stringify(selectedLabels));
    data.set("preview_title", previewText(pagePreview.title || title.value, 300));
    data.set("preview_description", previewText(pagePreview.description, 500));
    data.set("preview_image", previewImageUrl(pagePreview.image));
    data.set("preview_hostname", pageHostname(url.value));
    if (selectedImage) data.set("image", selectedImage, selectedImage.name || "pasted.png");
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${settings.apiKey}` },
      body: data,
      credentials: "omit",
      redirect: "error",
    });
    let result = null;
    try {
      result = await response.json();
    } catch {
      result = null;
    }
    if (!response.ok) throw new Error(result?.error || "popup.error.saveFailed");
    body.value = "";
    clearImage();
    const noteId = result?.note?.id;
    if (typeof noteId === "string" && noteId.trim()) {
      duplicateNotes = [
        {
          id: noteId,
          title: typeof result.note.title === "string" ? result.note.title : limitText(title.value, 300),
          archived: false,
          deleted_at: null,
        },
        ...duplicateNotes.filter((note) => note.id !== noteId),
      ].slice(0, 5);
      duplicateSavedWithoutId = false;
      try {
        savedNoteUrl = noteUrlFromCaptureEndpoint(endpoint, noteId);
        openNote.hidden = false;
      } catch {
        hideSavedNoteLink();
      }
    } else {
      duplicateSavedWithoutId = true;
    }
    duplicateCheckState = "ready";
    duplicateConfirmationOpen = false;
    renderDuplicatePanel();
    showStatus("popup.saved");
  } catch (error) {
    showStatus(error instanceof Error ? error.message : "popup.error.sendFailed", true);
  } finally {
    isSaving = false;
    setSaveEnabled();
  }
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  if (duplicateConfirmationOpen || save.disabled || isSaving || duplicateCheckState === "checking") return;
  if (hasDuplicateMatches()) {
    duplicateConfirmationOpen = true;
    renderDuplicatePanel();
    setSaveEnabled();
    confirmAdd.focus();
    return;
  }
  void saveCapture();
});

confirmAdd.addEventListener("click", () => {
  if (!duplicateConfirmationOpen || isSaving) return;
  void saveCapture();
});
cancelAdd.addEventListener("click", () => {
  if (isSaving) return;
  duplicateConfirmationOpen = false;
  renderDuplicatePanel();
  setSaveEnabled();
  save.focus();
});

onLanguageChange(() => {
  renderLabelOptions();
  renderDuplicatePanel();
  if (labelStatusMessage) labelStatus.textContent = t(labelStatusMessage);
  renderStatus();
});
await initializeI18n();
void loadPage();
void loadLabels();
