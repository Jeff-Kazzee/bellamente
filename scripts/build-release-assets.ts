import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const version = process.env.RELEASE_VERSION || (await import("../package.json")).default.version;
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
  throw new Error(`Invalid RELEASE_VERSION: ${version}`);
}
const releaseRoot = resolve(import.meta.dir, "..", ".release");
const outDir = resolve(releaseRoot, `v${version}`);
if (!outDir.startsWith(`${releaseRoot}\\`) && !outDir.startsWith(`${releaseRoot}/`)) {
  throw new Error(`Refusing to write release assets outside ${releaseRoot}: ${outDir}`);
}

const targets = [
  { target: "bun-windows-x64", asset: "bella-windows-x64.exe" },
  { target: "bun-linux-x64", asset: "bella-linux-x64" },
];

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

for (const t of targets) {
  const outfile = join(outDir, t.asset);
  console.log(`\n=== build ${t.asset} (${t.target}) ===`);
  const proc = Bun.spawn(["bun", "run", "build"], {
    stdout: "inherit",
    stderr: "inherit",
    env: {
      ...process.env,
      BUN_COMPILE_TARGET: t.target,
      OUTFILE: outfile,
    },
  });
  const code = await proc.exited;
  if (code !== 0) process.exit(code);
}

const sums = targets
  .map((t) => {
    const file = join(outDir, t.asset);
    const hash = createHash("sha256").update(readFileSync(file)).digest("hex");
    return `${hash}  ${t.asset}`;
  })
  .join("\n");

writeFileSync(join(outDir, "SHA256SUMS.txt"), `${sums}\n`);
console.log(`\nrelease assets written to ${outDir}`);
