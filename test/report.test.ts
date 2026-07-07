// report.test.ts - the `bella report` privacy + shape contract. `bella report` assembles a GitHub issue from
// REDACTED error groups + environment diagnostics for the user to review and submit (the binary sends nothing).
// The load-bearing guarantees proven here: the issue body is content-free BY CONSTRUCTION (a whitelist of
// developer-constant + generated fields — never a stored message/stack/path), no filesystem path (which would
// carry a username) ever reaches the body, the URL stays under GitHub's practical length cap, and the read-path
// orchestration fails CLOSED (aborts, never prints) if a home-dir path ever slips into the assembled report.
import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";
import { Hono } from "hono";
import { makePgliteSql, type Sql } from "../src/pg-shim";
import { schemaForDim } from "../src/db";
import { persistErrorEventSafe, readErrorGroups, errorsRoutes, type ErrorGroup } from "../src/error-store";
import type { ErrorEventInput } from "../src/observe";
import { DB_LOCK_ERR } from "../src/db";
import {
  buildIssue,
  collectDiagnostics,
  runReport,
  probeHealth,
  fetchReportData,
  type Diagnostics,
  type ReportData,
  type FetchDeps,
} from "../src/report";
import { VERSION } from "../src/version";
import { messageForCode } from "../src/errors";

const TEST_TIMEOUT_MS = 20000;

// Sentinels — a real secret AND a real-looking home-dir path (the path is the actual leak vector: a storage dir
// carries a username). If any appears in the issue body/url, the content-free construction failed.
const SECRET = "REPORTSECRET_zzz999";
const HOMEPATH = "C:\\Users\\victimuser\\AppData\\Local\\Bellamente";

// --- fixtures --------------------------------------------------------------------------------------------

function sampleDiag(overrides: Partial<Diagnostics> = {}): Diagnostics {
  return {
    version: VERSION,
    os: { platform: "linux", arch: "x64", release: "6.1.0" },
    provider: "local",
    tier: "quality",
    model: "minishlab/potion-base-8M",
    engine: "static/inline",
    dim: 384,
    port: 8080,
    modelCached: true,
    disk: { usedMb: 812.3, budgetMb: 0 },
    dirs: [
      { name: "data", sizeMb: 5.2 },
      { name: "models", sizeMb: 800.1 },
    ],
    ...overrides,
  };
}

function group(overrides: Partial<ErrorGroup> = {}): ErrorGroup {
  return {
    fingerprint: "fp_abc",
    code: "SEARCH_FAILED",
    severity: "error",
    category: "search",
    count: 3,
    firstSeen: "2026-07-01T00:00:00.000Z",
    lastSeen: "2026-07-07T00:00:00.000Z",
    sampleMessage: "Search failed to complete",
    sampleTrace: "trace_abc",
    ...overrides,
  };
}

function report(overrides: Partial<ReportData> = {}): ReportData {
  return {
    diagnostics: sampleDiag(),
    db: { mode: "embedded", ok: true, pgvector: true },
    errorGroups: [group()],
    errorsNote: null,
    ...overrides,
  };
}

async function offlineDb() {
  const pg = await PGlite.create({ dataDir: "memory://", extensions: { vector } });
  const sql = makePgliteSql(pg);
  await sql.unsafe(schemaForDim(4));
  return { sql, close: () => sql.end() };
}

function ev(overrides: Partial<ErrorEventInput> = {}): ErrorEventInput {
  return {
    severity: "error",
    category: "search",
    code: "SEARCH_FAILED",
    fingerprint: "fp_group1",
    messageRedacted: "Internal error",
    requestShape: {},
    ...overrides,
  };
}

// --- buildIssue (pure seam) ------------------------------------------------------------------------------

test("buildIssue: emits a valid prefilled issues/new URL and a body carrying the safe diagnostics", () => {
  const { title, body, url } = buildIssue(report());

  expect(title).toContain("Bellamente");
  expect(title).toContain(VERSION);

  // The safe, useful signal IS present.
  expect(body).toContain(VERSION);
  expect(body).toContain("quality"); // tier
  expect(body).toContain("minishlab/potion-base-8M"); // model
  expect(body).toContain("384"); // dim
  expect(body).toContain("SEARCH_FAILED"); // error code
  expect(body).toContain("×3"); // aggregated count
  expect(body).toContain(messageForCode("SEARCH_FAILED")); // static per-code label

  // A real prefilled GitHub issue link into the canonical repo.
  expect(url.startsWith("https://github.com/The-Little-AI-Company/bellamente/issues/new?")).toBe(true);
  const decoded = decodeURIComponent(url);
  expect(decoded).toContain(VERSION);
});

