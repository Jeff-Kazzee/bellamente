// embed-wasm.ts - the local embedding engine, WASM-only (no native code).
//   - Tokenizer: transformers.js AutoTokenizer (pure JS). build.ts aliases onnxruntime-node ->
//     onnxruntime-web so importing transformers.js never pulls the native backend into the binary.
//   - Inference: onnxruntime-web (WASM), SINGLE-thread (multi-thread hangs in Bun via Atomics.wait).
// The wasm runtime + emscripten glue are embedded (type:"file") and extracted to runtimeDir() at boot.
import * as ort from "onnxruntime-web";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { statSync, renameSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { EMBED_DIM, LOCAL_MODEL, LOCAL_DTYPE, ONNX_FILE, onnxRelPath, profile, formatForTask, truncatePayload, mrl, type TaskType } from "./embed-common";
import wasmFile from "../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm" with { type: "file" };
import glueFile from "../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.mjs" with { type: "file" };

// Validate the model id up front: it is interpolated into a filesystem path AND a download URL, so reject
// anything but a plain "<org>/<name>" (no `..`, slashes, or URL/path injection).
const MODEL_RE = /^[\w.-]+\/[\w.-]+$/;
if (!MODEL_RE.test(LOCAL_MODEL)) {
  throw new Error(`invalid LOCAL_EMBED_MODEL '${LOCAL_MODEL}' (expected '<org>/<name>')`);
}

const MODEL_DOWNLOAD_TIMEOUT_MS = Number(process.env.EUNOIA_MODEL_DOWNLOAD_TIMEOUT_MS ?? 300_000);

// The threaded emscripten glue creates a SHARED WebAssembly.Memory with `maximum: 65536` pages (4 GB).
// A *shared* memory pre-reserves its entire maximum up front (it can't be remapped on growth), so on a
// machine with little free RAM that init fails with "out of memory". We force numThreads=1 (no extra
// threads are spawned), so the 4 GB ceiling is unnecessary. We lower it to EUNOIA_EMBED_WASM_MAX_MB
// (default 512 MB) when extracting the glue. The module's memory import only requires {min: 256 pages,
// max <= 65536}, so any cap in [256 pages, 65536] is a valid import. 1 wasm page = 64 KiB. Raise the env
// only if you run a larger opt-in model and have the RAM. Everything stays 100% local — no cloud.
const WASM_MAX_MB = Number(process.env.EUNOIA_EMBED_WASM_MAX_MB ?? 512);
const WASM_MAX_PAGES = Math.min(65536, Math.max(256, Math.ceil((WASM_MAX_MB * 1024 * 1024) / 65536)));
let gluePatchWarned = false;
function patchGlueMemory(src: string): string {
  // Target only the main heap allocation ({initial:256,maximum:65536}); leave the {initial:0,maximum:0}
  // SharedArrayBuffer polyfill untouched.
  const out = src.replace(
    /(new WebAssembly\.Memory\(\{initial:256,maximum:)65536(,shared:!0\}\))/,
    `$1${WASM_MAX_PAGES}$2`,
  );
  if (out === src && !gluePatchWarned) {
    gluePatchWarned = true;
    console.warn("[embed] could not lower the WASM memory ceiling (glue format changed); the 4 GB default may OOM on low-RAM machines");
  }
  return out;
}

// A low-memory failure during WASM init/inference surfaces as an opaque RangeError / "no available
// backend" / emscripten abort. Turn it into a clear, actionable, fully-local message (never suggest cloud).
const LOW_MEM_RE = /out of memory|no available backend|cannot enlarge memory|memory access out of bounds|rangeerror|\babort\b/i;
function asLowMemError(cause: unknown): Error | null {
  if (!LOW_MEM_RE.test(String((cause as any)?.message ?? cause))) return null;
  return new Error(
    "local embedding engine failed to initialize — most likely not enough free memory. It runs " +
      `fully on your machine (no cloud) and reserves up to ${WASM_MAX_MB} MB of RAM ` +
      "(set EUNOIA_EMBED_WASM_MAX_MB to tune). Close other apps to free memory and retry. " +
      `(cause: ${String((cause as any)?.message ?? cause)})`,
  );
}

let sessionP: Promise<ort.InferenceSession> | null = null;
let tokP: Promise<any> | null = null;

async function modelDir(): Promise<string> {
  const { modelsDir } = await import("./paths");
  return process.env.EUNOIA_MODEL_DIR ?? modelsDir();
}

/** Ensure the .onnx weights exist in the cache; download from HF on first run if missing.
 *  Downloads to a temp file and renames on success, so an interrupted download never leaves a
 *  truncated file that the size>0 reuse check would wrongly accept. */
async function ensureModelFile(): Promise<string> {
  const onnxName = ONNX_FILE[LOCAL_DTYPE] ?? "model_quantized.onnx";
  const dest = join(await modelDir(), ...onnxRelPath());
  try {
    if (statSync(dest).size > 0) return dest; // any present file is complete (only full downloads are renamed in)
  } catch {}

  const url = `https://huggingface.co/${LOCAL_MODEL}/resolve/main/onnx/${onnxName}`;
  const tmp = dest + ".part";
  console.log(`[embed] downloading model ${LOCAL_MODEL}/${onnxName} ...`);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), MODEL_DOWNLOAD_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`model download failed HTTP ${res.status}: ${url}`);
    await Bun.write(tmp, res); // Bun.write creates parent dirs
    const expected = Number(res.headers.get("content-length") ?? 0);
    const got = statSync(tmp).size;
    if (expected > 0 && got !== expected) {
      throw new Error(`model download truncated: got ${got} of ${expected} bytes`);
    }
    renameSync(tmp, dest); // atomic publish — only a complete file ever appears at `dest`
  } catch (e) {
    try { rmSync(tmp, { force: true }); } catch {}
    throw e;
  } finally {
    clearTimeout(timer);
  }
  console.log(`[embed] model cached at ${dest}`);
  return dest;
}

