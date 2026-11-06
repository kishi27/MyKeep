import { spawn } from "node:child_process";
import { access, lstat, mkdtemp, readFile, realpath, rm, unlink } from "node:fs/promises";
import { createReadStream, createWriteStream, fstatSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { finished, pipeline } from "node:stream/promises";
import { Readable, Writable } from "node:stream";
import { TextReader, ZipWriter } from "@zip.js/zip.js";
import {
  MAX_ARCHIVE_ENTRIES,
  MAX_ATTACHMENT_BYTES,
  MAX_EXPANDED_BYTES,
  MAX_NOTES_JSON_BYTES,
  MAX_ZIP_BYTES,
  TABLE_NAMES,
  TABLE_PAGE_SIZE,
  LEGACY_TABLE_PAGE_SIZE,
  convertScheduledRows,
  validateBucketName,
  validateLatest,
  validateScheduledManifest,
  validateSnapshotId,
} from "./backup-format.mjs";

const DEFAULT_BUCKET = "mykeep-backups";
const CONTROL_JSON_LIMIT = 64 * 1024;
const TABLE_PAGE_JSON_LIMIT = 64 * 1024 * 1024;
const TOTAL_PAGE_JSON_LIMIT = 256 * 1024 * 1024;
const WRANGLER_OUTPUT_LIMIT = 64 * 1024;
const WRANGLER_TIMEOUT_MS = 5 * 60 * 1000;
const PROJECT_ROOT = fileURLToPath(new URL("..", import.meta.url));

function isWithin(parent, child) {
  const pathFromParent = relative(parent, child);
  return !!pathFromParent && pathFromParent !== ".." && !pathFromParent.startsWith(`..${sep}`)
    && !isAbsolute(pathFromParent);
}

function sameFile(left, right) {
  return left.isFile() && right.isFile() && left.dev === right.dev && left.ino === right.ino;
}

function parseArguments(args) {
  if (!Array.isArray(args) || args.length < 2 || args.length > 3) {
    throw new Error("Usage: node scripts/download-backup.mjs latest|SNAPSHOT_ID output.zip [bucket]");
  }
  const selector = args[0] === "latest" ? "latest" : validateSnapshotId(args[0]);
  const output = args[1];
  if (typeof output !== "string" || !output.trim() || /[\u0000-\u001f\u007f]/u.test(output)
    || extname(output).toLowerCase() !== ".zip") {
    throw new Error("Output path must name a .zip file.");
  }
  const bucket = validateBucketName(args[2] ?? DEFAULT_BUCKET);
  return { selector, output, bucket };
}

async function resolveOutputPath(output, cwd) {
  let candidate;
  try {
    candidate = resolve(cwd, output);
    const parent = await realpath(dirname(candidate));
    const resolved = join(parent, basename(candidate));
    if (!resolved || resolved === dirname(resolved) || resolved === resolve(resolved, "..")) {
      throw new Error("Invalid output path.");
    }
    try {
      await lstat(resolved);
      throw new Error("Output file already exists.");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    return resolved;
  } catch (error) {
    if (error instanceof Error && error.message === "Output file already exists.") throw error;
    throw new Error("Output directory is unavailable.");
  }
}

function allowedObjectKey(key) {
  if (key === "latest.json") return true;
  if (typeof key !== "string") return false;
  const parts = key.split("/");
  if (parts[0] !== "daily") return false;
  try {
    validateSnapshotId(parts[1]);
  } catch {
    return false;
  }
  if (parts.length === 3) return parts[2] === "manifest.json";
  if (parts.length !== 4) return false;
  if (parts[2] === "files") return /^[0-9a-f-]{36}$/i.test(parts[3]);
  return TABLE_NAMES.includes(parts[2]) && /^\d{6}\.json$/.test(parts[3]);
}

export function createWranglerDownloader({ projectDir = PROJECT_ROOT, timeoutMs = WRANGLER_TIMEOUT_MS } = {}) {
  const entry = join(projectDir, "node_modules", "wrangler", "bin", "wrangler.js");
  return async (bucket, key, destination) => {
    validateBucketName(bucket);
    if (!allowedObjectKey(key)) throw new Error("Invalid backup object path.");
    try {
      await access(entry);
    } catch {
      throw new Error("Project-local Wrangler is unavailable.");
    }
    await new Promise((resolvePromise, rejectPromise) => {
      let settled = false;
      let totalOutput = 0;
      let timedOut = false;
      let outputOverflow = false;
      const child = spawn(process.execPath, [entry, "r2", "object", "get", `${bucket}/${key}`, "--remote", "--file", destination], {
        cwd: projectDir,
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) rejectPromise(error);
        else resolvePromise();
      };
      const countOutput = (chunk) => {
        totalOutput += chunk.byteLength;
        if (totalOutput > WRANGLER_OUTPUT_LIMIT && !outputOverflow) {
          outputOverflow = true;
          child.kill();
        }
      };
      child.stdout.on("data", countOutput);
      child.stderr.on("data", countOutput);
      child.once("error", () => finish(new Error("Wrangler could not start.")));
      child.once("close", (code) => {
        if (timedOut) finish(new Error("Wrangler download timed out."));
        else if (outputOverflow) finish(new Error("Wrangler output exceeded the allowed limit."));
        else if (code !== 0) finish(new Error("Wrangler object download failed."));
        else finish();
      });
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill();
      }, timeoutMs);
      timer.unref?.();
    });
  };
}

