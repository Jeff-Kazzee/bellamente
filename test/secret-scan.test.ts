// secret-scan.test.ts - the secret-format gate contract. Two corpora carry equal weight: MUST-REDACT (real
// credential formats that have no business being stored verbatim) and MUST-NOT-REDACT (legit developer content
// that merely LOOKS key-shaped). For this product the false-POSITIVE is the worse failure — the users are coding
// agents/devs who legitimately write about keys — so the must-not-redact corpus is the load-bearing one.
import { test, expect } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";
import { makePgliteSql } from "../src/pg-shim";
import { schemaForDim } from "../src/db";
import { writeMemories, memoriesRoutes } from "../src/memories";
import type { Embed } from "../src/embed";
import { EMBED_DIM } from "../src/embed-common";
import { redactSecrets, redactSecretsDeep, scanSecrets, type SecretKind } from "../src/secret-scan";

const T = 20000;
const pad = (v: number[]) => [...v, ...Array(Math.max(0, EMBED_DIM - v.length)).fill(0)];
const embed: Embed = async ({ values }) => values.map(() => pad([1, 0, 0, 0])); // constant fake at the configured dim
async function db() {
  const pg = await PGlite.create({ dataDir: "memory://", extensions: { vector } });
  const sql = makePgliteSql(pg);
  await sql.unsafe(schemaForDim(EMBED_DIM));
  return { sql, close: () => sql.end() };
}
const OPENAI_KEY = "sk-proj-" + "A1b2C3d4E5f6G7h8I9j0K1l2";

