// report.ts - `bella report`: assemble a GitHub issue from REDACTED error groups + environment diagnostics so
// a user can file a good bug report without hand-collecting context. Bellamente never phones home: this binary
// SENDS NOTHING. It prints a summary of exactly what will be shared and a prefilled `issues/new` URL; the user
// reviews it and clicks submit on GitHub themselves.
//
// PRIVACY MODEL (why there is no redact() pass here): src/redact.ts is fail-closed — it reduces any value under
// a non-allowlisted key to a shape ({type,len}). The report's readable fields (version/os/tier/model/engine and
// firstSeen/lastSeen/message) are NOT in redact's SAFE_KEYS, so running redact() over the payload would destroy
// the body. Instead this file is content-free BY CONSTRUCTION: every emitted field is a developer constant
// (code/category/severity/tier/model/version), a number/size, an ISO timestamp we generate, or a static
// messageForCode() label — never a stored error message/stack/requestShape, never an absolute path (storage
// dirs are reduced to name+size), never the DATABASE_URL (only a mode enum). test/report.test.ts proves this
// with real home-dir/secret sentinels, and runReport adds a fail-CLOSED tripwire that aborts (never prints) if a
// home-dir path ever slips into the assembled report.
import { statSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";
import { storageDirs, dirSizeBytes, diskUsedBytes, diskBudgetMb } from "./paths";
import { EMBED_DIM, EMBED_TIER, LOCAL_MODEL, LOCAL_DTYPE, PROVIDER, profile, onnxRelPath } from "./embed-common";
import { brandEnv } from "./env";
import { messageForCode } from "./errors";
import { readErrorGroups, type ErrorGroup } from "./error-store";
import { makeDb, DB_LOCK_ERR } from "./db";
import { VERSION } from "./version";

const REPO = "The-Little-AI-Company/bellamente";
const ISSUES_NEW = `https://github.com/${REPO}/issues/new`;
// GitHub's issues/new accepts a prefilled ?body= but silently drops it past a practical URL limit; stay well
// under ~8k so the link always works. The FULL body still prints to stdout for copy-paste.
const MAX_URL = 8000;
const TRUNC_NOTE =
  "\n\n> ⚠️ Diagnostics were truncated to fit this link. Run `bella report` locally and paste the full output (printed to your terminal) above.";

const MB = 1024 * 1024;
const round1 = (n: number): number => Math.round(n * 10) / 10;

export type Diagnostics = {
  version: string;
  os: { platform: string; arch: string; release: string };
  provider: string;
  tier: string;
  model: string;
  engine: string;
  dim: number;
  port: number;
  modelCached: boolean;
  disk: { usedMb: number; budgetMb: number };
  dirs: { name: string; sizeMb: number }[];
};

export type DbStatus = { mode: "external" | "embedded"; ok: boolean; pgvector: boolean };

export type ReportData = {
  diagnostics: Diagnostics;
  db: DbStatus;
  errorGroups: ErrorGroup[];
  errorsNote?: string | null;
};

export type IssuePayload = { title: string; body: string; url: string };

// Injected so runReport's orchestration is unit-testable without opening the real DB or hitting the network
// (paths.ts freezes the data dir at import, so an integration test can't repoint it hermetically).
export type ReportDeps = {
  collectDiagnostics: () => Diagnostics;
  fetchReportData: () => Promise<{ db: DbStatus; errorGroups: ErrorGroup[]; errorsNote: string | null }>;
  homedir: () => string;
  log: (s: string) => void;
  error: (s: string) => void;
};

// A content-free environment snapshot. Storage dirs are reduced to NAME + size (never the absolute path, which
// embeds the OS username); the DB URL is never read here (mode only); no os.hostname().
export function collectDiagnostics(): Diagnostics {
  const dirs = storageDirs();
  const dirSizes = Object.entries(dirs).map(([name, dir]) => ({ name, sizeMb: round1(dirSizeBytes(dir) / MB) }));

  const engine = profile.engine === "static" ? "static/inline" : `wasm/worker dtype=${LOCAL_DTYPE}`;

  let modelCached = false;
  if (PROVIDER === "local") {
    const modelBase = brandEnv("MODEL_DIR") ?? dirs.models;
    const rel = profile.engine === "static" ? [...LOCAL_MODEL.split("/"), "model.safetensors"] : onnxRelPath();
    try {
      modelCached = statSync(join(modelBase, ...rel)).size > 0;
    } catch {
      /* absent weights = normal on a fresh install; reported as a bool */
    }
  }

  return {
    version: VERSION,
    os: { platform: os.platform(), arch: os.arch(), release: os.release() },
    provider: PROVIDER,
    tier: EMBED_TIER,
    model: LOCAL_MODEL,
    engine,
    dim: EMBED_DIM,
    port: Number(process.env.PORT ?? 8080),
    modelCached,
    disk: { usedMb: round1(diskUsedBytes() / MB), budgetMb: diskBudgetMb() },
    dirs: dirSizes,
  };
}

function encodeIssueUrl(title: string, body: string): string {
  return `${ISSUES_NEW}?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`;
}

// The URL carries an encoded (and possibly truncated) copy of the body; the returned `body` is always the FULL
// text so stdout can show everything. Shrink the raw body until the encoded URL (with a truncation note) fits.
function buildUrl(title: string, body: string): string {
  let url = encodeIssueUrl(title, body);
  if (url.length <= MAX_URL) return url;
  let len = body.length;
  while (len > 0 && encodeIssueUrl(title, body.slice(0, len) + TRUNC_NOTE).length > MAX_URL) {
    len -= 128;
  }
  return encodeIssueUrl(title, body.slice(0, Math.max(len, 0)) + TRUNC_NOTE);
}

// Pure seam: structured report data -> {title, body, url}. The single place the issue text is shaped; every
// field is drawn from the content-free whitelist above. NEVER emits errorGroups' sampleMessage/sampleTrace.
export function buildIssue(data: ReportData): IssuePayload {
  const { diagnostics: d, db, errorGroups, errorsNote } = data;
  const dbLine = db.ok
    ? `${db.mode} (reachable, ${db.pgvector ? "pgvector ok" : "pgvector MISSING"})`
    : `${db.mode} (not probed)`;
  const diskLine =
    d.disk.budgetMb > 0 ? `${d.disk.usedMb} MB used / ${d.disk.budgetMb} MB budget` : `${d.disk.usedMb} MB used (no budget set)`;

  const lines: string[] = [
    "## Bellamente bug report",
    "",
    `**Version:** ${d.version}`,
    `**OS:** ${d.os.platform} ${d.os.arch} (${d.os.release})`,
    `**Embedder:** provider=${d.provider} tier=${d.tier} model=${d.model} engine=${d.engine} dim=${d.dim}`,
    `**Model cached:** ${d.modelCached ? "yes" : "no"}`,
    `**Database:** ${dbLine}`,
    `**Disk:** ${diskLine}`,
    `**Storage:** ${d.dirs.map((x) => `${x.name} ${x.sizeMb} MB`).join(" · ")}`,
    "",
    "### Recent errors (redacted, content-free)",
  ];

  if (errorsNote) {
    lines.push(`_${errorsNote}_`);
  } else if (errorGroups.length === 0) {
    lines.push("_No errors recorded._");
  } else {
    for (const g of errorGroups) {
      // WHITELIST: developer constants + generated fields only. messageForCode(code) is a static per-code label
      // (never interpolated user text); sampleMessage/sampleTrace/requestShape are deliberately NOT emitted.
      lines.push(
        `- \`${g.code}\` (${g.category}/${g.severity}) ×${g.count} — ${messageForCode(g.code)} ` +
          `— first ${g.firstSeen}, last ${g.lastSeen}`,
      );
    }
  }

  lines.push(
    "",
    "---",
    "### What happened?",
    "<!-- Describe what you were doing when the problem occurred. -->",
    "<!-- This report contains NO conversation content and NO file contents — only the redacted diagnostics above. -->",
    "",
    "_Generated by `bella report`. You are reviewing this before submitting — Bellamente sent nothing automatically._",
  );

  const body = lines.join("\n");
  const title = `[bug] Bellamente ${d.version} on ${d.os.platform}`;
  return { title, body, url: buildUrl(title, body) };
}

// Boundaries injected into fetchReportData so its lock-workaround branch logic is unit-testable without opening
// the real DB or hitting the network (both real impls default in via defaultFetchDeps).
export type FetchDeps = {
  databaseUrl: string | undefined;
  port: number;
  probeHealth: (port: number) => Promise<{ service?: string; auth?: string } | null>;
  openEmbeddedAndRead: () => Promise<{ pgvector: boolean; errorGroups: ErrorGroup[] }>; // makeDb; throws {code:DB_LOCK_ERR} if held
  openExternalAndRead: (url: string) => Promise<{ pgvector: boolean; errorGroups: ErrorGroup[] }>; // raw read-only; no DDL
  fetchErrorsHttp: (port: number) => Promise<{ ok: boolean; errors: ErrorGroup[] }>;
};

// Is a Bellamente server up (holding the single-writer lock)? Also surfaces the auth mode so we know whether the
// content-free /errors read needs a key we don't have. Requires the `service` tag so an unrelated 200 can't spoof it.
export async function probeHealth(
  port: number,
  fetchFn: typeof fetch = fetch,
): Promise<{ service?: string; auth?: string } | null> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 1000);
    const res = await fetchFn(`http://127.0.0.1:${port}/health`, { signal: ctrl.signal });
    clearTimeout(t);
    if (!res.ok) return null;
    return (await res.json().catch(() => ({}))) as { service?: string; auth?: string };
  } catch {
    return null;
  }
}