async function createTempDirectory(tempRoot) {
  let realRoot;
  try {
    realRoot = await realpath(tempRoot);
  } catch {
    throw new Error("Operating system temporary directory is unavailable.");
  }
  const created = await mkdtemp(join(realRoot, "mykeep-backup-"));
  const realCreated = await realpath(created);
  if (dirname(realCreated) !== realRoot || !isWithin(realRoot, realCreated)
    || !realCreated.split(/[\\/]/u).at(-1).startsWith("mykeep-backup-")) {
    throw new Error("Temporary directory failed its path check.");
  }
  return { root: realRoot, path: realCreated };
}

async function removeTempDirectory(temp) {
  if (!temp) return;
  let current;
  try {
    current = await realpath(temp.path);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw new Error("Temporary backup files could not be removed.");
  }
  if (dirname(current) !== temp.root || !isWithin(temp.root, current)
    || !current.split(/[\\/]/u).at(-1).startsWith("mykeep-backup-")) {
    throw new Error("Temporary backup files failed their cleanup path check.");
  }
  await rm(current, { recursive: true, force: false });
}

async function readJsonFile(filePath, limit) {
  let info;
  try {
    info = await lstat(filePath);
  } catch {
    throw new Error("Backup object is missing.");
  }
  if (!info.isFile() || info.isSymbolicLink() || !Number.isSafeInteger(info.size) || info.size > limit) {
    throw new Error("Backup JSON object exceeds the allowed limit or is not a regular file.");
  }
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(await readFile(filePath));
    return JSON.parse(text);
  } catch {
    throw new Error("Backup JSON object is invalid.");
  }
}

async function downloadObject(download, bucket, key, destination) {
  if (!allowedObjectKey(key)) throw new Error("Invalid backup object path.");
  try {
    await download(bucket, key, destination);
    const info = await lstat(destination);
    if (!info.isFile() || info.isSymbolicLink() || !Number.isSafeInteger(info.size)) {
      throw new Error("Downloaded object is not a regular file.");
    }
    return info;
  } catch (error) {
    if (error instanceof Error && /^(Invalid backup object path|Downloaded object is not a regular file)\./.test(error.message)) throw error;
    throw new Error("A required backup object could not be downloaded.");
  }
}

