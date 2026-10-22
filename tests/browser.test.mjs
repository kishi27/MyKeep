import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync, statSync } from "node:fs";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { pbkdf2Sync } from "node:crypto";
import { test } from "node:test";

const PROJECT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DIST_DIR = resolve(PROJECT_DIR, "dist");
const TEST_PIN = "4826";
const PIN_SALT = "0123456789abcdef0123456789abcdef";
const PIN_RECORD = {
  version: 1,
  salt: PIN_SALT,
  hash: pbkdf2Sync(TEST_PIN, Buffer.from(PIN_SALT, "hex"), 120_000, 32, "sha256").toString("hex"),
  iterations: 120_000,
  failures: 0,
  blockedUntil: 0,
};
const TEST_START = Date.UTC(2026, 9, 22, 0, 0, 0);

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
  throw new Error(`Playwright is required for this browser suite. Set PLAYWRIGHT_MODULE or install it in the standard Node resolution path.\n${failures.join("\n")}`);
}

const { chromium, devices } = loadPlaywright();

function makeNote(id, title, createdAt, updatedAt) {
  return {
    id,
    title,
    body: `${title}の本文`,
    url: "",
    pinned: false,
    archived: false,
    color: "default",
    card_image: "auto",
    preview_title: "",
    preview_description: "",
    preview_image: "",
    preview_hostname: "",
    deleted_at: null,
    created_at: createdAt,
    updated_at: updatedAt,
    attachments: [],
    checklist: [],
    labels: ["仕事"],
  };
}

const NOTE_FIXTURES = [
  makeNote("n-old", "作成が古い", "2026-01-01T00:00:00.000Z", "2026-04-01T00:00:00.000Z"),
  makeNote("n-middle", "中間", "2026-02-01T00:00:00.000Z", "2026-02-01T00:00:00.000Z"),
  makeNote("n-new", "作成が新しい", "2026-03-01T00:00:00.000Z", "2026-03-01T00:00:00.000Z"),
];

const SORT_EXPECTATIONS = {
  updated_desc: ["作成が古い", "作成が新しい", "中間"],
  updated_asc: ["中間", "作成が新しい", "作成が古い"],
  created_desc: ["作成が新しい", "中間", "作成が古い"],
  created_asc: ["作成が古い", "中間", "作成が新しい"],
};

function sortNotes(sort, notes = NOTE_FIXTURES) {
  const [field, direction] = String(sort || "updated_desc").split("_");
  const key = field === "created" ? "created_at" : "updated_at";
  const multiplier = direction === "asc" ? 1 : -1;
  return [...notes].sort((a, b) => multiplier * a[key].localeCompare(b[key]));
}

async function mockApi(context) {
  const state = { calls: [], revision: 1, notes: NOTE_FIXTURES.map((note) => ({ ...note })), exportFailure: false };
  await context.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    state.calls.push({ method: request.method(), path: `${url.pathname}${url.search}` });
    const params = url.searchParams;
    const field = params.get('date_field') === 'updated' ? 'updated_at' : 'created_at';
    const matches = state.notes.filter(note => (!params.get('from') || note[field] >= params.get('from'))
      && (!params.get('before') || note[field] < params.get('before'))
      && (!params.get('q') || `${note.title}${note.body}`.includes(params.get('q'))));
    if (url.pathname === '/api/export/counts') {
      return route.fulfill({ status: state.exportFailure ? 500 : 200, contentType: 'application/json', body: JSON.stringify({
        notes: state.notes.length, attachments: state.notes.reduce((n, note) => n + note.attachments.length, 0),
        max_id: [...state.notes].sort((a,b) => a.id.localeCompare(b.id)).at(-1)?.id ?? null, revision: state.revision,
      }) });
    }
    if (url.pathname === '/api/export/notes') return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ notes: [...state.notes].sort((a,b) => a.id.localeCompare(b.id)), hasMore: false }) });
    if (url.pathname === '/api/files/missing') return route.fulfill({ status: 404, body: 'missing' });

    if (url.pathname === "/api/notes/check") {
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ notes: sortNotes(url.searchParams.get("sort"), matches).map(({ id, updated_at }) => ({ id, updated_at })), revision: state.revision }),
      });
    }
    if (url.pathname === "/api/notes") {
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ notes: sortNotes(url.searchParams.get("sort"), matches), hasMore: false, revision: state.revision }),
      });
    }
    if (url.pathname === "/api/labels") {
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ labels: ["仕事"], groups: [], labelDetails: [{ name: "仕事", group_id: null }] }),
      });
    }
    if (url.pathname === "/api/counts") {
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          views: { active: 3, pinned: 0, unpinned: 3, unlabeled: 0, imageless: 3, archived: 0, trash: 0 },
          labels: { "仕事": 3 },
        }),
      });
    }
    const noteId = decodeURIComponent(url.pathname.slice("/api/notes/".length));
    const note = state.notes.find((item) => item.id === noteId);
    if (request.method() === "GET" && note) {
      return route.fulfill({ contentType: "application/json", body: JSON.stringify({ note }) });
    }
    return route.fulfill({ contentType: "application/json", body: JSON.stringify({}) });
  });
  return state;
}

