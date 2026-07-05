// error-store.test.ts - the PR #2 privacy contract for the STORE. PR #1 proved logs + the 500 body are
// content-free; this proves the persisted error_event row is too. A leak here cannot ship. Also covers
// fingerprint grouping (aggregate-on-read), retention rotation, the never-throw writer, and the read API.
import { test, expect, afterEach } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";
import { Hono } from "hono";
import { makePgliteSql, type Sql } from "../src/pg-shim";
import { schemaForDim } from "../src/db";
import { persistErrorEvent, persistErrorEventSafe, errorsRoutes } from "../src/error-store";
import { capture, setErrorSink, type ErrorEventInput } from "../src/observe";
import { hashId } from "../src/redact";
import { newId } from "../src/util";

// A fresh in-memory PGlite + full schema per test is ~1-2s of setup; the DB-touching tests need headroom
// over bun's 5s default under full-suite load (same reason test/capture.test.ts uses an explicit timeout).
const TEST_TIMEOUT_MS = 20000;

// Distinctive tokens - if any appears in a stored row, redaction at the store boundary failed.
const QRY = "QUERYSECRET_bbb222";
const EMAIL = "victim_ccc333@secret.example";
const USERDIR = "USERDIRSECRET_ddd444";
const WINPATH = `C:\\Users\\${USERDIR}\\notes.md`;
const FREEFORM = "FREEFORMSECRET_fff666";
const ERRMSG = "ERRMSGSECRET_ggg777";
const MEM = "MEMTEXTSECRET_aaa111";
const ALL_SECRETS = [QRY, EMAIL, USERDIR, FREEFORM, ERRMSG, MEM];

async function makeDb() {
  const pg = await PGlite.create({ dataDir: "memory://", extensions: { vector } });
  const sql = makePgliteSql(pg);
  await sql.unsafe(schemaForDim(4));
  return { sql, close: () => sql.end() };
}

function expectNoSecrets(haystack: string, secrets = ALL_SECRETS) {
  for (const s of secrets) expect(haystack).not.toContain(s);
}

// Swap console.{warn,log} for a collector, run fn, restore no matter what. Returns everything logged.
async function captureConsole(fn: () => unknown | Promise<unknown>): Promise<string> {
  const lines: string[] = [];
  const priorWarn = console.warn;
  const priorLog = console.log;
  console.warn = (...a: unknown[]) => lines.push(a.map(String).join(" "));
  console.log = (...a: unknown[]) => lines.push(a.map(String).join(" "));
  try {
    await fn();
  } finally {
    console.warn = priorWarn;
    console.log = priorLog;
  }
  return lines.join("\n");
}

// The sink write is fire-and-forget from capture(), so poll briefly for the async row to land.
async function waitFor<T>(fn: () => Promise<T | undefined>, ms = 4000): Promise<T | undefined> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const v = await fn();
    if (v !== undefined) return v;
    await new Promise((r) => setTimeout(r, 50));
  }
  return undefined;
}

function ev(overrides: Partial<ErrorEventInput> = {}): ErrorEventInput {
  return {
    severity: "error",
    category: "search",
    code: "SEARCH_FAILED",
    fingerprint: "fp_group1",
    traceId: newId(),
    messageRedacted: "Internal error",
    requestShape: {},
    ...overrides,
  };
}

// A leaked module-global sink would bleed into other test files' capture() calls. Always reset.
afterEach(() => setErrorSink(null));

function errorsApp(sql: Sql) {
  const app = new Hono();
  app.route("/errors", errorsRoutes({ sql: sql as any }));
  return app;
}

test(
  "schema.sql creates error_event idempotently (empty on fresh boot)",
  async () => {
    const { sql, close } = await makeDb();
    try {
      const rows = await sql`SELECT * FROM error_event`;
      expect(rows).toEqual([]);
      // Re-applying the schema is a no-op (CREATE TABLE IF NOT EXISTS), never an error.
      await sql.unsafe(schemaForDim(4));
      expect((await sql`SELECT count(*)::int AS n FROM error_event`)[0]!.n).toBe(0);
    } finally {
      await close();
    }
  },
  TEST_TIMEOUT_MS,
);