// Format-valid but obviously-fake tokens, length-built so the anchored patterns match deterministically.
const SECRETS: { kind: SecretKind; value: string }[] = [
  { kind: "private key", value: "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkq" + "A".repeat(40) + "\n-----END PRIVATE KEY-----" },
  { kind: "private key", value: "-----BEGIN OPENSSH PRIVATE KEY-----" }, // truncated header alone
  { kind: "AWS access key", value: "AKIA" + "1234567890ABCDEF" },
  { kind: "AWS access key", value: "ASIA" + "ABCDEFGHIJ123456" },
  { kind: "GitHub token", value: "ghp_" + "a".repeat(36) },
  { kind: "GitHub token", value: "github_pat_" + "A1b2".repeat(8) },
  { kind: "Slack token", value: "xoxb-2222222222-3333333333-" + "ABCDefgh1234" },
  { kind: "Stripe secret key", value: "sk_live_" + "A1b2C3d4E5f6G7h8I9j0" },
  { kind: "Anthropic API key", value: "sk-ant-api03-" + "A1b2C3d4E5".repeat(9) },
  { kind: "OpenAI API key", value: "sk-proj-" + "A1b2C3d4E5f6G7h8I9j0K1l2" },
  { kind: "OpenAI API key", value: "sk-" + "a1B2c3D4".repeat(6) }, // legacy: sk- + 48
  { kind: "Google API key", value: "AIza" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r" },
];

// Legit developer content that must survive verbatim. This is the trust-protecting corpus.
const BENIGN: string[] = [
  "my api key is stored in 1Password, ask me if you need it",
  "the AWS docs example key is AKIAIOSFODNN7EXAMPLE — a placeholder, not real",
  "remember to rotate the GitHub token before Friday's deploy",
  "the deploy key lives in vault X under prod/",
  "a git commit sha looks like e83c5163316f89bfbde7d9ab23ca2e25604af290",
  "JWTs have three base64url parts separated by dots, e.g. header.payload.signature",
  "use Bearer auth: send an Authorization header with the token",
  "the config uses SCREAMING_SNAKE_CASE for env vars like DATABASE_URL",
  "npm package hash sha512-abcdef0123456789 in the lockfile",
  "sk_test_ keys are safe to commit; only sk_live_ ones are secrets", // mentions the prefix but no full live key
];

// --- MUST REDACT ---------------------------------------------------------------------------------------

for (const { kind, value } of SECRETS) {
  test(`redacts a ${kind}: value removed, marker inserted`, () => {
    const wrapped = `context before ${value} context after`;
    const { redacted, found } = redactSecrets(wrapped);
    expect(found).toContain(kind);
    expect(redacted).not.toContain(value); // the raw secret is gone
    expect(redacted).toContain(`[redacted: ${kind}]`);
    expect(redacted).toContain("context before"); // surrounding context is preserved
    expect(redacted).toContain("context after");
  });
}

test("redacts MULTIPLE distinct secrets in one string", () => {
  const text = `aws AKIA1234567890ABCDEF and github ghp_${"a".repeat(36)} done`;
  const { redacted, found } = redactSecrets(text);
  expect(found).toContain("AWS access key");
  expect(found).toContain("GitHub token");
  expect(redacted).not.toContain("AKIA1234567890ABCDEF");
  expect(redacted).not.toContain(`ghp_${"a".repeat(36)}`);
  expect(redacted).toContain("done");
});

// --- MUST NOT REDACT (the load-bearing corpus) ---------------------------------------------------------

for (const text of BENIGN) {
  test(`leaves benign dev content untouched: "${text.slice(0, 40)}..."`, () => {
    const { redacted, found } = redactSecrets(text);
    expect(found).toEqual([]); // nothing detected
    expect(redacted).toBe(text); // byte-for-byte unchanged
  });
}

test("the canonical AWS EXAMPLE key is NOT redacted (documented placeholder)", () => {
  const { redacted, found } = redactSecrets("key AKIAIOSFODNN7EXAMPLE here");
  expect(found).toEqual([]);
  expect(redacted).toContain("AKIAIOSFODNN7EXAMPLE");
});

// --- helper contract -----------------------------------------------------------------------------------

test("scanSecrets returns the kinds found without mutating text", () => {
  expect(scanSecrets(`x AKIA1234567890ABCDEF y`)).toContain("AWS access key");
  expect(scanSecrets("nothing here")).toEqual([]);
});

test("empty / whitespace input is a no-op", () => {
  expect(redactSecrets("")).toEqual({ redacted: "", found: [] });
  expect(redactSecrets("   \n\t ").found).toEqual([]);
});

test("redactSecretsDeep walks nested JSON, redacts string values, preserves non-strings", () => {
  const key = "ghp_" + "a".repeat(36);
  const input = { a: `token ${key}`, b: 42, c: [true, { d: key }], e: null };
  const { value, found } = redactSecretsDeep(input) as { value: any; found: SecretKind[] };
  expect(found).toContain("GitHub token");
  expect(JSON.stringify(value)).not.toContain(key);
  expect(value.a).toContain("[redacted: GitHub token]");
  expect(value.c[1].d).toContain("[redacted: GitHub token]");
  expect(value.b).toBe(42); // numbers untouched
  expect(value.c[0]).toBe(true);
  expect(value.e).toBeNull();
});

test("redactSecretsDeep leaves benign metadata untouched", () => {
  const input = { tags: ["work", "prod"], count: 3, note: "the key is in 1Password" };
  const { value, found } = redactSecretsDeep(input);
  expect(found).toEqual([]);
  expect(value).toEqual(input);
});

// --- write-path integration (the gate covers manual/MCP/batch/auto-capture via writeMemories) -----------

test(
  "writeMemories redacts a secret before it is stored + embedded, and reports it",
  async () => {
    const { sql, close } = await db();
    try {
      const { results } = await writeMemories(
        { sql, embed },
        { containerTag: "default", items: [{ content: `prod key is ${OPENAI_KEY}, stored in vault X` }] },
      );
      const r = results[0]!;
      expect(r.redacted).toContain("OpenAI API key");
      expect(r.content).not.toContain(OPENAI_KEY); // returned content is redacted
      expect(r.content).toContain("[redacted: OpenAI API key]");
      expect(r.content).toContain("stored in vault X"); // context preserved

      // The PERSISTED row (not just the return value) must be clean — the raw key never entered the store.
      const [row] = await sql`SELECT memory FROM memory_entry WHERE id = ${r.id}`;
      expect(row.memory).not.toContain(OPENAI_KEY);
      expect(row.memory).toContain("[redacted: OpenAI API key]");
    } finally {
      await close();
    }
  },
  T,
);

test(
  "writeMemories redacts secrets in METADATA too, not just content (structured side-channel)",
  async () => {
    const { sql, close } = await db();
    try {
      const { results } = await writeMemories(
        { sql, embed },
        { containerTag: "default", items: [{ content: "harmless note", metadata: { apiKey: OPENAI_KEY, nested: { note: `see ${OPENAI_KEY}` } } }] },
      );
      const r = results[0]!;
      expect(r.redacted).toContain("OpenAI API key");
      const [row] = await sql`SELECT metadata FROM memory_entry WHERE id = ${r.id}`;
      const md = typeof row.metadata === "string" ? JSON.parse(row.metadata) : row.metadata;
      expect(JSON.stringify(md)).not.toContain(OPENAI_KEY); // no raw key anywhere in stored metadata
      expect(md.apiKey).toContain("[redacted: OpenAI API key]");
      expect(md.nested.note).toContain("[redacted: OpenAI API key]");
    } finally {
      await close();
    }
  },
  T,
);

test(
  "writeMemories with allowSecrets stores the value verbatim (deliberate override)",
  async () => {
    const { sql, close } = await db();
    try {
      const { results } = await writeMemories(
        { sql, embed },
        { containerTag: "default", allowSecrets: true, items: [{ content: `key ${OPENAI_KEY}` }] },
      );
      const r = results[0]!;
      expect(r.redacted).toEqual([]);
      const [row] = await sql`SELECT memory FROM memory_entry WHERE id = ${r.id}`;
      expect(row.memory).toContain(OPENAI_KEY);
    } finally {
      await close();
    }
  },
  T,
);

test(
  "POST /memories redacts at the ROUTE (the manual/agent write path) and reports it in the response",
  async () => {
    const { sql, close } = await db();
    try {
      const res = await memoriesRoutes({ sql, embed }).request("/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ memories: [{ content: `deploy key ${OPENAI_KEY} lives in vault` }] }),
      });
      expect(res.status).toBe(201);
      const json = (await res.json()) as { memories: { memory: string; redacted?: string[] }[] };
      const m = json.memories[0]!;
      expect(m.memory).not.toContain(OPENAI_KEY);
      expect(m.memory).toContain("[redacted: OpenAI API key]");
      expect(m.redacted).toContain("OpenAI API key");
    } finally {
      await close();
    }
  },
  T,
);

