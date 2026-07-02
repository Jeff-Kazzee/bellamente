// upstream.ts - the ONE place upstream chat-completions config is resolved. The proxy layers
// per-request header overrides on top; capture's distillation pass uses the identical resolution
// (same ctx fields, same env knobs, same loopback no-auth rule, same ctx.fetch stub path for tests).
// Factored out of proxy.ts so there is never a second config mechanism to drift.
import { isIP } from "node:net";
import { brandEnv } from "./env";

export type FetchLike = typeof fetch;

export type UpstreamCtx = {
  fetch?: FetchLike;
  upstreamBaseUrl?: string;
  upstreamApiKey?: string;
  allowUnauthenticatedUpstream?: boolean;
};

export type UpstreamConfig =
  | { ok: true; url: string; headers: Headers }
  | { ok: false; error: string; status: number; upstreamBase?: string };

function chatCompletionsUrl(base: string): string {
  const trimmed = base.replace(/\/+$/, "");
  return trimmed.endsWith("/chat/completions") ? trimmed : `${trimmed}/chat/completions`;
}

function normalizedHostname(url: URL): string {
  return url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
}

function isIpv4Loopback(host: string): boolean {
  if (isIP(host) !== 4) return false;
  return Number(host.split(".")[0]) === 127;
}

function hexWord(word: string): number | null {
  if (!/^[0-9a-f]{1,4}$/i.test(word)) return null;
  const value = Number.parseInt(word, 16);
  return Number.isInteger(value) && value >= 0 && value <= 0xffff ? value : null;
}

function isIpv4MappedLoopback(host: string): boolean {
  if (isIP(host) !== 6 || !host.startsWith("::ffff:")) return false;
  const mapped = host.slice("::ffff:".length);
  if (isIpv4Loopback(mapped)) return true;

  const words = mapped.split(":");
  if (words.length !== 2) return false;
  const highWord = hexWord(words[0]!);
  const lowWord = hexWord(words[1]!);
  if (highWord == null || lowWord == null) return false;
  return highWord >> 8 === 127;
}

function isLoopbackUpstream(url: URL): boolean {
  const host = normalizedHostname(url);
  return host === "localhost" || host.endsWith(".localhost") || host === "::1" || isIpv4Loopback(host) || isIpv4MappedLoopback(host);
}

/** Resolve the upstream target from ctx + env. `overrides` carries per-request header values (proxy only). */
export function resolveUpstream(ctx: UpstreamCtx, overrides?: { authorization?: string; apiKey?: string }): UpstreamConfig {
  const base = ctx.upstreamBaseUrl || brandEnv("UPSTREAM_BASE_URL") || "http://127.0.0.1:11434/v1";
  let parsed: URL;
  try {
    parsed = new URL(chatCompletionsUrl(base));
  } catch {
    return { ok: false, status: 400, error: "Invalid upstream base URL", upstreamBase: base };
  }
  const url = parsed.toString();

  const explicitAuth = overrides?.authorization;
  const apiKey = overrides?.apiKey || ctx.upstreamApiKey || brandEnv("UPSTREAM_API_KEY") || "";
  const allowNoAuth = ctx.allowUnauthenticatedUpstream || brandEnv("UPSTREAM_ALLOW_NO_AUTH") === "1" || isLoopbackUpstream(parsed);
  if (!explicitAuth && !apiKey && !allowNoAuth) {
    return {
      ok: false,
      status: 502,
      error: "Missing upstream API key for non-local upstream. Set BELLA_UPSTREAM_API_KEY, send x-bella-upstream-api-key, or point BELLA_UPSTREAM_BASE_URL at a local server.",
      upstreamBase: base,
    };
  }

  const headers = new Headers({ "content-type": "application/json" });
  if (explicitAuth) headers.set("authorization", explicitAuth);
  else if (apiKey) headers.set("authorization", `Bearer ${apiKey}`);
  return { ok: true, url, headers };
}

// Upstream timeouts. Read lazily (per request, not at import) so tests and long-running processes can
// adjust without a restart. Bounded [1ms, 10min]; local LLM generation can legitimately take minutes,
// so the buffered default is generous — the point is "never hang forever", not "be snappy".
const clampMs = (raw: unknown, fallback: number): number => {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.max(Math.round(n), 1), 600_000);
};
export function upstreamTimeoutMs(): number {
  return clampMs(brandEnv("UPSTREAM_TIMEOUT_MS"), 120_000);
}
export function streamIdleTimeoutMs(): number {
  return clampMs(brandEnv("STREAM_IDLE_TIMEOUT_MS"), 120_000);
}

// One deadline covers connect + headers + (for buffered exchanges) the full body read: fetch's abort
// signal governs res.text() too, so a stalled body can't hang past the deadline. Streaming call sites
// clear the deadline once headers arrive and hand off to the per-read idle timeout in pipeStream.
export type Deadline = { signal: AbortSignal; clear: () => void };
export function upstreamDeadline(ms: number): Deadline {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error(`upstream timed out after ${ms}ms (BELLA_UPSTREAM_TIMEOUT_MS)`)),
    ms,
  );
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
}

export async function forwardUpstream(
  fetcher: FetchLike,
  config: Extract<UpstreamConfig, { ok: true }>,
  body: any,
  signal?: AbortSignal,
) {
  return fetcher(config.url, { method: "POST", headers: config.headers, body: JSON.stringify(body), signal });
}

export async function readUpstreamBody(res: Response): Promise<{ text: string; json: any }> {
  const text = await res.text();
  try {
    return { text, json: text ? JSON.parse(text) : null };
  } catch {
    return { text, json: null };
  }
}

// fetch() wraps abort reasons in a TypeError whose `cause` holds the real deadline error — unwrap it so
// traces say "timed out after Nms" instead of "fetch failed".
export function upstreamErrorMessage(e: unknown): string {
  const cause = (e as any)?.cause;
  if (cause instanceof Error && cause.message) return cause.message;
  return e instanceof Error ? e.message : String(e);
}
