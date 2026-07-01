// chunk.ts - markdown-aware chunker. Char-based, default ~1075, with overlap and
// heading breadcrumbs.
//
// Design goals (and where it is deliberately strict):
//  - Keep fenced code blocks and markdown tables ATOMIC when they fit; only force-split
//    them when a single block exceeds maxChars (flagged so we can see the damage).
//  - Track the heading hierarchy and prepend a breadcrumb to the EMBEDDED text (not the
//    displayed text) - improves retrieval of section-scoped facts.
//  - Add sentence/line-boundary overlap between adjacent chunks in the same section.
export type Chunk = {
  content: string;        // raw text shown to the user
  embeddedContent: string; // breadcrumb + content; this is what gets embedded
  position: number;
  headingPath: string;
  charLen: number;
  flags: string[];        // quality flags for critique
};

export type ChunkOptions = { maxChars?: number; overlapChars?: number; minChars?: number; tokenBudget?: number };
const DEFAULTS = { maxChars: 1075, overlapChars: 150, minChars: 64, tokenBudget: 480 };

// The embedders truncate at 512 TOKENS (embed-wasm/embed-model2vec max_length), but sizing here is
// char-based — token-dense content (CJK ~1 token/char vs English ~1 token/4 chars) could fit maxChars
// yet blow the token limit and get SILENTLY truncated at embed time. Guard with a conservative
// estimate: CJK-range code points count as 1 token each, everything else at 3 chars/token (English is
// really ~4 — overestimating is the safe direction). Budget 480 leaves margin for the model's
// query/passage prefix and special tokens.
export const EMBED_TOKEN_BUDGET = DEFAULTS.tokenBudget;
// Ranges (raw chars; BMP only): U+1100-11FF Hangul Jamo, U+2E80-A4CF CJK radicals..Yi (includes
// Unified Ideographs + kana), U+A840-A87F Phags-pa, U+AC00-D7AF Hangul syllables, U+F900-FAFF and
// U+FE30-FE4F compatibility ideographs/forms, U+FF65-FFDC halfwidth katakana + Jamo.
const CJK_RE =
  /[ᄀ-ᇿ⺀-꓏ꡀ-꡿가-힯豈-﫿︰-﹏･-ￜ]/;
export function estimateTokens(s: string): number {
  let cjk = 0;
  for (const ch of s) if (CJK_RE.test(ch)) cjk++;
  const rest = s.length - cjk;
  return cjk + Math.ceil(rest / 3);
}

// Split text into pieces whose token ESTIMATE fits the budget: line/sentence boundaries first, then a
// guaranteed-terminating binary hard cut for any single oversized unit.
function splitByTokenBudget(text: string, budget: number): string[] {
  const hardCut = (u: string): string[] => {
    if (estimateTokens(u) <= budget) return [u];
    const mid = Math.ceil(u.length / 2);
    return [...hardCut(u.slice(0, mid)), ...hardCut(u.slice(mid))];
  };
  const units = text.includes("\n") ? text.split("\n").map((l) => l + "\n") : splitSentences(text);
  const out: string[] = [];
  let cur = "";
  for (const u of units) {
    if (estimateTokens(u) > budget) {
      if (cur.trim()) out.push(cur.trimEnd());
      cur = "";
      out.push(...hardCut(u).map((p) => p.trimEnd()).filter(Boolean));
      continue;
    }
    if (cur && estimateTokens(cur + u) > budget) {
      out.push(cur.trimEnd());
      cur = "";
    }
    cur += u;
  }
  if (cur.trim()) out.push(cur.trimEnd());
  return out;
}

type Block = { type: "heading" | "code" | "table" | "para"; text: string; level: number };

function parseBlocks(md: string): Block[] {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    // fenced code block
    const fence = line.match(/^\s*(```|~~~)/);
    if (fence) {
      const tag = fence[1]!;
      const buf = [line];
      i++;
      while (i < lines.length && !lines[i]!.trim().startsWith(tag)) buf.push(lines[i++]!);
      if (i < lines.length) buf.push(lines[i++]!); // closing fence
      blocks.push({ type: "code", text: buf.join("\n"), level: 0 });
      continue;
    }
    // heading
    const h = line.match(/^(#{1,6})\s+\S/);
    if (h) { blocks.push({ type: "heading", text: line.trim(), level: h[1]!.length }); i++; continue; }
    // table (contiguous run of pipe lines)
    if (line.trim().startsWith("|")) {
      const buf: string[] = [];
      while (i < lines.length && lines[i]!.trim().startsWith("|")) buf.push(lines[i++]!);
      blocks.push({ type: "table", text: buf.join("\n"), level: 0 });
      continue;
    }
    // blank
    if (line.trim() === "") { i++; continue; }
    // paragraph / list: accumulate until blank or a structural line
    const buf: string[] = [];
    while (
      i < lines.length &&
      lines[i]!.trim() !== "" &&
      !lines[i]!.match(/^\s*(```|~~~)/) &&
      !lines[i]!.match(/^(#{1,6})\s+\S/) &&
      !lines[i]!.trim().startsWith("|")
    ) buf.push(lines[i++]!);
    blocks.push({ type: "para", text: buf.join("\n"), level: 0 });
  }
  return blocks;
}

