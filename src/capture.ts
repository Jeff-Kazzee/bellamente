// capture.ts - proxy auto-capture (v2): remember durable facts FROM conversations, with the trust
// guarantees this product is built on. No SDK, no cloud — the capture loop never leaves the machine.
//
// Design decisions (deliberate, see docs/BACKLOG.md P1.6 + HANDOFF-CODEX §BLOCKER 2):
//  - v2 distillation: one extra chat call per answered turn through the SAME local upstream the
//    proxy uses (identical config resolution + ctx.fetch path — src/upstream.ts; never a cloud
//    call), asking for durable facts as a JSON array. Heuristics remain the FALLBACK: any
//    distillation failure (timeout, non-2xx, unparseable) degrades to the v1 extractor, so
//    distillation can never lose a capture the heuristics would have made.
//    BELLA_CAPTURE_DISTILL=0 turns the LLM pass off entirely (heuristics only).
//  - Heuristic extractor (v1, kept): only the LAST user message; sentence-split; short declarative
//    first-person statements. Questions never match. Cap 3/turn (distilled: cap 5/turn).
//  - Everything captured goes through writeMemories() — the same dedup/supersede path as manual
//    writes, so repeating yourself reinforces (source_count) instead of duplicating.
//  - VISIBILITY is the differentiator: every capture records its own `capture` trace (linked to the
//    proxy trace) showing exactly what was remembered and why; rows carry is_inference=true and
//    metadata.source="proxy_capture" (+ metadata.distilled=true when the LLM extracted it), so
//    captured memories are distinguishable and reversible (forget/delete) like everything else.
//    The trace's metadata.distill = { used, latencyMs, error? } shows what the LLM pass did.
//  - SENSITIVE_RE applies to DISTILLED statements too — the model may paraphrase a secret back in.
//  - Fire-and-forget from the proxy: capture NEVER delays or breaks the chat turn. Errors land in
//    an error-status capture trace, not in the response.
//  - ON by default (this is the product working out of the box); BELLA_PROXY_CAPTURE=0 disables.
import type { DB } from "./db";
import type { Embed } from "./embed";
import { writeMemories } from "./memories";
import { recordTraceSafe, traceTextItem } from "./inspect";
import { brandEnv } from "./env";
import { resolveUpstream, upstreamDeadline, upstreamTimeoutMs, forwardUpstream, readUpstreamBody, upstreamErrorMessage, type UpstreamCtx } from "./upstream";

type Ctx = { sql: DB; embed: Embed } & UpstreamCtx;

export function captureEnabled(): boolean {
  const v = brandEnv("PROXY_CAPTURE");
  return !(v === "0" || v === "false");
}

export function captureDistillEnabled(): boolean {
  const v = brandEnv("CAPTURE_DISTILL");
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

const DISTILL_SYSTEM_PROMPT =
  "Extract durable facts about the user from the message as a JSON array of short standalone statements. " +
  "Include only preferences, identity, and standing instructions. Respond with [] if there are none. " +
  "Respond with ONLY the JSON array — no prose, no explanations.";

const DISTILL_MAX_FACTS = 5;
const DISTILL_TIMEOUT_MS = 20_000;

// Local servers disagree about response_format, so parse defensively: a bare JSON array, a fenced
// ```json block, or an array embedded in prose. null = unparseable (caller falls back to heuristics).
export function parseDistilledFacts(content: unknown): string[] | null {
  if (typeof content !== "string") return null;
  let text = content.trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) text = fenced[1]!.trim();
  const candidates = [text];
  const first = text.indexOf("[");
  const last = text.lastIndexOf("]");
  if (first >= 0 && last > first) candidates.push(text.slice(first, last + 1));
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (Array.isArray(parsed)) {
        return parsed.filter((f): f is string => typeof f === "string").map((f) => f.trim()).filter(Boolean);
      }
    } catch {}
  }
  return null;
}

type DistillOutcome = { facts?: string[]; latencyMs: number; error?: string };

// One bounded chat call through the shared upstream path. Any failure is reported, never thrown —
// the caller degrades to heuristics.
async function distillFacts(ctx: Ctx, text: string, model?: string): Promise<DistillOutcome> {
  const started = Date.now();
  const target = resolveUpstream(ctx);
  if (!target.ok) return { latencyMs: Date.now() - started, error: target.error };
  const fetcher = ctx.fetch ?? fetch;
  const deadline = upstreamDeadline(Math.min(upstreamTimeoutMs(), DISTILL_TIMEOUT_MS));
  try {
    const res = await forwardUpstream(
      fetcher,
      target,
      {
        ...(model ? { model } : {}),
        messages: [
          { role: "system", content: DISTILL_SYSTEM_PROMPT },
          { role: "user", content: text },
        ],
        temperature: 0,
        max_tokens: 256,
        stream: false,
      },
      deadline.signal,
    );
    const { json } = await readUpstreamBody(res);
    if (!res.ok) return { latencyMs: Date.now() - started, error: `distill upstream returned ${res.status}` };
    const facts = parseDistilledFacts(json?.choices?.[0]?.message?.content);
    if (facts === null) return { latencyMs: Date.now() - started, error: "distill response was not a JSON array" };
    return { facts, latencyMs: Date.now() - started };
  } catch (e) {
    return { latencyMs: Date.now() - started, error: upstreamErrorMessage(e) };
  } finally {
    deadline.clear();
  }
}

/** Capture facts from an answered proxy turn. Fire-and-forget: never throws, never blocks the turn. */
export async function captureFromTurn(
  ctx: Ctx,
  args: { messages: any[]; containerTag: string; userId?: string; proxyTraceId: string; model?: string },
): Promise<void> {
  if (!captureEnabled()) return;
  const text = lastUserText(args.messages);
  if (!text) return;

  let facts: string[];
  let distilledUsed = false;
  let distill: { used: boolean; latencyMs: number; error?: string } | undefined;
  if (captureDistillEnabled()) {
    const outcome = await distillFacts(ctx, text, args.model);
    // SENSITIVE_RE re-applied to every distilled statement; cap 5/turn; oversized statements dropped.
    const usable = (outcome.facts ?? [])
      .filter((f) => f.length <= 300 && !SENSITIVE_RE.test(f))
      .slice(0, DISTILL_MAX_FACTS);
    if (usable.length) {
      facts = usable;
      distilledUsed = true;
      distill = { used: true, latencyMs: outcome.latencyMs, ...(outcome.error ? { error: outcome.error } : {}) };
    } else {
      // Failure OR a clean [] — either way heuristics still run, so distillation never loses a
      // capture the v1 extractor would have made.
      facts = extractCandidateFacts(text);
      distill = { used: false, latencyMs: outcome.latencyMs, ...(outcome.error ? { error: outcome.error } : {}) };
    }
  } else {
    facts = extractCandidateFacts(text);
  }
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
        metadata: { source: "proxy_capture", proxyTraceId: args.proxyTraceId, ...(distilledUsed ? { distilled: true } : {}) },
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
      metadata: { proxyTraceId: args.proxyTraceId, actions: results.map((r) => r.action), ...(distill ? { distill } : {}) },
    });
  } catch (e) {
    await recordTraceSafe(ctx.sql, {
      kind: "capture",
      status: "error",
      userId: args.userId,
      containerTag: args.containerTag,
      query: text,
      latencyMs: Date.now() - started,
      metadata: { proxyTraceId: args.proxyTraceId, error: e instanceof Error ? e.message : String(e), ...(distill ? { distill } : {}) },
    });
  }
}
