// scripts/eval.ts - offline A/B evaluation harness for LOCAL embedding models.
// Pure + in-process: embeds a small labeled set, computes cosine retrieval metrics.
// No DB, no server, no cloud. Every model compared here is Apache-2.0 / MIT licensed.
//
// Run:  bun run bench         (or: bun run scripts/eval.ts)
// Add models: uncomment / extend PROFILES below.
import { pipeline } from "@huggingface/transformers";

type Pooling = "last_token" | "mean" | "cls";
type Profile = {
  name: string;
  modelId: string;
  dtype: "fp32" | "fp16" | "q8" | "q4";
  pooling: Pooling;
  dim: number; // Matryoshka target dim
  queryPrompt: (t: string) => string;
  docPrompt: (t: string) => string;
};

// --- prompt helpers --------------------------------------------------------
const QWEN_INSTRUCTION =
  "Given a search query, retrieve relevant memories and passages that answer the query";
const qwenQuery = (t: string) => `Instruct: ${QWEN_INSTRUCTION}\nQuery:${t}`;
const raw = (t: string) => t;

// --- models to compare (all Apache-2.0 / MIT) ------------------------------
// Defaults run on the already-cached Qwen3-0.6B at two dims (no new download).
const PROFILES: Profile[] = [
  { name: "Qwen3-0.6B q8 d768", modelId: "onnx-community/Qwen3-Embedding-0.6B-ONNX", dtype: "q8", pooling: "last_token", dim: 768, queryPrompt: qwenQuery, docPrompt: raw },
  { name: "Qwen3-0.6B q8 d256", modelId: "onnx-community/Qwen3-Embedding-0.6B-ONNX", dtype: "q8", pooling: "last_token", dim: 256, queryPrompt: qwenQuery, docPrompt: raw },
  // ---- opt-in (uncomment; downloads weights on first run) ----
  // { name: "Qwen3-4B q8 d768",  modelId: "onnx-community/Qwen3-Embedding-4B-ONNX", dtype: "q8", pooling: "last_token", dim: 768, queryPrompt: qwenQuery, docPrompt: raw },
  // nomic-embed-text-v2 (Apache-2.0): mean pooling + search_query/search_document prefixes
  // { name: "nomic-v2 d768", modelId: "onnx-community/nomic-embed-text-v2-moe-ONNX", dtype: "q8", pooling: "mean", dim: 768, queryPrompt: (t)=>`search_query: ${t}`, docPrompt: (t)=>`search_document: ${t}` },
];

// --- labeled eval set (personal-memory style) ------------------------------
const MEMORIES: { id: string; text: string }[] = [
  { id: "m1", text: "John prefers dark mode in his editor" },
  { id: "m2", text: "John lives in Boston and bikes to work" },
  { id: "m3", text: "John is allergic to peanuts" },
  { id: "m4", text: "John's favorite programming language is Rust" },
  { id: "m5", text: "John has a standup meeting with Sarah every Monday at 10am" },
  { id: "m6", text: "The capital of France is Paris" },
  { id: "m7", text: "John drinks oat milk in his coffee" },
  { id: "m8", text: "John's daughter is named Emma" },
  { id: "m9", text: "John uses a mechanical keyboard with brown switches" },
  { id: "m10", text: "John's car is a blue Tesla Model 3" },
];
const QUERIES: { q: string; gold: string }[] = [
  { q: "what color theme does John use", gold: "m1" },
  { q: "how does John get to work", gold: "m2" },
  { q: "what food should I avoid serving John", gold: "m3" },
  { q: "which language does John like coding in", gold: "m4" },
  { q: "when is John's weekly sync with Sarah", gold: "m5" },
  { q: "what does John put in his coffee", gold: "m7" },
  { q: "what is the name of John's kid", gold: "m8" },
  { q: "what keyboard does John type on", gold: "m9" },
  { q: "what kind of car does John drive", gold: "m10" },
];

// --- engine ----------------------------------------------------------------
const cache = new Map<string, Promise<any>>();
function getPipe(p: Profile): Promise<any> {
  const key = `${p.modelId}:${p.dtype}`;
  let pr = cache.get(key);
  if (!pr) { pr = pipeline("feature-extraction", p.modelId, { dtype: p.dtype }) as any; cache.set(key, pr); }
  return pr;
}

function mrl(v: number[], dim: number): number[] {
  const s = v.length > dim ? v.slice(0, dim) : v;
  let n = 0;
  for (const x of s) n += x * x;
  n = Math.sqrt(n) || 1;
  return s.map((x) => x / n);
}
const cos = (a: number[], b: number[]): number => {
  let d = 0;
  for (let i = 0; i < a.length; i++) d += (a[i] as number) * (b[i] as number);
  return d; // inputs are L2-normalized -> dot product == cosine
};

async function embedBatch(p: Profile, texts: string[]): Promise<{ vecs: number[][]; ms: number }> {
  const pipe = await getPipe(p);
  const t0 = performance.now();
  const out = await pipe(texts, { pooling: p.pooling, normalize: false });
  const ms = performance.now() - t0;
  const vecs = (out.tolist() as number[][]).map((v) => mrl(v, p.dim));
  return { vecs, ms };
}

async function evalProfile(p: Profile) {
  const docs = await embedBatch(p, MEMORIES.map((m) => p.docPrompt(m.text)));
  const qs = await embedBatch(p, QUERIES.map((q) => p.queryPrompt(q.q)));
  let r1 = 0, r3 = 0, mrrSum = 0;
  QUERIES.forEach((query, qi) => {
    const ranked = MEMORIES
      .map((m, mi) => ({ id: m.id, s: cos(qs.vecs[qi] as number[], docs.vecs[mi] as number[]) }))
      .sort((a, b) => b.s - a.s);
    const rank = ranked.findIndex((x) => x.id === query.gold) + 1;
    if (rank === 1) r1++;
    if (rank >= 1 && rank <= 3) r3++;
    if (rank >= 1) mrrSum += 1 / rank;
  });
  const n = QUERIES.length;
  const msPer = (docs.ms + qs.ms) / (MEMORIES.length + QUERIES.length);
  return { name: p.name, dim: p.dim, r1: r1 / n, r3: r3 / n, mrr: mrrSum / n, msPer };
}

const rows: Awaited<ReturnType<typeof evalProfile>>[] = [];
console.log(`Eval set: ${MEMORIES.length} memories, ${QUERIES.length} queries\n`);
for (const p of PROFILES) {
  process.stdout.write(`Running ${p.name} ... `);
  rows.push(await evalProfile(p));
  console.log("done");
}
console.log("\n| Profile | dim | Recall@1 | Recall@3 | MRR | ms/embed |");
console.log("|---|---:|---:|---:|---:|---:|");
for (const r of rows) {
  console.log(`| ${r.name} | ${r.dim} | ${(r.r1 * 100).toFixed(1)}% | ${(r.r3 * 100).toFixed(1)}% | ${r.mrr.toFixed(3)} | ${r.msPer.toFixed(1)} |`);
}
console.log("\nRecall@1 = right memory ranked #1. MRR = mean reciprocal rank. ms/embed = CPU latency.");
