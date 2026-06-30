// memories.ts - direct write path (Spec 03, port of $V2).
import { Hono } from "hono";
import type { Db } from "./db";
import { type Embed, EMBED_DIM, isValidVector } from "./embed";

type Ctx = { db: Db; embed: Embed };
const ORG_ID = process.env.ORG_ID ?? "sm_default_org";

// 22-char id (nanoid-style). TODO: replace with a real nanoid(22).
const newId = () => Math.random().toString(36).slice(2).padEnd(22, "0").slice(0, 22);

export function memoriesRoutes({ db, embed }: Ctx) {
  const app = new Hono();

  // POST /memories
  app.post("/", async (c) => {
    const body = await c.req.json();
    const memories: any[] = body.memories ?? [];
    const containerTag: string = body.containerTag ?? process.env.DEFAULT_CONTAINER_TAG ?? "sm_project_default";
    if (!Array.isArray(memories) || memories.length < 1 || memories.length > 100) {
      return c.json({ error: "memories must be 1..100" }, 400);
    }

    // 1. upsert space -> spaceId  (TODO: real upsert + SpaceNotFoundError 404)
    const spaceId = newId();

    // 2. embed contents as documents
    const contents = memories.map((m) => String(m.content));
    const vectors = await embed({ values: contents, taskType: "RETRIEVAL_DOCUMENT" });

    // 3. build rows (skip invalid vectors)
    const rows = memories.flatMap((m, i) => {
      const v = vectors[i];
      if (!v || !isValidVector(v)) return [];
      const id = newId();
      return [{
        id, memory: contents[i], spaceId, orgId: ORG_ID, version: 1, isLatest: true,
        isStatic: !!m.isStatic, isForgotten: false, rootMemoryId: id, sourceCount: 1,
        metadata: m.metadata ?? null, forgetAfter: m.forgetAfter ?? null,
        forgetReason: m.forgetAfter ? (m.forgetReason ?? null) : null, embedding: v,
      }];
    });
    if (rows.length === 0) return c.json({ documentId: null, memories: [] }, 201);

    // 4. txn: synthetic document + memory rows + memory_document_source (TODO real SQL)
    // 5. upsert embeddings into vector index (TODO)
    void db; void EMBED_DIM;

    return c.json({
      documentId: newId(),
      memories: rows.map((r) => ({
        id: r.id, memory: r.memory, isStatic: r.isStatic,
        createdAt: new Date().toISOString(), forgetAfter: r.forgetAfter, forgetReason: r.forgetReason,
      })),
    }, 201);
  });

  // GET /memories, GET /:id, PATCH /:id, POST /:id/forget  (TODO Spec 03/08)
  return app;
}