test(
  "⭐ persisted error_event row is content-free: ids hashed, paths leafed, content shaped",
  async () => {
    const { sql, close } = await makeDb();
    try {
      // Direct writer call is deterministic (no poll). Secrets ride in via requestShape + would-be message.
      await persistErrorEventSafe(
        sql,
        ev({
          fingerprint: "fp_privacy1",
          requestShape: { query: QRY, userId: EMAIL, filepath: WINPATH, note: FREEFORM, memory: MEM },
        }),
      );

      const [row] = await sql`SELECT * FROM error_event`;
      expect(row).toBeDefined();
      const serialized = JSON.stringify(row);

      // Negative: not one sensitive token, and no Windows path prefix, anywhere in the stored row.
      expectNoSecrets(serialized);
      expect(serialized).not.toContain("C:\\Users");

      // Positive: the useful, safe signal IS stored.
      expect(row.fingerprint).toBe("fp_privacy1");
      expect(row.message_redacted).toBe("Internal error"); // never a raw message
      expect(row.request_shape.userId).toBe(hashId(EMAIL)); // identity -> stable hash
      expect(row.request_shape.filepath).toBe("notes.md"); // path -> leaf
      expect(row.request_shape.query).toEqual({ type: "string", len: QRY.length }); // content -> shape
      expect(row.request_shape.note).toEqual({ type: "string", len: FREEFORM.length }); // unknown key -> fail-closed shape
      expect(row.count).toBe(1); // DB default
    } finally {
      await close();
    }
  },
  TEST_TIMEOUT_MS,
);

test(
  "message_redacted is clipped at the store boundary (bounds a userFacing-contract slip)",
  async () => {
    const { sql, close } = await makeDb();
    try {
      await persistErrorEventSafe(sql, ev({ messageRedacted: "X".repeat(500) }));
      const [row] = await sql`SELECT message_redacted FROM error_event`;
      expect(row.message_redacted.length).toBeLessThanOrEqual(203); // MESSAGE_LIMIT (200) + "..."
      expect(row.message_redacted.endsWith("...")).toBe(true);
      // A normal short, static label is stored intact.
      await sql.unsafe("DELETE FROM error_event");
      await persistErrorEventSafe(sql, ev({ messageRedacted: "Internal error" }));
      expect((await sql`SELECT message_redacted FROM error_event`)[0].message_redacted).toBe("Internal error");
    } finally {
      await close();
    }
  },
  TEST_TIMEOUT_MS,
);

test(
  "seam: capture() -> registered sink persists a row that NEVER carries the raw error message",
  async () => {
    const { sql, close } = await makeDb();
    try {
      setErrorSink((e) => void persistErrorEventSafe(sql, e));
      let result: { traceId: string; errorId: string; fingerprint: string } | undefined;
      await captureConsole(() => {
        result = capture(new Error(ERRMSG), { category: "search", code: "SEARCH_FAILED", query: QRY, userId: EMAIL });
      });

      const row = await waitFor(async () => (await sql`SELECT * FROM error_event`)[0]);
      expect(row).toBeDefined();
      const serialized = JSON.stringify(row);

      expectNoSecrets(serialized);
      expect(serialized).not.toContain(ERRMSG); // the raw Error.message must never reach the store

      // Correlates to what capture() returned + the redacted context landed.
      expect(row.fingerprint).toBe(result!.fingerprint);
      expect(row.stack_fingerprint).toBe(result!.fingerprint); // same token in both columns (design doc)
      expect(row.trace_id).toBe(result!.traceId);
      expect(row.code).toBe("SEARCH_FAILED");
      expect(row.category).toBe("search");
      expect(row.message_redacted).toBe("Internal error"); // BellaError.userFacing, not ERRMSG
      expect(row.request_shape.userId).toBe(hashId(EMAIL));
    } finally {
      setErrorSink(null);
      await close();
    }
  },
  TEST_TIMEOUT_MS,
);