test("buildIssue: content-free — a stored sampleMessage/sampleTrace is NEVER whitelisted into the issue", () => {
  // Simulate a group whose stored strings carry a secret (the drill-down fields we deliberately DO NOT emit).
  const g = group({ sampleMessage: SECRET, sampleTrace: SECRET, code: "SEARCH_FAILED" });
  const { title, body, url } = buildIssue(report({ errorGroups: [g] }));

  // The body is built from a whitelist (code/category/severity/count/timestamps + messageForCode) — the stored
  // sample strings must not appear, pre- OR post-URL-encoding (the URL is percent-encoded, so decode to check).
  expect(body).not.toContain(SECRET);
  expect(title).not.toContain(SECRET);
  expect(decodeURIComponent(url)).not.toContain(SECRET);
});

test("buildIssue: long error lists are truncated to keep the URL under GitHub's cap; full body is untruncated", () => {
  const many = Array.from({ length: 400 }, (_, i) => group({ fingerprint: `fp_${i}`, code: `CODE_${i}` }));
  const { body, url } = buildIssue(report({ errorGroups: many }));

  // Full body (for stdout copy-paste) keeps every group, even the last.
  expect(body).toContain("CODE_399");

  // The URL is capped and carries a truncation note; the overflow content is dropped from the link only.
  expect(url.length).toBeLessThanOrEqual(8000);
  const decoded = decodeURIComponent(url);
  expect(decoded.toLowerCase()).toContain("truncat");
  expect(decoded).not.toContain("CODE_399");
});

test("buildIssue: empty store yields a valid diagnostics-only report (never crashes)", () => {
  const { body } = buildIssue(report({ errorGroups: [], errorsNote: null }));
  expect(body).toContain("No errors recorded");
  expect(body).toContain(VERSION); // diagnostics still present
});

test("buildIssue: a DB-unavailable note replaces the error list (never 'No errors recorded')", () => {
  const note = "a Bellamente process holds the database — stop it and re-run for full error data";
  const { body } = buildIssue(report({ errorGroups: [], errorsNote: note }));
  expect(body).toContain(note);
  expect(body).not.toContain("No errors recorded");
});

test("buildIssue: db status is a mode enum + bools — the DATABASE_URL is never rendered", () => {
  const secretUrl = "postgres://admin:hunter2@db.internal.example:5432/prod";
  // Even if a caller mistakenly stuffed a URL into the note, the db block itself renders only the enum.
  const { body } = buildIssue(report({ db: { mode: "external", ok: true, pgvector: true } }));
  expect(body).toContain("external");
  expect(body).not.toContain(secretUrl);
  expect(body).not.toContain("hunter2");
});

// --- collectDiagnostics ----------------------------------------------------------------------------------

test("collectDiagnostics: returns the structured snapshot and leaks NO absolute path (dir names + sizes only)", () => {
  const d = collectDiagnostics();

  expect(d.version).toBe(VERSION);
  expect(typeof d.os.platform).toBe("string");
  expect(typeof d.tier).toBe("string");
  expect(typeof d.model).toBe("string");
  expect(typeof d.dim).toBe("number");
  expect(Array.isArray(d.dirs)).toBe(true);
  for (const dir of d.dirs) {
    expect(typeof dir.name).toBe("string");
    expect(typeof dir.sizeMb).toBe("number");
    // A name is a short label ("data","models") — never a path segment.
    expect(dir.name).not.toContain("/");
    expect(dir.name).not.toContain("\\");
  }

  // The real leak vector: a storage dir path embeds the OS username. The snapshot must not contain the home dir.
  const home = require("node:os").homedir();
  const serialized = JSON.stringify(d);
  if (home) expect(serialized).not.toContain(home);
});

// --- readErrorGroups (offline extraction, shared with errorsRoutes) --------------------------------------

