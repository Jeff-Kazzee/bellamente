// error-store.ts - the append-only error_event store + read API. PR #2's persistence layer for the capture
// funnel (src/observe.ts): capture() hands a redacted-by-construction event to a registered sink; this
// module writes it content-free (redact() at the store boundary), groups identical failures by fingerprint
// on read, and self-prunes to ERROR_RETENTION. Deliberately mirrors src/inspect.ts's recordTrace /
// recordTraceSafe / prune so the two local logs behave identically.
import { Hono } from "hono";
import type { DB } from "./db";
import { newId, ORG_ID } from "./util";
import { brandEnv } from "./env";
import { redact } from "./redact";
import type { ErrorEventInput } from "./observe";

type Ctx = { sql: DB };

// Read per-call (not frozen at import) so tests and live processes can tune retention.
function errorRetention(): number {
  const raw = Number(brandEnv("ERROR_RETENTION") ?? 1000);
  if (!Number.isFinite(raw)) return 1000;
  return Math.min(Math.max(Math.round(raw), 0), 100000);
}

function parseLimit(value: string | null | undefined): number {
  const n = Number(value ?? 50);
  if (!Number.isFinite(n)) return 50;
  return Math.min(Math.max(Math.round(n), 1), 200);
}

// message_redacted holds the STATIC per-code label from messageForCode(code) (errors.ts CODE_MESSAGES): the
// boot capture sink (src/observe.ts) passes THAT — never BellaError.userFacing (which can be interpolated) and
// never the raw Error.message. That static-label sink IS the content-free guarantee. We ALSO clip here as
// defense-in-depth: if a future second caller of persistErrorEvent ever passed raw text, the slip is bounded to
// 200 chars, not stored in full. The clip is a bound, not the guarantee. Mirrors inspect.ts clippedScalar.
// (Do NOT "fix" this to store userFacing — that field is free-form and would reintroduce a content channel.)
const MESSAGE_LIMIT = 200;
function clippedMessage(value: string | undefined | null): string | null {
  if (value == null) return null;
  const s = String(value);
  return s.length > MESSAGE_LIMIT ? s.slice(0, MESSAGE_LIMIT) + "..." : s;
}

async function pruneErrorLog(sql: DB): Promise<void> {
  const retention = errorRetention();
  if (retention <= 0) return;
  await sql`
    DELETE FROM error_event
    WHERE org_id = ${ORG_ID}
      AND id NOT IN (
        SELECT id FROM error_event WHERE org_id = ${ORG_ID} ORDER BY ts DESC LIMIT ${retention}
      )`;
}

// Batch pruning: every PRUNE_EVERY writes per DB handle (same rationale as inspect.ts), so the table is
// bounded by retention + PRUNE_EVERY - 1 rows worst case. WeakMap keyed on the handle isolates test DBs.
const PRUNE_EVERY = 25;
const writesSincePrune = new WeakMap<DB, number>();

// Persist one captured failure. request_shape is redacted HERE (fail-closed at the store boundary), so the
// row is content-free regardless of what the caller passed. message_redacted must already be safe
// (BellaError.userFacing) — never a raw error message. id/ts/count default (id minted, ts/count in the DB).
export async function persistErrorEvent(sql: DB, ev: ErrorEventInput): Promise<string> {
  const id = ev.id ?? newId();
  await sql`
    INSERT INTO error_event
      (id, org_id, severity, category, code, fingerprint, message_redacted, stack_fingerprint, request_shape, trace_id)
    VALUES
      (${id}, ${ORG_ID}, ${ev.severity}, ${ev.category}, ${ev.code}, ${ev.fingerprint},
       ${clippedMessage(ev.messageRedacted)}, ${ev.stackFingerprint ?? ev.fingerprint},
       ${sql.json(redact(ev.requestShape ?? {}))}, ${ev.traceId ?? null})`;
  const writes = (writesSincePrune.get(sql) ?? 0) + 1;
  if (writes >= PRUNE_EVERY) {
    writesSincePrune.set(sql, 0);
    try {
      await pruneErrorLog(sql);
    } catch (e) {
      console.warn("[error-store] failed to prune error log:", e instanceof Error ? e.message : String(e));
    }
  } else {
    writesSincePrune.set(sql, writes);
  }
  return id;
}

