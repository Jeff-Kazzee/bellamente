// build.ts - compile the Bun single binary (WASM engine: no native code embedded).
//
//  Env knobs:
//    OUTFILE                 output binary  (default ./bella — the public CLI name, see BRAND.md)
//    BUN_COMPILE_TARGET      Bun compile target, e.g. bun-linux-x64 / bun-darwin-arm64 (default: host)
//
//  What it does:
//   - stubs the unused native `sharp` image dep (we are text-only)
//   - aliases `onnxruntime-node` -> `onnxruntime-web` so transformers.js (used only for its pure-JS
//     tokenizer) never pulls the NATIVE ONNX backend into the bundle. Inference uses onnxruntime-web.
//   The ONNX WASM runtime + glue are embedded automatically via type:"file" imports in src/embed-wasm.ts.
import { resolve } from "node:path";

const ENTRY = resolve(import.meta.dir, "src/index.ts");
// The embed worker MUST be an explicit entrypoint — Bun does not auto-detect new Worker(...) for --compile.
// Both entrypoints live in src/ so they co-locate in the embedded FS.
const WORKER = resolve(import.meta.dir, "src/embed-worker.ts");
const OUTFILE = process.env.OUTFILE ?? import.meta.dir + "/bella";
const TARGET = process.env.BUN_COMPILE_TARGET; // undefined -> host target

const compile: Record<string, unknown> = {
  outfile: OUTFILE,
  // SECURITY: a standalone binary must NOT autoload bunfig.toml/.env from the current working directory,
  // or an attacker who controls the cwd could run arbitrary `preload` code (RCE) or override
  // DATABASE_URL / BELLA_API_KEY / BELLA_*_DIR via a planted .env. The binary reads config from real
  // process environment variables only (docs/10-config.md). These flags do not affect `bun run dev`.
  autoloadBunfig: false,
  autoloadDotenv: false,
};
if (TARGET) compile.target = TARGET;

const webEntry = Bun.resolveSync("onnxruntime-web", import.meta.dir);

const r = await Bun.build({
  entrypoints: [ENTRY, WORKER],
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
      // Keep the NATIVE onnxruntime-node backend out of the bundle (inference runs on onnxruntime-web).
      // Broad filter so a bare OR subpath import (`onnxruntime-node`, `onnxruntime-node/...`) is aliased
      // — survives transformers.js switching to a subpath import in a future version.
      name: "alias-ort-node-to-web",
      setup(b) {
        b.onResolve({ filter: /^onnxruntime-node(\/|$)/ }, () => ({ path: webEntry }));
      },
    },
  ],
});
console.log("build success:", r.success, "| entry:", ENTRY, "| out:", OUTFILE, "| target:", TARGET ?? "host");
if (!r.success) for (const m of r.logs) console.log(String(m));
