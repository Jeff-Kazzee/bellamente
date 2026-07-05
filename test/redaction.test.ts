// redaction.test.ts - the privacy contract, PROVEN. Feeds known-sensitive strings through every
// capture path (redact() directly, capture()'s context, and capture()'s Error message/stack) and
// asserts none survive in logged output. Content-free by construction: a leak here cannot ship.
import { test, expect } from "bun:test";
import { redact, hashId, baseName } from "../src/redact";
import { capture, captureFatal } from "../src/observe";
import { BellaError, toBellaError } from "../src/errors";
import { logEvent } from "../src/log";

// Distinctive tokens - if any of these appears in default log output, redaction failed.
const MEM = "MEMTEXTSECRET_aaa111";
const QRY = "QUERYSECRET_bbb222";
const EMAIL = "victim_ccc333@secret.example";
const USERDIR = "USERDIRSECRET_ddd444";
const WINPATH = `C:\\Users\\${USERDIR}\\notes.md`;
const APIKEY = "sk-SECRETKEY_eee555";
const FREEFORM = "FREEFORMSECRET_fff666";
const ERRMSG = "ERRMSGSECRET_ggg777";
const ALL_SECRETS = [MEM, QRY, EMAIL, USERDIR, APIKEY, FREEFORM, ERRMSG];

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

function expectNoSecrets(haystack: string, secrets = ALL_SECRETS) {
  for (const s of secrets) expect(haystack).not.toContain(s);
}

// ---------------------------------------------------------------------------
// redact() - the pure primitive
// ---------------------------------------------------------------------------
test("redact() drops content, hashes identity IDs, basenames paths, fail-closes unknown keys", () => {
  const out = redact({
    memory: MEM, // content key -> shape
    query: QRY, // content key -> shape
    userId: EMAIL, // identity key -> hashId
    containerTag: "TENANTSECRET", // identity key -> hashId
    filepath: WINPATH, // path key -> basename
    apiKey: APIKEY, // UNKNOWN key -> fail-closed shape
    note: FREEFORM, // UNKNOWN key -> fail-closed shape
    count: 3, // number -> kept
    ok: true, // boolean -> kept
    mode: "hybrid", // safe key -> verbatim
    code: "SEARCH_FAILED", // safe key -> verbatim
    nested: { content: MEM, latencyMs: 5 },
    list: [QRY, "x"], // unknown-key array -> elements fail-closed
    scores: [1, 2, 3], // number array -> kept
  }) as Record<string, any>;

  // Positive: safe metadata survives verbatim; paths reduce to leaf; ids become stable hashes.
  expect(out.count).toBe(3);
  expect(out.ok).toBe(true);
  expect(out.mode).toBe("hybrid");
  expect(out.code).toBe("SEARCH_FAILED");
  expect(out.nested.latencyMs).toBe(5);
  expect(out.scores).toEqual([1, 2, 3]);
  expect(out.filepath).toBe("notes.md");
  expect(out.userId).toBe(hashId(EMAIL));
  expect(out.memory).toEqual({ type: "string", len: MEM.length });

  // Negative: no raw secret anywhere in the serialized result.
  expectNoSecrets(JSON.stringify(out), [MEM, QRY, EMAIL, USERDIR, APIKEY, FREEFORM]);
  expect(JSON.stringify(out)).not.toContain("TENANTSECRET");
  expect(JSON.stringify(out)).not.toContain("C:\\Users");
});

test("redact() is safe on hostile inputs: cycles, bigint, functions, null", () => {
  const cyclic: any = { a: 1 };
  cyclic.self = cyclic;
  const out = redact({ node: cyclic, big: 10n, fn: () => 1, nothing: null, s: "bare" }) as Record<string, any>;
  expect(() => JSON.stringify(out)).not.toThrow();
  expect(out.big).toEqual({ type: "bigint" });
  expect(out.nothing).toBeNull();
  // A bare string under an unknown key is fail-closed to a shape (never passed through).
  expect(out.s).toEqual({ type: "string", len: 4 });
});

test("redact() fail-closes array elements under a safe key (no verbatim passthrough)", () => {
  const out = redact({ mode: ["ARRAYSECRET_hhh888"], scores: [1, 2] }) as Record<string, any>;
  // A safe-scalar key does not license raw strings inside an array value.
  expect(JSON.stringify(out)).not.toContain("ARRAYSECRET_hhh888");
  expect(out.mode).toEqual([{ type: "string", len: "ARRAYSECRET_hhh888".length }]);
  expect(out.scores).toEqual([1, 2]); // numbers are inherently safe
});

test("hashId is stable, non-reversible, and prefixed", () => {
  const h = hashId(EMAIL);
  expect(h).toBe(hashId(EMAIL)); // stable
  expect(h.startsWith("h_")).toBe(true);
  expect(h).not.toContain(EMAIL); // non-reversible (no plaintext)
  expect(hashId("a")).not.toBe(hashId("b")); // distinguishes
});

test("baseName reduces Windows and POSIX paths to the leaf", () => {
  expect(baseName(WINPATH)).toBe("notes.md");
  expect(baseName("/home/victim/x.md")).toBe("x.md");
  expect(baseName("noseparator")).toBe("noseparator");
});

