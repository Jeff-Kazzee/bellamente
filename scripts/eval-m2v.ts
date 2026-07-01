// scripts/eval-m2v.ts - Phase B quality gate: Model2Vec ("potion") static models vs the e5-small baseline
// on the labeled memory set (EN + cross-lingual retrieval). Pure + in-process, no DB/cloud.
//   run: bun run scripts/eval-m2v.ts
import { pipeline, AutoTokenizer, env } from "@huggingface/transformers";
import { join } from "node:path";
import { statSync, renameSync } from "node:fs";
import { homedir } from "node:os";

const CACHE = join(process.env.LOCALAPPDATA ?? join(homedir(), ".cache"), "Eunoia", "Cache", "models");
(env as any).cacheDir = CACHE;

// ---- labeled set (mirrors scripts/eval.ts) ----
const MEMORIES = [
  ["m1", "John prefers dark mode in his code editor and dims his screen at night."],
  ["m2", "John lives in the Back Bay neighborhood of Boston and bikes to work most days."],
  ["m3", "John is severely allergic to peanuts and carries an EpiPen."],
  ["m4", "John's favorite programming language is Rust, though he writes Python at work."],
  ["m5", "John has a standup meeting with Sarah and the platform team every Monday at 10am."],
  ["m6", "John drinks oat milk lattes and avoids dairy."],
  ["m7", "John's daughter Emma is six years old and just started first grade."],
  ["m8", "John uses a split mechanical keyboard with brown switches and a trackball mouse."],
  ["m9", "John drives a blue Tesla Model 3 and charges it at home overnight."],
  ["m10", "John is learning to play the cello and practices on weekends."],
  ["m11", "John's manager is Priya, and his skip-level is the VP of Engineering, Dale."],
  ["m12", "John prefers async communication and finds back-to-back meetings draining."],
  ["ml1", "A Maria le encanta el cafe con leche de avena por las mananas."],
  ["ml2", "Pierre travaille comme ingenieur logiciel a Paris."],
  ["ml3", "Hans faehrt jeden Tag mit dem Fahrrad zur Arbeit."],
] as const;
const EN = [
  ["what theme does John use when coding", "m1"], ["how does John usually get to the office", "m2"],
  ["what food allergy should I be careful about with John", "m3"], ["which language does John actually enjoy programming in", "m4"],
  ["when is John's weekly team standup", "m5"], ["what does John drink instead of regular milk", "m6"],
  ["how old is John's kid", "m7"], ["what kind of keyboard does John type on", "m8"],
  ["what car does John own", "m9"], ["what hobby is John picking up", "m10"],
  ["who does John report to", "m11"], ["how does John feel about lots of meetings", "m12"],
] as const;
const ML = [
  ["que bebida le gusta a Maria", "ml1"], ["quel est le metier de Pierre", "ml2"], ["wie kommt Hans zur Arbeit", "ml3"],
] as const;

const cos = (a: number[], b: number[]) => { let d = 0; for (let i = 0; i < a.length; i++) d += a[i]! * b[i]!; return d; };
function score(qv: number[][], queries: readonly (readonly [string, string])[], dv: number[][]) {
  let r1 = 0, mrr = 0;
  queries.forEach(([, gold], qi) => {
    const ranked = MEMORIES.map(([id], mi) => ({ id, s: cos(qv[qi]!, dv[mi]!) })).sort((a, b) => b.s - a.s);
    const rank = ranked.findIndex((x) => x.id === gold) + 1;
    if (rank === 1) r1++;
    mrr += 1 / rank;
  });
  return { r1: r1 / queries.length, mrr: mrr / queries.length };
}