function startDistServer() {
  if (!statSync(DIST_DIR, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`Built dist directory not found at ${DIST_DIR}; build MyKeep before running this suite.`);
  }
  const indexPath = join(DIST_DIR, "index.html");
  const contentTypes = {
    ".css": "text/css; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".webmanifest": "application/manifest+json; charset=utf-8",
  };
  const server = createServer((request, response) => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405).end();
      return;
    }
    let pathname;
    try { pathname = decodeURIComponent(new URL(request.url || "/", "http://127.0.0.1").pathname); }
    catch { response.writeHead(400).end(); return; }
    const target = resolve(DIST_DIR, `.${pathname}`);
    const pathFromRoot = relative(DIST_DIR, target);
    if (pathFromRoot === ".." || pathFromRoot.startsWith(`..${sep}`) || pathFromRoot.startsWith(`..\\`)) {
      response.writeHead(403).end();
      return;
    }
    let filePath = target;
    try {
      if (!statSync(filePath).isFile()) filePath = indexPath;
    } catch { filePath = indexPath; }
    try {
      const body = readFileSync(filePath);
      response.writeHead(200, {
        "Content-Type": contentTypes[extname(filePath)] || "application/octet-stream",
        "Cache-Control": "no-store",
        "Content-Length": body.length,
      });
      response.end(request.method === "HEAD" ? undefined : body);
    } catch {
      response.writeHead(404).end();
    }
  });
  return new Promise((resolveServer, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolveServer({ server, url: `http://127.0.0.1:${address.port}/` });
    });
  });
}

function browserTargets() {
  const iphone = devices["iPhone 14"] || devices["iPhone 13"]
    || Object.entries(devices).find(([name]) => name.startsWith("iPhone"))?.[1];
  const android = Object.values(devices).find((device) => /Android/i.test(device.userAgent) && /Mobile/i.test(device.userAgent));
  if (!iphone || !android) throw new Error("Playwright must provide both an iPhone and an Android phone emulation.");
  return [
    { name: "wide PC", options: { viewport: { width: 1920, height: 1080 } } },
    { name: "390px iPhone emulation", options: iphone },
    { name: "Android emulation", options: android },
  ];
}

async function makeContext(browser, target, { fakeVisibility = false } = {}) {
  const context = await browser.newContext({
    ...target.options,
    locale: "ja-JP",
    timezoneId: "Asia/Tokyo",
    serviceWorkers: "block",
  });
  context.setDefaultTimeout(8000);
  if (fakeVisibility) {
    await context.addInitScript(({ pinRecord, start }) => {
      localStorage.setItem("mykeep.language", "ja");
      localStorage.setItem("mykeep.pinLock", JSON.stringify(pinRecord));
      const testClock = { now: start };
      Date.now = () => testClock.now;
      let visibility = "visible";
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
      window.advanceTestTime = (milliseconds) => { testClock.now += milliseconds; };
      window.setTestVisibility = (value) => {
        visibility = value;
        document.dispatchEvent(new Event("visibilitychange"));
      };
    }, { pinRecord: PIN_RECORD, start: TEST_START });
  } else {
    await context.addInitScript(() => {
      localStorage.setItem("mykeep.language", "ja");
    });
  }
  return context;
}

async function waitForPinPhase(page, phase) {
  await page.waitForFunction((expected) => document.documentElement.dataset.pinPhase === expected, phase);
}

async function unlock(page) {
  await page.locator("input.pin-native-input").fill(TEST_PIN);
  await waitForPinPhase(page, "unlocked");
}

