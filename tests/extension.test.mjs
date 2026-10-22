import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test, before, after } from "node:test";

const PROJECT_DIR = resolve(fileURLToPath(new URL("..", import.meta.url)));
const EXTENSION_DIR = resolve(PROJECT_DIR, "extension");
const PAGE_URL = "https://article.example/Story?A=one&b=two";
const BROWSER_EXECUTABLE = [
  process.env.PLAYWRIGHT_EXECUTABLE_PATH,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "/usr/bin/chromium",
  "/usr/bin/google-chrome",
].filter(Boolean).find((candidate) => existsSync(candidate));

function loadPlaywright() {
  const require = createRequire(import.meta.url);
  const candidates = [
    process.env.PLAYWRIGHT_MODULE,
    "playwright",
    join(homedir(), ".cache", "codex-runtimes", "codex-primary-runtime", "dependencies", "node", "node_modules", "playwright"),
  ].filter(Boolean);
  const failures = [];
  for (const candidate of candidates) {
    try {
      return require(candidate);
    } catch (error) {
      failures.push(`${candidate}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(`Playwright is required for the extension browser tests. Set PLAYWRIGHT_MODULE or install it in the standard Node resolution path.\n${failures.join("\n")}`);
}

const { chromium } = loadPlaywright();
const duplicateFixtures = [
  { id: "active-1", title: "同じURLのメモ", archived: false, deleted_at: null },
  { id: "archived-1", title: "アーカイブ済み", archived: true, deleted_at: null },
  { id: "trash-1", title: "ゴミ箱のメモ", archived: false, deleted_at: "2026-10-01T00:00:00.000Z" },
];

let browser;

async function openPopup({
  failDuplicateCheck = false,
  failSave = false,
  delayDuplicateCheck = false,
  language = "ja",
  notes = duplicateFixtures,
} = {}) {
  const context = await browser.newContext();
  await context.route("https://keep.example/**", (route) => route.fulfill({
    contentType: "text/html; charset=utf-8",
    body: "<!doctype html><html><body>MyKeep note</body></html>",
  }));
  const page = await context.newPage();
  await page.setViewportSize({ width: 340, height: 900 });
  await page.addInitScript(({ pageUrl, notes, failCheck, failPost, delayCheck, initialLanguage }) => {
    const mock = window.__myKeepMock = { calls: [], posts: [], openedTabs: [] };
    const settings = { apiUrl: "https://keep.example/api/capture", apiKey: "extension-test-key", language: initialLanguage };
    let resolveDelayedDuplicate;
    const storageGet = async (keys) => {
      if (Array.isArray(keys)) return Object.fromEntries(keys.map((key) => [key, settings[key]]));
      if (typeof keys === "string") return { [keys]: settings[keys] };
      return { ...settings };
    };
    window.chrome = {
      storage: {
        local: {
          get: storageGet,
          set: async (values) => Object.assign(settings, values),
        },
        onChanged: { addListener: () => {} },
      },
      tabs: {
        query: async () => [{ id: 7, title: "Current tab title", url: pageUrl }],
        create: async (details) => { mock.openedTabs.push(details.url); },
      },
      scripting: {
        executeScript: async () => [{ result: { href: pageUrl, title: "Page metadata title", description: "Description", image: "" } }],
      },
    };
    window.fetch = async (input, options = {}) => {
      const requestUrl = new URL(typeof input === "string" ? input : input.toString());
      const method = options.method || "GET";
      const call = {
        method,
        mode: requestUrl.searchParams.get("mode"),
        url: requestUrl.searchParams.get("url"),
        credentials: options.credentials,
        redirect: options.redirect,
        authorization: options.headers?.Authorization || "",
      };
      mock.calls.push(call);
      if (method === "GET" && call.mode === "duplicates") {
        if (failCheck) throw new TypeError("network unavailable");
        if (delayCheck) {
          return new Promise((resolveResponse) => {
            resolveDelayedDuplicate = resolveResponse;
          });
        }
        return new Response(JSON.stringify({ notes, hasMore: false }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (method === "GET") {
        return new Response(JSON.stringify({ labels: ["仕事"], groups: [], labelDetails: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (method === "POST") {
        const payload = {};
        for (const [key, value] of options.body.entries()) {
          payload[key] = value instanceof File
            ? { name: value.name, type: value.type, size: value.size }
            : value;
        }
        mock.posts.push(payload);
        if (failPost) {
          return new Response(JSON.stringify({ error: "popup.error.saveFailed" }), {
            status: 500,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(JSON.stringify({ note: { id: "saved-1", title: payload.title } }), {
          status: 201,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("{}", { status: 404, headers: { "content-type": "application/json" } });
    };
    if (delayCheck) {
      const nativeSetTimeout = window.setTimeout.bind(window);
      window.setTimeout = (callback, delay, ...args) => {
        if (delay === 8000) {
          mock.duplicateTimeoutMs = delay;
          mock.fireDuplicateTimeout = () => callback(...args);
          return nativeSetTimeout(() => {}, 60_000);
        }
        return nativeSetTimeout(callback, delay, ...args);
      };
      mock.releaseDuplicateCheck = (releasedNotes) => {
        if (!resolveDelayedDuplicate) return;
        resolveDelayedDuplicate(new Response(JSON.stringify({ notes: releasedNotes, hasMore: false }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }));
        resolveDelayedDuplicate = null;
      };
    }
  }, {
    pageUrl: PAGE_URL,
    notes,
    failCheck: failDuplicateCheck,
    failPost: failSave,
    delayCheck: delayDuplicateCheck,
    initialLanguage: language,
  });
  await page.goto(pathToFileURL(join(EXTENSION_DIR, "popup.html")).href);
  await page.waitForFunction(() => window.__myKeepMock.calls.some((call) => call.mode === "duplicates"));
  return { context, page };
}

before(async () => {
  browser = await chromium.launch({
    headless: true,
    args: ["--allow-file-access-from-files"],
    ...(BROWSER_EXECUTABLE ? { executablePath: BROWSER_EXECUTABLE } : {}),
  });
});

after(async () => {
  await browser?.close();
});

test("duplicate matches link to saved notes and require a cancellable, data-preserving confirmation", async () => {
  const { context, page } = await openPopup();
  try {
    await page.waitForFunction(() => !document.querySelector("#save").disabled && document.querySelectorAll("#duplicateList a").length === 3);
    const duplicateRequest = await page.evaluate(() => window.__myKeepMock.calls.find((call) => call.mode === "duplicates"));
    assert.equal(await page.evaluate(() => window.__myKeepMock.calls.filter((call) => call.mode === "duplicates").length), 1);
    assert.equal(duplicateRequest.url, await page.locator("#url").inputValue());
    assert.equal(duplicateRequest.url, PAGE_URL);
    assert.equal(duplicateRequest.credentials, "omit");
    assert.equal(duplicateRequest.redirect, "error");
    assert.equal(duplicateRequest.authorization, "Bearer extension-test-key");
    assert.equal(await page.locator("#duplicateList a").nth(0).getAttribute("href"), "https://keep.example/?note=active-1");
    assert.match(await page.locator("#duplicateList").innerText(), /アーカイブ/);
    assert.match(await page.locator("#duplicateList").innerText(), /ゴミ箱/);

    const opened = page.waitForEvent("popup");
    await page.locator("#duplicateList a").first().click();
    const notePage = await opened;
    assert.equal(notePage.url(), "https://keep.example/?note=active-1");
    await notePage.close();

    await page.locator("#title").fill("Edited title");
    await page.locator("#body").fill("Keep this body until I confirm.");
    await page.locator("#pinned").check();
    await page.waitForFunction(() => !document.querySelector("#labelToggle").disabled);
    await page.locator("#labelToggle").click();
    await page.waitForFunction(() => document.querySelectorAll("#labelOptions input").length === 1);
    await page.locator("#labelOptions input").check();
    await page.locator("#imageFile").setInputFiles({ name: "clip.png", mimeType: "image/png", buffer: Buffer.from("test image") });

    await page.locator("#title").press("Enter");
    assert.equal(await page.locator("#duplicateConfirm").isVisible(), true);
    assert.equal(await page.evaluate(() => window.__myKeepMock.posts.length), 0);
    await page.locator("#cancelAdd").click();
    assert.equal(await page.locator("#duplicateConfirm").isVisible(), false);
    assert.equal(await page.locator("#title").inputValue(), "Edited title");
    assert.equal(await page.locator("#body").inputValue(), "Keep this body until I confirm.");
    assert.equal(await page.locator("#pinned").isChecked(), true);
    assert.equal(await page.locator("#labelOptions input").isChecked(), true);
    assert.equal(await page.locator("#imagePreview").isVisible(), true);
    assert.equal(await page.evaluate(() => window.__myKeepMock.posts.length), 0);

    await page.locator("#save").click();
    await page.locator("#confirmAdd").click();
    await page.waitForFunction(() => window.__myKeepMock.posts.length === 1);
    const payload = await page.evaluate(() => window.__myKeepMock.posts[0]);
    assert.equal(payload.title, "Edited title");
    assert.equal(payload.url, PAGE_URL);
    assert.equal(payload.body, "Keep this body until I confirm.");
    assert.equal(payload.pinned, "true");
    assert.equal(payload.labels, JSON.stringify(["仕事"]));
    assert.deepEqual(payload.image, { name: "clip.png", type: "image/png", size: 10 });
    await page.waitForFunction(() => Array.from(document.querySelectorAll("#duplicateList a")).some((link) => link.textContent === "Edited title"));

    await page.locator("#save").click();
    assert.equal(await page.locator("#duplicateConfirm").isVisible(), true);
    await page.locator("#cancelAdd").click();
    assert.equal(await page.evaluate(() => window.__myKeepMock.posts.length), 1);
  } finally {
    await context.close();
  }
});

test("zero matches save directly, then the successful save warns before another copy", async () => {
  const { context, page } = await openPopup({ notes: [] });
  try {
    await page.waitForFunction(() => !document.querySelector("#save").disabled && document.querySelector("#duplicatePanel").hidden);
    await page.locator("#title").fill("First save");
    await page.locator("#body").fill("First copy body");
    await page.locator("#save").click();
    await page.waitForFunction(() => window.__myKeepMock.posts.length === 1);
    await page.waitForFunction(() => document.querySelectorAll("#duplicateList a").length === 1 && !document.querySelector("#save").disabled);
    assert.equal(await page.locator("#duplicateConfirm").isVisible(), false);
    assert.equal(await page.locator("#duplicateList a").count(), 1);
    assert.equal(await page.locator("#duplicateList a").getAttribute("href"), "https://keep.example/?note=saved-1");

    await page.locator("#save").click();
    assert.equal(await page.locator("#duplicateConfirm").isVisible(), true);
    assert.equal(await page.evaluate(() => window.__myKeepMock.posts.length), 1);
    await page.locator("#cancelAdd").click();
  } finally {
    await context.close();
  }
});

test("the 8-second timeout enables save and a late duplicate response cannot replace the new result", async () => {
  const { context, page } = await openPopup({ notes: [], delayDuplicateCheck: true });
  try {
    await page.waitForFunction(() => window.__myKeepMock.duplicateTimeoutMs === 8000);
    await page.evaluate(() => window.__myKeepMock.fireDuplicateTimeout());
    await page.waitForFunction(() => document.querySelector("#duplicateStatus").textContent.includes("重複を確認できませんでした")
      && !document.querySelector("#save").disabled);
    await page.locator("#title").fill("Saved after timeout");
    await page.locator("#save").click();
    await page.waitForFunction(() => window.__myKeepMock.posts.length === 1);
    await page.evaluate(() => window.__myKeepMock.releaseDuplicateCheck([
      { id: "late-result", title: "Late duplicate response", archived: false, deleted_at: null },
    ]));
    await page.evaluate(() => new Promise((resolveMicrotask) => setTimeout(resolveMicrotask, 0)));
    assert.equal(await page.locator("#duplicateList a").count(), 1);
    assert.equal(await page.locator("#duplicateList a").getAttribute("href"), "https://keep.example/?note=saved-1");
    assert.equal(await page.locator("#duplicateList").innerText(), "Saved after timeout");
    await page.locator("#save").click();
    assert.equal(await page.locator("#duplicateConfirm").isVisible(), true);
    assert.equal(await page.evaluate(() => window.__myKeepMock.posts.length), 1);
  } finally {
    await context.close();
  }
});

test("a failed save retains title, body, image, labels, and pin state", async () => {
  const { context, page } = await openPopup({ failSave: true });
  try {
    await page.waitForFunction(() => !document.querySelector("#save").disabled && document.querySelectorAll("#duplicateList a").length === 3);
    await page.locator("#title").fill("Retain my title");
    await page.locator("#body").fill("Retain my body");
    await page.locator("#pinned").check();
    await page.waitForFunction(() => !document.querySelector("#labelToggle").disabled);
    await page.locator("#labelToggle").click();
    await page.locator("#labelOptions input").check();
    await page.locator("#imageFile").setInputFiles({ name: "retain.png", mimeType: "image/png", buffer: Buffer.from("image bytes") });

    await page.locator("#save").click();
    await page.locator("#confirmAdd").click();
    await page.waitForFunction(() => document.querySelector("#status").textContent.includes("保存できませんでした"));
    assert.equal(await page.locator("#title").inputValue(), "Retain my title");
    assert.equal(await page.locator("#body").inputValue(), "Retain my body");
    assert.equal(await page.locator("#pinned").isChecked(), true);
    assert.equal(await page.locator("#labelOptions input").isChecked(), true);
    assert.equal(await page.locator("#imagePreview").isVisible(), true);
    assert.equal(await page.locator("#imageName").innerText(), "retain.png");
    assert.equal(await page.evaluate(() => window.__myKeepMock.posts.length), 1);
  } finally {
    await context.close();
  }
});

test("long duplicate titles stay within the 340px popup width", async () => {
  const longTitle = "W".repeat(600);
  const { context, page } = await openPopup({ notes: [{ id: "long-title", title: longTitle, archived: false, deleted_at: null }] });
  try {
    await page.waitForFunction(() => !document.querySelector("#save").disabled && document.querySelectorAll("#duplicateList a").length === 1);
    const dimensions = await page.evaluate(() => ({
      viewportWidth: document.documentElement.clientWidth,
      documentWidth: document.documentElement.scrollWidth,
      bodyWidth: document.body.clientWidth,
      bodyScrollWidth: document.body.scrollWidth,
    }));
    assert.equal(dimensions.viewportWidth, 340);
    assert.ok(dimensions.documentWidth <= 340, JSON.stringify(dimensions));
    assert.ok(dimensions.bodyScrollWidth <= dimensions.bodyWidth, JSON.stringify(dimensions));
  } finally {
    await context.close();
  }
});

test("a failed duplicate check keeps saving available and uses the English fallback message", async () => {
  const { context, page } = await openPopup({ failDuplicateCheck: true, language: "en" });
  try {
    await page.waitForFunction(() => document.querySelector("#duplicateStatus").textContent.includes("Could not check duplicates"));
    assert.equal(await page.locator("#save").isEnabled(), true);
    await page.locator("#title").fill("Available to save");
    await page.locator("#save").click();
    await page.waitForFunction(() => window.__myKeepMock.posts.length === 1);
    await page.waitForFunction(() => document.querySelector("#status").textContent === "Saved.");
    assert.equal(await page.locator("#status").innerText(), "Saved.");
    assert.equal(await page.locator("#duplicateConfirm").isVisible(), false);
  } finally {
    await context.close();
  }
});
