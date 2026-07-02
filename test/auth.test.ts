// auth.test.ts - zero-config local auth (TDD, Jeff's call 2026-07-02): a local tool must work with
// NO .env and NO shared key. Loopback (the default bind) needs no key; exposing beyond loopback
// auto-generates one and requires it; BELLA_API_KEY always wins when set.
import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Hono } from "hono";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";
import { makePgliteSql } from "../src/pg-shim";
import { schemaForDim } from "../src/db";
import { resolveAuth, isLoopbackHost, bearerOk } from "../src/auth";
import { buildApp } from "../src/index";
import type { Embed } from "../src/embed";

const TEST_TIMEOUT_MS = 20000;
const embed: Embed = async ({ values }) => values.map(() => [1, 0, 0, 0]);

async function makeApp(auth: ReturnType<typeof resolveAuth>) {
  const pg = await PGlite.create({ dataDir: "memory://", extensions: { vector } });
  const sql = makePgliteSql(pg);
  await sql.unsafe(schemaForDim(4));
  const app: Hono = buildApp({ sql, embed } as any, auth);
  return { app, close: () => sql.end() };
}

test("isLoopbackHost: loopback shapes are local, everything else is exposed", () => {
  for (const h of ["127.0.0.1", "127.9.9.9", "localhost", "::1", "[::1]", ""]) {
    expect(isLoopbackHost(h)).toBe(true);
  }
  for (const h of ["0.0.0.0", "192.168.1.5", "10.0.0.2", "::", "example.com"]) {
    expect(isLoopbackHost(h)).toBe(false);
  }
});

test("no key + loopback host: auth is NOT required and the API answers without a bearer", async () => {
  delete process.env.BELLA_API_KEY;
  const auth = resolveAuth("127.0.0.1");
  expect(auth).toMatchObject({ required: false, key: null, source: "none" });

  const { app, close } = await makeApp(auth);
  try {
    const health = await (await app.request("/health")).json();
    expect(health).toMatchObject({ ok: true, service: "bellamente", auth: "none" });
    const res = await app.request("/memories"); // no Authorization header at all
    expect(res.status).toBe(200);
  } finally {
    await close();
  }
}, TEST_TIMEOUT_MS);

test("BELLA_API_KEY set: auth required regardless of host; wrong/missing bearer 401, right one 200", async () => {
  process.env.BELLA_API_KEY = "jeff-secret-1";
  try {
    const auth = resolveAuth("127.0.0.1");
    expect(auth).toMatchObject({ required: true, key: "jeff-secret-1", source: "env" });

    const { app, close } = await makeApp(auth);
    try {
      const health = await (await app.request("/health")).json();
      expect(health.auth).toBe("required");
      expect((await app.request("/memories")).status).toBe(401);
      expect((await app.request("/memories", { headers: { authorization: "Bearer wrong" } })).status).toBe(401);
      expect((await app.request("/memories", { headers: { authorization: "Bearer jeff-secret-1" } })).status).toBe(200);
    } finally {
      await close();
    }
  } finally {
    delete process.env.BELLA_API_KEY;
  }
}, TEST_TIMEOUT_MS);

test("no key + exposed host: a key is auto-generated, persisted, reused, and REQUIRED", async () => {
  delete process.env.BELLA_API_KEY;
  const dir = mkdtempSync(join(tmpdir(), "bella-auth-"));
  try {
    const auth = resolveAuth("0.0.0.0", { dataDir: dir });
    expect(auth.required).toBe(true);
    expect(auth.source).toBe("generated");
    expect(auth.key).toBeTruthy();
    expect(auth.key!.length).toBeGreaterThanOrEqual(24);

    // persisted to <data>/apikey and stable across boots
    expect(readFileSync(join(dir, "apikey"), "utf8").trim()).toBe(auth.key!);
    const again = resolveAuth("0.0.0.0", { dataDir: dir });
    expect(again.key).toBe(auth.key);

    const { app, close } = await makeApp(auth);
    try {
      expect((await app.request("/memories")).status).toBe(401);
      expect((await app.request("/memories", { headers: { authorization: `Bearer ${auth.key}` } })).status).toBe(200);
    } finally {
      await close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, TEST_TIMEOUT_MS);

test("bearerOk: constant-shape compare accepts only the exact bearer", () => {
  expect(bearerOk("Bearer abc", "abc")).toBe(true);
  expect(bearerOk("Bearer ab", "abc")).toBe(false);
  expect(bearerOk("Bearer abcd", "abc")).toBe(false);
  expect(bearerOk("", "abc")).toBe(false);
});