test(
  "grouping: identical failures aggregate by fingerprint with a summed count",
  async () => {
    const { sql, close } = await makeDb();
    try {
      for (let i = 0; i < 3; i++) await persistErrorEventSafe(sql, ev({ fingerprint: "fp_dupe", code: "SEARCH_FAILED" }));
      await persistErrorEventSafe(sql, ev({ fingerprint: "fp_other", code: "EMBED_TIMEOUT", category: "embed" }));

      const res = await errorsApp(sql).request("/errors");
      expect(res.status).toBe(200);
      const { errors } = await res.json();
      expect(errors).toHaveLength(2);

      const dupe = errors.find((e: any) => e.fingerprint === "fp_dupe");
      expect(dupe.count).toBe(3); // "this happened 3x", not 3 stacks
      expect(dupe.code).toBe("SEARCH_FAILED");
      expect(typeof dupe.firstSeen).toBe("string");
      expect(typeof dupe.lastSeen).toBe("string");
      const other = errors.find((e: any) => e.fingerprint === "fp_other");
      expect(other.count).toBe(1);
    } finally {
      await close();
    }
  },
  TEST_TIMEOUT_MS,
);

test(
  "retention: self-prune caps the table at ERROR_RETENTION after a prune batch",
  async () => {
    const prior = process.env.BELLA_ERROR_RETENTION;
    process.env.BELLA_ERROR_RETENTION = "5";
    const { sql, close } = await makeDb();
    try {
      // PRUNE_EVERY writes (25) trigger exactly one prune, keeping the newest ERROR_RETENTION (5) rows.
      for (let i = 0; i < 25; i++) await persistErrorEventSafe(sql, ev({ fingerprint: `fp_${i}` }));
      const n = (await sql`SELECT count(*)::int AS n FROM error_event`)[0]!.n;
      expect(n).toBe(5);
    } finally {
      if (prior === undefined) delete process.env.BELLA_ERROR_RETENTION;
      else process.env.BELLA_ERROR_RETENTION = prior;
      await close();
    }
  },
  TEST_TIMEOUT_MS,
);

test(
  "writer never throws: a failing INSERT is swallowed with a warning, returns an id",
  async () => {
    const { sql, close } = await makeDb();
    try {
      await sql.unsafe("DROP TABLE error_event");
      let id: string | undefined;
      const logged = await captureConsole(async () => {
        // Must RESOLVE (never-throw contract) even though the table is gone.
        id = await persistErrorEventSafe(sql, ev());
      });
      expect(id).toHaveLength(22);
      expect(logged).toContain("[error-store]");
    } finally {
      await close();
    }
  },
  TEST_TIMEOUT_MS,
);

test("a synchronously-throwing sink cannot break capture()", async () => {
  setErrorSink(() => {
    throw new Error("sink boom");
  });
  const logged = await captureConsole(() => {
    expect(() => capture(new Error("boom"), { category: "search" })).not.toThrow();
  });
  expect(logged).toContain("[observe]"); // still logged the failure; the broken sink was swallowed
});

test(
  "read route: ?fingerprint returns raw occurrences; empty store returns []",
  async () => {
    const { sql, close } = await makeDb();
    try {
      const app = errorsApp(sql);

      const empty = await app.request("/errors");
      expect((await empty.json()).errors).toEqual([]);

      await persistErrorEvent(sql, ev({ fingerprint: "fp_detail", traceId: "trace-detail-1" }));
      await persistErrorEvent(sql, ev({ fingerprint: "fp_detail", traceId: "trace-detail-2" }));

      const res = await app.request("/errors?fingerprint=fp_detail");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.fingerprint).toBe("fp_detail");
      expect(body.occurrences).toHaveLength(2);
      expect(body.occurrences.every((o: any) => o.fingerprint === "fp_detail")).toBe(true);
      expect(body.occurrences.map((o: any) => o.traceId).sort()).toEqual(["trace-detail-1", "trace-detail-2"]);
    } finally {
      await close();
    }
  },
  TEST_TIMEOUT_MS,
);
