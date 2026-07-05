import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

type Command = {
  name: string;
  command: string[];
  cwd?: string;
};

const root = join(import.meta.dir, "..");
const version = (await import("../package.json")).default.version;
const pypiOut = join(root, ".release", "pypi");
const releaseOut = join(root, ".release", `v${version}`);

function bin(command: string) {
  return process.platform === "win32" && command === "npm" ? "npm.cmd" : command;
}

function cleanPythonBuildArtifacts() {
  for (const path of [
    join(root, "packages", "pypi", "build"),
    join(root, "packages", "pypi", "src", "bellamente.egg-info"),
    join(root, "packages", "pypi", "src", "bellamente", "__pycache__"),
  ]) {
    rmSync(path, { recursive: true, force: true });
  }
}

async function run({ name, command, cwd }: Command) {
  console.log(`\n=== ${name} ===`);
  console.log(`$ ${cwd ? `(cd ${cwd} && ${command.join(" ")})` : command.join(" ")}`);
  const proc = Bun.spawn([bin(command[0]), ...command.slice(1)], {
    cwd,
    stdout: "inherit",
    stderr: "inherit",
    env: process.env,
  });
  const code = await proc.exited;
  if (code !== 0) throw new Error(`${name} exited ${code}`);
}

function sha256(path: string) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function verifyReleaseAssets() {
  const assets = ["bella-windows-x64.exe", "bella-darwin-arm64", "bella-darwin-x64", "bella-linux-x64"];
  const checksumPath = join(releaseOut, "SHA256SUMS.txt");
  if (!existsSync(checksumPath)) throw new Error(`missing ${checksumPath}`);
  const checksums = new Map<string, string>();
  for (const line of readFileSync(checksumPath, "utf8").trim().split(/\r?\n/)) {
    const match = line.match(/^([a-f0-9]{64})\s+\*?(.+)$/i);
    if (!match) throw new Error(`bad checksum line: ${line}`);
    checksums.set(match[2], match[1].toLowerCase());
  }
  for (const asset of assets) {
    const path = join(releaseOut, asset);
    if (!existsSync(path)) throw new Error(`missing release asset: ${asset}`);
    const expected = checksums.get(asset);
    if (!expected) throw new Error(`checksum file omitted ${asset}`);
    const actual = sha256(path);
    if (actual !== expected) throw new Error(`checksum mismatch for ${asset}: ${actual} !== ${expected}`);
  }
}

try {
  cleanPythonBuildArtifacts();
  rmSync(pypiOut, { recursive: true, force: true });

  await run({ name: "npm launcher syntax", command: ["node", "--check", "packages/npm/bin/bella.cjs"] });
  await run({ name: "npm package dry-run", command: ["npm", "pack", "--dry-run"], cwd: join(root, "packages", "npm") });
  await run({
    name: "PyPI launcher syntax",
    command: ["python", "-B", "-m", "py_compile", "packages/pypi/src/bellamente/cli.py"],
  });
  await run({ name: "PyPI package build", command: ["python", "-m", "build", "packages/pypi", "--outdir", pypiOut] });

  const pypiArtifacts = readdirSync(pypiOut)
    .filter((name) => name === `bellamente-${version}.tar.gz` || name === `bellamente-${version}-py3-none-any.whl`)
    .map((name) => join(pypiOut, name));
  if (pypiArtifacts.length !== 2) throw new Error(`expected 2 PyPI artifacts, found ${pypiArtifacts.length}`);
  await run({ name: "PyPI metadata check", command: ["python", "-m", "twine", "check", ...pypiArtifacts] });

  await run({ name: "cross-platform release assets", command: ["bun", "run", "build:release"] });
  verifyReleaseAssets();
  console.log("\npackage gate passed");
} finally {
  cleanPythonBuildArtifacts();
}
