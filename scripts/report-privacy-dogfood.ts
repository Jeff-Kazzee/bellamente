// report-privacy-dogfood.ts — adversarial proof that `bella report` is content-free even when a user is
// "stupid with it": we inject real secrets (API keys, passwords, emails, home-dir paths, a raw query) through
// EVERY error vector into a throwaway store, then run the ACTUAL `bella report` CLI against it and assert none of
// the secrets appear in what would be submitted (body + prefilled URL) — WHILE asserting the safe signal (the
// error code + count) IS present, so a lock-degraded / empty read can't produce a false pass.
//
// Runs as two phases in separate processes (embedded PGlite is single-writer; the seed must release the lock
// before report opens it): `--seed` writes poisoned rows; the default (orchestrator) mode spawns the seed, then
// spawns report, then greps. Usage: `bun run scripts/report-privacy-dogfood.ts`. Exit 0 = PROVEN, 1 = LEAK.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Distinctive sentinels — if ANY appears in the report output, redaction/construction failed.
const SK = "sk-live-DOGFOODLEAK-abc123XYZ789";
const PW = "hunter2-DOGFOOD-passw0rd";
const EMAIL = "victim-dogfood@secret.example";
const SECRETQUERY = "my social security number is 123-45-6789 DOGFOODQUERY";
const HOMEPATHISH = "C:\\Users\\victimdogfood\\AppData\\Local\\Bellamente";
const SECRETS = [SK, PW, EMAIL, SECRETQUERY, HOMEPATHISH, "DOGFOODLEAK", "hunter2", "123-45-6789"];

async function seed(): Promise<void> {
  const { makeDb } = await import("../src/db");
  const { setErrorSink, capture } = await import("../src/observe");
  const { persistErrorEventSafe } = await import("../src/error-store");

  const sql = await makeDb();
  setErrorSink((ev) => void persistErrorEventSafe(sql, ev));

  // Vector A — secret in a raw thrown Error message (the most common accident). The store must persist only the
  // static per-code label, never this text.
  capture(new Error(`FATAL: OpenAI key ${SK} and DB password ${PW} — path ${HOMEPATHISH}`), {
    category: "search",
    code: "SEARCH_FAILED",
  });

  // Vector B — secrets in the request context (query + a PII userId). Redacted at the store boundary.
  capture(new Error("secondary failure"), {
    category: "search",
    code: "SEARCH_FAILED",
    query: SECRETQUERY,
    userId: EMAIL,
  });

  // Vector C — secrets stuffed into requestShape under both sensitive AND unknown keys (direct write; redact()
  // fail-closes every one of these).
  await persistErrorEventSafe(sql, {
    severity: "error",
    category: "search",
    code: "TOOL_SEARCH_FAILED",
    fingerprint: "fp_dogfood_reqshape",
    messageRedacted: "Internal error",
    requestShape: { apiKey: SK, authorization: `Bearer ${SK}`, password: PW, filepath: HOMEPATHISH, query: SECRETQUERY, note: SK },
  });

  // capture()'s sink is fire-and-forget; poll until the rows land, then release the lock.
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const [{ n }] = (await sql`SELECT count(*)::int AS n FROM error_event`) as unknown as [{ n: number }];
    if (n >= 3) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  await sql.end({ timeout: 1 });
}

async function orchestrate(): Promise<number> {
  const home = mkdtempSync(join(tmpdir(), "bella-report-dogfood-"));
  const childEnv = { ...process.env, BELLA_HOME: home };
  delete (childEnv as Record<string, string>).DATABASE_URL; // force the embedded path
  const selfPath = new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

  try {
    // Phase 1: seed the throwaway store with poisoned errors (separate process; releases the lock on exit).
    const seedProc = Bun.spawn(["bun", "run", selfPath, "--seed"], { env: childEnv, stdout: "inherit", stderr: "inherit" });
    if ((await seedProc.exited) !== 0) {
      console.error("DOGFOOD SETUP FAILED: seed process did not exit cleanly");
      return 1;
    }

    // Phase 2: run the ACTUAL report command against the seeded store; capture what it would surface.
    const reportProc = Bun.spawn(["bun", "run", "src/index.ts", "report"], { env: childEnv, stdout: "pipe", stderr: "pipe" });
    const out = await new Response(reportProc.stdout).text();
    const err = await new Response(reportProc.stderr).text();
    const exit = await reportProc.exited;

    // The submitted artifact is the body + the (decoded) prefilled URL. stderr is local-only, but scan it too.
    let decodedUrl = "";
    const m = out.match(/https:\/\/github\.com\/\S+/);
    if (m) {
      try {
        decodedUrl = decodeURIComponent(m[0]);
      } catch {
        decodedUrl = m[0];
      }
    }
    const submitted = out + "\n" + decodedUrl;

    // POSITIVE CONTROL — the report must have actually READ the seeded errors (else "no secret" is a false pass
    // because it degraded to diagnostics-only). Mirrors functional-e2e's empty-on-boot + count assertions.
    const readErrors = /SEARCH_FAILED|TOOL_SEARCH_FAILED/.test(out) && /×\d+/.test(out);

    // NEGATIVE — not one sentinel in the submitted artifact (nor stderr, belt-and-suspenders).
    const leaks = SECRETS.filter((s) => submitted.includes(s) || err.includes(s));

    console.log("\n===== bella report privacy dogfood =====");
    console.log(`report exit code:         ${exit}`);
    console.log(`positive control (read):  ${readErrors ? "PASS — errors surfaced (code + count)" : "FAIL — no error signal (degraded?)"}`);
    console.log(`secrets injected:         ${SECRETS.length} sentinels across 3 error vectors`);
    console.log(`secrets found in output:  ${leaks.length === 0 ? "0 — NONE LEAKED" : leaks.join(", ")}`);

    const pass = exit === 0 && readErrors && leaks.length === 0;
    console.log(pass ? "\nRESULT: PASS — report is content-free with real errors present.\n" : "\nRESULT: FAIL — see above.\n");
    return pass ? 0 : 1;
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

if (process.argv.includes("--seed")) {
  await seed();
  process.exit(0);
} else {
  process.exit(await orchestrate());
}