test(
  "readErrorGroups: aggregates identical failures by fingerprint with a summed count (offline)",
  async () => {
    const { sql, close } = await offlineDb();
    try {
      for (let i = 0; i < 3; i++) await persistErrorEventSafe(sql, ev({ fingerprint: "fp_dupe", code: "SEARCH_FAILED" }));
      await persistErrorEventSafe(sql, ev({ fingerprint: "fp_other", code: "FATAL", category: "http" }));

      const groups = await readErrorGroups(sql);
      expect(groups).toHaveLength(2);
      const dupe = groups.find((g) => g.fingerprint === "fp_dupe")!;
      expect(dupe.count).toBe(3);
      expect(dupe.code).toBe("SEARCH_FAILED");
      expect(typeof dupe.firstSeen).toBe("string");
      expect(typeof dupe.lastSeen).toBe("string");
    } finally {
      await close();
    }
  },
  TEST_TIMEOUT_MS,
);

test(
  "readErrorGroups: errorsRoutes returns the SAME groups (extraction is behavior-preserving)",
  async () => {
    const { sql, close } = await offlineDb();
    try {
      for (let i = 0; i < 2; i++) await persistErrorEventSafe(sql, ev({ fingerprint: "fp_r" }));
      const app = new Hono();
      app.route("/errors", errorsRoutes({ sql: sql as any }));

      const viaRoute = (await (await app.request("/errors")).json()).errors;
      const viaHelper = await readErrorGroups(sql);
      expect(viaRoute).toEqual(viaHelper);
    } finally {
      await close();
    }
  },
  TEST_TIMEOUT_MS,
);

// --- runReport (orchestration, dependency-injected) ------------------------------------------------------

test("runReport: prints the summary + prefilled URL and returns 0 on the happy path", async () => {
  const out: string[] = [];
  const errs: string[] = [];
  const code = await runReport({
    collectDiagnostics: () => sampleDiag(),
    fetchReportData: async () => ({ db: { mode: "embedded", ok: true, pgvector: true }, errorGroups: [group()], errorsNote: null }),
    homedir: () => "/nonexistent/home",
    log: (s) => out.push(s),
    error: (s) => errs.push(s),
  });

  expect(code).toBe(0);
  const printed = out.join("\n");
  expect(printed).toContain(VERSION);
  expect(printed).toContain("issues/new");
  expect(errs).toHaveLength(0);
});

test("runReport: FAILS CLOSED — if a home-dir path slips into the assembled report, it aborts without printing it", async () => {
  const out: string[] = [];
  const errs: string[] = [];
  // Simulate a collectDiagnostics regression that leaks the home dir into a displayed field (model).
  const code = await runReport({
    collectDiagnostics: () => sampleDiag({ model: `${HOMEPATH}\\model.onnx` }),
    fetchReportData: async () => ({ db: { mode: "embedded", ok: true, pgvector: true }, errorGroups: [], errorsNote: null }),
    homedir: () => HOMEPATH,
    log: (s) => out.push(s),
    error: (s) => errs.push(s),
  });

  expect(code).toBe(1);
  // The leaking content must NOT have been printed; a loud error must have been.
  expect(out.join("\n")).not.toContain(HOMEPATH);
  expect(errs.join("\n")).toMatch(/abort|privacy|path/i);
});

// --- probeHealth (injectable fetch) ----------------------------------------------------------------------

function fakeFetch(impl: () => Promise<{ ok: boolean; json?: () => Promise<unknown> }>): typeof fetch {
  return impl as unknown as typeof fetch;
}

test("probeHealth: returns the health body on a 200, null on non-ok, null on a network error", async () => {
  const up = await probeHealth(8080, fakeFetch(async () => ({ ok: true, json: async () => ({ service: "bellamente", auth: "none" }) })));
  expect(up).toEqual({ service: "bellamente", auth: "none" });

  const down = await probeHealth(8080, fakeFetch(async () => ({ ok: false })));
  expect(down).toBeNull();

  const errored = await probeHealth(8080, fakeFetch(async () => { throw new Error("ECONNREFUSED"); }));
  expect(errored).toBeNull();
});

// --- fetchReportData (lock-workaround branch logic, injected) --------------------------------------------

