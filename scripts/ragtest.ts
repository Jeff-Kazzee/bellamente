// scripts/ragtest.ts - real RAG over selected local markdown docs.
// Chunk -> embed (local model) -> store in pgvector -> query. No extra LLM. Reports
// chunk-quality stats + retrieval results so we can be critical about both.
import { readdirSync, readFileSync } from "node:fs";
import { join, basename } from "node:path";
import { makeDb } from "../src/db";
import { makeEmbed } from "../src/embed";
import { chunkMarkdown } from "../src/chunk";
import { ingestDocument } from "../src/documents";
import { searchChunks } from "../src/search";

const DOC_DIRS = (process.env.EUNOIA_RAGTEST_DIRS?.split(";").filter(Boolean) ?? [
  "C:/Users/jeffk/dev/The Little AI Co Projects/eunoia/docs",
]);
const TAG = "docs";

function gatherFiles() {
  const files: { path: string; title: string; content: string }[] = [];
  for (const dir of DOC_DIRS) {
    for (const f of readdirSync(dir)) {
      if (!f.toLowerCase().endsWith(".md")) continue;
      const path = join(dir, f);
      files.push({ path, title: `${basename(dir)}/${f}`, content: readFileSync(path, "utf8") });
    }
  }
  return files;
}

function pct(arr: number[], p: number) {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] ?? 0;
}

const sql = await makeDb();
const embed = makeEmbed();
const ctx = { sql, embed };

// wipe prior run
await sql`DELETE FROM chunk`;
await sql`DELETE FROM document`;

const files = gatherFiles();
console.log(`\n=== CHUNK QUALITY (maxChars=1075, overlap=150) ===`);
const allLens: number[] = [];
const flagTotals: Record<string, number> = {};
const worst: { len: number; title: string; head: string; preview: string }[] = [];
for (const f of files) {
  const chunks = chunkMarkdown(f.content);
  for (const c of chunks) {
    allLens.push(c.charLen);
    for (const fl of c.flags) flagTotals[fl] = (flagTotals[fl] ?? 0) + 1;
    worst.push({ len: c.charLen, title: f.title, head: c.headingPath, preview: c.content.slice(0, 90).replace(/\n/g, " ") });
  }
  console.log(`  ${f.title.padEnd(32)} ${String(f.content.length).padStart(6)} chars -> ${String(chunks.length).padStart(3)} chunks`);
}
console.log(`\nchunks=${allLens.length}  char len: min=${Math.min(...allLens)} p50=${pct(allLens,50)} p90=${pct(allLens,90)} max=${Math.max(...allLens)} mean=${Math.round(allLens.reduce((a,b)=>a+b,0)/allLens.length)}`);
console.log("flags:", flagTotals);
console.log("largest 5 chunks:");
worst.sort((a, b) => b.len - a.len).slice(0, 5).forEach((w) => console.log(`  ${String(w.len).padStart(5)}  ${w.title} :: ${w.head.slice(0, 40)}`));

// ingest
console.log(`\n=== INGESTING (${files.length} docs) ===`);
for (const f of files) {
  const r = await ingestDocument(ctx, { title: f.title, content: f.content, filepath: f.path, containerTag: TAG });
  console.log(`  ${f.title.padEnd(32)} doc=${r.documentId} chunks=${r.chunkCount}`);
}

// query
const QUERIES = [
  "What is the default similarity threshold for vector search?",
  "What embedding vector dimensions are used?",
  "How are memories versioned when they are updated?",
  "What is the default chunk size in characters?",
  "How does the memory tool injection proxy work?",
  "What pooling method does the default embedding model use?",
  "How do you create a memory directly bypassing the ingestion workflow?",
  "What pgvector operator is used for cosine distance?",
];
console.log(`\n=== RETRIEVAL (searchChunks, top 3, threshold 0.4) ===`);
for (const q of QUERIES) {
  const res = await searchChunks(ctx, { q, containerTag: TAG, limit: 3 });
  console.log(`\nQ: ${q}`);
  if (res.length === 0) console.log("   (no hits >= 0.4)");
  res.forEach((r, i) => {
    const snip = r.content.replace(/\s+/g, " ").slice(0, 130);
    console.log(`  ${i + 1}. ${r.similarity.toFixed(3)} [${r.title} :: ${(r.headingPath ?? "").slice(0, 36)}]`);
    console.log(`       ${snip}`);
  });
}

await sql.end();
console.log("\nDONE");
