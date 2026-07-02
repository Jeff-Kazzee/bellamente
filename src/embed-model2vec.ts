// embed-model2vec.ts - PURE-TS static ("Model2Vec" / MinishLab "potion") embedding engine. No ONNX, no
// WASM, no native code, no worker: a token->vector lookup matrix, mean-pooled + L2-normalized. RAM is
// BOUNDED and FLAT (the matrix, stored as float16) and it can never OOM-crash like the threaded WASM path.
//   pipeline: tokenize (add_special_tokens=false) -> gather token rows -> mean -> (config) L2-normalize.
// Weights download once to the model cache (atomic, like the ONNX path); tokenization uses transformers.js
// AutoTokenizer (pure JS), which build.ts already keeps native-free by aliasing onnxruntime-node -> web.
import { join } from "node:path";
import { statSync, renameSync, rmSync } from "node:fs";
import { EMBED_DIM, LOCAL_MODEL, formatForTask, truncatePayload, type TaskType } from "./embed-common";
import { brandEnv } from "./env";

// Interpolated into a filesystem path AND a URL — reject anything but "<org>/<name>". [\w.-]+ would match a
// pure-dot segment (".."/"."), so explicitly reject those to prevent escaping the model cache dir.
const MODEL_RE = /^[\w.-]+\/[\w.-]+$/;
if (!MODEL_RE.test(LOCAL_MODEL) || LOCAL_MODEL.split("/").some((p) => p === "." || p === "..")) {
  throw new Error(`invalid LOCAL_EMBED_MODEL '${LOCAL_MODEL}' (expected '<org>/<name>')`);
}
const DL_TIMEOUT_MS = Number(brandEnv("MODEL_DOWNLOAD_TIMEOUT_MS") ?? 300_000);
const MAX_TOKENS = 512;

async function modelDir(): Promise<string> {
  const { modelsDir } = await import("./paths");
  return brandEnv("MODEL_DIR") ?? modelsDir();
}

/** Download a single model file from HF to the cache (atomic temp+rename; reused across boots via size>0). */
async function ensureFile(rel: string): Promise<string> {
  const dest = join(await modelDir(), ...LOCAL_MODEL.split("/"), rel);
  try { if (statSync(dest).size > 0) return dest; } catch {}
  const url = `https://huggingface.co/${LOCAL_MODEL}/resolve/main/${rel}`;
  const tmp = dest + ".part";
  console.log(`[embed] downloading ${LOCAL_MODEL}/${rel} ...`);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), DL_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`model download failed HTTP ${res.status}: ${url}`);
    await Bun.write(tmp, res); // creates parent dirs
    const expected = Number(res.headers.get("content-length") ?? 0);
    const got = statSync(tmp).size;
    if (expected > 0 && got !== expected) throw new Error(`model download truncated: got ${got} of ${expected} bytes: ${url}`);
    renameSync(tmp, dest); // atomic publish — only a complete, length-verified file ever appears at `dest`
  } catch (e) {
    try { rmSync(tmp, { force: true }); } catch {}
    throw e;
  } finally {
    clearTimeout(timer);
  }
  return dest;
}

// IEEE-754 half<->single. Storing the matrix as float16 halves its RAM; the tiny precision loss is
// irrelevant for cosine similarity on L2-normalized vectors.
function f16to32(h: number): number {
  const s = (h & 0x8000) >> 15, e = (h & 0x7c00) >> 10, f = h & 0x03ff;
  if (e === 0) return (s ? -1 : 1) * 2 ** -14 * (f / 1024);
  if (e === 0x1f) return f ? NaN : (s ? -Infinity : Infinity);
  return (s ? -1 : 1) * 2 ** (e - 15) * (1 + f / 1024);
}
function packF16(f32: Float32Array): Uint16Array {
  const bits = new Int32Array(f32.buffer, f32.byteOffset, f32.length); // same bytes, read as int
  const out = new Uint16Array(f32.length);
  for (let k = 0; k < f32.length; k++) {
    const x = bits[k]!;
    const s = (x >>> 16) & 0x8000;
    const e = ((x >>> 23) & 0xff) - 112; // rebias 127 -> 15
    const m = x & 0x7fffff;
    if (e <= 0) out[k] = s; // underflow/subnormal -> signed zero
    else if (e >= 0x1f) out[k] = s | 0x7c00; // overflow -> inf
    else out[k] = s | (e << 10) | (m >> 13);
  }
  return out;
}

type Matrix = { mat: Uint16Array; V: number; D: number; normalize: boolean };
let matP: Promise<Matrix> | null = null;
let tokP: Promise<any> | null = null;

function memo<T>(get: () => Promise<T>, slot: "mat" | "tok"): Promise<T> {
  const p = get();
  p.catch(() => { if (slot === "mat" && matP === (p as unknown)) matP = null; if (slot === "tok" && tokP === (p as unknown)) tokP = null; });
  return p;
}

