// runtime.ts - native ONNX Runtime library co-location for the COMPILED single binary.
//
// In dev (`bun run`) the ORT libs resolve from node_modules, so this is a no-op. In the compiled
// standalone binary, the embedded `onnxruntime_binding.node` needs its dependent shared library
// (Linux: libonnxruntime.so.1; macOS: libonnxruntime.*.dylib; Windows: onnxruntime.dll + DirectML/
// dxil/dxcompiler) to be resolvable by the OS loader. P0b extracts the embedded lib(s) to
// runtimeDir() and makes the loader resolve THAT copy (never a stray system lib).
//
// Platform note (locked in docs/RUNTIME-RESEARCH.md): Windows re-reads PATH per LoadLibrary, but
// Linux ld.so reads LD_LIBRARY_PATH once at process start, so on Linux we must co-locate beside the
// .node ($ORIGIN) / dlopen by absolute path / re-exec — NOT mutate process.env at runtime.
let prepared = false;

/** Idempotent. Call once before the first transformers.js import (i.e. inside the embed worker). */
export function prepareNativeRuntime(): void {
  if (prepared) return;
  prepared = true;
  // No-op until P0b. (Compiled-binary detection + extraction lands there.)
}
