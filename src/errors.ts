// errors.ts - typed errors + a coercion helper. Every failure that flows through capture() is first
// normalized to a BellaError, so category / severity / code are always present and the funnel can key
// its dedupe map on a stable object.

export type Severity = "error" | "warn" | "degraded";
export type Category = "http" | "search" | "proxy" | "embed" | "db" | "process" | "unknown";

export interface BellaErrorInit {
  code: string;
  category: Category;
  severity?: Severity;
  retryable?: boolean;
  userFacing?: string;
  status?: number;
  context?: Record<string, unknown>;
  cause?: unknown;
}

export class BellaError extends Error {
  readonly code: string;
  readonly category: Category;
  readonly severity: Severity;
  readonly retryable: boolean;
  readonly userFacing: string;
  readonly status: number;
  readonly context?: Record<string, unknown>;

  constructor(init: BellaErrorInit) {
    super(init.userFacing ?? init.code, init.cause !== undefined ? { cause: init.cause } : undefined);
    this.name = "BellaError";
    this.code = init.code;
    this.category = init.category;
    this.severity = init.severity ?? "error";
    this.retryable = init.retryable ?? false;
    this.userFacing = init.userFacing ?? "Internal error";
    this.status = init.status ?? 500;
    this.context = init.context;
  }
}

// Coerce any thrown value into a BellaError. Identity for an existing BellaError (keeps object identity
// stable for capture()'s WeakMap dedupe); wraps everything else, preserving the original as `cause` so
// the raw message/stack stay reachable for the local self-debug escape hatch.
export function toBellaError(e: unknown): BellaError {
  if (e instanceof BellaError) return e;
  const be = new BellaError({ code: "UNKNOWN", category: "unknown", userFacing: "Internal error", cause: e });
  if (e instanceof Error && e.stack) be.stack = e.stack;
  return be;
}

// Static, content-free labels keyed by error code. This is the ONLY source for the DURABLE error message
// (src/observe.ts sink -> error_event.message_redacted), so a stored label can NEVER carry interpolated user
// text — it is content-free BY CONSTRUCTION (an unknown code falls back to the generic). Deliberately
// distinct from BellaError.userFacing, which app.onError sends in the transient 500 body; the durable store
// no longer reads that free-form field. Add a line here when a new code ships.
const CODE_MESSAGES: Record<string, string> = {
  UNKNOWN: "Internal error",
  FATAL: "The service crashed unexpectedly",
  SEARCH_FAILED: "Search failed to complete",
  TOOL_SEARCH_FAILED: "Memory tool degraded to passthrough",
};

export function messageForCode(code: string): string {
  return CODE_MESSAGES[code] ?? "Internal error";
}