// Never-throw wrapper (mirrors recordTraceSafe): mint the id up front so the caller always gets one, then
// warn-and-continue on any write failure. This is what the boot-registered sink calls fire-and-forget.
export async function persistErrorEventSafe(sql: DB, ev: ErrorEventInput): Promise<string> {
  const id = ev.id ?? newId();
  try {
    await persistErrorEvent(sql, { ...ev, id });
  } catch (e) {
    console.warn("[error-store] failed to persist error event:", e instanceof Error ? e.message : String(e));
  }
  return id;
}

function toIso(v: unknown): string {
  const d = v instanceof Date ? v : new Date(v as any);
  return Number.isNaN(d.getTime()) ? String(v) : d.toISOString();
}

// A fingerprint group: "this failure happened N times". Counts are over the retained window (append-only +
// prune-oldest), which is what triage wants — recent recurrence, not all-time history.
export type ErrorGroup = {
  fingerprint: string;
  code: string;
  severity: string;
  category: string;
  count: number;
  firstSeen: string;
  lastSeen: string;
  sampleMessage: string | null;
  sampleTrace: string | null;
};

function normalizeGroup(row: any): ErrorGroup {
  return {
    fingerprint: row.fingerprint,
    code: row.code,
    severity: row.severity,
    category: row.category,
    count: Number(row.count ?? 0),
    firstSeen: toIso(row.first_seen),
    lastSeen: toIso(row.last_seen),
    sampleMessage: row.sample_message ?? null,
    sampleTrace: row.sample_trace ?? null,
  };
}

// A single raw occurrence (the ?fingerprint drill-down).
function normalizeEvent(row: any) {
  return {
    id: row.id,
    severity: row.severity,
    category: row.category,
    code: row.code,
    fingerprint: row.fingerprint,
    stackFingerprint: row.stack_fingerprint ?? null,
    messageRedacted: row.message_redacted ?? null,
    requestShape: row.request_shape ?? {},
    traceId: row.trace_id ?? null,
    count: Number(row.count ?? 1),
    ts: toIso(row.ts),
  };
}

// Read the fingerprint-grouped error summary (the GET /errors payload). Extracted so `bella report` reads it
// directly (offline, opening the DB like `bella doctor` does) with the SAME query the route serves — one
// source, no drift. `limit` is clamped exactly like the route's ?limit=.
export async function readErrorGroups(sql: DB, limit = 50): Promise<ErrorGroup[]> {
  const n = parseLimit(String(limit));
  const rows = await sql`
    SELECT fingerprint, code, severity, category,
           sum(count)::int AS count, min(ts) AS first_seen, max(ts) AS last_seen,
           (array_agg(message_redacted ORDER BY ts DESC))[1] AS sample_message,
           (array_agg(trace_id ORDER BY ts DESC))[1] AS sample_trace
    FROM error_event
    WHERE org_id = ${ORG_ID}
    GROUP BY fingerprint, code, severity, category
    ORDER BY max(ts) DESC
    LIMIT ${n}`;
  return rows.map(normalizeGroup);
}

// Read-only errors API (bearer-gated at the mount, like /inspect). GET /errors -> fingerprint groups;
// GET /errors?fingerprint=... -> that group's recent raw occurrences.
export function errorsRoutes({ sql }: Ctx) {
  const app = new Hono();

  app.get("/", async (c) => {
    const limit = parseLimit(c.req.query("limit"));
    const fingerprint = c.req.query("fingerprint");
    if (fingerprint) {
      const rows = await sql`
        SELECT * FROM error_event
        WHERE org_id = ${ORG_ID} AND fingerprint = ${fingerprint}
        ORDER BY ts DESC
        LIMIT ${limit}`;
      return c.json({ fingerprint, occurrences: rows.map(normalizeEvent) });
    }
    return c.json({ errors: await readErrorGroups(sql, limit) });
  });

  return app;
}