async function fetchTableRows(snapshot, manifest, bucket, tempPath, download) {
  const tableRows = Object.create(null);
  let totalPageBytes = 0;
  for (const table of manifest.tables) {
    const allRows = [];
    for (let part = 1; part <= table.parts; part += 1) {
      const partName = String(part).padStart(6, "0");
      const key = `daily/${snapshot}/${table.name}/${partName}.json`;
      const filePath = join(tempPath, `${table.name}-${partName}.json`);
      const info = await downloadObject(download, bucket, key, filePath);
      if (info.size > TABLE_PAGE_JSON_LIMIT) throw new Error("Backup table page exceeds the allowed limit.");
      totalPageBytes += info.size;
      if (!Number.isSafeInteger(totalPageBytes) || totalPageBytes > TOTAL_PAGE_JSON_LIMIT) {
        throw new Error("Backup table data exceeds the allowed limit.");
      }
      const rows = await readJsonFile(filePath, TABLE_PAGE_JSON_LIMIT);
      if (!Array.isArray(rows) || rows.length < 1 || rows.length > TABLE_PAGE_SIZE
        || allRows.length + rows.length > table.rows
        || (part < table.parts && rows.length !== TABLE_PAGE_SIZE && rows.length !== LEGACY_TABLE_PAGE_SIZE)) {
        throw new Error(`Invalid ${table.name} page contents.`);
      }
      allRows.push(...rows);
      await unlink(filePath);
    }
    if (allRows.length !== table.rows) throw new Error(`${table.name} row count does not match the manifest.`);
    tableRows[table.name] = allRows;
  }
  return tableRows;
}

async function fetchAttachments(snapshot, manifest, backup, bucket, tempPath, download) {
  const attachments = backup.notes.flatMap((note) => note.attachments);
  if (attachments.length !== manifest.attachments || attachments.length + 1 > MAX_ARCHIVE_ENTRIES) {
    throw new Error("Attachment count does not match the restore limits.");
  }
  const paths = new Map();
  let totalBytes = 0;
  for (const [index, attachment] of attachments.entries()) {
    const key = `daily/${snapshot}/files/${attachment.id}`;
    const filePath = join(tempPath, `attachment-${String(index + 1).padStart(6, "0")}.bin`);
    const info = await downloadObject(download, bucket, key, filePath);
    if (info.size === 0 || info.size > MAX_ATTACHMENT_BYTES) {
      throw new Error("Attachment size exceeds the restore limits.");
    }
    totalBytes += info.size;
    if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_EXPANDED_BYTES) {
      throw new Error("Expanded backup exceeds the restore limit.");
    }
    paths.set(attachment.id, filePath);
  }
  if (totalBytes !== manifest.attachment_bytes) throw new Error("Attachment byte count does not match the manifest.");
  return { attachments, paths, totalBytes };
}

async function writeZipFile(filePath, notesJson, attachments, filePaths) {
  const output = createWriteStream(filePath, { flags: "wx" });
  let writer;
  try {
    await new Promise((resolvePromise, rejectPromise) => {
      output.once("open", resolvePromise);
      output.once("error", rejectPromise);
    });
    writer = new ZipWriter(Writable.toWeb(output), {
      useWebWorkers: false,
      bufferedWrite: false,
      useUnicodeFileNames: true,
    });
    await writer.add("notes.json", new TextReader(notesJson));
    for (const attachment of attachments) {
      const input = createReadStream(filePaths.get(attachment.id));
      try {
        await writer.add(attachment.zip_path, Readable.toWeb(input), { level: 0 });
      } catch (error) {
        input.destroy();
        throw error;
      }
    }
    await writer.close();
    await finished(output);
  } catch {
    output.destroy();
    await finished(output).catch(() => {});
    throw new Error("Could not create a complete restore ZIP.");
  }
}

