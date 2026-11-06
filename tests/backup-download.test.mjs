import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { runDownload } from "../scripts/download-backup.mjs";
import { TABLE_NAMES } from "../scripts/backup-format.mjs";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SNAPSHOT = "2026-11-06-550e8400-e29b-41d4-a716-446655440000";
const NOTE_ID = "11111111-1111-4111-8111-111111111111";
const ATTACHMENT_ID = "22222222-2222-4222-8222-222222222222";
const CHECKLIST_1 = "33333333-3333-4333-8333-333333333333";
const CHECKLIST_2 = "33333333-3333-4333-8333-333333333334";
const GROUP_ID = "44444444-4444-4444-8444-444444444444";
const EMPTY_GROUP_ID = "55555555-5555-4555-8555-555555555555";
const COMPLETED_AT = "2026-11-06T17:05:00.000Z";
const CREATED_AT = "2026-11-05T12:30:00.000Z";
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9t8AAAAASUVORK5CYII=", "base64");

async function moduleFrom(path) {
  const result = await build({ entryPoints: [resolve(PROJECT_ROOT, path)], bundle: true, write: false,
    format: "esm", platform: "node", target: "node24" });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
}

const { readBackupZip } = await moduleFrom("src/restoreBackup.ts");

function makeFixture() {
  const tables = {
    notes: [{
      id: NOTE_ID,
      title: "Private scheduled note",
      body: "Note body",
      url: "https://example.com/",
      pinned: 1,
      archived: 1,
      created_at: CREATED_AT,
      updated_at: COMPLETED_AT,
      color: "blue",
      deleted_at: "2026-11-06T16:00:00.000Z",
      preview_title: "Preview title",
      preview_description: "Preview description",
      preview_image: "https://example.com/image.png",
      preview_hostname: "example.com",
      card_image: `attachment:${ATTACHMENT_ID}`,
    }],
    attachments: [{
      id: ATTACHMENT_ID,
      note_id: NOTE_ID,
      filename: "元の画像名.png",
      mime_type: "image/png",
      r2_key: "private/internal/key-not-for-export",
      created_at: CREATED_AT,
    }],
    checklist_items: [
      { id: CHECKLIST_1, note_id: NOTE_ID, position: 1, text: "Second", checked: 0 },
      { id: CHECKLIST_2, note_id: NOTE_ID, position: 0, text: "First", checked: 1 },
    ],
    labels: [
      { name_key: "work", name: "Work", group_id: GROUP_ID },
      { name_key: "unused", name: "Unused label", group_id: null },
    ],
    label_groups: [
      { id: GROUP_ID, name_key: "work-group", name: "Work group" },
      { id: EMPTY_GROUP_ID, name_key: "empty-group", name: "Empty group" },
    ],
    note_labels: [{ note_id: NOTE_ID, label_key: "work" }],
  };
  const manifest = {
    format: "mykeep-scheduled-backup",
    version: 1,
    status: "complete",
    snapshot: SNAPSHOT,
    started_at: "2026-11-06T17:00:00.000Z",
    completed_at: COMPLETED_AT,
    revision: 31,
    tables: TABLE_NAMES.map((name) => ({
      name,
      parts: Math.ceil(tables[name].length / 20),
      rows: tables[name].length,
    })),
    attachments: 1,
    attachment_bytes: PNG.byteLength,
  };
  const objects = new Map([
    ["latest.json", Buffer.from(JSON.stringify({ snapshot: SNAPSHOT, completed_at: COMPLETED_AT }))],
    [`daily/${SNAPSHOT}/manifest.json`, Buffer.from(JSON.stringify(manifest))],
    [`daily/${SNAPSHOT}/files/${ATTACHMENT_ID}`, PNG],
  ]);
  for (const name of TABLE_NAMES) {
    for (let start = 0, part = 1; start < tables[name].length; start += 20, part += 1) {
      const page = tables[name].slice(start, start + 20);
      objects.set(`daily/${SNAPSHOT}/${name}/${String(part).padStart(6, "0")}.json`, Buffer.from(JSON.stringify(page)));
    }
  }
  return { manifest, objects, tables };
}

function fakeDownloader(objects, { missing = () => false } = {}) {
  const calls = [];
  const downloadObject = async (bucket, key, destination) => {
    calls.push({ bucket, key });
    if (missing(key)) throw new Error("Private object data is unavailable.");
    const bytes = objects.get(key);
    if (!bytes) throw new Error("Private object data is unavailable.");
    await writeFile(destination, bytes, { flag: "wx" });
  };
  return { calls, downloadObject };
}

async function testWorkspace(callback) {
  const root = await mkdtemp(join(tmpdir(), "mykeep-backup-test-"));
  const tempRoot = join(root, "temp");
  await mkdir(tempRoot);
  try {
    await callback({ root, tempRoot });
  } finally {
    const expectedParent = await realpath(tmpdir());
    const resolvedRoot = await realpath(root);
    if (dirname(resolvedRoot).toLowerCase() !== expectedParent.toLowerCase()
      || !basename(resolvedRoot).startsWith("mykeep-backup-test-")) {
      throw new Error("Test temporary directory failed its cleanup path check.");
    }
    await rm(resolvedRoot, { recursive: true, force: false });
  }
}

