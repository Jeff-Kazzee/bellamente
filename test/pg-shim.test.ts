// Validates the REAL pg-shim `sql` surface (not compose() in isolation) against an in-memory PGlite:
// the dual-nature thenable Frag (lazy / interpolate-vs-await / single-execution), begin/tx.json,
// rollback, nested fragments, json + array params, and concurrency (PGlite is one serialized connection).
import { test, expect, beforeAll, afterAll } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";
import { makePgliteSql, compose, type Sql } from "../src/pg-shim";

let pg: PGlite;
let sql: Sql;

beforeAll(async () => {
  pg = await PGlite.create({ dataDir: "memory://", extensions: { vector } });
  sql = makePgliteSql(pg);
  await sql.unsafe(`
    CREATE EXTENSION IF NOT EXISTS vector;
    DO $$ BEGIN CREATE TYPE tt AS ENUM ('a','b'); EXCEPTION WHEN duplicate_object THEN null; END $$;
    CREATE TABLE t (id text primary key, tags text[], meta json, emb vector(4), n int default 0);`);
});
afterAll(async () => { await sql.end(); });

test("tagged template resolves to an array of plain row objects", async () => {
  const rows = await sql<{ a: number; b: string }>`select ${1}::int as a, ${"x"} as b`;
  expect(rows).toEqual([{ a: 1, b: "x" }]);
});

test("RETURNING + destructure first row", async () => {
  const [row] = await sql`INSERT INTO t (id) VALUES (${"ret1"}) RETURNING id`;
  expect(row.id).toBe("ret1");
});

test("nested fragments: empty + param-bearing between params -> correct $N", async () => {
  await sql`INSERT INTO t (id, meta) VALUES (${"f1"}, ${sql.json({ k: 1 })})`;
  const empty = sql``;
  const cond = sql`AND meta IS NOT NULL`;
  const idClause = sql`AND id = ${"f1"}`;
  const rows = await sql`SELECT id FROM t WHERE 1=1 ${cond} ${empty} ${idClause} ${empty}`;
  expect(rows.map((r) => r.id)).toEqual(["f1"]);
});

test("compose() renumbers nested-fragment $N sequentially", () => {
  const frag = sql`AND id = ${"z"}`;
  const { text, params } = compose(["SELECT * FROM t WHERE x = ", " ", ""] as any, ["a", frag]);
  expect(text).toBe("SELECT * FROM t WHERE x = $1 AND id = $2");
  expect(params).toEqual(["a", "z"]);
});

test("multi-param nested fragment renumbers $N across the whole query (the crux)", async () => {
  await sql`INSERT INTO t (id, tags, meta) VALUES (${"mp1"}, ${["red", "blue"]}, ${sql.json({ ok: 1 })})`;
  const frag = sql`AND tags @> ARRAY[${"red"}]::text[] AND meta IS NOT NULL AND id <> ${"zzz"}`;
  const rows = await sql`SELECT id FROM t WHERE id = ${"mp1"} ${frag}`;
  expect(rows.map((r) => r.id)).toEqual(["mp1"]);
  const { text, params } = compose(["SELECT id FROM t WHERE id = ", " ", ""] as any, ["mp1", frag]);
  expect(text).toBe("SELECT id FROM t WHERE id = $1 AND tags @> ARRAY[$2]::text[] AND meta IS NOT NULL AND id <> $3");
  expect(params).toEqual(["mp1", "red", "zzz"]);
});

test("mixed json param + raw null in one statement (distinct paramTypes)", async () => {
  await sql`INSERT INTO t (id, meta, tags) VALUES (${"mix1"}, ${sql.json({ a: 1 })}, ${null})`;
  const [r] = await sql`SELECT meta, tags FROM t WHERE id = ${"mix1"}`;
  expect(r.meta).toEqual({ a: 1 });
  expect(r.tags).toBeNull();
});

test("sql.json param -> json column; result parsed back to an object", async () => {
  await sql`INSERT INTO t (id, meta) VALUES (${"j1"}, ${sql.json({ nested: { a: 1 }, arr: [1, 2] })})`;
  const [row] = await sql`SELECT meta FROM t WHERE id = ${"j1"}`;
  expect(row.meta).toEqual({ nested: { a: 1 }, arr: [1, 2] });
});