// Embedded PGlite (the default, our OWN store): makeDb applies the idempotent schema/migrations, exactly like
// `bella doctor`. Probe pgvector, read the content-free groups, close. Propagates {code:DB_LOCK_ERR} if held.
async function defaultOpenEmbeddedAndRead(): Promise<{ pgvector: boolean; errorGroups: ErrorGroup[] }> {
  const sql = await makeDb();
  try {
    const ext = await sql`SELECT extname FROM pg_extension WHERE extname = 'vector'`;
    return { pgvector: ext.length > 0, errorGroups: await readErrorGroups(sql) };
  } finally {
    await sql.end({ timeout: 1 });
  }
}

// External Postgres (someone else's server): `bella report` is READ-ONLY and must NOT mutate it — so open a raw
// connection and query directly, NEVER makeDb (which applies schema DDL + migrations). Mirrors `bella doctor`'s
// read-only external probe. If the error_event table isn't there, the SELECT throws -> caller's generic degrade.
async function defaultOpenExternalAndRead(url: string): Promise<{ pgvector: boolean; errorGroups: ErrorGroup[] }> {
  const pg = (await import("postgres")).default;
  const sql = pg(url, { max: 1, onnotice: () => {} });
  try {
    const ext = await sql`SELECT extname FROM pg_extension WHERE extname = 'vector'`;
    return { pgvector: ext.length > 0, errorGroups: await readErrorGroups(sql as any) };
  } finally {
    await sql.end({ timeout: 1 });
  }
}

