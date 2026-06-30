// embed.ts - the single embedding singleton (Spec 02).
// Default = local, in-process (no cloud/server): multilingual-e5-small (MIT, 384-d, ~100 langs).
export type TaskType = "QUESTION_ANSWERING" | "RETRIEVAL_QUERY" | "RETRIEVAL_DOCUMENT";
export const EMBED_DIM = Number(process.env.EMBED_DIM ?? 384);
const MAX_PAYLOAD_CHARS = 36000;

const PROVIDER = process.env.EMBEDDING_PROVIDER ?? "local";
const LOCAL_MODEL = process.env.LOCAL_EMBED_MODEL ?? "Xenova/multilingual-e5-small";
const LOCAL_DTYPE = (process.env.LOCAL_EMBED_DTYPE ?? "q8") as "fp32" | "fp16" | "q8" | "q4";

export type Embed = (args: { values: string[]; taskType: TaskType }) => Promise<number[][]>;

type Pooling = "last_token" | "mean" | "cls";
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
const profile: ModelProfile = PROFILES[LOCAL_MODEL] ?? { pooling: "mean", query: raw, doc: raw };

export function embedModelName(): string {
  return PROVIDER === "openai" ? (process.env.OPENAI_EMBED_MODEL ?? "text-embedding-3-small") : LOCAL_MODEL;
}
export function isValidVector(v: number[]): boolean {
  return v.length === EMBED_DIM && v.every((x) => Number.isFinite(x));
}

function truncatePayload(values: string[]): string[] {
  const total = values.reduce((n, v) => n + v.length, 0) * 2;
  if (total <= MAX_PAYLOAD_CHARS) return values;
  const per = Math.floor(MAX_PAYLOAD_CHARS / 2 / Math.max(values.length, 1));
  return values.map((v) => (v.length > per ? v.slice(0, per) : v));
}
function formatForTask(text: string, taskType: TaskType): string {
  return taskType === "RETRIEVAL_DOCUMENT" ? profile.doc(text) : profile.query(text);
}
function mrl(vec: number[], dim: number): number[] {
  const s = vec.length > dim ? vec.slice(0, dim) : vec;
  let n = 0;
  for (const x of s) n += x * x;
  n = Math.sqrt(n) || 1;
  return s.map((x) => x / n);
}

let pipePromise: Promise<(input: string[], opts: any) => Promise<{ tolist: () => number[][] }>> | null = null;
async function getLocalPipe() {
  if (!pipePromise) {
    pipePromise = (async () => {
      const { pipeline, env } = await import("@huggingface/transformers");
      const { homedir } = await import("node:os");
      const { join } = await import("node:path");
      // Explicit, writable model cache dir (the default resolves wrong inside a compiled binary).
      env.cacheDir = process.env.EUNOIA_MODEL_DIR ?? join(homedir(), ".eunoia", "models");
      return (await pipeline("feature-extraction", LOCAL_MODEL, { dtype: LOCAL_DTYPE })) as any;
    })();
  }
  return pipePromise;
}

async function embedOpenAI(input: string[]): Promise<number[][]> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY required when EMBEDDING_PROVIDER=openai");
  const res = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: process.env.OPENAI_EMBED_MODEL ?? "text-embedding-3-small", input, dimensions: EMBED_DIM }),
  });
  if (!res.ok) throw new Error(`OpenAI embeddings HTTP ${res.status}: ${await res.text()}`);
  const json = (await res.json()) as { data: { index: number; embedding: number[] }[] };
  return json.data.slice().sort((a, b) => a.index - b.index).map((d) => d.embedding);
}

async function embedLocal(input: string[]): Promise<number[][]> {
  const pipe = await getLocalPipe();
  const out = await pipe(input, { pooling: profile.pooling, normalize: false });
  return out.tolist().map((v) => mrl(v, EMBED_DIM));
}

export function makeEmbed(): Embed {
  return async ({ values, taskType }) => {
    const input = truncatePayload(values).map((v) => formatForTask(v, taskType));
    return PROVIDER === "openai" ? embedOpenAI(input) : embedLocal(input);
  };
}

export async function prewarmEmbed(embed: Embed): Promise<void> {
  if (PROVIDER === "openai") return;
  if (process.env.EUNOIA_SKIP_EMBEDDING_PREWARM === "1" || process.env.EUNOIA_SKIP_EMBEDDING_PREWARM === "true") {
    console.log("[embeddings] skipping local embedding model prewarm");
    return;
  }
  console.log(`[embeddings] prewarming ${LOCAL_MODEL} (dtype=${LOCAL_DTYPE}, pooling=${profile.pooling}, dim=${EMBED_DIM})...`);
  const t = Date.now();
  await embed({ values: ["warmup"], taskType: "RETRIEVAL_DOCUMENT" });
  console.log(`[embeddings] ready in ${Date.now() - t}ms`);
}
