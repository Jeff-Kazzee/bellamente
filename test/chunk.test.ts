// chunk.test.ts - the markdown chunker: token-budget guard (CJK/token-dense content must not exceed
// the embedder's 512-token truncation limit), plus the pre-existing structural behaviors.
import { test, expect } from "bun:test";
import { chunkMarkdown, estimateTokens, EMBED_TOKEN_BUDGET } from "../src/chunk";

test("estimateTokens: ~3 chars/token for ascii, 1 token/char for CJK", () => {
  expect(estimateTokens("hello world")).toBe(Math.ceil(11 / 3));
  const cjk = "안녕하세요세계입니다"; // 10 Hangul syllables -> 10 tokens
  expect(estimateTokens(cjk)).toBe(10);
  const mixed = "abc" + "안녕"; // 1 + 2
  expect(estimateTokens(mixed)).toBe(Math.ceil(3 / 3) + 2);
});

test("English prose within maxChars never trips the token budget", () => {
  const para = ("The quick brown fox jumps over the lazy dog. ").repeat(80); // ~3.6k chars, several chunks
  const chunks = chunkMarkdown("# Title\n\n" + para);
  expect(chunks.length).toBeGreaterThan(1);
  for (const c of chunks) {
    expect(c.flags).not.toContain("token-split");
    expect(estimateTokens(c.embeddedContent)).toBeLessThanOrEqual(EMBED_TOKEN_BUDGET);
  }
});

test("CJK prose is split to fit the embed token budget and flagged", () => {
  // ~3000 Hangul chars in sentences: fits ~1075-char chunks by CHAR count but would be ~1000 TOKENS —
  // silently truncated at embed time before this guard existed.
  const sentence = "메모리 시스템은 사용자가 신뢰할 수 있어야 하고 검사할 수 있어야 한다고 생각합니다. ";
  const doc = "# 소개\n\n" + sentence.repeat(70);
  const chunks = chunkMarkdown(doc);
  expect(chunks.some((c) => c.flags.includes("token-split"))).toBe(true);
  for (const c of chunks) {
    expect(estimateTokens(c.embeddedContent)).toBeLessThanOrEqual(EMBED_TOKEN_BUDGET);
  }
  // positions stay sequential after the split pass
  expect(chunks.map((c) => c.position)).toEqual(chunks.map((_, i) => i));
});

test("a single giant unbreakable CJK line still lands under budget via hard cut", () => {
  const giant = "한".repeat(2000); // no sentence/line boundaries at all
  const chunks = chunkMarkdown(giant);
  expect(chunks.length).toBeGreaterThan(3);
  for (const c of chunks) {
    expect(estimateTokens(c.embeddedContent)).toBeLessThanOrEqual(EMBED_TOKEN_BUDGET);
  }
});

test("a token-heavy giant heading cannot defeat the budget: breadcrumb capped to half, tail kept", () => {
  const giantHeading = "# " + "제목이 아주 긴 한국어 헤딩 ".repeat(40); // heading alone ≈ several hundred tokens
  const doc = giantHeading + "\n\n" + "본문 내용입니다. ".repeat(60);
  const chunks = chunkMarkdown(doc);
  expect(chunks.length).toBeGreaterThan(0);
  for (const c of chunks) {
    expect(estimateTokens(c.embeddedContent)).toBeLessThanOrEqual(EMBED_TOKEN_BUDGET);
  }
  expect(chunks.some((c) => c.flags.includes("breadcrumb-truncated"))).toBe(true);
});

test("hard cuts never split a surrogate pair (astral CJK stays intact)", () => {
  const astral = "𠀀".repeat(1200); // U+20000, surrogate pairs, no line/sentence boundaries
  const chunks = chunkMarkdown(astral);
  expect(chunks.length).toBeGreaterThan(1);
  const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
  for (const c of chunks) {
    expect(loneSurrogate.test(c.content)).toBe(false);
    expect(estimateTokens(c.embeddedContent)).toBeLessThanOrEqual(EMBED_TOKEN_BUDGET);
  }
});

test("junk chunkOptions fall back to defaults instead of disabling splitting", () => {
  const para = ("A sentence that repeats to build a long paragraph. ").repeat(120); // ~6k chars
  const junk = chunkMarkdown(para, { maxChars: "oops" as any, tokenBudget: NaN as any, minChars: -5 as any });
  const sane = chunkMarkdown(para);
  expect(junk.length).toBe(sane.length); // NaN used to make every size comparison false -> one giant chunk
  expect(junk.length).toBeGreaterThan(1);
});

test("structural behavior preserved: code fences stay atomic, breadcrumbs prepended to embedded text", () => {
  const md = "# API\n\n## Auth\n\nUse the bearer token.\n\n```ts\nconst x = 1;\nconst y = 2;\n```\n";
  const chunks = chunkMarkdown(md);
  const withCode = chunks.find((c) => c.content.includes("const x = 1;"));
  expect(withCode).toBeDefined();
  expect(withCode!.content).toContain("```ts"); // fence intact
  expect(withCode!.embeddedContent.startsWith("API > Auth")).toBe(true);
});