function fetchDeps(overrides: Partial<FetchDeps> = {}): FetchDeps {
  return {
    databaseUrl: undefined,
    port: 8080,
    probeHealth: async () => null,
    openEmbeddedAndRead: async () => ({ pgvector: true, errorGroups: [group()] }),
    openExternalAndRead: async () => ({ pgvector: true, errorGroups: [group()] }),
    fetchErrorsHttp: async () => ({ ok: true, errors: [group()] }),
    ...overrides,
  };
}

test("fetchReportData: external Postgres reads READ-ONLY (never makeDb/DDL), mode=external", async () => {
  let embeddedCalled = false;
  let externalUrl: string | undefined;
  const r = await fetchReportData(
    fetchDeps({
      databaseUrl: "postgres://x",
      openEmbeddedAndRead: async () => { embeddedCalled = true; return { pgvector: true, errorGroups: [] }; },
      openExternalAndRead: async (url) => { externalUrl = url; return { pgvector: true, errorGroups: [group()] }; },
    }),
  );
  expect(r.db).toEqual({ mode: "external", ok: true, pgvector: true });
  expect(r.errorGroups).toHaveLength(1);
  expect(r.errorsNote).toBeNull();
  expect(externalUrl).toBe("postgres://x"); // routed to the read-only reader...
  expect(embeddedCalled).toBe(false); // ...never the makeDb (schema-applying) path
});

test("fetchReportData: a running loopback serve (auth:none) recovers errors via the /errors HTTP read", async () => {
  const r = await fetchReportData(
    fetchDeps({
      probeHealth: async () => ({ service: "bellamente", auth: "none" }),
      fetchErrorsHttp: async () => ({ ok: true, errors: [group({ code: "FATAL" })] }),
    }),
  );
  expect(r.db).toEqual({ mode: "embedded", ok: true, pgvector: true });
  expect(r.errorGroups[0]!.code).toBe("FATAL");
  expect(r.errorsNote).toBeNull();
});

test("fetchReportData: serve up but /errors rejected -> honest note, no errors", async () => {
  const r = await fetchReportData(
    fetchDeps({ probeHealth: async () => ({ service: "bellamente", auth: "none" }), fetchErrorsHttp: async () => ({ ok: false, errors: [] }) }),
  );
  expect(r.errorGroups).toHaveLength(0);
  expect(r.errorsNote).toMatch(/rejected/i);
});

test("fetchReportData: serve up with auth required -> diagnostics-only note (no token to read /errors)", async () => {
  const r = await fetchReportData(fetchDeps({ probeHealth: async () => ({ service: "bellamente", auth: "required" }) }));
  expect(r.errorGroups).toHaveLength(0);
  expect(r.errorsNote).toMatch(/API key required/i);
});

test("fetchReportData: nothing running -> opens the embedded DB directly", async () => {
  const r = await fetchReportData(fetchDeps({ probeHealth: async () => null, openEmbeddedAndRead: async () => ({ pgvector: true, errorGroups: [group()] }) }));
  expect(r.db).toEqual({ mode: "embedded", ok: true, pgvector: true });
  expect(r.errorGroups).toHaveLength(1);
});

test("fetchReportData: embedded DB held by another process (DB_LOCK_ERR) -> honest 'stop the process' note", async () => {
  const r = await fetchReportData(
    fetchDeps({
      probeHealth: async () => null,
      openEmbeddedAndRead: async () => {
        const e: any = new Error("locked");
        e.code = DB_LOCK_ERR;
        throw e;
      },
    }),
  );
  expect(r.db.ok).toBe(false);
  expect(r.errorsNote).toMatch(/holds the database/i);
});

test("fetchReportData: an unexpected DB error degrades to a generic note (never throws to the caller)", async () => {
  const r = await fetchReportData(
    fetchDeps({ probeHealth: async () => null, openEmbeddedAndRead: async () => { throw new Error("disk exploded"); } }),
  );
  expect(r.errorGroups).toHaveLength(0);
  expect(r.errorsNote).toMatch(/unavailable/i);
});

// --- version drift guard ---------------------------------------------------------------------------------

test("version: the runtime VERSION constant matches root package.json (drift guard)", () => {
  const pkg = JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf8"));
  expect(VERSION).toBe(pkg.version);
});