test(
  "PATCH /:id redacts a CORRECTED memory too (the correction path is gated)",
  async () => {
    const { sql, close } = await db();
    try {
      const app = memoriesRoutes({ sql, embed });
      const created = (await (
        await app.request("/", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ memories: [{ content: "initial harmless note" }] }),
        })
      ).json()) as { memories: { id: string }[] };
      const id = created.memories[0]!.id;

      const res = await app.request(`/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: `corrected: my key ${OPENAI_KEY} here` }),
      });
      expect(res.status).toBe(200);
      const json = (await res.json()) as { redacted?: string[] };
      expect(json.redacted).toContain("OpenAI API key");
      const [row] = await sql`SELECT memory FROM memory_entry WHERE is_latest = true`;
      expect(row.memory).not.toContain(OPENAI_KEY);
      expect(row.memory).toContain("[redacted: OpenAI API key]");
    } finally {
      await close();
    }
  },
  T,
);

test(
  "writeMemories does NOT touch benign key-shaped content (no false positive)",
  async () => {
    const { sql, close } = await db();
    try {
      const { results } = await writeMemories(
        { sql, embed },
        { containerTag: "default", items: [{ content: "the AWS example key AKIAIOSFODNN7EXAMPLE is a placeholder" }] },
      );
      const r = results[0]!;
      expect(r.redacted).toEqual([]);
      const [row] = await sql`SELECT memory FROM memory_entry WHERE id = ${r.id}`;
      expect(row.memory).toContain("AKIAIOSFODNN7EXAMPLE");
    } finally {
      await close();
    }
  },
  T,
);
