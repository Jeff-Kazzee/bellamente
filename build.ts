// build.ts - compile the Bun single binary (WASM engine: no native code embedded).
//
//  Env knobs:
//    ENTRY               entrypoint        (default ./src/index.ts)
//    OUTFILE             output binary     (default ./eunoia)
//    BUN_COMPILE_TARGET  Bun compile target, e.g. bun-linux-x64 / bun-darwin-arm64 (default: host)
//    WORKER              worker entrypoint (default ./src/embed-worker.ts; "none" => single-entry)
//
//  What it does:
//   - stubs the unused native `sharp` image dep (we are text-only)
//   - aliases `onnxruntime-node` -> `onnxruntime-web` so transformers.js (used only for its pure-JS
//     tokenizer) never drags the NATIVE ONNX backend into the binary. Inference uses onnxruntime-web.
//   The ONNX WASM runtime + glue are embedded automatically via type:"file" imports in src/embed-wasm.ts.
import { resolve } from "node:path";

const ENTRY = resolve(import.meta.dir, process.env.ENTRY ?? "src/index.ts");
// The embed worker MUST be an explicit entrypoint — Bun does not auto-detect new Worker(...) for --compile.
// Both entrypoints live in src/ so they co-locate in the embedded FS.
const WORKER = resolve(import.meta.dir, process.env.WORKER && process.env.WORKER !== "none" ? process.env.WORKER : "src/embed-worker.ts");
const OUTFILE = process.env.OUTFILE ?? import.meta.dir + "/eunoia";
const TARGET = process.env.BUN_COMPILE_TARGET; // undefined -> host target

const compile: Record<string, unknown> = { outfile: OUTFILE };
if (TARGET) compile.target = TARGET;
const entrypoints = process.env.WORKER === "none" ? [ENTRY] : [ENTRY, WORKER];

const webEntry = Bun.resolveSync("onnxruntime-web", import.meta.dir);

const r = await Bun.build({
  entrypoints,
  compile: compile as any,
  plugins: [
    {
      name: "stub-sharp",
      setup(b) {
        b.onResolve({ filter: /^sharp$/ }, () => ({ path: "sharp", namespace: "stub-sharp" }));
        b.onLoad({ filter: /.*/, namespace: "stub-sharp" }, () => ({
          contents: "const f=()=>{throw new Error('sharp disabled: text-only build')};export default f;",
          loader: "js",
        }));
      },
    },
    {
      // Alias the native ONNX backend to the WASM one so it is never bundled. Same onnxruntime-common API.
      name: "alias-ort-node-to-web",
      setup(b) {
        b.onResolve({ filter: /^onnxruntime-node$/ }, () => ({ path: webEntry }));
      },
    },
  ],
});
console.log("build success:", r.success, "| entry:", ENTRY, "| out:", OUTFILE, "| target:", TARGET ?? "host");
if (!r.success) for (const m of r.logs) console.log(String(m));