// ---------------------------------------------------------------------------
// capture() - the funnel. THE signature assertions.
// ---------------------------------------------------------------------------
test("capture() logs metadata but NEVER the error message/stack or context content by default", async () => {
  let result: { traceId: string; errorId: string; fingerprint: string } | undefined;
  const logged = await captureConsole(() => {
    result = capture(new Error(ERRMSG), {
      category: "search",
      code: "SEARCH_FAILED",
      query: QRY,
      userId: EMAIL,
      filepath: WINPATH,
      note: FREEFORM,
    });
  });

  // The whole point: not one sensitive token in the default log line.
  expectNoSecrets(logged);
  expect(logged).not.toContain("C:\\Users");

  // But the useful, safe signal IS there.
  expect(logged).toContain("SEARCH_FAILED");
  expect(logged).toContain("search");
  expect(logged).toContain("notes.md"); // path leaf survives
  expect(logged).toContain(hashId(EMAIL)); // id survives as a stable hash
  expect(result!.traceId).toHaveLength(22);
  expect(result!.errorId).toHaveLength(22);
  expect(result!.fingerprint.length).toBeGreaterThan(0);
  expect(logged).toContain(result!.traceId); // correlation id is logged
});

test("BELLA_LOG_CONTENT=1 surfaces raw message/stack in LOGS ONLY (self-debug escape hatch)", async () => {
  const prior = process.env.BELLA_LOG_CONTENT;
  process.env.BELLA_LOG_CONTENT = "1";
  try {
    const logged = await captureConsole(() => capture(new Error(ERRMSG), {}));
    expect(logged).toContain(ERRMSG); // hatch ON -> the dev sees their own content
  } finally {
    if (prior === undefined) delete process.env.BELLA_LOG_CONTENT;
    else process.env.BELLA_LOG_CONTENT = prior;
  }
  // hatch OFF (default) -> the same message is gone.
  const off = await captureConsole(() => capture(new Error(ERRMSG), {}));
  expect(off).not.toContain(ERRMSG);
});

test("capture() never throws, even on unserializable context", async () => {
  const cyclic: any = {};
  cyclic.self = cyclic;
  await captureConsole(() => {
    expect(() => capture(new Error("boom"), { data: cyclic, big: 9n })).not.toThrow();
    expect(() => capture(null)).not.toThrow(); // non-Error throw value
    const r = capture("just a string");
    expect(r.traceId).toHaveLength(22);
  });
});

test("capture() is idempotent per error object: same traceId, logged once", async () => {
  const e = new Error("boom");
  let r1: any, r2: any;
  const logged = await captureConsole(() => {
    r1 = capture(e, { category: "search" });
    r2 = capture(e, { category: "http" }); // e.g. re-entered via app.onError
  });
  expect(r2.traceId).toBe(r1.traceId);
  expect(r2.errorId).toBe(r1.errorId);
  // One error object -> one log line (the second call is a cache hit).
  expect(logged.split("\n").filter((l) => l.includes("[observe]")).length).toBe(1);
});

test("captureFatal captures a process-level error without throwing", async () => {
  const logged = await captureConsole(() => {
    expect(() => captureFatal(new Error(ERRMSG))).not.toThrow();
  });
  expect(logged).toContain("process");
  expect(logged).not.toContain(ERRMSG);
});

// ---------------------------------------------------------------------------
// log.ts - the emitter gate (both branches, both levels)
// ---------------------------------------------------------------------------
test("logEvent redacts fields unconditionally and gates raw content on BELLA_LOG_CONTENT", async () => {
  const warnDefault = await captureConsole(() =>
    logEvent("warn", "t", { userId: EMAIL, code: "X" }, { message: ERRMSG }),
  );
  expect(warnDefault).toContain("[t]");
  expect(warnDefault).toContain("X");
  expect(warnDefault).toContain(hashId(EMAIL));
  expect(warnDefault).not.toContain(EMAIL);
  expect(warnDefault).not.toContain(ERRMSG); // raw gated off by default

  const prior = process.env.BELLA_LOG_CONTENT;
  process.env.BELLA_LOG_CONTENT = "1";
  try {
    const info = await captureConsole(() => logEvent("info", "t", { code: "X" }, { message: ERRMSG }));
    expect(info).toContain(ERRMSG); // hatch on
  } finally {
    if (prior === undefined) delete process.env.BELLA_LOG_CONTENT;
    else process.env.BELLA_LOG_CONTENT = prior;
  }
});

// ---------------------------------------------------------------------------
// errors.ts - typed errors + coercion
// ---------------------------------------------------------------------------
test("BellaError carries typed fields with sensible defaults", () => {
  const be = new BellaError({ code: "EMBED_TIMEOUT", category: "embed" });
  expect(be).toBeInstanceOf(Error);
  expect(be.code).toBe("EMBED_TIMEOUT");
  expect(be.category).toBe("embed");
  expect(be.severity).toBe("error");
  expect(be.retryable).toBe(false);
  expect(be.status).toBe(500);
  expect(be.userFacing).toBe("Internal error");
});

test("toBellaError is identity for a BellaError and wraps anything else", () => {
  const be = new BellaError({ code: "X", category: "db" });
  expect(toBellaError(be)).toBe(be); // identity -> stable WeakMap keying

  const wrapped = toBellaError(new Error("boom"));
  expect(wrapped).toBeInstanceOf(BellaError);
  expect(wrapped.category).toBe("unknown");
  expect(wrapped.cause).toBeInstanceOf(Error);

  const fromString = toBellaError("plain");
  expect(fromString).toBeInstanceOf(BellaError);
  expect(fromString.cause).toBe("plain");
});