async function assertNoteOrder(page, expected) {
  await page.waitForFunction((titles) => {
    const actual = [...document.querySelectorAll(".card-content[aria-label]")]
      .map((element) => element.getAttribute("aria-label")?.replace(/を編集$/, ""));
    return JSON.stringify(actual) === JSON.stringify(titles);
  }, expected);
  const actual = await page.locator(".card-content[aria-label]").evaluateAll((elements) =>
    elements.map((element) => element.getAttribute("aria-label").replace(/を編集$/, "")));
  assert.deepEqual(actual, expected);
}

async function assertNoHorizontalOverflow(page) {
  const dimensions = await page.evaluate(() => ({
    viewport: window.innerWidth,
    document: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
  }));
  assert.ok(dimensions.document <= dimensions.viewport, `document overflows horizontally: ${JSON.stringify(dimensions)}`);
  assert.ok(dimensions.body <= dimensions.viewport, `body overflows horizontally: ${JSON.stringify(dimensions)}`);
}

test("built MyKeep dist keeps PIN privacy, unsaved drafts, dates, and sort order in Chrome", { timeout: 120_000 }, async (t) => {
  const { server, url } = await startDistServer();
  let browser;
  try {
    browser = await chromium.launch({ channel: "chrome", headless: true });
    for (const target of browserTargets()) {
      await t.test(`${target.name}: PIN lock preserves an unsaved draft`, async () => {
        const context = await makeContext(browser, target, { fakeVisibility: true });
        try {
          const apiState = await mockApi(context);
          const page = await context.newPage();
          await page.goto(url, { waitUntil: "domcontentloaded" });
          await page.locator(".pin-screen").waitFor({ state: "visible" });
          assert.equal(apiState.calls.length, 0, "the locked startup must not request note or label APIs");

          await unlock(page);
          await page.locator("button.new-note").click();
          const editor = page.getByRole("form", { name: "新規メモ" });
          await editor.getByLabel("タイトル").fill("未保存タイトル");
          await editor.getByLabel("本文").fill("ロック解除後も残す本文");
          await editor.getByRole("button", { name: "＋ 項目を追加" }).click();
          await editor.getByLabel("1番目の項目", { exact: true }).fill("買い物リスト項目");
          await editor.getByLabel("1番目の項目をチェック", { exact: true }).check();
          await editor.getByRole("button", { name: "ラベルを選択" }).click();
          await editor.getByRole("checkbox", { name: "仕事" }).check();
          await editor.locator('input[type="file"]').setInputFiles({
            name: "保留画像.png",
            mimeType: "image/png",
            buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/Z1sAAAAASUVORK5CYII=", "base64"),
          });
          await editor.locator(".pending-image-name").waitFor({ state: "visible" });

          await page.evaluate(() => window.setTestVisibility("hidden"));
          await page.evaluate(() => window.advanceTestTime(30_000));
          await page.evaluate(() => window.setTestVisibility("visible"));
          await waitForPinPhase(page, "unlocked");
          assert.equal(await editor.getByLabel("タイトル").inputValue(), "未保存タイトル", "a 30-second background keeps the editor open");

          await page.evaluate(() => window.setTestVisibility("hidden"));
          await page.evaluate(() => window.advanceTestTime(61_000));
          await page.evaluate(() => window.setTestVisibility("visible"));
          await waitForPinPhase(page, "locked");
          assert.equal(await page.locator(".pin-screen").isVisible(), true);
          assert.equal(await editor.isVisible(), false, "the draft editor must be hidden while PIN-locked");
          const unloadPrevented = await page.evaluate(() => {
            const event = new Event("beforeunload", { cancelable: true });
            window.dispatchEvent(event);
            return event.defaultPrevented;
          });
          assert.equal(unloadPrevented, true, "unsaved work must still guard navigation while PIN-locked");

          await unlock(page);
          assert.equal(await editor.getByLabel("タイトル").inputValue(), "未保存タイトル");
          assert.equal(await editor.getByLabel("本文").inputValue(), "ロック解除後も残す本文");
          assert.equal(await editor.getByLabel("1番目の項目", { exact: true }).inputValue(), "買い物リスト項目");
          assert.equal(await editor.getByLabel("1番目の項目をチェック", { exact: true }).isChecked(), true);
          assert.match(await editor.locator(".selected-label").innerText(), /仕事/);
          assert.equal(await editor.locator(".pending-image-name").innerText(), "保留画像.png");
          assert.equal(apiState.calls.some((call) => call.method === "POST" || call.method === "PATCH"), false, "the draft scenario must remain unsaved");
        } finally {
          await context.close();
        }
      });

      await t.test(`${target.name}: date filters, saved searches and read-only long notes`, async () => {
        const context = await makeContext(browser, target, { fakeVisibility: true });
        try {
          const state = await mockApi(context);
          const longBody = '長文の本文\n'.repeat(150) + '<script>window.readerInjected=true</script>全文の末尾';
          state.notes[0].body = longBody;
          state.notes[0].checklist = [{ id: 'check', text: '読むだけの項目', checked: true, position: 0 }];
          state.notes[0].attachments = [{ id: 'reader-img', filename: '読取画像.png', mime_type: 'image/png', url: '/reader-test.png', created_at: '2026-01-01T00:00:00.000Z' }];
          state.notes[0].preview_image = 'https://preview.example/reader-test.png';
          await context.route('**/reader-test.png', route => route.fulfill({ contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9t8AAAAASUVORK5CYII=', 'base64') }));
          const page = await context.newPage();
          await page.goto(url);
          await unlock(page);
          await page.locator('.list-filters summary').click();
          const filters = page.locator('.list-filters');
          await filters.getByLabel('開始日', { exact: true }).fill('2026-02-01');
          await filters.getByLabel('終了日', { exact: true }).fill('2026-02-01');
          await filters.getByRole('button', { name: '適用', exact: true }).click();
          await assertNoteOrder(page, ['中間']);
          assert.ok(state.calls.some(c => c.path.includes('from=2026-01-31T15') && c.path.includes('before=2026-02-01T15')));
          await page.evaluate(() => window.dispatchEvent(new Event('focus')));
          await page.waitForFunction(() => document.querySelectorAll('.card').length === 1);
          await filters.getByLabel('条件の名前').fill('二月の仕事');
          await filters.getByRole('button', { name: '現在の条件を保存' }).click();
          await filters.getByRole('button', { name: '日付をクリア' }).click();
          await assertNoteOrder(page, SORT_EXPECTATIONS.updated_desc);
          await page.reload(); await unlock(page);
          await page.locator('.list-filters summary').click();
          await filters.getByLabel('保存した条件', { exact: true }).selectOption({ label: '二月の仕事' });
          await filters.getByRole('button', { name: '呼び出す', exact: true }).click();
          await assertNoteOrder(page, ['中間']);
          await assertNoHorizontalOverflow(page);
          if (process.env.MYKEEP_SCREENSHOTS) await page.screenshot({ path: `.wrangler/filters-${target.name.replace(/\W+/g, '-')}.png` });
          await filters.getByRole('button', { name: '条件を削除' }).click();
          assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('mykeep.savedSearches')).length), 0);
          await filters.getByLabel('開始日', { exact: true }).fill('2026-03-01');
          assert.equal(await filters.getByRole('button', { name: '適用', exact: true }).isDisabled(), true);
          await filters.getByRole('button', { name: '日付をクリア' }).click();
          await page.getByRole('button', { name: '作成が古いを読む', exact: true }).click();
          const reader = page.getByRole('dialog', { name: 'メモを読む', exact: true });
          assert.equal(await reader.locator('.reader-body').innerText(), longBody);
          assert.equal(await page.evaluate(() => window.readerInjected), undefined);
          assert.equal(await reader.locator('input,textarea').count(), 0);
          await assertNoHorizontalOverflow(page);
          await reader.getByRole('button', { name: '読取画像.pngを拡大表示', exact: true }).click();
          assert.match(await page.locator('.image-viewer-toolbar').innerText(), /1 \/ 2/);
          await page.keyboard.press('ArrowRight');
          assert.match(await page.locator('.image-viewer-toolbar').innerText(), /2 \/ 2/);
          assert.equal(await page.getByRole('link', { name: '元画像を開く', exact: true }).getAttribute('rel'), 'noopener noreferrer');
          await page.keyboard.press('Escape');
          assert.equal(await reader.isVisible(), true);
          await page.evaluate(() => { window.setTestVisibility('hidden'); window.advanceTestTime(61000); window.setTestVisibility('visible'); });
          await waitForPinPhase(page, 'locked'); assert.equal(await reader.isVisible(), false);
          await unlock(page); assert.equal(await reader.isVisible(), true);
          await reader.getByRole('button', { name: '編集する', exact: true }).click();
          assert.equal(await page.locator('form.editor textarea').inputValue(), longBody);
          await page.locator('form.editor button.close').click();
          await page.getByRole('button', { name: '設定メニュー' }).click();
          await page.getByRole('menuitem', { name: '設定', exact: true }).click();
          const settings = page.getByRole('dialog', { name: '設定', exact: true });
          await settings.getByRole('checkbox', { name: 'ダークモード' }).check();
          await settings.locator('select').first().selectOption('en');
          await page.getByRole('dialog', { name: 'Settings', exact: true }).getByRole('button', { name: 'Close', exact: true }).click();
          await assertNoHorizontalOverflow(page);
          assert.equal(await filters.getByLabel('From date', { exact: true }).count(), 1);
          await page.getByRole('button', { name: 'Read 作成が古い', exact: true }).click();
          await assertNoHorizontalOverflow(page);
          if (process.env.MYKEEP_SCREENSHOTS) await page.screenshot({ path: `.wrangler/reader-${target.name.replace(/\W+/g, '-')}.png` });
          await page.keyboard.press('Escape');
          assert.equal(await page.getByRole('dialog', { name: 'Read note', exact: true }).count(), 0);
          assert.equal(state.calls.some(c => c.method !== 'GET'), false);
        } finally { await context.close(); }
      });

      await t.test(`${target.name}: creation and update dates match all four sort choices`, async () => {
        const context = await makeContext(browser, target);
        try {
          const apiState = await mockApi(context);
          const page = await context.newPage();
          await page.goto(url, { waitUntil: "domcontentloaded" });
          await page.locator(".card-created time[datetime]").first().waitFor({ state: "visible" });

          const sort = page.locator("#note-sort");
          assert.equal(await sort.inputValue(), "updated_desc");
          assert.deepEqual(await sort.locator("option").evaluateAll((options) => options.map((option) => option.value)), [
            "updated_desc", "updated_asc", "created_desc", "created_asc",
          ]);
          await assertNoteOrder(page, SORT_EXPECTATIONS.updated_desc);
          await assertNoHorizontalOverflow(page);

          for (const sortValue of ["updated_asc", "created_desc", "created_asc"]) {
            await sort.selectOption(sortValue);
            await assertNoteOrder(page, SORT_EXPECTATIONS[sortValue]);
            assert.equal(apiState.calls.some((call) => call.path.startsWith("/api/notes?") && call.path.includes(`sort=${sortValue}`)), true, `the list API receives ${sortValue}`);
          }
          assert.equal(await page.evaluate(() => localStorage.getItem("mykeep.sortOrder")), "created_asc");

          const cardDates = await page.locator(".card-created time[datetime]").evaluateAll((elements) =>
            elements.map((element) => element.getAttribute("datetime")));
          assert.deepEqual(cardDates, NOTE_FIXTURES.map((note) => note.created_at));
          await page.getByRole("button", { name: "作成が古いを編集" }).click();
          const editorDates = await page.locator(".editor-dates time[datetime]").evaluateAll((elements) =>
            elements.map((element) => element.getAttribute("datetime")));
          assert.deepEqual(editorDates, [NOTE_FIXTURES[0].created_at, NOTE_FIXTURES[0].updated_at]);
          assert.equal(await page.locator(".editor-dates time").count(), 2);
          assert.equal(await page.locator(".editor-dates time").nth(0).innerText() !== "", true);
          assert.equal(await page.locator(".editor-dates time").nth(1).innerText() !== "", true);
          await assertNoHorizontalOverflow(page);
          await page.locator("form.editor button.close").click();

          await page.getByRole("button", { name: "設定メニュー" }).click();
          await page.getByRole("menuitem", { name: "設定" }).click();
          const settings = page.getByRole("dialog", { name: "設定" });
          await settings.getByRole("checkbox", { name: "ダークモード" }).check();
          await page.waitForFunction(() => document.documentElement.dataset.theme === "dark");
          assert.equal(await page.evaluate(() => localStorage.getItem("mykeep.darkMode")), "true");
          await settings.getByRole("button", { name: "閉じる" }).click();
          assert.equal(await page.locator(".card-created time[datetime]").count(), 3, "card dates remain visible in dark mode");
          await assertNoHorizontalOverflow(page);

          await page.reload({ waitUntil: "domcontentloaded" });
          await page.locator(".card-created time[datetime]").first().waitFor({ state: "visible" });
          assert.equal(await page.locator("#note-sort").inputValue(), "created_asc", "sort selection persists after reload");
          assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), "dark", "dark mode persists after reload");
          await assertNoteOrder(page, SORT_EXPECTATIONS.created_asc);
          await assertNoHorizontalOverflow(page);

          apiState.revision = 2;
          apiState.notes = apiState.notes.map((note) => note.id === "n-old"
            ? { ...note, title: "サーバーで更新" }
            : note);
          const checkResponse = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/notes/check");
          const reloadResponse = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/notes");
          await page.evaluate(() => window.dispatchEvent(new Event("focus")));
          await checkResponse;
          await reloadResponse;
          await assertNoteOrder(page, ["サーバーで更新", "中間", "作成が新しい"]);
        } finally {
          await context.close();
        }
      });
    }
    await t.test('backup record updates only after export and distinguishes partial, cancel and file write', async () => {
      const context = await makeContext(browser, browserTargets()[0]);
      try {
        const state = await mockApi(context);
        const page = await context.newPage();
        await page.goto(url);
        // Use Blob download first, even when desktop Chrome exposes the file picker.
        await page.evaluate(() => { window.showSaveFilePicker = undefined; });
        const exportNow = async () => {
          await page.getByRole('button', { name: '設定メニュー' }).click();
          await page.getByRole('menuitem', { name: 'エクスポート', exact: true }).click();
        };
        const closeExport = () => page.getByRole('dialog', { name: 'エクスポート', exact: true }).getByRole('button', { name: '閉じる', exact: true }).click();
        state.exportFailure = true;
        await exportNow();
        await page.getByRole('dialog', { name: 'エクスポート', exact: true }).getByRole('status').waitFor();
        assert.equal(await page.evaluate(() => localStorage.getItem('mykeep.lastBackup')), null);
        await closeExport(); state.exportFailure = false;
        const downloaded = page.waitForEvent('download');
        await exportNow(); await downloaded;
        await page.waitForFunction(() => localStorage.getItem('mykeep.lastBackup') !== null);
        const first = await page.evaluate(() => localStorage.getItem('mykeep.lastBackup'));
        assert.equal(JSON.parse(first).method, 'download'); assert.equal(JSON.parse(first).attachmentsFailed, 0);
        await closeExport();
        await page.evaluate(() => { window.showSaveFilePicker = async () => { throw new DOMException('Cancelled', 'AbortError'); }; });
        await exportNow(); await closeExport();
        assert.equal(await page.evaluate(() => localStorage.getItem('mykeep.lastBackup')), first);
        state.notes[0].attachments = [{ id: 'missing', filename: 'missing.png', mime_type: 'image/png', url: '/api/files/missing', created_at: '2026-01-01T00:00:00.000Z' }];
        await page.evaluate(() => { window.showSaveFilePicker = undefined; });
        const partial = page.waitForEvent('download'); await exportNow(); await partial;
        await page.waitForFunction(() => JSON.parse(localStorage.getItem('mykeep.lastBackup')).attachmentsFailed === 1);
        await closeExport();
        await page.getByRole('button', { name: '設定メニュー' }).click();
        await page.getByRole('menuitem', { name: '設定', exact: true }).click();
        const settings = page.getByRole('dialog', { name: '設定', exact: true });
        assert.match(await settings.locator('.backup-record').innerText(), /完全なバックアップではありません/);
        await settings.getByRole('button', { name: '閉じる', exact: true }).click();
        state.notes[0].attachments = [];
        await page.evaluate(() => {
          window.fileWriteClosed = false;
          window.showSaveFilePicker = async () => ({ createWritable: async () => new WritableStream({ write() {}, close() { window.fileWriteClosed = true; } }) });
        });
        await exportNow();
        await page.waitForFunction(() => JSON.parse(localStorage.getItem('mykeep.lastBackup')).method === 'file');
        assert.equal(await page.evaluate(() => window.fileWriteClosed), true);
        await closeExport(); await page.reload();
        assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('mykeep.lastBackup')).method), 'file');
      } finally { await context.close(); }
    });
  } finally {
    await browser?.close();
    await new Promise((resolveClose, rejectClose) => server.close((error) => error ? rejectClose(error) : resolveClose()));
  }
});