function splitSentences(s: string): string[] {
  return s.match(/[^.!?]+[.!?]+(?:\s|$)|[^.!?]+$/g) ?? [s];
}

// Force-split a block that is itself larger than maxChars. Returns [text, flag].
function forceSplit(block: Block, maxChars: number): { text: string; flag: string }[] {
  const out: { text: string; flag: string }[] = [];
  const flag = block.type === "code" ? "force-split-code" : block.type === "table" ? "force-split-table" : "force-split-para";
  const units = block.type === "para" ? splitSentences(block.text) : block.text.split("\n").map((l) => l + "\n");
  let cur = "";
  for (const u of units) {
    if (cur && cur.length + u.length > maxChars) { out.push({ text: cur.trim(), flag }); cur = ""; }
    if (u.length > maxChars) { // a single unit (e.g. one giant line) still too big -> hard cut
      for (let k = 0; k < u.length; k += maxChars) out.push({ text: u.slice(k, k + maxChars), flag: flag + "+hard-cut" });
    } else cur += u;
  }
  if (cur.trim()) out.push({ text: cur.trim(), flag });
  return out;
}

function tail(s: string, n: number): string {
  if (s.length <= n) return s;
  const t = s.slice(s.length - n);
  const m = t.search(/[.!?]\s|\n/);
  return (m >= 0 ? t.slice(m + 1) : t).trim();
}

export function chunkMarkdown(md: string, opts: ChunkOptions = {}): Chunk[] {
  const maxChars = opts.maxChars ?? DEFAULTS.maxChars;
  const overlapChars = opts.overlapChars ?? DEFAULTS.overlapChars;
  const minChars = opts.minChars ?? DEFAULTS.minChars;
  const tokenBudget = opts.tokenBudget ?? DEFAULTS.tokenBudget;
  const blocks = parseBlocks(md);

  const stack: { level: number; text: string }[] = [];
  const pathOf = () => stack.map((h) => h.text.replace(/^#+\s*/, "")).join(" > ");

  type Raw = { text: string; headingPath: string; flags: string[] };
  const raws: Raw[] = [];
  let cur = "";
  let curPath = "";
  const flush = (flags: string[] = []) => {
    if (cur.trim()) raws.push({ text: cur.trim(), headingPath: curPath, flags });
    cur = "";
  };

  for (const b of blocks) {
    if (b.type === "heading") {
      flush();
      while (stack.length && stack[stack.length - 1]!.level >= b.level) stack.pop();
      stack.push({ level: b.level, text: b.text });
      curPath = pathOf();
      continue;
    }
    curPath = pathOf();
    if (b.text.length > maxChars) {
      flush();
      for (const part of forceSplit(b, maxChars)) raws.push({ text: part.text, headingPath: curPath, flags: [part.flag] });
      continue;
    }
    if (cur && cur.length + b.text.length + 2 > maxChars) flush();
    cur += (cur ? "\n\n" : "") + b.text;
  }
  flush();

  // overlap pass + token-budget pass + assemble (overlap only within the same section)
  const chunks: Chunk[] = [];
  const push = (content: string, headingPath: string, flags: string[]) => {
    if (content.length < minChars) flags.push("tiny");
    if (content.length > maxChars * 1.15) flags.push("oversized");
    if (!/[.!?:)\]`"\n]$/.test(content.trim())) flags.push("mid-sentence");
    const breadcrumb = headingPath ? headingPath + "\n\n" : "";
    chunks.push({
      content,
      embeddedContent: breadcrumb + content,
      position: chunks.length,
      headingPath,
      charLen: content.length,
      flags,
    });
  };
  raws.forEach((r, idx) => {
    let content = r.text;
    const flags = [...r.flags];
    const prev = raws[idx - 1];
    if (prev && prev.headingPath === r.headingPath && overlapChars > 0) {
      const ov = tail(prev.text, overlapChars);
      if (ov) { content = ov + "\n\n" + content; flags.push("overlap"); }
    }
    // Token-budget guard: the EMBEDDED text (breadcrumb + content) must fit the embedder's token limit,
    // or it gets silently truncated at embed time. Char-based sizing already bounds English; this split
    // only fires for token-dense content (CJK, symbol-heavy) — flagged so the damage is visible.
    const breadcrumb = r.headingPath ? r.headingPath + "\n\n" : "";
    const contentBudget = Math.max(tokenBudget - estimateTokens(breadcrumb), 32);
    if (estimateTokens(content) > contentBudget) {
      for (const part of splitByTokenBudget(content, contentBudget)) {
        push(part, r.headingPath, [...flags, "token-split"]);
      }
    } else {
      push(content, r.headingPath, flags);
    }
  });
  return chunks;
}
