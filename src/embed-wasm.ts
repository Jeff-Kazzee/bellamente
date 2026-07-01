// embed-wasm.ts - the local embedding engine, WASM-only (no native code).
//   - Tokenizer: transformers.js AutoTokenizer (pure JS). build.ts aliases onnxruntime-node ->
//     onnxruntime-web so importing transformers.js never pulls the native backend into the binary.
//   - Inference: onnxruntime-web (WASM), SINGLE-thread (multi-thread hangs in Bun via Atomics.wait).
// The wasm runtime + emscripten glue are embedded (type:"file") and extracted to runtimeDir() at boot.
import * as ort from "onnxruntime-web";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { statSync, renameSync, rmSync } from "node:fs";
import { EMBED_DIM, EMBED_DIM_EXPLICIT, LOCAL_MODEL, LOCAL_DTYPE, ONNX_FILE, onnxRelPath, profile, formatForTask, truncatePayload, mrl, type TaskType } from "./embed-common";
import wasmFile from "../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm" with { type: "file" };
import glueFile from "../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.mjs" with { type: "file" };

// Validate the model id up front: it is interpolated into a filesystem path AND a download URL, so reject
// anything but a plain "<org>/<name>" (no `..`, slashes, or URL/path injection).
const MODEL_RE = /^[\w.-]+\/[\w.-]+$/;
if (!MODEL_RE.test(LOCAL_MODEL)) {
  throw new Error(`invalid LOCAL_EMBED_MODEL '${LOCAL_MODEL}' (expected '<org>/<name>')`);
}

const MODEL_DOWNLOAD_TIMEOUT_MS = Number(process.env.EUNOIA_MODEL_DOWNLOAD_TIMEOUT_MS ?? 300_000);

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
    for (const [name, src] of [
      ["ort-wasm-simd-threaded.wasm", wasmFile],
      ["ort-wasm-simd-threaded.mjs", glueFile],
    ] as const) {
      const d = join(dir, name);
      let have = false;
      try {
        have = statSync(d).size === (await Bun.file(src).size);
      } catch {}
      if (!have) await Bun.write(d, Bun.file(src));
    }
    ort.env.wasm.numThreads = 1; // MUST be 1 — multi-thread WASM hangs in Bun (Atomics.wait on main thread)
    ort.env.wasm.proxy = false;
    ort.env.wasm.wasmPaths = pathToFileURL(dir).href + "/";
    const modelPath = await ensureModelFile();
    return ort.InferenceSession.create(modelPath, { executionProviders: ["wasm"] });
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

  const out: any = await session.run(feeds);
  const lhs = out[session.outputNames[0]!];
  if (lhs.type !== "float32") {
    throw new Error(`unexpected model output dtype '${lhs.type}'; only float32 last_hidden_state is supported`);
  }
  const H = lhs.dims[2] as number;
  // Guard an unlisted, non-matryoshka model whose native dim != EMBED_DIM: without this, mrl() would silently
  // SLICE it to EMBED_DIM (semantically wrong) and store degraded vectors. Skip when the dim is authoritative
  // (user-pinned / persisted) so intentional matryoshka truncation still works.
  if (H !== EMBED_DIM && !EMBED_DIM_EXPLICIT) {
    throw new Error(`model ${LOCAL_MODEL} has native dim ${H} but EMBED_DIM=${EMBED_DIM}. Set EMBED_DIM=${H} (and, on an existing DB, recreate the tables).`);
  }
  const data = lhs.data as Float32Array;

  const result: number[][] = [];
  for (let n = 0; n < N!; n++) result.push(mrl(poolRow(data, mask, n, L!, H), EMBED_DIM));
  return result;
}
