#!/usr/bin/env node
"use strict";

const childProcess = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Readable } = require("node:stream");
const { pipeline } = require("node:stream/promises");

const pkg = require("../package.json");

const VERSION = pkg.version;
const REPO = "The-Little-AI-Company/bellamente";
const BASE_URL = process.env.BELLA_DOWNLOAD_BASE || `https://github.com/${REPO}/releases/download/v${VERSION}`;

function platformAsset(platform = process.platform, arch = process.arch) {
  if (platform === "win32" && arch === "x64") return "bella-windows-x64.exe";
  if (platform === "linux" && arch === "x64") return "bella-linux-x64";
  throw new Error(`Bellamente currently publishes binaries for Windows x64 and Linux x64 only; detected ${platform}/${arch}.`);
}

function cacheRoot() {
  if (process.env.BELLA_BIN_CACHE) return process.env.BELLA_BIN_CACHE;
  if (process.platform === "win32" && process.env.LOCALAPPDATA) {
    return path.join(process.env.LOCALAPPDATA, "Bellamente", "Launcher");
  }
  return path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"), "bellamente", "launcher");
}

async function fetchText(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed ${res.status}: ${url}`);
  return await res.text();
}

async function download(url, dest) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed ${res.status}: ${url}`);
  if (!res.body) throw new Error(`download returned an empty response body: ${url}`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.tmp-${process.pid}`;
  const out = fs.createWriteStream(tmp, { mode: 0o755 });
  try {
    await pipeline(Readable.fromWeb(res.body), out);
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch (_) {
      // Best-effort cleanup; the original download error is the actionable failure.
    }
    throw err;
  }
  if (process.platform !== "win32") fs.chmodSync(tmp, 0o755);
  fs.renameSync(tmp, dest);
}

function sha256(file) {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(file));
  return hash.digest("hex");
}

function readCachedSha(file) {
  try {
    const text = fs.readFileSync(`${file}.sha256`, "utf8").trim().toLowerCase();
    return /^[a-f0-9]{64}$/.test(text) ? text : "";
  } catch (_) {
    return "";
  }
}

function writeCachedSha(file, expected) {
  fs.writeFileSync(`${file}.sha256`, `${expected}\n`, { mode: 0o644 });
}

function parseChecksums(text) {
  const checksums = new Map();
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^([a-fA-F0-9]{64})\s+\*?(.+)$/);
    if (match) checksums.set(match[2].trim(), match[1].toLowerCase());
  }
  return checksums;
}

async function expectedSha(asset) {
  const checksums = parseChecksums(await fetchText(`${BASE_URL}/SHA256SUMS.txt`));
  const expected = checksums.get(asset);
  if (!expected) throw new Error(`SHA256SUMS.txt did not contain ${asset}`);
  return expected;
}

async function ensureBinary() {
  const asset = platformAsset();
  const dest = path.join(cacheRoot(), VERSION, asset);
  const cached = readCachedSha(dest);
  if (cached && fs.existsSync(dest) && sha256(dest) === cached) {
    return dest;
  }
  const expected = await expectedSha(asset);
  if (!fs.existsSync(dest) || sha256(dest) !== expected) {
    await download(`${BASE_URL}/${asset}`, dest);
  }
  if (sha256(dest) !== expected) throw new Error(`checksum mismatch for ${asset}`);
  writeCachedSha(dest, expected);
  return dest;
}

async function main() {
  const binary = await ensureBinary();
  const child = childProcess.spawn(binary, process.argv.slice(2), { stdio: "inherit" });
  process.on("SIGINT", () => child.kill("SIGINT"));
  process.on("SIGTERM", () => child.kill("SIGTERM"));
  child.on("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    process.exit(code ?? 1);
  });
}

main().catch((err) => {
  console.error(`bella launcher failed: ${err.message}`);
  process.exit(1);
});
