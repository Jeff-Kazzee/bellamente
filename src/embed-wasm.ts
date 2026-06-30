// embed-wasm.ts - the local embedding engine, WASM-only (no native code).
//   - Tokenizer: transformers.js AutoTokenizer (pure JS). build.ts aliases onnxruntime-node ->
//     onnxruntime-web so importing transformers.js never pulls the native backend into the binary.
//   - Inference: onnxruntime-web (WASM), single-thread (multi-thread hangs in Bun via Atomics.wait).
// The wasm runtime + emscripten glue are embedded (type:"file") and extracted to runtimeDir() at boot.
import * as ort from "onnxruntime-web";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { statSync } from "node:fs";
import { EMBED_DIM, LOCAL_MODEL, LOCAL_DTYPE, formatForTask, mrl, type TaskType } from "./embed-common";
import wasmFile from "../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm" with { type: "file" };
import glueFile from "../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.mjs" with { type: "file" };

const ONNX_FILE: Record<string, string> = {
  fp32: "model.onnx",
  fp16: "model_fp16.onnx",
  q8: "model_quantized.onnx",
  int8: "model_quantized.onnx",
  q4: "model_q4.onnx",
};

let sessionP: Promise<ort.InferenceSession> | null = null;
let tokP: Promise<any> | null = null;

async function modelDir(): Promise<string> {
  const { modelsDir } = await import("./paths");
  return process.env.EUNOIA_MODEL_DIR ?? modelsDir();
}

/** Ensure the .onnx weights exist in the cache; download from HF on first run if missing. */
async function ensureModelFile(): Promise<string> {
  const onnxName = ONNX_FILE[LOCAL_DTYPE] ?? "model_quantized.onnx";
  const dest = join(await modelDir(), ...LOCAL_MODEL.split("/"), "onnx", onnxName);
  try {
    if (statSync(dest).size > 0) return dest;
  } catch {}
  const url = `https://huggingface.co/${LOCAL_MODEL}/resolve/main/onnx/${onnxName}`;
  console.log(`[embed] downloading model ${LOCAL_MODEL}/${onnxName} ...`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`model download failed HTTP ${res.status}: ${url}`);
  await Bun.write(dest, res); // Bun.write creates parent dirs
  console.log(`[embed] model cached at ${dest}`);
  return dest;
}

async function getSession(): Promise<ort.InferenceSession> {
  if (sessionP) return sessionP;
  sessionP = (async () => {
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
    ort.env.wasm.numThreads = Math.max(1, Number(process.env.EUNOIA_ONNX_THREADS ?? 1)); // >1 hangs in Bun
    ort.env.wasm.proxy = false;
    ort.env.wasm.wasmPaths = pathToFileURL(dir).href + "/";
    const modelPath = await ensureModelFile();
    return ort.InferenceSession.create(modelPath, { executionProviders: ["wasm"] });
  })();
  return sessionP;
}

async function getTokenizer(): Promise<any> {
  if (tokP) return tokP;
  tokP = (async () => {
    const { AutoTokenizer, env } = await import("@huggingface/transformers");
    (env as any).cacheDir = await modelDir();
    return AutoTokenizer.from_pretrained(LOCAL_MODEL);
  })();
  return tokP;
}

/** Embed a batch of texts -> EMBED_DIM-length L2-normalized vectors (masked mean pool). */
export async function embedWasm(values: string[], taskType: TaskType): Promise<number[][]> {
  if (values.length === 0) return [];
  const texts = values.map((v) => formatForTask(v, taskType));
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
  const H = lhs.dims[2] as number;
  const data = lhs.data as Float32Array;

  const result: number[][] = [];
  for (let n = 0; n < N!; n++) {
    const pooled = new Array(H).fill(0);
    let count = 0;
    for (let s = 0; s < L!; s++) {
      if (Number(mask[n * L! + s]) === 0) continue;
      count++;
      const base = (n * L! + s) * H;
      for (let h = 0; h < H; h++) pooled[h] += data[base + h]!;
    }
    for (let h = 0; h < H; h++) pooled[h] /= count || 1;
    result.push(mrl(pooled, EMBED_DIM));
  }
  return result;
}