// ---- static Model2Vec embedder (mirrors src/embed-model2vec.ts, F32 for eval) ----
async function ensureST(model: string): Promise<string> {
  const dest = join(CACHE, ...model.split("/"), "model.safetensors");
  try { if (statSync(dest).size > 0) return dest; } catch {}
  const res = await fetch(`https://huggingface.co/${model}/resolve/main/model.safetensors`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const tmp = dest + ".part";
  await Bun.write(tmp, res);
  renameSync(tmp, dest);
  return dest;
}
async function makeStatic(model: string): Promise<(texts: string[]) => Promise<number[][]>> {
  const buf = new Uint8Array(await Bun.file(await ensureST(model)).arrayBuffer());
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const hLen = Number(dv.getBigUint64(0, true));
  const header = JSON.parse(new TextDecoder().decode(buf.subarray(8, 8 + hLen)));
  const name = Object.keys(header).find((k) => k !== "__metadata__" && header[k].shape?.length === 2)!;
  const [V, D] = header[name].shape as number[];
  const [s, e] = header[name].data_offsets as number[];
  const mat = new Float32Array(buf.subarray(8 + hLen + s, 8 + hLen + e).slice().buffer, 0, V! * D!);
  const tok = await AutoTokenizer.from_pretrained(model);
  return async (texts) => {
    const res: number[][] = [];
    for (const text of texts) {
      const enc = await tok(text, { add_special_tokens: false, truncation: true, max_length: 512 });
      const ids = Array.from(enc.input_ids.data as ArrayLike<any>, Number);
      const out = new Float32Array(D!);
      let c = 0;
      for (const id of ids) {
        if (id < 0 || id >= V!) continue;
        c++; for (let j = 0; j < D!; j++) out[j] += mat[id * D! + j]!;
      }
      if (c) for (let j = 0; j < D!; j++) out[j] /= c;
      let nrm = 0; for (let j = 0; j < D!; j++) nrm += out[j]! * out[j]!; nrm = Math.sqrt(nrm) + 1e-32;
      res.push(Array.from(out, (x) => x / nrm));
    }
    return res;
  };
}
// ---- e5 (transformer) baseline ----
function l2(v: number[]) { let n = 0; for (const x of v) n += x * x; n = Math.sqrt(n) || 1; return v.map((x) => x / n); }
async function makeE5(): Promise<(texts: string[], isQuery: boolean) => Promise<number[][]>> {
  const pipe = await pipeline("feature-extraction", "Xenova/multilingual-e5-small", { dtype: "q8" });
  return async (texts, isQuery) => {
    const out = await pipe(texts.map((t) => (isQuery ? `query: ${t}` : `passage: ${t}`)), { pooling: "mean", normalize: false });
    return (out.tolist() as number[][]).map(l2);
  };
}

type Row = { name: string; dim: number; enR1: number; enMrr: number; mlR1: number; mlMrr: number };
const rows: Row[] = [];
async function run(name: string, dim: number, embed: (t: string[], q: boolean) => Promise<number[][]>) {
  process.stdout.write(`Running ${name} ... `);
  const dv = await embed(MEMORIES.map(([, t]) => t), false);
  const enq = await embed(EN.map(([q]) => q), true);
  const mlq = await embed(ML.map(([q]) => q), true);
  const en = score(enq, EN, dv), ml = score(mlq, ML, dv);
  rows.push({ name, dim, enR1: en.r1, enMrr: en.mrr, mlR1: ml.r1, mlMrr: ml.mrr });
  console.log("done");
}

const e5 = await makeE5();
await run("multilingual-e5-small (q8)", 384, (t, q) => e5(t, q));
const ret = await makeStatic("minishlab/potion-retrieval-32M");
await run("potion-retrieval-32M", 512, (t) => ret(t));
const mul = await makeStatic("minishlab/potion-multilingual-128M");
await run("potion-multilingual-128M", 256, (t) => mul(t));

console.log(`\nEN: ${EN.length} queries | ML(es/fr/de): ${ML.length} | ${MEMORIES.length} memories\n`);
console.log("| Model | dim | EN R@1 | EN MRR | ML R@1 | ML MRR |");
console.log("|---|---:|---:|---:|---:|---:|");
for (const r of rows) console.log(`| ${r.name} | ${r.dim} | ${(r.enR1 * 100).toFixed(0)}% | ${r.enMrr.toFixed(3)} | ${(r.mlR1 * 100).toFixed(0)}% | ${r.mlMrr.toFixed(3)} |`);
