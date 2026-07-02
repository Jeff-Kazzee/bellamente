// profile.test.ts - profile formatting (bullets, recency cap), the injection context block, the
// loadProfile fallbacks (missing space / NULL metadata / non-object profile), and the GET/PUT
// /profile routes (upsert + jsonb_set update that preserves sibling metadata keys).
import { test, expect } from "bun:test";
import { Hono } from "hono";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";
import { makePgliteSql } from "../src/pg-shim";
import { schemaForDim } from "../src/db";
import { loadProfile, formatProfile, profileContextBlock, profileRoutes, type Profile } from "../src/profile";
import { ORG_ID, DEFAULT_CONTAINER_TAG } from "../src/util";
import type { Embed } from "../src/embed";

const TEST_TIMEOUT_MS = 15000;
const embed: Embed = async ({ values }) => values.map(() => [1, 0, 0, 0]);

async function makeApp() {
  const pg = await PGlite.create({ dataDir: "memory://", extensions: { vector } });
  const sql = makePgliteSql(pg);
  await sql.unsafe(schemaForDim(4));
  const app = new Hono();
  app.route("/profile", profileRoutes({ sql, embed }));
  return { app, sql, close: () => sql.end() };
}

async function put(app: Hono, path: string, body: BodyInit) {
  return app.request(path, { method: "PUT", headers: { "content-type": "application/json" }, body });
}

test("formatProfile: static bullets first, then dynamic capped at 10 with an overflow line", () => {
  const dynamic = Array.from({ length: 12 }, (_, i) => `recent ${i + 1}`);
  const out = formatProfile({ static: ["likes tea"], dynamic });
  const lines = out.split("\n");
  expect(lines[0]).toBe("  - likes tea");
  expect(lines[1]).toBe("  - recent 1");
  expect(lines[10]).toBe("  - recent 10");
  expect(lines[11]).toBe("(+2 more recent items)");
  expect(lines).toHaveLength(12);
  expect(out).not.toContain("recent 11"); // items past the cap are summarized, never listed

  // Exactly at the cap -> every item listed, NO overflow line.
  const atCap = formatProfile({ dynamic: Array.from({ length: 10 }, (_, i) => `d${i}`) });
  expect(atCap.split("\n")).toHaveLength(10);
  expect(atCap).not.toContain("more recent items");
});

test("formatProfile: empty or absent sections format to an empty string (no stray bullets)", () => {
  expect(formatProfile({})).toBe("");
  expect(formatProfile({ static: [], dynamic: [] })).toBe("");
});

test("profileContextBlock wraps the formatted facts in the injection preamble", () => {
  const block = profileContextBlock("  - likes tea");
  expect(block.startsWith("\n\n[User memory context]")).toBe(true);
  expect(block).toContain("Known facts about the current user");
  expect(block).toContain("\n\n  - likes tea\n\n"); // the facts sit blank-line-separated in the middle
  expect(block).toContain("do not call attention to having a stored profile");
});

test("loadProfile: missing space, NULL metadata, and metadata without a profile all fall back to empty", async () => {
  const { sql, close } = await makeApp();
  try {
    const empty: Profile = { static: [], dynamic: [] };
    // No space row at all.
    expect(await loadProfile(sql, "no-such-tag")).toEqual(empty);
    // Space exists but metadata is NULL.
    await sql`INSERT INTO space (id, container_tag, org_id) VALUES (${"a".repeat(22)}, ${"bare"}, ${ORG_ID})`;
    expect(await loadProfile(sql, "bare")).toEqual(empty);
    // Space has metadata, but no profile key in it.
    await sql`INSERT INTO space (id, container_tag, org_id, metadata)
              VALUES (${"b".repeat(22)}, ${"other-meta"}, ${ORG_ID}, ${sql.json({ other: 1 })})`;
    expect(await loadProfile(sql, "other-meta")).toEqual(empty);
  } finally {
    await close();
  }
}, TEST_TIMEOUT_MS);

test("loadProfile: a non-object profile value passes through as-is (?? only guards null) and formatProfile tolerates it", async () => {
  const { sql, close } = await makeApp();
  try {
    await sql`INSERT INTO space (id, container_tag, org_id, metadata)
              VALUES (${"c".repeat(22)}, ${"malformed"}, ${ORG_ID}, ${sql.json({ profile: "not-an-object" })})`;
    const p = await loadProfile(sql, "malformed");
    expect(p as unknown).toBe("not-an-object"); // pinned quirk: only null/undefined fall back to the default
    expect(formatProfile(p)).toBe(""); // ...and the formatter degrades to an empty block, not a crash
  } finally {
    await close();
  }
}, TEST_TIMEOUT_MS);

test("GET /profile without a stored space returns the empty profile", async () => {
  const { app, close } = await makeApp();
  try {
    const res = await app.request("/profile");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ static: [], dynamic: [] });
  } finally {
    await close();
  }
}, TEST_TIMEOUT_MS);

test("PUT /profile upserts per containerTag; the conflict path jsonb_sets ONLY the profile key", async () => {
  const { app, sql, close } = await makeApp();
  try {
    // Pre-existing space with sibling metadata that the PUT must not clobber.
    await sql`INSERT INTO space (id, container_tag, org_id, metadata)
              VALUES (${"d".repeat(22)}, ${DEFAULT_CONTAINER_TAG}, ${ORG_ID}, ${sql.json({ other: "kept", profile: { static: ["stale"] } })})`;

    const res = await put(app, "/profile", JSON.stringify({ static: ["likes tea"], dynamic: ["moved to Boulder"] }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    const got = await (await app.request("/profile")).json();
    expect(got).toEqual({ static: ["likes tea"], dynamic: ["moved to Boulder"] });
    const [row] = await sql`SELECT metadata FROM space WHERE container_tag = ${DEFAULT_CONTAINER_TAG} AND org_id = ${ORG_ID}`;
    expect(row!.metadata.other).toBe("kept"); // jsonb_set replaced the profile key, not the whole metadata
    const spaces = await sql`SELECT count(*)::int AS n FROM space`;
    expect(Number(spaces[0]!.n)).toBe(1); // updated in place, no second row

    // A PUT under a different containerTag creates its own space and never leaks across tags.
    const scoped = await put(app, "/profile?containerTag=work", JSON.stringify({ static: ["work fact"], dynamic: [] }));
    expect(scoped.status).toBe(200);
    expect(await (await app.request("/profile?containerTag=work")).json()).toEqual({ static: ["work fact"], dynamic: [] });
    expect(await (await app.request("/profile")).json()).toEqual({ static: ["likes tea"], dynamic: ["moved to Boulder"] });
    expect(Number((await sql`SELECT count(*)::int AS n FROM space`)[0]!.n)).toBe(2);
  } finally {
    await close();
  }
}, TEST_TIMEOUT_MS);

test("PUT /profile with an unparseable body stores an empty profile object (the catch -> {})", async () => {
  const { app, close } = await makeApp();
  try {
    const res = await put(app, "/profile", "{not json");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(await (await app.request("/profile")).json()).toEqual({}); // {} was stored, so {} comes back (not the null-fallback default)
  } finally {
    await close();
  }
}, TEST_TIMEOUT_MS);