async function copyZipToOutput(source, outputPath) {
  let originalStat;
  const output = createWriteStream(outputPath, { flags: "wx" });
  output.once("open", (fd) => {
    try { originalStat = fstatSync(fd); } catch { /* Cleanup leaves unverified paths alone. */ }
  });
  try {
    await pipeline(createReadStream(source), output);
  } catch (error) {
    if (originalStat) {
      try {
        const current = await lstat(outputPath);
        if (sameFile(current, originalStat)) await unlink(outputPath);
      } catch { /* Keep any path that no longer identifies our partial file. */ }
    }
    if (error?.code === "EEXIST") throw new Error("Output file already exists.");
    throw new Error("Could not write the output ZIP.");
  }
}

async function ensureOutputAbsent(outputPath) {
  try {
    await lstat(outputPath);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw new Error("Output path is unavailable.");
  }
  throw new Error("Output file already exists.");
}

export async function runDownload(args, options = {}) {
  const parsed = parseArguments(args);
  const cwd = options.cwd ?? process.cwd();
  const outputPath = await resolveOutputPath(parsed.output, cwd);
  await ensureOutputAbsent(outputPath);
  const bucket = parsed.bucket;
  const download = options.downloadObject ?? createWranglerDownloader({
    projectDir: options.projectDir ?? PROJECT_ROOT,
    timeoutMs: options.timeoutMs ?? WRANGLER_TIMEOUT_MS,
  });
  const temp = await createTempDirectory(options.tempRoot ?? tmpdir());
  try {
    let snapshot = parsed.selector;
    let latestCompletedAt = null;
    if (snapshot === "latest") {
      const latestPath = join(temp.path, "latest.json");
      await downloadObject(download, bucket, "latest.json", latestPath);
      const latest = validateLatest(await readJsonFile(latestPath, CONTROL_JSON_LIMIT));
      snapshot = latest.snapshot;
      latestCompletedAt = latest.completed_at;
      await unlink(latestPath);
    }
    validateSnapshotId(snapshot);

    const manifestPath = join(temp.path, "manifest.json");
    await downloadObject(download, bucket, `daily/${snapshot}/manifest.json`, manifestPath);
    const manifest = validateScheduledManifest(await readJsonFile(manifestPath, CONTROL_JSON_LIMIT), snapshot, latestCompletedAt);
    await unlink(manifestPath);

    const tableRows = await fetchTableRows(snapshot, manifest, bucket, temp.path, download);
    const backup = convertScheduledRows(manifest, tableRows);
    const notesJson = JSON.stringify(backup, null, 2);
    const notesJsonBytes = Buffer.byteLength(notesJson, "utf8");
    if (notesJsonBytes > MAX_NOTES_JSON_BYTES) throw new Error("notes.json exceeds the restore limit.");
    if (notesJsonBytes + manifest.attachment_bytes > MAX_EXPANDED_BYTES) {
      throw new Error("Expanded backup exceeds the restore limit.");
    }

    const { attachments, paths } = await fetchAttachments(snapshot, manifest, backup, bucket, temp.path, download);
    const zipPath = join(temp.path, "backup.zip");
    await writeZipFile(zipPath, notesJson, attachments, paths);
    const zipInfo = await lstat(zipPath);
    if (!zipInfo.isFile() || zipInfo.isSymbolicLink() || zipInfo.size > MAX_ZIP_BYTES) {
      throw new Error("ZIP size exceeds the restore limit.");
    }
    await copyZipToOutput(zipPath, outputPath);
    return { snapshot, outputPath, notes: backup.notes.length, attachments: attachments.length };
  } finally {
    await removeTempDirectory(temp);
  }
}

function isMainModule() {
  if (!process.argv[1]) return false;
  return pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
}

if (isMainModule()) {
  runDownload(process.argv.slice(2)).then((result) => {
    console.log(`Backup saved: ${result.outputPath} (${result.notes} notes, ${result.attachments} attachments, ${result.snapshot})`);
  }).catch((error) => {
    console.error(error instanceof Error ? error.message : "Backup download failed.");
    process.exitCode = 1;
  });
}
