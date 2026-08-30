// doctor.test.ts - regression coverage for `bella doctor`'s stale-PGlite-lock diagnosis: the Zo host-restart
// incident (a dead-PID db.lock left behind by a hard process kill) MUST be surfaced as an ACTIONABLE FAILURE.
// Before this fix, doctor.ts treated EVERY DB_LOCK_ERR (from acquireDbLock refusing to open a second writer)
// as healthy/informational — "in use by another Bellamente process (not probed)" — which would have hidden
// the exact startup failure that bit prod: nothing was actually running, yet doctor reported all-clear.
//
// The contract under test:
//   - a dead-PID lock -> doctor FAILS loudly, names the pid + liveness, and repeats the archive-not-delete
//     guidance (never "delete", so the stale lock survives as forensic evidence and no data can be lost).
//   - a live foreign-owned lock -> still refused by acquireDbLock (never reclaimed), but doctor reports it
//     informationally, not as a failure (a running peer is healthy, not a problem).
//   - an empty/garbage lock (ambiguous ownership, no readable pid) -> doctor FAILS loudly too; ambiguous
//     ownership is never treated as safe-to-ignore, mirroring the "never silently corrupt" fail-safe rule.
//   - in EVERY case the lock file itself is left byte-for-byte untouched: doctor's diagnostic is read-only
//     (inspectDbLock never creates/writes/removes anything) and never reclaims a foreign lock.
//
// NOT testable in-process: BELLA_HOME is a module-level constant captured at import time in src/paths.ts
// (see test/paths.test.ts), so the only way to exercise a real boot against an isolated data dir is a REAL
// subprocess — the actual public startup seam a Zo restart goes through (`bun src/index.ts doctor`).
import { test, expect } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";

const indexPath = join(import.meta.dir, "..", "src", "index.ts");
// Nothing listens here, so doctor's serverIsUp() probe fails fast (connection refused) and falls through to
// opening the embedded DB directly — the exact path the dead-lock incident hit.
const UNUSED_PORT = "39217";

async function runDoctor(home: string): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn([process.execPath, indexPath, "doctor"], {
    // Strip any DATABASE_URL from the current shell so the embedded (PGlite) path is always exercised,
    // regardless of the invoking environment.
    env: { ...process.env, DATABASE_URL: "", BELLA_HOME: home, PORT: UNUSED_PORT },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, out: out + err };
}

test("bella doctor: a dead-PID db.lock (the Zo restart incident) fails loudly with archive-not-delete guidance, lock left untouched", async () => {
  const home = mkdtempSync(join(tmpdir(), "bella-doctor-dead-"));
  try {
    const lockPath = join(home, "db.lock");
    // A genuinely dead pid: spawn a process, let it exit, then use its pid — guaranteed ESRCH on this
    // exact platform (no OS-specific pid-reuse guessing).
    const ghost = Bun.spawn([process.execPath, "-e", "1"]);
    await ghost.exited;
    const deadPid = ghost.pid;
    writeFileSync(lockPath, String(deadPid));

    const { code, out } = await runDoctor(home);

    expect(code).toBe(1); // a startup-blocking dead lock is a hard failure, never a silent pass
    expect(out).toContain('liveness="dead"');
    expect(out).toContain("ARCHIVE this file");
    expect(out).not.toContain("in use by another Bellamente process (not probed)"); // must not be misreported as healthy
    expect(readFileSync(lockPath, "utf8").trim()).toBe(String(deadPid)); // read-only: never mutated or removed
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}, 20000);

test("bella doctor: a live foreign-owned db.lock still refuses (never reclaimed) but is reported informationally, not as a failure", async () => {
  const home = mkdtempSync(join(tmpdir(), "bella-doctor-live-"));
  const holder = Bun.spawn([process.execPath, "-e", "setTimeout(() => {}, 30000)"]);
  try {
    const lockPath = join(home, "db.lock");
    writeFileSync(lockPath, String(holder.pid));

    const { code, out } = await runDoctor(home);

    expect(out).toContain("in use by another Bellamente process (not probed)");
    expect(out).not.toMatch(/XX\s+embedded database/); // no failing check recorded for the DB line
    expect(code).toBe(0);
    expect(readFileSync(lockPath, "utf8").trim()).toBe(String(holder.pid)); // never mutated or reclaimed
  } finally {
    holder.kill();
    await holder.exited;
    rmSync(home, { recursive: true, force: true });
  }
}, 20000);

test("bella doctor: an empty/garbage db.lock (ambiguous ownership, no readable pid) fails loudly too, and is never deleted", async () => {
  const home = mkdtempSync(join(tmpdir(), "bella-doctor-garbage-"));
  try {
    const lockPath = join(home, "db.lock");
    writeFileSync(lockPath, "not-a-pid");

    const { code, out } = await runDoctor(home);

    expect(code).toBe(1); // ambiguous ownership must never be treated as safe / silently passed
    expect(out).toContain('liveness="unparseable"');
    expect(out).not.toContain("in use by another Bellamente process (not probed)");
    expect(readFileSync(lockPath, "utf8").trim()).toBe("not-a-pid"); // read-only: garbage lock left exactly as found
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}, 20000);
