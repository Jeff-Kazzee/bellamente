// memories.ts - direct write path (Spec 03, clean-room port of the direct-create algorithm).
import { Hono } from "hono";
import type { DB } from "./db";
import { type Embed, isValidVector, embedModelName } from "./embed";
import { newId, toVector, ORG_ID, DEFAULT_CONTAINER_TAG } from "./util";

type Ctx = { sql: DB; embed: Embed };

export function memoriesRoutes({ sql, embed }: Ctx) {
  const app = new Hono();

  // POST /memories
  app.post("/", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const memories: any[] = body.memories ?? [];
    const containerTag: string = body.containerTag ?? DEFAULT_CONTAINER_TAG;
    if (!Array.isArray(memories) || memories.length < 1 || memories.length > 100) {
      return c.json({ error: "memories must be an array of 1..100 items" }, 400);
    }
    for (const m of memories) {
      if (typeof m?.content !== "string" || m.content.length < 1 || m.content.length > 10000) {
        return c.json({ error: "each memory.content must be a string of 1..10000 chars" }, 400);
      }
    }

    // 1. upsert space -> spaceId
    const [space] = await sql`
      INSERT INTO space (id, container_tag, org_id)
      VALUES (${newId()}, ${containerTag}, ${ORG_ID})
      ON CONFLICT (container_tag, org_id) DO UPDATE SET updated_at = now()
      RETURNING id`;
    const spaceId = space!.id as string;

    // 2. embed contents
    const contents = memories.map((m) => String(m.content));
    const vectors = await embed({ values: contents, taskType: "RETRIEVAL_DOCUMENT" });
    const model = embedModelName();

    // 3. build rows (skip invalid vectors)
    const rows = memories.flatMap((m, i) => {
      const v = vectors[i];
      if (!v || !isValidVector(v)) return [];
      const id = newId();
      const forgetAfter: string | null = m.forgetAfter ?? null;
      return [{
        id,
        memory: contents[i]!,
        isStatic: !!m.isStatic,
        metadata: m.metadata ?? null,
        forgetAfter,
        forgetReason: forgetAfter ? (m.forgetReason ?? null) : null,
        embedding: v,
      }];
    });
    if (rows.length === 0) return c.json({ documentId: null, memories: [] }, 201);

    // 4. one transaction: grouping document + memory rows + source links
    const docId = newId();
    const joined = contents.join("\n\n");
    const title = "Direct memories (" + rows.length + ")";
    await sql.begin(async (tx) => {
      await tx`
        INSERT INTO document (id, content, type, source, status, container_tags, title,
                              chunk_count, token_count, metadata, org_id)
        VALUES (${docId}, ${joined}, 'text', 'api', 'done', ${[containerTag]},
                ${title}, 0, 0, ${tx.json({ mm_direct_memory: true })}, ${ORG_ID})`;
      await tx`
        INSERT INTO documents_to_spaces (document_id, space_id)
        VALUES (${docId}, ${spaceId}) ON CONFLICT DO NOTHING`;
      for (const r of rows) {
        await tx`
          INSERT INTO memory_entry
            (id, org_id, space_id, memory, is_static, is_latest, version, root_memory_id,
             source_count, metadata, forget_after, forget_reason, memory_embedding, memory_embedding_model)
          VALUES
            (${r.id}, ${ORG_ID}, ${spaceId}, ${r.memory}, ${r.isStatic}, true, 1, ${r.id},
             1, ${r.metadata ? tx.json(r.metadata) : null}, ${r.forgetAfter}, ${r.forgetReason},
             ${toVector(r.embedding)}::vector, ${model})`;
        await tx`
          INSERT INTO memory_document_source (memory_entry_id, document_id, chunk_id, relevance_score)
          VALUES (${r.id}, ${docId}, ${null}, 100) ON CONFLICT DO NOTHING`;
      }
    });

    return c.json({
      documentId: docId,
      memories: rows.map((r) => ({
        id: r.id, memory: r.memory, isStatic: r.isStatic,
        createdAt: new Date().toISOString(), forgetAfter: r.forgetAfter, forgetReason: r.forgetReason,
      })),
    }, 201);
  });

  // GET /memories - list latest, non-forgotten
  app.get("/", async (c) => {
    const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 50), 1), 100);
    const rows = await sql`
      SELECT id, memory, is_static, version, created_at, forget_after
      FROM memory_entry
      WHERE org_id = ${ORG_ID} AND is_latest = true AND is_forgotten = false
      ORDER BY created_at DESC
      LIMIT ${limit}`;
    return c.json({ memories: rows });
  });

  return app;
}
