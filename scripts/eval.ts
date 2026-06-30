// scripts/eval.ts - A/B evaluation of LOCAL embedding models on a labeled memory set.
// Pure + in-process. No DB, no server, no cloud. All models here are MIT / Apache-2.0.
// Each model carries its own pooling + query/doc prompt format (this matters - getting it
// wrong tanks a model's score). Robust: a model that fails to load is reported and skipped.
import { pipeline } from "@huggingface/transformers";

type Pooling = "last_token" | "mean" | "cls";
type Profile = {
  name: string;
  modelId: string;
  dtype: "fp32" | "fp16" | "q8" | "q4";
  pooling: Pooling;
  dim: number;
  params: string;
  ctx: string;
  license: string;
  queryPrompt: (t: string) => string;
  docPrompt: (t: string) => string;
};

const raw = (t: string) => t;
const PROFILES: Profile[] = [
  // the original Supermemory model (MIT) - baseline
  { name: "bge-base-en-v1.5", modelId: "Xenova/bge-base-en-v1.5", dtype: "q8", pooling: "cls", dim: 768,
    params: "109M", ctx: "512", license: "MIT",
    queryPrompt: (t) => `Represent this sentence for searching relevant passages: ${t}`, docPrompt: raw },
  // long-context (8192) lightweight Apache option - NOT a clone of Supermemory
  { name: "nomic-embed-text-v1.5", modelId: "Xenova/nomic-embed-text-v1.5", dtype: "q8", pooling: "mean", dim: 768,
    params: "137M", ctx: "8192", license: "Apache-2.0",
    queryPrompt: (t) => `search_query: ${t}`, docPrompt: (t) => `search_document: ${t}` },
  // current default - heavier, top quality, multilingual (Apache)
  { name: "Qwen3-Embedding-0.6B", modelId: "onnx-community/Qwen3-Embedding-0.6B-ONNX", dtype: "q8", pooling: "last_token", dim: 768,
    params: "600M", ctx: "32K", license: "Apache-2.0",
    queryPrompt: (t) => `Instruct: Given a search query, retrieve relevant memories and passages that answer the query\nQuery:${t}`, docPrompt: raw },
  // ultralight floor (MIT, 384-dim)
  { name: "bge-small-en-v1.5", modelId: "Xenova/bge-small-en-v1.5", dtype: "q8", pooling: "cls", dim: 384,
    params: "33M", ctx: "512", license: "MIT",
    queryPrompt: (t) => `Represent this sentence for searching relevant passages: ${t}`, docPrompt: raw },
];

const MEMORIES: { id: string; text: string }[] = [
  { id: "m1", text: "John prefers dark mode in his code editor and dims his screen at night." },
  { id: "m2", text: "John lives in the Back Bay neighborhood of Boston and bikes to work most days." },
  { id: "m3", text: "John is severely allergic to peanuts and carries an EpiPen." },
  { id: "m4", text: "John's favorite programming language is Rust, though he writes Python at work." },
  { id: "m5", text: "John has a standup meeting with Sarah and the platform team every Monday at 10am." },
  { id: "m6", text: "John drinks oat milk lattes and avoids dairy." },
  { id: "m7", text: "John's daughter Emma is six years old and just started first grade." },
  { id: "m8", text: "John uses a split mechanical keyboard with brown switches and a trackball mouse." },
  { id: "m9", text: "John drives a blue Tesla Model 3 and charges it at home overnight." },
  { id: "m10", text: "John is learning to play the cello and practices on weekends." },
  { id: "m11", text: "John's manager is Priya, and his skip-level is the VP of Engineering, Dale." },
  { id: "m12", text: "John prefers async communication and finds back-to-back meetings draining." },
  { id: "m13", text: "John's home office faces east and gets bright morning light." },
  { id: "m14", text: "The capital of France is Paris." },
];
const QUERIES: { q: string; gold: string }[] = [
  { q: "what theme does John use when coding", gold: "m1" },
  { q: "how does John usually get to the office", gold: "m2" },
  { q: "what food allergy should I be careful about with John", gold: "m3" },
  { q: "which language does John actually enjoy programming in", gold: "m4" },
  { q: "when is John's weekly team standup", gold: "m5" },
  { q: "what does John drink instead of regular milk", gold: "m6" },
  { q: "how old is John's kid", gold: "m7" },
  { q: "what kind of keyboard does John type on", gold: "m8" },
  { q: "what car does John own", gold: "m9" },
  { q: "what hobby is John picking up", gold: "m10" },
  { q: "who does John report to", gold: "m11" },
  { q: "how does John feel about lots of meetings", gold: "m12" },
];

function mrl(v: number[], dim: number): number[] {
  const s = v.length > dim ? v.slice(0, dim) : v;
  let n = 0; for (const x of s) n += x * x; n = Math.sqrt(n) || 1;
  return s.map((x) => x / n);
}
const cos = (a: number[], b: number[]): number => { let d = 0; for (let i = 0; i < a.length; i++) d += (a[i] as number) * (b[i] as number); return d; };

async function embedBatch(pipe: any, p: Profile, texts: string[]): Promise<{ vecs: number[][]; ms: number }> {
  const t0 = performance.now();
  const out = await pipe(texts, { pooling: p.pooling, normalize: false });
  const ms = performance.now() - t0;
  return { vecs: (out.tolist() as number[][]).map((v) => mrl(v, p.dim)), ms };
}

type Row = { name: string; params: string; dim: number; ctx: string; license: string; r1: number; r3: number; mrr: number; msPer: number };
const rows: Row[] = [];

for (const p of PROFILES) {
  process.stdout.write(`Running ${p.name} (${p.params}, ${p.license}) ... `);
  try {
    const pipe = await pipeline("feature-extraction", p.modelId, { dtype: p.dtype });
    const docs = await embedBatch(pipe, p, MEMORIES.map((m) => p.docPrompt(m.text)));
    const qs = await embedBatch(pipe, p, QUERIES.map((q) => p.queryPrompt(q.q)));
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
    rows.push({ name: p.name, params: p.params, dim: p.dim, ctx: p.ctx, license: p.license,
      r1: r1 / n, r3: r3 / n, mrr: mrrSum / n, msPer: (docs.ms + qs.ms) / (MEMORIES.length + QUERIES.length) });
    console.log("done");
  } catch (e) {
    console.log(`FAILED: ${(e as Error).message.slice(0, 120)}`);
  }
}

console.log(`\nEval set: ${MEMORIES.length} memories, ${QUERIES.length} queries (English, short + multi-sentence)\n`);
console.log("| Model | params | dim | ctx | license | Recall@1 | Recall@3 | MRR | ms/embed |");
console.log("|---|---:|---:|---:|---|---:|---:|---:|---:|");
for (const r of rows.sort((a, b) => b.mrr - a.mrr)) {
  console.log(`| ${r.name} | ${r.params} | ${r.dim} | ${r.ctx} | ${r.license} | ${(r.r1 * 100).toFixed(1)}% | ${(r.r3 * 100).toFixed(1)}% | ${r.mrr.toFixed(3)} | ${r.msPer.toFixed(1)} |`);
}
console.log("\n(sorted by MRR. Recall@1 = right memory ranked #1; ms/embed = CPU latency.)");
