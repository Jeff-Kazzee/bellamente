// documents.ts - document ingestion: chunk -> embed chunks -> store (Spec 05), plus the HTTP surface
// (POST/GET/DELETE /documents). task_type='superrag' (chunked + searchable, no memory extraction).
// Direct-memory grouping documents (task_type='memory', created by POST /memories) are NOT listed
// here — they are provenance records, not user documents.
import { Hono } from "hono";
import type { DB } from "./db";
import { type Embed, isValidVector, embedModelName } from "./embed";
import { chunkMarkdown, type ChunkOptions } from "./chunk";
import { newId, toVector, ORG_ID, DEFAULT_CONTAINER_TAG } from "./util";

type Ctx = { sql: DB; embed: Embed };

const ID_RE = /^[0-9A-Za-z]{22}$/;
const MAX_CONTENT_CHARS = 2_000_000;

export type IngestInput = {
  title: string;
  content: string;
  filepath?: string;
  containerTag: string;
  chunkOptions?: ChunkOptions;
};

export async function ingestDocument(
  { sql, embed }: Ctx,
  input: IngestInput,
): Promise<{ documentId: string; chunkCount: number; skippedChunks: number; flags: Record<string, number> }> {
  const [space] = await sql`
    INSERT INTO space (id, container_tag, org_id)
    VALUES (${newId()}, ${input.containerTag}, ${ORG_ID})
    ON CONFLICT (container_tag, org_id) DO UPDATE SET updated_at = now()
    RETURNING id`;
  const spaceId = space!.id as string;

  const chunks = chunkMarkdown(input.content, input.chunkOptions);
  const flags: Record<string, number> = {};
  for (const c of chunks) for (const f of c.flags) flags[f] = (flags[f] ?? 0) + 1;

  const docId = newId();
  const model = embedModelName();
  // Embed the heading-breadcrumbed text; store raw content for display.
  const vectors = chunks.length
    ? await embed({ values: chunks.map((c) => c.embeddedContent), taskType: "RETRIEVAL_DOCUMENT" })
    : [];

  // A chunk whose embedding is missing/invalid is dropped — its text is unsearchable — so chunk_count
  // must reflect what was actually INSERTED, not the pre-embed count, and the drop must be surfaced (#125).
  const embedded = chunks.flatMap((c, i) => {
    const v = vectors[i];
    return v && isValidVector(v) ? [{ c, v }] : [];
  });
  const skippedChunks = chunks.length - embedded.length;

  await sql.begin(async (tx) => {
    await tx`
      INSERT INTO document (id, content, type, source, status, task_type, container_tags,
                            filepath, chunk_count, title, metadata, org_id)
      VALUES (${docId}, ${input.content}, 'text', 'file', 'done', 'superrag', ${[input.containerTag]},
              ${input.filepath ?? null}, ${embedded.length}, ${input.title}, ${tx.json({ rag: true })}, ${ORG_ID})`;
    await tx`
      INSERT INTO documents_to_spaces (document_id, space_id)
      VALUES (${docId}, ${spaceId}) ON CONFLICT DO NOTHING`;
    for (const { c, v } of embedded) {
      await tx`
        INSERT INTO chunk (id, document_id, content, embedded_content, position, type,
                           metadata, embedding, embedding_model)
        VALUES (${newId()}, ${docId}, ${c.content}, ${c.embeddedContent}, ${c.position}, 'text',
                ${tx.json({ headingPath: c.headingPath, flags: c.flags })},
                ${toVector(v)}::vector, ${model})`;
    }
  });

  return { documentId: docId, chunkCount: embedded.length, skippedChunks, flags };
}

export function documentsRoutes(ctx: Ctx) {
  const { sql } = ctx;
  const app = new Hono();

  // POST /documents - ingest one markdown/text document; chunks become searchable via
  // /search {searchMode:"documents"|"hybrid"}.
  app.post("/", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    if (typeof body.content !== "string" || body.content.length < 1 || body.content.length > MAX_CONTENT_CHARS) {
      return c.json({ error: `content must be a string of 1..${MAX_CONTENT_CHARS} chars` }, 400);
    }
    const title = typeof body.title === "string" && body.title.trim() ? body.title.trim() : "Untitled";
    const containerTag = typeof body.containerTag === "string" && body.containerTag ? body.containerTag : DEFAULT_CONTAINER_TAG;
    const result = await ingestDocument(ctx, {
      title,
      content: body.content,
      filepath: typeof body.filepath === "string" ? body.filepath : undefined,
      containerTag,
      chunkOptions: body.chunkOptions,
    });
    return c.json(result, 201);
  });

  // GET /documents - list ingested documents (newest first).
  app.get("/", async (c) => {
    const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 50), 1), 200);
    const rows = await sql`
      SELECT id, title, filepath, source, status, chunk_count, container_tags, created_at
      FROM document
      WHERE org_id = ${ORG_ID} AND task_type = 'superrag'
      ORDER BY created_at DESC
      LIMIT ${limit}`;
    return c.json({ documents: rows });
  });

  // GET /documents/:id - one document + its chunks (with quality flags — the inspection surface).
  app.get("/:id", async (c) => {
    const id = c.req.param("id");
    if (!ID_RE.test(id)) return c.json({ error: "invalid document id" }, 400);
    const [doc] = await sql`
      SELECT id, title, filepath, source, status, task_type, chunk_count, container_tags, metadata, created_at
      FROM document WHERE org_id = ${ORG_ID} AND id = ${id} LIMIT 1`;
    if (!doc) return c.json({ error: "DocumentNotFound" }, 404);
    const chunks = await sql`
      SELECT id, position, content, metadata FROM chunk WHERE document_id = ${id} ORDER BY position ASC`;
    return c.json({
      document: doc,
      chunks: chunks.map((ch) => ({
        id: ch.id,
        position: Number(ch.position),
        content: ch.content,
        headingPath: (ch.metadata?.headingPath as string) ?? null,
        flags: (ch.metadata?.flags as string[]) ?? [],
      })),
    });
  });

  // DELETE /documents/:id - hard-delete the document, its chunks, space links, and any
  // memory-provenance links that pointed at it (the memories themselves are NOT touched).
  app.delete("/:id", async (c) => {
    const id = c.req.param("id");
    if (!ID_RE.test(id)) return c.json({ error: "invalid document id" }, 400);
    const [doc] = await sql`SELECT id FROM document WHERE org_id = ${ORG_ID} AND id = ${id} LIMIT 1`;
    if (!doc) return c.json({ error: "DocumentNotFound" }, 404);
    const chunkCount = await sql.begin(async (tx) => {
      const deletedChunks = await tx`DELETE FROM chunk WHERE document_id = ${id} RETURNING id`;
      await tx`DELETE FROM documents_to_spaces WHERE document_id = ${id}`;
      await tx`DELETE FROM memory_document_source WHERE document_id = ${id}`;
      await tx`DELETE FROM document WHERE org_id = ${ORG_ID} AND id = ${id}`;
      return deletedChunks.length;
    });
    return c.json({ deleted: true, chunksDeleted: chunkCount });
  });

  return app;
}