// Cache the session/tokenizer promises, but clear them on rejection so a transient first-run failure
// (e.g. a network blip during download) does not poison every later embed until process restart.
function memo<T>(get: () => Promise<T>, slot: "session" | "tok"): Promise<T> {
  const p = get();
  p.catch(() => {
    if (slot === "session" && sessionP === (p as unknown)) sessionP = null;
    if (slot === "tok" && tokP === (p as unknown)) tokP = null;
  });
  return p;
}

function getSession(): Promise<ort.InferenceSession> {
  if (sessionP) return sessionP;
  sessionP = memo(async () => {
    const { runtimeDir } = await import("./paths");
    const dir = runtimeDir();
    // The wasm binary is large + unmodified — skip the rewrite if it's already the right size.
    {
      const d = join(dir, "ort-wasm-simd-threaded.wasm");
      let have = false;
      try { have = statSync(d).size === (await Bun.file(wasmFile).size); } catch {}
      if (!have) await Bun.write(d, Bun.file(wasmFile));
    }
    // The glue is small + patched (memory ceiling). Rewrite whenever the on-disk copy doesn't match the
    // patched text (e.g. first run, or EUNOIA_EMBED_WASM_MAX_MB changed since last boot).
    {
      const d = join(dir, "ort-wasm-simd-threaded.mjs");
      const patched = patchGlueMemory(await Bun.file(glueFile).text());
      let cur: string | null = null;
      try { cur = readFileSync(d, "utf8"); } catch {}
      if (cur !== patched) writeFileSync(d, patched);
    }
    ort.env.wasm.numThreads = 1; // MUST be 1 — multi-thread WASM hangs in Bun (Atomics.wait on main thread)
    ort.env.wasm.proxy = false;
    ort.env.wasm.wasmPaths = pathToFileURL(dir).href + "/";
    const modelPath = await ensureModelFile();
    try {
      return await ort.InferenceSession.create(modelPath, { executionProviders: ["wasm"] });
    } catch (e) {
      throw asLowMemError(e) ?? e;
    }
  }, "session");
  return sessionP;
}

function getTokenizer(): Promise<any> {
  if (tokP) return tokP;
  tokP = memo(async () => {
    const { AutoTokenizer, env } = await import("@huggingface/transformers");
    (env as any).cacheDir = await modelDir();
    return AutoTokenizer.from_pretrained(LOCAL_MODEL);
  }, "tok");
  return tokP;
}

// Pool one row's token embeddings into a single vector per the model's pooling strategy.
function poolRow(data: Float32Array, mask: BigInt64Array, n: number, L: number, H: number): number[] {
  const at = (s: number, h: number) => data[(n * L + s) * H + h]!;
  if (profile.pooling === "cls") {
    return Array.from({ length: H }, (_, h) => at(0, h)); // CLS = first token (bge)
  }
  if (profile.pooling === "last_token") {
    let last = 0;
    for (let s = 0; s < L; s++) if (Number(mask[n * L + s]) !== 0) last = s; // last non-padded (qwen)
    return Array.from({ length: H }, (_, h) => at(last, h));
  }
  // mean = masked mean over real tokens (e5, default)
  const pooled = new Array(H).fill(0);
  let count = 0;
  for (let s = 0; s < L; s++) {
    if (Number(mask[n * L + s]) === 0) continue;
    count++;
    for (let h = 0; h < H; h++) pooled[h] += at(s, h);
  }
  for (let h = 0; h < H; h++) pooled[h] /= count || 1;
  return pooled;
}

/** Embed a batch of texts -> EMBED_DIM-length L2-normalized vectors (pooling per the model profile). */
export async function embedWasm(values: string[], taskType: TaskType): Promise<number[][]> {
  if (values.length === 0) return [];
  const texts = truncatePayload(values).map((v) => formatForTask(v, taskType));
  const [tok, session] = await Promise.all([getTokenizer(), getSession()]);
  const enc = await tok(texts, { padding: true, truncation: true, max_length: 512 });
  const [N, L] = enc.input_ids.dims as number[];
  const ids = enc.input_ids.data as BigInt64Array;
  const mask = enc.attention_mask.data as BigInt64Array;

  const feeds: Record<string, ort.Tensor> = {
    input_ids: new ort.Tensor("int64", ids, [N!, L!]),
    attention_mask: new ort.Tensor("int64", mask, [N!, L!]),
  };
  if (session.inputNames.includes("token_type_ids")) {
    feeds.token_type_ids = new ort.Tensor("int64", new BigInt64Array(N! * L!), [N!, L!]);
  }

  let out: any;
  try {
    out = await session.run(feeds);
  } catch (e) {
    throw asLowMemError(e) ?? e;
  }
  const lhs = out[session.outputNames[0]!];
  if (lhs.type !== "float32") {
    throw new Error(`unexpected model output dtype '${lhs.type}'; only float32 last_hidden_state is supported`);
  }
  const H = lhs.dims[2] as number;
  const data = lhs.data as Float32Array;

  const result: number[][] = [];
  for (let n = 0; n < N!; n++) result.push(mrl(poolRow(data, mask, n, L!, H), EMBED_DIM));
  return result;
}
