// scripts/eval.ts - A/B of LOCAL embedding models on a labeled memory set.
// Pure + in-process, no DB/server/cloud. All models MIT / Apache-2.0.
// Reports English AND multilingual (cross-lingual) retrieval separately.
import { pipeline } from "@huggingface/transformers";

type Pooling = "last_token" | "mean" | "cls";
type Profile = {
  name: string; modelId: string; dtype: "fp32" | "fp16" | "q8" | "q4";
  pooling: Pooling; dim: number; params: string; ctx: string; license: string; multi: boolean;
  query: (t: string) => string; doc: (t: string) => string;
};
const raw = (t: string) => t;
const PROFILES: Profile[] = [
  { name: "bge-base-en-v1.5", modelId: "Xenova/bge-base-en-v1.5", dtype: "q8", pooling: "cls", dim: 768,
    params: "109M", ctx: "512", license: "MIT", multi: false,
    query: (t) => `Represent this sentence for searching relevant passages: ${t}`, doc: raw },
  { name: "multilingual-e5-small", modelId: "Xenova/multilingual-e5-small", dtype: "q8", pooling: "mean", dim: 384,
    params: "118M", ctx: "512", license: "MIT", multi: true,
    query: (t) => `query: ${t}`, doc: (t) => `passage: ${t}` },
  { name: "multilingual-e5-base", modelId: "Xenova/multilingual-e5-base", dtype: "q8", pooling: "mean", dim: 768,
    params: "278M", ctx: "512", license: "MIT", multi: true,
    query: (t) => `query: ${t}`, doc: (t) => `passage: ${t}` },
  { name: "Qwen3-Embedding-0.6B", modelId: "onnx-community/Qwen3-Embedding-0.6B-ONNX", dtype: "q8", pooling: "last_token", dim: 768,
    params: "600M", ctx: "32K", license: "Apache-2.0", multi: true,
    query: (t) => `Instruct: Given a search query, retrieve relevant memories and passages that answer the query\nQuery:${t}`, doc: raw },
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
  // multilingual memories
  { id: "ml1", text: "A Maria le encanta el cafe con leche de avena por las mananas." },
  { id: "ml2", text: "Pierre travaille comme ingenieur logiciel a Paris." },
  { id: "ml3", text: "Hans faehrt jeden Tag mit dem Fahrrad zur Arbeit." },
];
const EN_QUERIES: { q: string; gold: string }[] = [
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
const ML_QUERIES: { q: string; gold: string }[] = [
  { q: "que bebida le gusta a Maria", gold: "ml1" },
  { q: "quel est le metier de Pierre", gold: "ml2" },
  { q: "wie kommt Hans zur Arbeit", gold: "ml3" },
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
  return { vecs: (out.tolist() as number[][]).map((v) => mrl(v, p.dim)), ms: performance.now() - t0 };
}
function score(qvecs: number[][], queries: { gold: string }[], dvecs: number[][]) {
  let r1 = 0, mrr = 0;
  queries.forEach((query, qi) => {
    const ranked = MEMORIES.map((m, mi) => ({ id: m.id, s: cos(qvecs[qi] as number[], dvecs[mi] as number[]) })).sort((a, b) => b.s - a.s);
    const rank = ranked.findIndex((x) => x.id === query.gold) + 1;
    if (rank === 1) r1++;
    if (rank >= 1) mrr += 1 / rank;
  });
  return { r1: r1 / queries.length, mrr: mrr / queries.length };
}

type Row = { name: string; params: string; dim: number; ctx: string; license: string; multi: boolean; enR1: number; enMrr: number; mlR1: number; mlMrr: number; ms: number };
const rows: Row[] = [];
for (const p of PROFILES) {
  process.stdout.write(`Running ${p.name} ... `);
  try {
    const pipe = await pipeline("feature-extraction", p.modelId, { dtype: p.dtype });
    const docs = await embedBatch(pipe, p, MEMORIES.map((m) => p.doc(m.text)));
    const enq = await embedBatch(pipe, p, EN_QUERIES.map((q) => p.query(q.q)));
    const mlq = await embedBatch(pipe, p, ML_QUERIES.map((q) => p.query(q.q)));
    const en = score(enq.vecs, EN_QUERIES, docs.vecs);
    const ml = score(mlq.vecs, ML_QUERIES, docs.vecs);
    rows.push({ name: p.name, params: p.params, dim: p.dim, ctx: p.ctx, license: p.license, multi: p.multi,
      enR1: en.r1, enMrr: en.mrr, mlR1: ml.r1, mlMrr: ml.mrr, ms: (docs.ms + enq.ms + mlq.ms) / (MEMORIES.length + EN_QUERIES.length + ML_QUERIES.length) });
    console.log("done");
  } catch (e) { console.log(`FAILED: ${(e as Error).message.slice(0, 100)}`); }
}
console.log(`\nEN: ${EN_QUERIES.length} queries  |  ML(es/fr/de): ${ML_QUERIES.length} queries  |  ${MEMORIES.length} memories\n`);
console.log("| Model | params | dim | ctx | license | EN R@1 | EN MRR | ML R@1 | ML MRR | ms/embed |");
console.log("|---|---:|---:|---:|---|---:|---:|---:|---:|---:|");
for (const r of rows.sort((a, b) => b.enMrr - a.enMrr)) {
  console.log(`| ${r.name} | ${r.params} | ${r.dim} | ${r.ctx} | ${r.license} | ${(r.enR1*100).toFixed(0)}% | ${r.enMrr.toFixed(3)} | ${(r.mlR1*100).toFixed(0)}% | ${r.mlMrr.toFixed(3)} | ${r.ms.toFixed(1)} |`);
}