// A `keepCache` error is a VALID-but-incompatible file (wrong dim/dtype/shape) — re-downloading won't fix it,
// so the cache is kept and the config error surfaced. Anything else (truncated/corrupt bytes) drops the cache.
function keepErr(message: string): Error {
  const e = new Error(message);
  (e as { keepCache?: boolean }).keepCache = true;
  return e;
}

// Parse the safetensors embedding tensor -> a compact float16 matrix. Kept in its own function so the large
// intermediates (the F32 copy) are unreachable the moment it returns.
function parseMatrix(buf: Uint8Array): { mat: Uint16Array; V: number; D: number } {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const headerLen = Number(dv.getBigUint64(0, true));
  const header = JSON.parse(new TextDecoder().decode(buf.subarray(8, 8 + headerLen)));
  const dataStart = 8 + headerLen;
  const names = Object.keys(header).filter((k) => k !== "__metadata__");
  const embName = names.find((k) => Array.isArray(header[k].shape) && header[k].shape.length === 2);
  if (!embName) throw keepErr(`no 2-D embedding tensor in ${LOCAL_MODEL}/model.safetensors`);
  const t = header[embName];
  const [V, D] = t.shape as number[];
  if (D !== EMBED_DIM) {
    throw keepErr(`model ${LOCAL_MODEL} has native dim ${D} but EMBED_DIM=${EMBED_DIM}. Set EMBED_DIM=${D} (and, on an existing DB, recreate the tables — see docs).`);
  }
  if (t.dtype !== "F32") throw keepErr(`unsupported embedding dtype ${t.dtype} (expected F32)`);
  const [s, e] = t.data_offsets as number[];
  // Copy the tensor region into an aligned Float32Array (safetensors offsets aren't guaranteed 4-aligned),
  // then pack to float16.
  const f32 = new Float32Array(buf.subarray(dataStart + s, dataStart + e).slice().buffer, 0, V * D);
  return { mat: packF16(f32), V, D };
}

function getMatrix(): Promise<Matrix> {
  if (matP) return matP;
  matP = memo(async () => {
    const [stPath, cfgPath] = await Promise.all([ensureFile("model.safetensors"), ensureFile("config.json").catch(() => "")]);
    let bytes: Uint8Array | null = new Uint8Array(await Bun.file(stPath).arrayBuffer());
    let parsed: { mat: Uint16Array; V: number; D: number };
    try {
      parsed = parseMatrix(bytes);
    } catch (e: any) {
      // Drop a structurally-corrupt/truncated cache so the next boot re-downloads; keep a valid-but-
      // incompatible one (wrong dim/dtype) so the config error isn't masked by a pointless re-download loop.
      if (!e?.keepCache) { try { rmSync(stPath, { force: true }); } catch {} }
      throw e;
    }
    const { mat, V, D } = parsed;
    bytes = null; // release the whole-file buffer + the F32 copy — only the compact F16 matrix is retained
    void bytes;
    (globalThis as any).Bun?.gc?.(true); // reclaim the load transients now, not at some later GC
    let normalize = true; // potion models set normalize:true; honor config if present
    try { normalize = JSON.parse(await Bun.file(cfgPath).text()).normalize ?? true; } catch {}
    console.log(`[embed] static model ${LOCAL_MODEL} loaded: vocab=${V} dim=${D} normalize=${normalize} (~${Math.round(mat.byteLength / 1048576)}MB matrix)`);
    return { mat, V, D, normalize };
  }, "mat");
  return matP;
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

/** Embed a batch of texts -> EMBED_DIM-length vectors (mean of token rows, L2-normalized per config). */
export async function embedStatic(values: string[], taskType: TaskType): Promise<number[][]> {
  if (values.length === 0) return [];
  const texts = truncatePayload(values).map((v) => formatForTask(v, taskType)); // raw for static profiles
  const [{ mat, V, D, normalize }, tok] = await Promise.all([getMatrix(), getTokenizer()]);

  // Tokenize per text (NOT batched): batch padding trips a transformers.js BigInt bug on some tokenizers
  // (bge-m3, used by the multilingual model). Static pooling is cheap, so per-text is fine.
  const results: number[][] = [];
  for (const text of texts) {
    const enc = await tok(text, { add_special_tokens: false, truncation: true, max_length: MAX_TOKENS });
    const ids = enc.input_ids.data as ArrayLike<any>;
    const out = new Float32Array(D);
    let count = 0;
    for (let i = 0; i < (ids as { length: number }).length; i++) {
      const id = Number(ids[i]);
      if (id < 0 || id >= V) continue; // out-of-vocab guard
      count++;
      const base = id * D;
      for (let j = 0; j < D; j++) out[j] += f16to32(mat[base + j]!);
    }
    if (count) for (let j = 0; j < D; j++) out[j] /= count;
    if (normalize && count) {
      let nrm = 0;
      for (let j = 0; j < D; j++) nrm += out[j]! * out[j]!;
      nrm = Math.sqrt(nrm) + 1e-32;
      for (let j = 0; j < D; j++) out[j] /= nrm;
    }
    results.push(Array.from(out));
  }
  return results;
}