test("JS array -> Postgres array param (text[] col, no cast) + ANY($1::text[])", async () => {
  await sql`INSERT INTO t (id, tags) VALUES (${"arr1"}, ${["p", "q"]})`;
  const [row] = await sql`SELECT tags FROM t WHERE id = ${"arr1"}`;
  expect(row.tags).toEqual(["p", "q"]);
  const rows = await sql`SELECT id FROM t WHERE id = ANY(${["arr1", "nope"]}::text[])`;
  expect(rows.map((r) => r.id)).toEqual(["arr1"]);
});

test("vector text-literal param + <=> cosine", async () => {
  await sql`INSERT INTO t (id, emb) VALUES (${"v1"}, ${"[0.1,0.2,0.3,0.4]"}::vector)`;
  const [row] = await sql`SELECT id, 1 - (emb <=> ${"[0.1,0.2,0.3,0.4]"}::vector) AS sim
                          FROM t WHERE emb IS NOT NULL ORDER BY emb <=> ${"[0.1,0.2,0.3,0.4]"}::vector LIMIT 1`;
  expect(row.id).toBe("v1");
  expect(Number(row.sim)).toBeGreaterThan(0.99);
});

test("a fragment is lazy: interpolating it does NOT execute it", async () => {
  // If interpolation executed this INSERT, a 'lazy1' row would appear. It must not.
  const sideEffect = sql`INSERT INTO t (id) VALUES (${"lazy1"})`;
  void sideEffect; // created but never awaited nor interpolated-and-run
  const [{ c }] = await sql`SELECT count(*)::int AS c FROM t WHERE id = ${"lazy1"}`;
  expect(c).toBe(0);
});

test("a query executes exactly once even if awaited twice (memoized)", async () => {
  const q = sql`INSERT INTO t (id, n) VALUES (${"once1"}, 1) RETURNING id`;
  const [a, b] = await Promise.all([q, q]);
  expect(a[0].id).toBe("once1");
  expect(b[0].id).toBe("once1");
  const [{ c }] = await sql`SELECT count(*)::int AS c FROM t WHERE id = ${"once1"}`;
  expect(c).toBe(1); // one physical INSERT despite two awaits
});

test("sql.begin commits; tx is a template fn with tx.json", async () => {
  await sql.begin(async (tx) => {
    await tx`INSERT INTO t (id, meta) VALUES (${"tx1"}, ${tx.json({ ok: true })})`;
    await tx`INSERT INTO t (id) VALUES (${"tx2"})`;
  });
  const [{ c }] = await sql`SELECT count(*)::int AS c FROM t WHERE id IN (${"tx1"}, ${"tx2"})`;
  expect(c).toBe(2);
  const [row] = await sql`SELECT meta FROM t WHERE id = ${"tx1"}`;
  expect(row.meta).toEqual({ ok: true });
});

test("sql.begin rolls back on throw (durability/atomicity)", async () => {
  await expect(
    sql.begin(async (tx) => {
      await tx`INSERT INTO t (id) VALUES (${"rb1"})`;
      throw new Error("boom");
    }),
  ).rejects.toThrow("boom");
  const [{ c }] = await sql`SELECT count(*)::int AS c FROM t WHERE id = ${"rb1"}`;
  expect(c).toBe(0); // rolled back
});

test("concurrency: Promise.all of a transaction + reads does not deadlock", async () => {
  const results = await Promise.all([
    sql.begin(async (tx) => { await tx`INSERT INTO t (id) VALUES (${"cc1"})`; return "tx-done"; }),
    sql`SELECT 1 AS a`,
    sql`SELECT 2 AS a`,
    sql`SELECT 3 AS a`,
  ]);
  expect(results[0]).toBe("tx-done");
  expect((results[1] as any[])[0].a).toBe(1);
  expect((results[3] as any[])[0].a).toBe(3);
  const [{ c }] = await sql`SELECT count(*)::int AS c FROM t WHERE id = ${"cc1"}`;
  expect(c).toBe(1);
});

test("sql.unsafe runs a multi-statement batch incl DO $$ block", async () => {
  await sql.unsafe(`
    DO $$ BEGIN CREATE TYPE tt2 AS ENUM ('x'); EXCEPTION WHEN duplicate_object THEN null; END $$;
    CREATE TABLE IF NOT EXISTS u (id int);
    INSERT INTO u VALUES (1),(2);`);
  const [{ c }] = await sql`SELECT count(*)::int AS c FROM u`;
  expect(c).toBe(2);
});
