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

export type ChunkOptions = { maxChars?: number; overlapChars?: number; minChars?: number };
const DEFAULTS = { maxChars: 1075, overlapChars: 150, minChars: 64 };

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

  // overlap pass + assemble (only within the same section)
  const chunks: Chunk[] = [];
  raws.forEach((r, idx) => {
    let content = r.text;
    const flags = [...r.flags];
    const prev = raws[idx - 1];
    if (prev && prev.headingPath === r.headingPath && overlapChars > 0) {
      const ov = tail(prev.text, overlapChars);
      if (ov) { content = ov + "\n\n" + content; flags.push("overlap"); }
    }
    if (content.length < minChars) flags.push("tiny");
    if (content.length > maxChars * 1.15) flags.push("oversized");
    if (!/[.!?:)\]`"\n]$/.test(content.trim())) flags.push("mid-sentence");
    const breadcrumb = r.headingPath ? r.headingPath + "\n\n" : "";
    chunks.push({
      content,
      embeddedContent: breadcrumb + content,
      position: idx,
      headingPath: r.headingPath,
      charLen: content.length,
      flags,
    });
  });
  return chunks;
}
