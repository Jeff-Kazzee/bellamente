// embed.ts - the single embedding singleton (Spec 02).
// Default provider = "local": Qwen3-Embedding-0.6B via transformers.js (in-process, no server,
// no cloud). Instruction-aware + Matryoshka, truncated to EMBED_DIM (768) so the schema is
// unchanged. Provider "openai" remains as a dev fallback.
export type TaskType = "QUESTION_ANSWERING" | "RETRIEVAL_QUERY" | "RETRIEVAL_DOCUMENT";
export const EMBED_DIM = Number(process.env.EMBED_DIM ?? 768);
const MAX_PAYLOAD_CHARS = 36000;

const PROVIDER = process.env.EMBEDDING_PROVIDER ?? "local";
const LOCAL_MODEL = process.env.LOCAL_EMBED_MODEL ?? "onnx-community/Qwen3-Embedding-0.6B-ONNX";
const LOCAL_DTYPE = (process.env.LOCAL_EMBED_DTYPE ?? "q8") as "fp32" | "fp16" | "q8";
// Qwen3 retrieval instruction (queries only). Documents are embedded raw.
const QUERY_INSTRUCTION =
  process.env.EMBED_QUERY_INSTRUCTION ??
  "Given a search query, retrieve relevant memories and passages that answer the query";

export type Embed = (args: { values: string[]; taskType: TaskType }) => Promise<number[][]>;

export function embedModelName(): string {
  return PROVIDER === "openai"
    ? (process.env.OPENAI_EMBED_MODEL ?? "text-embedding-3-small")
    : LOCAL_MODEL;
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

// Qwen3 query format. Documents get no instruction (improves asymmetric retrieval).
function formatForTask(text: string, taskType: TaskType): string {
  if (taskType === "RETRIEVAL_DOCUMENT") return text;
  return `Instruct: ${QUERY_INSTRUCTION}\nQuery:${text}`;
}

// Matryoshka: slice to dim, then L2-normalize.
function mrl(vec: number[], dim: number): number[] {
  const slice = vec.length > dim ? vec.slice(0, dim) : vec;
  let n = 0;
  for (const x of slice) n += x * x;
  n = Math.sqrt(n) || 1;
  return slice.map((x) => x / n);
}

// Lazy, cached transformers.js pipeline (prewarmed at boot).
let pipePromise: Promise<(input: string[], opts: any) => Promise<{ tolist: () => number[][] }>> | null = null;
async function getLocalPipe() {
  if (!pipePromise) {
    pipePromise = (async () => {
      const { pipeline } = await import("@huggingface/transformers");
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
    body: JSON.stringify({
      model: process.env.OPENAI_EMBED_MODEL ?? "text-embedding-3-small",
      input,
      dimensions: EMBED_DIM,
    }),
  });
  if (!res.ok) throw new Error(`OpenAI embeddings HTTP ${res.status}: ${await res.text()}`);
  const json = (await res.json()) as { data: { index: number; embedding: number[] }[] };
  return json.data.slice().sort((a, b) => a.index - b.index).map((d) => d.embedding);
}

async function embedLocal(input: string[]): Promise<number[][]> {
  const pipe = await getLocalPipe();
  const out = await pipe(input, { pooling: "last_token", normalize: false });
  return out.tolist().map((v) => mrl(v, EMBED_DIM));
}

export function makeEmbed(): Embed {
  return async ({ values, taskType }) => {
    const input = truncatePayload(values).map((v) => formatForTask(v, taskType));
    return PROVIDER === "openai" ? embedOpenAI(input) : embedLocal(input);
  };
}

// Prewarm the local model at boot (Spec 02). No-op for openai / when skipped.
export async function prewarmEmbed(embed: Embed): Promise<void> {
  if (PROVIDER === "openai") return;
  if (process.env.MINIMEM_SKIP_EMBEDDING_PREWARM === "1" || process.env.MINIMEM_SKIP_EMBEDDING_PREWARM === "true") {
    console.log("[embeddings] skipping local embedding model prewarm");
    return;
  }
  console.log(`[embeddings] prewarming ${LOCAL_MODEL} (dtype=${LOCAL_DTYPE}, dim=${EMBED_DIM})...`);
  const t = Date.now();
  await embed({ values: ["warmup"], taskType: "RETRIEVAL_DOCUMENT" });
  console.log(`[embeddings] ready in ${Date.now() - t}ms`);
}
