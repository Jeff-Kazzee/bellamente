// runtime.ts - native ONNX Runtime library co-location for the COMPILED single binary.
//
// In dev (`bun run`) the ORT libs resolve from node_modules, so this is a no-op (Bun.embeddedFiles
// is empty). In the compiled standalone binary, the embedded `onnxruntime_binding.node` is
// auto-extracted by Bun, but its dependent shared library is NOT co-located, so the OS loader
// can't find it (Linux binding RUNPATH is `$ORIGIN/`, which points at Bun's extraction dir).
//
// Fix (in-process, no re-exec → respects the bounded-memory mandate): embed the dependent lib(s)
// (build.ts plugin → virtual module `eunoia:ort-libs`), extract them to runtimeDir(), then PRELOAD
// the shared lib via dlopen BEFORE the binding loads. The binding's NEEDED dependency is then matched
// by soname against the already-loaded object — no filesystem search, no LD_LIBRARY_PATH (which Linux
// reads only once at process start), no stray system lib.
import { join } from "node:path";
import { statSync } from "node:fs";

type OrtLibFile = { name: string; src: string; preload?: boolean };

let preparedPromise: Promise<void> | null = null;

/** Idempotent, async. Await before the first transformers.js import (i.e. inside the embed worker). */
export function prepareNativeRuntime(): Promise<void> {
  if (!preparedPromise) preparedPromise = doPrepare();
  return preparedPromise;
}

async function doPrepare(): Promise<void> {
  const B = (globalThis as any).Bun;
  // Only a compiled standalone binary has embedded files; `bun run` resolves libs from node_modules.
  if (!B?.embeddedFiles || B.embeddedFiles.length === 0) return;
  // Windows uses its own DLL search; the native compiled target is Linux/macOS.
  if (process.platform === "win32") return;

  let mod: { ortLibFiles?: OrtLibFile[] };
  try {
    mod = await import("eunoia:ort-libs"); // virtual module injected by build.ts (build-time only)
  } catch {
    return; // not present (e.g. dev) — nothing to do
  }
  const files = mod.ortLibFiles ?? [];
  if (files.length === 0) return;

  const { runtimeDir } = await import("./paths");
  const dir = runtimeDir();
  const toPreload: string[] = [];

  for (const f of files) {
    const dest = join(dir, f.name);
    const srcSize = await Bun.file(f.src).size;
    let have = false;
    try {
      have = statSync(dest).size === srcSize; // cheap idempotent extract (skip if already correct)
    } catch {}
    if (!have) await Bun.write(dest, Bun.file(f.src));
    if (f.preload) toPreload.push(dest);
  }

  // Preload the shared lib(s) so the binding's NEEDED entry is satisfied by soname when it dlopens.
  // bun:ffi's dlopen requires >=1 symbol, so we bind ORT's stable C-API entrypoint OrtGetApiBase
  // (we never call it — binding it just forces the library to load into the process).
  const { dlopen } = await import("bun:ffi");
  for (const p of toPreload) {
    try {
      dlopen(p, { OrtGetApiBase: { args: [], returns: "ptr" } }); // keep handle open for process lifetime
    } catch (e) {
      console.error("[runtime] failed to preload native lib " + p + ": " + (e as Error).message);
    }
  }
}
