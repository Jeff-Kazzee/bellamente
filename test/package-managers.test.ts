import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const VERSION = "0.1.0";
const REPO = "The-Little-AI-Company/bellamente";

function read(path: string) {
  return readFileSync(join(import.meta.dir, "..", path), "utf8");
}

test("npm launcher package exposes bella without publishing the dev tree", () => {
  const pkg = JSON.parse(read("packages/npm/package.json"));
  expect(pkg.name).toBe("bellamente");
  expect(pkg.version).toBe(VERSION);
  expect(pkg.bin.bella).toBe("bin/bella.cjs");
  expect(pkg.files).toEqual(["bin/bella.cjs", "README.md"]);

  const launcher = read("packages/npm/bin/bella.cjs");
  expect(launcher).toContain("const VERSION = pkg.version");
  expect(launcher).toContain(`const REPO = "${REPO}"`);
  expect(launcher).toContain("BELLA_DOWNLOAD_BASE");
  expect(launcher).toContain("BELLA_BIN_CACHE");
  expect(launcher).not.toContain("BELLAMENTE_");
  expect(launcher).toContain(".sha256");
  for (const asset of ["bella-windows-x64.exe", "bella-linux-x64"]) {
    expect(launcher).toContain(asset);
  }
  expect(launcher).not.toContain("bella-darwin");
  expect(launcher).toContain("Windows x64 and Linux x64 only");
  expect(launcher).toContain("SHA256SUMS.txt");
});

test("PyPI launcher package mirrors the npm release identity", () => {
  const pyproject = read("packages/pypi/pyproject.toml");
  const init = read("packages/pypi/src/bellamente/__init__.py");
  const cli = read("packages/pypi/src/bellamente/cli.py");

  expect(pyproject).toContain('name = "bellamente"');
  expect(pyproject).toContain(`version = "${VERSION}"`);
  expect(pyproject).toContain('bella = "bellamente.cli:main"');
  expect(init).toContain(`__version__ = "${VERSION}"`);
  expect(cli).toContain(`REPO = "${REPO}"`);
  expect(cli).toContain("BELLA_DOWNLOAD_BASE");
  expect(cli).toContain("BELLA_BIN_CACHE");
  expect(cli).not.toContain("BELLAMENTE_");
  expect(cli).not.toContain("bella-darwin");
  expect(cli).toContain("Windows x64 and Linux x64 only");
  expect(cli).toContain(".sha256");
  expect(cli).toContain("SHA256SUMS.txt");
});

test("public docs advertise npm, pipx, uvx, and the current release", () => {
  for (const path of ["README.md", "website/src/pages/docs/index.md"]) {
    const text = read(path);
    expect(text).toContain("npm install -g bellamente");
    expect(text).toContain("pipx install bellamente");
    expect(text).toContain("uvx bellamente doctor");
  }

  expect(read("website/src/pages/index.astro")).toContain(`releases/tag/v${VERSION}`);
  expect(read("website/public/llms.txt")).toContain(`Bellamente v${VERSION}`);
});
