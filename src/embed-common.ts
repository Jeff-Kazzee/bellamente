// embed-common.ts - PURE, shared embedding helpers (no native deps, no transformers.js import).
// Imported by BOTH the worker (src/embed-worker.ts, which owns the model) and the OpenAI fallback
// path (src/embed.ts), so the model-specific prompt/pooling/normalize logic lives in exactly one place.
import { totalmem } from "node:os";

export type TaskType = "QUESTION_ANSWERING" | "RETRIEVAL_QUERY" | "RETRIEVAL_DOCUMENT";
export type Embed = (args: { values: string[]; taskType: TaskType }) => Promise<number[][]>;

const MAX_PAYLOAD_CHARS = 36000;
export const PROVIDER = process.env.EMBEDDING_PROVIDER ?? "local";

// --- embedder tier (device-scaled) ---------------------------------------------------------------------
// DEFAULT = "quality" = multilingual-e5-small (WASM): the best-scoring engine (higher quality + multilingual),
// used on capable machines. LOW-RAM machines that would crash the threaded-WASM engine auto-fall back to
// "light" = a static Model2Vec model (never crashes, no worker, ~440 MB). The threaded-WASM OOM is
// UNCATCHABLE (mprotect), so we choose PROACTIVELY by total device RAM rather than trying and catching.
// Override: EUNOIA_EMBED_TIER=quality|light, or set LOCAL_EMBED_MODEL directly (wins outright).
// EUNOIA_EMBED_MIN_RAM_GB tunes the auto threshold (default 7 GB — 8 GB machines get e5, 4 GB get light).
const TIERS = { quality: "Xenova/multilingual-e5-small", light: "minishlab/potion-retrieval-32M" } as const;
const MODEL_DIMS: Record<string, number> = {
  "Xenova/multilingual-e5-small": 384, "Xenova/multilingual-e5-base": 768, "Xenova/multilingual-e5-large": 1024,
  "Xenova/bge-base-en-v1.5": 768, "Xenova/bge-small-en-v1.5": 384,
  "onnx-community/Qwen3-Embedding-0.6B-ONNX": 1024, "onnx-community/Qwen3-Embedding-4B-ONNX": 2560,
  "minishlab/potion-retrieval-32M": 512, "minishlab/potion-multilingual-128M": 256,
  "minishlab/potion-base-8M": 256, "minishlab/potion-base-32M": 512,
};
function resolveTier(): "quality" | "light" {
  const forced = process.env.EUNOIA_EMBED_TIER;
  if (forced === "quality" || forced === "light") return forced;
  const minRamGb = Number(process.env.EUNOIA_EMBED_MIN_RAM_GB ?? 7);
  return totalmem() / 2 ** 30 < minRamGb ? "light" : "quality"; // total RAM is stable per machine (no flip-flop)
}
export const EMBED_TIER = resolveTier();
export const LOCAL_MODEL = process.env.LOCAL_EMBED_MODEL ?? TIERS[EMBED_TIER];
// EMBED_DIM auto-follows the resolved model (the DB's on-disk vector dim). The Phase-A boot guard catches any
// mismatch against an existing DB (switching models/tiers on a populated DB requires recreating the tables).
export const EMBED_DIM = Number(process.env.EMBED_DIM ?? MODEL_DIMS[LOCAL_MODEL] ?? 384);
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
// `engine`: "wasm" = onnxruntime-web in a worker (transformer models); "static" = pure-TS Model2Vec lookup.
export type Engine = "wasm" | "static";
// `threshold`: the default cosine floor for /search filtering. Transformer models (e5/bge) score relevant
// pairs high (~0.8); Model2Vec's static vectors score on a LOWER absolute scale (~0.1-0.3), so a fixed 0.4
// would drop every real hit. Each engine carries its own default; SEARCH_THRESHOLD overrides it.
type ModelProfile = { pooling: Pooling; query: (t: string) => string; doc: (t: string) => string; engine: Engine; threshold: number };
const raw = (t: string) => t;
const e5: ModelProfile = { pooling: "mean", query: (t) => `query: ${t}`, doc: (t) => `passage: ${t}`, engine: "wasm", threshold: 0.4 };
const bge: ModelProfile = {
  pooling: "cls",
  query: (t) => `Represent this sentence for searching relevant passages: ${t}`,
  doc: raw,
  engine: "wasm",
  threshold: 0.4,
};
const qwen: ModelProfile = {
  pooling: "last_token",
  query: (t) => `Instruct: Given a search query, retrieve relevant memories and passages that answer the query\nQuery:${t}`,
  doc: raw,
  engine: "wasm",
  threshold: 0.4,
};
// Model2Vec / MinishLab "potion": static token->vector lookup — NO query/passage prefixes, mean-pooled,
// run by the pure-TS engine (src/embed-model2vec.ts). Not matryoshka: EMBED_DIM = the model's native dim.
const staticM2v: ModelProfile = { pooling: "mean", query: raw, doc: raw, engine: "static", threshold: 0.1 };
const PROFILES: Record<string, ModelProfile> = {
  "Xenova/multilingual-e5-small": e5,
  "Xenova/multilingual-e5-base": e5,
  "Xenova/multilingual-e5-large": e5,
  "Xenova/bge-base-en-v1.5": bge,
  "Xenova/bge-small-en-v1.5": bge,
  "onnx-community/Qwen3-Embedding-0.6B-ONNX": qwen,
  "onnx-community/Qwen3-Embedding-4B-ONNX": qwen,
  "minishlab/potion-retrieval-32M": staticM2v,
  "minishlab/potion-multilingual-128M": staticM2v,
  "minishlab/potion-base-8M": staticM2v,
  "minishlab/potion-base-32M": staticM2v,
};
const isStaticModel = LOCAL_MODEL.startsWith("minishlab/");
export const profile: ModelProfile =
  PROFILES[LOCAL_MODEL] ??
  { pooling: "mean", query: raw, doc: raw, engine: isStaticModel ? "static" : "wasm", threshold: isStaticModel ? 0.1 : 0.4 };

/** Default cosine floor for /search, calibrated to the active model's engine (overridden by SEARCH_THRESHOLD). */
export const DEFAULT_SIMILARITY_THRESHOLD = profile.threshold;

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