async function defaultFetchErrorsHttp(port: number): Promise<{ ok: boolean; errors: ErrorGroup[] }> {
  const res = await fetch(`http://127.0.0.1:${port}/errors?limit=50`);
  if (!res.ok) return { ok: false, errors: [] };
  const payload = (await res.json().catch(() => ({}))) as { errors?: ErrorGroup[] };
  return { ok: true, errors: payload.errors ?? [] };
}

const defaultFetchDeps: FetchDeps = {
  get databaseUrl() {
    return process.env.DATABASE_URL;
  },
  get port() {
    return Number(process.env.PORT ?? 8080);
  },
  probeHealth,
  openEmbeddedAndRead: defaultOpenEmbeddedAndRead,
  openExternalAndRead: defaultOpenExternalAndRead,
  fetchErrorsHttp: defaultFetchErrorsHttp,
};

// Read the content-free error groups + DB status, working around embedded PGlite's single-writer lock:
//  - external Postgres (DATABASE_URL): no lock — open, probe pgvector, read directly.
//  - a running `bella serve` on default loopback (auth:none): recover via the already-content-free /errors HTTP
//    endpoint (no token needed).
//  - nothing running: open the embedded DB directly (like `bella doctor`).
//  - any other lock holder (bella mcp — no HTTP; or an authed/exposed server): honest diagnostics-only note.
export async function fetchReportData(
  deps: FetchDeps = defaultFetchDeps,
): Promise<{ db: DbStatus; errorGroups: ErrorGroup[]; errorsNote: string | null }> {
  const { databaseUrl, port } = deps;
  try {
    if (databaseUrl) {
      const { pgvector, errorGroups } = await deps.openExternalAndRead(databaseUrl);
      return { db: { mode: "external", ok: true, pgvector }, errorGroups, errorsNote: null };
    }

    const health = await deps.probeHealth(port);
    if (health?.service === "bellamente") {
      // A server holds the lock; it already verified pgvector at boot, so report embedded+ok informationally.
      const db: DbStatus = { mode: "embedded", ok: true, pgvector: true };
      if (health.auth === "none") {
        const { ok, errors } = await deps.fetchErrorsHttp(port);
        if (ok) return { db, errorGroups: errors, errorsNote: null };
        return { db, errorGroups: [], errorsNote: "Error data unavailable: the running Bellamente server rejected the request." };
      }
      return {
        db,
        errorGroups: [],
        errorsNote:
          `Error data unavailable: a Bellamente server is running on :${port} with an API key required. ` +
          "Stop it and re-run `bella report` for full error data.",
      };
    }

    try {
      const { pgvector, errorGroups } = await deps.openEmbeddedAndRead();
      return { db: { mode: "embedded", ok: true, pgvector }, errorGroups, errorsNote: null };
    } catch (e: any) {
      if (e?.code === DB_LOCK_ERR) {
        return {
          db: { mode: "embedded", ok: false, pgvector: false },
          errorGroups: [],
          errorsNote:
            "Error data unavailable: a Bellamente process holds the database (e.g. `bella mcp`). " +
            "Stop it and re-run `bella report` for full error data.",
        };
      }
      throw e;
    }
  } catch (e: any) {
    return {
      db: { mode: databaseUrl ? "external" : "embedded", ok: false, pgvector: false },
      errorGroups: [],
      errorsNote: `Error data unavailable (${e?.message ?? e}).`,
    };
  }
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

const defaultDeps: ReportDeps = {
  collectDiagnostics,
  fetchReportData,
  homedir: () => os.homedir(),
  log: (s) => console.log(s),
  error: (s) => console.error(s),
};

export async function runReport(overrides: Partial<ReportDeps> = {}): Promise<number> {
  const deps = { ...defaultDeps, ...overrides };

  const diagnostics = deps.collectDiagnostics();
  const { db, errorGroups, errorsNote } = await deps.fetchReportData();
  const issue = buildIssue({ diagnostics, db, errorGroups, errorsNote });

  // Fail-CLOSED privacy tripwire. The report is content-free by construction; this is a loud last-resort guard
  // so a future collectDiagnostics regression aborts (nonzero, nothing printed) instead of leaking a home-dir
  // path into a public issue. Checks the full home path (not the bare username, which could coincidence-match).
  const home = deps.homedir();
  if (home && (issue.body.includes(home) || safeDecode(issue.url).includes(home))) {
    deps.error(
      "bella report: aborting — the assembled report contained a filesystem path (privacy guard). " +
        "Nothing was shown. Please open an issue that this happened (without the path).",
    );
    return 1;
  }

  // Consent UX: show EXACTLY what will be shared, then the prefilled link. Nothing is sent automatically.
  deps.log("Bellamente report — review the details below, then open the link to submit the issue yourself.\n");
  deps.log(issue.body);
  deps.log("\n———\nOpen this prefilled GitHub issue (review, edit, then submit):\n");
  deps.log(issue.url);
  deps.log("\nBellamente sent nothing — you submit the issue on GitHub. (Redacted diagnostics only; no conversation content.)");
  return 0;
}
