// documents.test.ts - the ingestion HTTP surface end-to-end: POST /documents populates the chunk
// table (the live populate path for document/hybrid search, previously unreachable), search finds the
// chunks, GET exposes them with quality flags, DELETE removes everything.
import { test, expect } from "bun:test";
import { Hono } from "hono";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";
import { makePgliteSql } from "../src/pg-shim";
import { schemaForDim } from "../src/db";
import { documentsRoutes } from "../src/documents";
import { searchRoutes } from "../src/search";
import { EMBED_DIM } from "../src/embed-common";
import type { Embed } from "../src/embed";

const TEST_TIMEOUT_MS = 20000;

// Same vector for every input: any query matches any chunk at cosine 1 (isValidVector needs real dims).
const unit = [1, ...new Array(EMBED_DIM - 1).fill(0)];
const embed: Embed = async ({ values }) => values.map(() => unit);

async function makeApp() {
  const pg = await PGlite.create({ dataDir: "memory://", extensions: { vector } });
  const sql = makePgliteSql(pg);
  await sql.unsafe(schemaForDim(EMBED_DIM));
  const ctx = { sql, embed };
  const app = new Hono();
  app.route("/documents", documentsRoutes(ctx));
  app.route("/search", searchRoutes(ctx));
  return { app, sql, close: () => sql.end() };
}

const MD = "# Setup\n\nInstall bun first.\n\n## Auth\n\nUse the bearer token from .env to call the API.\n";

test("ingest -> list -> detail -> search -> delete round trip", async () => {
  const { app, close } = await makeApp();
  try {
    // POST /documents ingests and reports chunking stats.
    const created = await app.request("/documents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Readme", content: MD, containerTag: "user_1", filepath: "README.md" }),
    });
    expect(created.status).toBe(201);
    const { documentId, chunkCount } = await created.json();
    expect(documentId).toBeTruthy();
    expect(chunkCount).toBeGreaterThan(0);

    // GET /documents lists it (direct-memory grouping docs are task_type='memory' and excluded).
    const list = await (await app.request("/documents")).json();
    expect(list.documents).toHaveLength(1);
    expect(list.documents[0]).toMatchObject({ id: documentId, title: "Readme", filepath: "README.md" });

    // GET /documents/:id exposes chunks with breadcrumb + flags — the inspection surface.
    const detail = await (await app.request(`/documents/${documentId}`)).json();
    expect(detail.chunks.length).toBe(chunkCount);
    expect(detail.chunks.some((ch: any) => ch.headingPath?.includes("Auth"))).toBe(true);

    // The chunk table is now actually populated by a live route: document search returns results.
    const found = await (await app.request("/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ q: "how do I authenticate", searchMode: "documents", threshold: 0.5, containerTag: "user_1" }),
    })).json();
    expect(found.results.length).toBeGreaterThan(0);
    expect(found.results[0]).toMatchObject({ type: "chunk", documentId });

    // DELETE removes the document AND its chunks; search over documents is empty again.
    const del = await app.request(`/documents/${documentId}`, { method: "DELETE" });
    expect(del.status).toBe(200);
    expect((await del.json()).chunksDeleted).toBe(chunkCount);
    const after = await (await app.request("/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ q: "how do I authenticate", searchMode: "documents", threshold: 0.5 }),
    })).json();
    expect(after.results).toHaveLength(0);
    expect((await app.request(`/documents/${documentId}`)).status).toBe(404);
  } finally {
    await close();
  }
}, TEST_TIMEOUT_MS);

test("validation: content required and bounded; bad ids rejected; unknown ids 404", async () => {
  const { app, close } = await makeApp();
  try {
    const missing = await app.request("/documents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "No content" }),
    });
    expect(missing.status).toBe(400);
    expect((await app.request("/documents/short-id")).status).toBe(400);
    expect((await app.request(`/documents/${"z".repeat(22)}`)).status).toBe(404);
    const delUnknown = await app.request(`/documents/${"z".repeat(22)}`, { method: "DELETE" });
    expect(delUnknown.status).toBe(404);
  } finally {
    await close();
  }
}, TEST_TIMEOUT_MS);