test("latest scheduled snapshot becomes a readable additive-restore ZIP", async () => {
  await testWorkspace(async ({ root, tempRoot }) => {
    const { objects } = makeFixture();
    const fake = fakeDownloader(objects);
    const output = join(root, "latest.zip");
    const result = await runDownload(["latest", output], { downloadObject: fake.downloadObject, tempRoot });
    assert.equal(result.snapshot, SNAPSHOT);
    assert.equal(result.notes, 1);
    assert.equal(result.attachments, 1);
    assert.equal(fake.calls[0].bucket, "mykeep-backups");
    assert.deepEqual(await readdir(tempRoot), []);

    const archive = await readBackupZip(new Blob([await readFile(output)]));
    try {
      assert.equal(archive.missingAttachments, 0);
      assert.equal(archive.attachmentTotal, 1);
      const note = archive.manifest.notes[0];
      assert.equal(note.title, "Private scheduled note");
      assert.equal(note.pinned, true);
      assert.equal(note.archived, true);
      assert.equal(note.trashed, true);
      assert.equal(note.deleted_at, "2026-11-06T16:00:00.000Z");
      assert.equal(note.preview_title, "Preview title");
      assert.equal(note.preview_description, "Preview description");
      assert.equal(note.preview_image, "https://example.com/image.png");
      assert.equal(note.preview_hostname, "example.com");
      assert.equal(note.card_image, `attachment:${ATTACHMENT_ID}`);
      assert.deepEqual(note.checklist.map(({ text, checked, order }) => ({ text, checked, order })), [
        { text: "First", checked: true, order: 0 },
        { text: "Second", checked: false, order: 1 },
      ]);
      assert.deepEqual(note.labels, ["Work"]);
      assert.equal(note.attachments[0].filename, "元の画像名.png");
      assert.equal(note.attachments[0].mime_type, "image/png");
      assert.equal(note.attachments[0].zip_path, `attachments/${ATTACHMENT_ID}.png`);
      assert.equal(archive.manifest.exported_at, COMPLETED_AT);
      assert.deepEqual(archive.manifest.groups, [
        { id: GROUP_ID, name: "Work group" },
        { id: EMPTY_GROUP_ID, name: "Empty group" },
      ]);
      assert.deepEqual(archive.manifest.memberships, [
        { label_name: "Work", group_id: GROUP_ID },
        { label_name: "Unused label", group_id: null },
      ]);
      assert.equal(JSON.stringify(archive.manifest).includes("internal/key-not-for-export"), false);
      const attachment = await archive.readAttachment(note.attachments[0]);
      assert.ok(attachment);
      assert.equal(attachment.type, "image/png");
      assert.deepEqual(Buffer.from(await attachment.arrayBuffer()), PNG);
    } finally {
      await archive.close();
    }
  });
});

test("explicit snapshot selection skips latest.json", async () => {
  await testWorkspace(async ({ root, tempRoot }) => {
    const { objects } = makeFixture();
    const fake = fakeDownloader(objects);
    await runDownload([SNAPSHOT, join(root, "snapshot.zip"), "mykeep-backups"], {
      downloadObject: fake.downloadObject,
      tempRoot,
    });
    assert.equal(fake.calls.some(({ key }) => key === "latest.json"), false);
    assert.equal(fake.calls[0].key, `daily/${SNAPSHOT}/manifest.json`);
  });
});

test("invalid snapshot and manifest paths never become remote object paths", async () => {
  await testWorkspace(async ({ root, tempRoot }) => {
    const { objects, manifest } = makeFixture();
    const fake = fakeDownloader(objects);
    await assert.rejects(runDownload(["../latest", join(root, "invalid.zip")], {
      downloadObject: fake.downloadObject,
      tempRoot,
    }), /Invalid snapshot ID/);
    assert.deepEqual(fake.calls, []);

    const badManifest = { ...manifest, tables: manifest.tables.map((table, index) => index === 0 ? { ...table, name: "../notes" } : table) };
    objects.set(`daily/${SNAPSHOT}/manifest.json`, Buffer.from(JSON.stringify(badManifest)));
    await assert.rejects(runDownload([SNAPSHOT, join(root, "invalid-manifest.zip")], {
      downloadObject: fake.downloadObject,
      tempRoot,
    }), /Invalid table manifest order/);
    assert.deepEqual(fake.calls.map(({ key }) => key), [`daily/${SNAPSHOT}/manifest.json`]);
    assert.deepEqual(await readdir(tempRoot), []);
  });
});

test("missing required attachment leaves no output and cleans only its temporary files", async () => {
  await testWorkspace(async ({ root, tempRoot }) => {
    const { objects } = makeFixture();
    const fake = fakeDownloader(objects, { missing: (key) => key.includes("/files/") });
    const output = join(root, "missing.zip");
    await assert.rejects(runDownload(["latest", output], { downloadObject: fake.downloadObject, tempRoot }), /required backup object/);
    await assert.rejects(readFile(output), { code: "ENOENT" });
    assert.deepEqual(await readdir(tempRoot), []);
  });
});

test("existing output ZIP is never overwritten", async () => {
  await testWorkspace(async ({ root, tempRoot }) => {
    const { objects } = makeFixture();
    const fake = fakeDownloader(objects);
    const output = join(root, "existing.zip");
    const prior = Buffer.from("existing file contents");
    await writeFile(output, prior);
    await assert.rejects(runDownload(["latest", output], { downloadObject: fake.downloadObject, tempRoot }), /already exists/);
    assert.equal(fake.calls.length, 0);
    assert.deepEqual(await readFile(output), prior);
  });
});
