// observe.ts - the single capture funnel. Every failure flows through here: coerce to a BellaError,
// emit a redacted structured line (via log.ts), and hand back stable correlation ids. Two guarantees,
// both mirrored on the existing recordTraceSafe (src/inspect.ts): it NEVER throws, and it is idempotent
// per error object so a site-captured error re-entering app.onError is logged exactly once.
import { createHash } from "node:crypto";
import { newId } from "./util";
import { messageForCode, toBellaError, type Category, type Severity } from "./errors";
import { logEvent } from "./log";

export interface CaptureContext {
  category?: Category;
  code?: string;
  severity?: Severity;
  traceId?: string;
  [key: string]: unknown;
}

export interface CaptureResult {
  traceId: string;
  errorId: string;
  fingerprint: string;
}

// The redacted-by-construction event handed to a persistence sink (PR #2). Defined here so the funnel owns
// the contract and stays decoupled from the store (src/error-store.ts consumes this shape). `requestShape`
// is the raw capture context; the sink redacts it at the store boundary. `messageRedacted` is a STATIC
// per-code label (messageForCode) — content-free by construction; the raw error message never travels.
export interface ErrorEventInput {
  severity: string;
  category: string;
  code: string;
  fingerprint: string;
  traceId?: string;
  messageRedacted?: string;
  stackFingerprint?: string;
  requestShape?: unknown;
  id?: string;
}

// Optional persistence sink. main() registers a db-backed writer at boot, AFTER makeDb() (src/index.ts); when
// null the funnel is log-only — today's behavior, and the fallback for any pre-DB crash. The sink must be
// non-throwing and fire-and-forget.
type ErrorSink = (ev: ErrorEventInput) => void;
let errorSink: ErrorSink | null = null;
export function setErrorSink(sink: ErrorSink | null): void {
  errorSink = sink;
}

// Dedupe by the ORIGINAL thrown object. Non-object throws (string/null) aren't keyable, so they simply
// aren't deduped - acceptable, they rarely double-flow.
const seen = new WeakMap<object, CaptureResult>();

// Stack fingerprint: normalize the top frames (paths -> basename, drop :line:col) and hash them with the
// code. The OUTPUT is a non-reversible token, safe to log/store; grouping/aggregation is PR #2.
function fingerprint(code: string, stack?: string): string {
  const frames = (stack ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("at "))
    .slice(0, 5)
    .map((l) => l.replace(/[^\s(]*[/\\]([^/\\:) ]+):\d+:\d+/g, "$1")) // path:line:col -> basename
    .join("|");
  return "fp_" + createHash("sha256").update(code + "\n" + frames).digest("hex").slice(0, 12);
}

export function capture(e: unknown, ctx: CaptureContext = {}): CaptureResult {
  const key = typeof e === "object" && e !== null ? (e as object) : undefined;
  if (key && seen.has(key)) return seen.get(key)!; // already captured (e.g. re-entered via onError)
  try {
    const be = toBellaError(e);
    const rawMessage = e instanceof Error ? e.message : String(e);
    const rawStack = e instanceof Error ? e.stack : undefined;

    const { category: ctxCat, code: ctxCode, severity: ctxSev, traceId: ctxTid, ...restCtx } = ctx;
    const category = ctxCat ?? be.category;
    const code = ctxCode ?? be.code;
    const severity = ctxSev ?? be.severity;
    const traceId = ctxTid ?? newId();
    const errorId = newId();
    const fp = fingerprint(code, rawStack);

    const result: CaptureResult = { traceId, errorId, fingerprint: fp };
    if (key) seen.set(key, result);

    // log.ts redacts `fields` and gates the raw message/stack behind BELLA_LOG_CONTENT.
    logEvent(
      "warn",
      "observe",
      { code, category, severity, retryable: be.retryable, traceId, errorId, fingerprint: fp, ...be.context, ...restCtx },
      { message: rawMessage, stack: rawStack },
    );

    // Persist (redacted) when a store sink is registered — fire-and-forget and guarded, because the funnel
    // must never become the failure. The sink's async write is itself never-throw; this try/catch only
    // guards a sink that throws synchronously. messageRedacted is a STATIC label looked up from the error
    // code (messageForCode) — content-free BY CONSTRUCTION: never the free-form userFacing or the raw
    // message, so no interpolated user text can ever reach the durable store.
    if (errorSink) {
      try {
        errorSink({
          severity,
          category,
          code,
          fingerprint: fp,
          traceId,
          messageRedacted: messageForCode(code),
          requestShape: { ...be.context, ...restCtx },
        });
      } catch {
        /* a broken sink must not break capture() */
      }
    }
    return result;
  } catch (inner) {
    // The funnel must never become the failure. Warn plainly and still return correlation ids.
    console.warn("[observe] capture failed:", inner instanceof Error ? inner.message : String(inner));
    return { traceId: newId(), errorId: newId(), fingerprint: "fp_error" };
  }
}

// Process-level fatal capture. main() wires this to uncaughtException/unhandledRejection then exit(1);
// exported so the capture path is unit-testable without terminating the test runner.
export function captureFatal(e: unknown): CaptureResult {
  return capture(e, { category: "process", code: "FATAL" });
}
