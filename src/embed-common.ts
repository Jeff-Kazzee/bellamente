// embed-common.ts - PURE, shared embedding helpers (no native deps, no transformers.js import).
// Imported by BOTH the worker (src/embed-worker.ts, which owns the model) and the OpenAI fallback
// path (src/embed.ts), so the model-specific prompt/pooling/normalize logic lives in exactly one place.
export type TaskType = "QUESTION_ANSWERING" | "RETRIEVAL_QUERY" | "RETRIEVAL_DOCUMENT";
export type Embed = (args: { values: string[]; taskType: TaskType }) => Promise<number[][]>;

export const EMBED_DIM = Number(process.env.EMBED_DIM ?? 384);
const MAX_PAYLOAD_CHARS = 36000;

export const PROVIDER = process.env.EMBEDDING_PROVIDER ?? "local";
export const LOCAL_MODEL = process.env.LOCAL_EMBED_MODEL ?? "Xenova/multilingual-e5-small";
export const LOCAL_DTYPE = (process.env.LOCAL_EMBED_DTYPE ?? "q8") as "fp32" | "fp16" | "q8" | "q4";

// Maps the weight dtype to the .onnx filename transformers.js publishes under <model>/onnx/.
export const ONNX_FILE: Record<string, string> = {
  fp32: "model.onnx",
  fp16: "model_fp16.onnx",
  q8: "model_quantized.onnx",
  int8: "model_quantized.onnx",
  q4: "model_q4.onnx",
};
/** Path segments (relative to the model cache dir) of the .onnx weights for the current model + dtype. */
export function onnxRelPath(): string[] {
  return [...LOCAL_MODEL.split("/"), "onnx", ONNX_FILE[LOCAL_DTYPE] ?? "model_quantized.onnx"];
}

export type Pooling = "last_token" | "mean" | "cls";
type ModelProfile = { pooling: Pooling; query: (t: string) => string; doc: (t: string) => string };
const raw = (t: string) => t;
const e5: ModelProfile = { pooling: "mean", query: (t) => `query: ${t}`, doc: (t) => `passage: ${t}` };
const bge: ModelProfile = {
  pooling: "cls",
  query: (t) => `Represent this sentence for searching relevant passages: ${t}`,
  doc: raw,
};
const qwen: ModelProfile = {
  pooling: "last_token",
  query: (t) => `Instruct: Given a search query, retrieve relevant memories and passages that answer the query\nQuery:${t}`,
  doc: raw,
};
const PROFILES: Record<string, ModelProfile> = {
  "Xenova/multilingual-e5-small": e5,
  "Xenova/multilingual-e5-base": e5,
  "Xenova/multilingual-e5-large": e5,
  "Xenova/bge-base-en-v1.5": bge,
  "Xenova/bge-small-en-v1.5": bge,
  "onnx-community/Qwen3-Embedding-0.6B-ONNX": qwen,
  "onnx-community/Qwen3-Embedding-4B-ONNX": qwen,
};
export const profile: ModelProfile = PROFILES[LOCAL_MODEL] ?? { pooling: "mean", query: raw, doc: raw };

export function embedModelName(): string {
  return PROVIDER === "openai" ? (process.env.OPENAI_EMBED_MODEL ?? "text-embedding-3-small") : LOCAL_MODEL;
}
export function isValidVector(v: number[]): boolean {
  return v.length === EMBED_DIM && v.every((x) => Number.isFinite(x));
}
export function truncatePayload(values: string[]): string[] {
  const total = values.reduce((n, v) => n + v.length, 0) * 2;
  if (total <= MAX_PAYLOAD_CHARS) return values;
  const per = Math.floor(MAX_PAYLOAD_CHARS / 2 / Math.max(values.length, 1));
  return values.map((v) => (v.length > per ? v.slice(0, per) : v));
}
export function formatForTask(text: string, taskType: TaskType): string {
  return taskType === "RETRIEVAL_DOCUMENT" ? profile.doc(text) : profile.query(text);
}
// Matryoshka: slice to EMBED_DIM then L2-normalize.
export function mrl(vec: number[], dim: number): number[] {
  const s = vec.length > dim ? vec.slice(0, dim) : vec;
  let n = 0;
  for (const x of s) n += x * x;
  n = Math.sqrt(n) || 1;
  return s.map((x) => x / n);
}
