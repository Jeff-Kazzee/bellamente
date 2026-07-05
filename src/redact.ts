// redact.ts - fail-closed redaction, the privacy core. Anything not provably safe metadata is reduced
// to a shape ({type,len}); IDs are hashed, paths reduced to their leaf, content dropped. Pure and
// dependency-light (node:crypto only) so it can sit on the request path without side effects.
import { createHash } from "node:crypto";

// Provably-safe metadata: enum-ish strings + correlation tokens. Kept verbatim.
const SAFE_KEYS = new Set([
  "code", "category", "severity", "status", "kind", "mode", "searchMode",
  "component", "retryable", "traceId", "errorId", "fingerprint",
]);
// Identity that can carry PII (a user-supplied id can be an email or a real name). Hashed, not dropped,
// so failures still correlate per-user without storing who.
const ID_KEYS = new Set(["userId", "user", "orgId", "org_id", "org", "containerTag"]);
// Filesystem paths: a directory can carry a username -> keep only the leaf.
const PATH_KEYS = new Set(["filepath", "path", "file", "dir", "cwd", "lockPath", "dbDir"]);
// The big content items. NOTE headingPath is a markdown breadcrumb ("Setup > Config"), NOT a path -
// classify it as content so it is dropped, never basename'd.
const CONTENT_KEYS = new Set([
  "query", "queries", "q", "memory", "content", "text", "document",
  "prompt", "messages", "embedding", "value", "facts", "headingPath",
]);

// Stable, non-reversible id hash. A truncated sha256 correlates without storing plaintext.
export function hashId(v: string): string {
  return "h_" + createHash("sha256").update(v).digest("hex").slice(0, 16);
}

// Cross-platform path leaf: splits on BOTH separators, so a Windows path redacted on POSIX (and the
// reverse) still loses its directories.
export function baseName(p: string): string {
  const parts = p.split(/[/\\]/);
  return parts[parts.length - 1] || p;
}

function shape(v: unknown): { type: string; len?: number } {
  if (typeof v === "string") return { type: "string", len: v.length };
  if (Array.isArray(v)) return { type: "array", len: v.length };
  return { type: typeof v };
}

function redactValue(key: string | undefined, value: unknown, seen: WeakSet<object>): unknown {
  if (value === null || value === undefined) return value;
  const t = typeof value;
  if (t === "number" || t === "boolean") return value; // inherently shapes, never content

  if (t === "string") {
    const s = value as string;
    if (key && CONTENT_KEYS.has(key)) return shape(s);
    if (key && ID_KEYS.has(key)) return hashId(s);
    if (key && PATH_KEYS.has(key)) return baseName(s);
    if (key && SAFE_KEYS.has(key)) return s; // provably safe -> verbatim
    return shape(s); // fail closed: unknown or absent key -> never the raw string
  }

  if (t === "bigint" || t === "function" || t === "symbol") return { type: t };

  if (Array.isArray(value)) {
    if (key && CONTENT_KEYS.has(key)) return shape(value); // e.g. queries/messages -> drop wholesale
    if (seen.has(value)) return { type: "circular" };
    seen.add(value);
    return value.map((el) => redactValue(key, el, seen));
  }

  const obj = value as Record<string, unknown>;
  if (key && CONTENT_KEYS.has(key)) return { type: "object" }; // a content-keyed object -> drop
  if (seen.has(obj)) return { type: "circular" };
  seen.add(obj);
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(obj)) out[k] = redactValue(k, obj[k], seen);
  return out;
}

// Redact a value for safe logging/storage. Objects are walked per-key; a bare top-level value has no
// key context and so fail-closes to a shape.
export function redact(value: unknown): unknown {
  return redactValue(undefined, value, new WeakSet());
}
