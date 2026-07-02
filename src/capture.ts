// capture.ts - proxy auto-capture (v1, heuristic): remember durable facts FROM conversations, with
// the trust guarantees this product is built on. No SDK, no cloud, no LLM call — the capture loop
// never leaves the machine.
//
// Design decisions (deliberate, see docs/BACKLOG.md P1.6):
//  - Heuristic v1: only the LAST user message of an answered turn; sentence-split; keep short
//    declarative first-person statements (preferences, identity, standing instructions). Questions
//    never match. Cap 3 per turn. An LLM distillation pass (through the same LOCAL upstream) is v2.
//  - Everything captured goes through writeMemories() — the same dedup/supersede path as manual
//    writes, so repeating yourself reinforces (source_count) instead of duplicating.
//  - VISIBILITY is the differentiator: every capture records its own `capture` trace (linked to the
//    proxy trace) showing exactly what was remembered and why; rows carry is_inference=true and
//    metadata.source="proxy_capture", so captured memories are distinguishable and reversible
//    (forget/delete) like everything else.
//  - Fire-and-forget from the proxy: capture NEVER delays or breaks the chat turn. Errors land in
//    an error-status capture trace, not in the response.
//  - ON by default (this is the product working out of the box); BELLA_PROXY_CAPTURE=0 disables.
import type { DB } from "./db";
import type { Embed } from "./embed";
import { writeMemories } from "./memories";
import { recordTraceSafe, traceTextItem } from "./inspect";
import { brandEnv } from "./env";

type Ctx = { sql: DB; embed: Embed };

export function captureEnabled(): boolean {
  const v = brandEnv("PROXY_CAPTURE");
  return !(v === "0" || v === "false");
}

// Declarative, first-person, durable-sounding openers. Anchored at sentence start; questions are
// rejected outright. Deliberately conservative — a missed fact costs little (say it again, or add
// it via the dashboard); a junk fact costs trust.
const FACT_OPENERS: RegExp[] = [
  /^i(?:'m| am| was)\b/i,
  /^i (?:prefer|like|love|hate|enjoy|use|need|want|live|work|drink|eat|speak|always|never|usually|don'?t|do not|can'?t|cannot)\b/i,
  /^my [a-z][\w' -]{0,40} (?:is|are|was)\b/i,
  /^call me\b/i,
  /^please (?:always|never)\b/i,
  /^remember (?:that )?/i,
];

// Sensitive-content EXCLUSION (privacy review finding): a candidate that looks like a credential,
// financial/government identifier, or an explicit medical disclosure is dropped outright — never
// stored, never embedded, never traced as a memory. Over-blocking is the right v1 bias: a user who
// WANTS such a fact remembered can add it deliberately via the dashboard or POST /memories.
const SENSITIVE_RE =
  /\b(password|passwd|passphrase|token|api[ _-]?key|secret|private key|credentials?|ssn|social security|credit card|card number|cvv|cvc|pin (?:is|code|number)|bank account|routing number|iban|swift|passport|driver'?s licen[cs]e|licen[cs]e number|diagnos(?:is|ed)|hiv|cancer|std|pregnan\w*|depress\w*|anxiet\w*|suicid\w*|medication|prescri\w*)\b/i;

/** Extract up to `cap` candidate facts from one message's text. Exported for direct unit testing. */
export function extractCandidateFacts(text: string, cap = 3): string[] {
  const sentences = text
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const out: string[] = [];
  for (const s of sentences) {
    if (out.length >= cap) break;
    if (s.length < 8 || s.length > 300) continue;
    if (s.endsWith("?")) continue;
    if (SENSITIVE_RE.test(s)) continue;
    if (!FACT_OPENERS.some((re) => re.test(s))) continue;
    out.push(s.replace(/^remember (that )?/i, "").trim());
  }
  return out;
}

function lastUserText(messages: any[]): string {
  const last = [...(messages ?? [])].reverse().find((m) => m?.role === "user");
  const content = last?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => (typeof p === "string" ? p : p && typeof p === "object" && "text" in p ? String(p.text ?? "") : ""))
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

/** Capture facts from an answered proxy turn. Fire-and-forget: never throws, never blocks the turn. */
export async function captureFromTurn(
  ctx: Ctx,
  args: { messages: any[]; containerTag: string; userId?: string; proxyTraceId: string },
): Promise<void> {
  if (!captureEnabled()) return;
  const text = lastUserText(args.messages);
  if (!text) return;
  const facts = extractCandidateFacts(text);
  if (!facts.length) return;
  const started = Date.now();
  try {
    const { results } = await writeMemories(ctx, {
      containerTag: args.containerTag,
      dedupe: true,
      documentSource: "proxy_capture",
      documentTitle: `Captured from chat (${facts.length})`,
      items: facts.map((f) => ({
        content: f,
        isInference: true,
        metadata: { source: "proxy_capture", proxyTraceId: args.proxyTraceId },
      })),
    });
    const items = results.map((r) => traceTextItem("memory", r.content, { id: r.id, action: r.action }));
    await recordTraceSafe(ctx.sql, {
      kind: "capture",
      status: "ok",
      userId: args.userId,
      containerTag: args.containerTag,
      query: text,
      resultCount: results.length,
      injectedCount: 0,
      latencyMs: Date.now() - started,
      retrieved: items,
      metadata: { proxyTraceId: args.proxyTraceId, actions: results.map((r) => r.action) },
    });
  } catch (e) {
    await recordTraceSafe(ctx.sql, {
      kind: "capture",
      status: "error",
      userId: args.userId,
      containerTag: args.containerTag,
      query: text,
      latencyMs: Date.now() - started,
      metadata: { proxyTraceId: args.proxyTraceId, error: e instanceof Error ? e.message : String(e) },
    });
  }
}
