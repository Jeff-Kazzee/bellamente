// memories.ts - the memory lifecycle: write (with dedup/supersede), read, edit (versioned), forget, delete.
//
// Write semantics (POST /):
//  - EXACT duplicate (same text, same space, latest & not forgotten) -> no new row, action "unchanged".
//  - NEAR duplicate (cosine >= supersedeThreshold() against the closest latest memory) -> a NEW VERSION
//    superseding the old one: old row keeps its content but flips is_latest=false; the new row records
//    parent_memory_id / root_memory_id / memory_relations {updates:[old]}. Contradictions ("prefers dark
//    mode" -> "prefers light mode") land here on purpose: newest wins, the old version stays inspectable.
//  - Otherwise -> action "created" (plain insert, version 1, its own chain root).
//  Send { dedupe: false } to bypass both checks (bulk imports, restores).
//
// The version chain is the trust story: nothing is silently overwritten or silently dropped — every
// correction is a new version, every forget is a flag, and only DELETE /:id physically removes rows.
import { Hono } from "hono";
import type { DB } from "./db";
import type { Tx } from "./pg-shim";
import { type Embed, isValidVector, embedModelName } from "./embed";
import { PROVIDER, profile } from "./embed-common";
import { estimateTokens, EMBED_TOKEN_BUDGET } from "./chunk";
import { newId, toVector, ORG_ID, DEFAULT_CONTAINER_TAG } from "./util";
import { brandEnv } from "./env";

type Ctx = { sql: DB; embed: Embed };

const ID_RE = /^[0-9A-Za-z]{22}$/;

// Near-duplicate floor for supersede-on-write. Engine-aware: transformer embeddings (e5/bge; OpenAI is
// on the same scale) put paraphrases ~0.95+; static Model2Vec vectors are weaker separators, so require
// near-identity (0.98) there rather than risk superseding unrelated facts. BELLA_SUPERSEDE_THRESHOLD
// overrides; read per-call so tests/live processes can tune without a restart.
const DEFAULT_SUPERSEDE_THRESHOLD = PROVIDER === "openai" || profile.engine === "wasm" ? 0.95 : 0.98;
export function supersedeThreshold(): number {
  const raw = Number(brandEnv("SUPERSEDE_THRESHOLD"));
  if (Number.isFinite(raw) && raw > 0 && raw <= 1) return raw;
  return DEFAULT_SUPERSEDE_THRESHOLD;
}

const toIso = (v: unknown): string => (v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString());

// forget_after used to be enforced only as a read-time filter — expired memories stayed
// is_forgotten=false forever, invisible in search but "alive" everywhere else. The sweep makes expiry
// durable state. Called at boot + on an interval from index.ts main().
export async function sweepExpiredMemories(sql: DB): Promise<number> {
  const rows = await sql`
    UPDATE memory_entry
    SET is_forgotten = true, forget_reason = COALESCE(forget_reason, 'forget_after expired'), updated_at = now()
    WHERE org_id = ${ORG_ID} AND is_forgotten = false AND forget_after IS NOT NULL AND forget_after <= now()
    RETURNING id`;
  if (rows.length) console.log(`[memories] forget_after sweep: forgot ${rows.length} expired memories`);
  return rows.length;
}

function normalizeMemory(r: any) {
  return {
    id: r.id,
    memory: r.memory,
    version: Number(r.version),
    isLatest: !!r.is_latest,
    isStatic: !!r.is_static,
    isForgotten: !!r.is_forgotten,
    parentMemoryId: r.parent_memory_id ?? null,
    rootMemoryId: r.root_memory_id ?? null,
    forgetAfter: r.forget_after ?? null,
    forgetReason: r.forget_reason ?? null,
    metadata: r.metadata ?? null,
    createdAt: toIso(r.created_at),
    updatedAt: toIso(r.updated_at),
  };
}

async function loadMemory(sql: DB, id: string) {
  const rows = await sql`SELECT * FROM memory_entry WHERE org_id = ${ORG_ID} AND id = ${id} LIMIT 1`;
  return rows[0] ?? null;
}

// All rows in a memory's version chain (the row's root, plus every row rooted there).
async function chainIds(sql: DB, row: any): Promise<string[]> {
  const root = row.root_memory_id ?? row.id;
  const rows = await sql`
    SELECT id FROM memory_entry
    WHERE org_id = ${ORG_ID} AND (root_memory_id = ${root} OR id = ${root})`;
  return rows.map((r) => r.id as string);
}

type WriteAction = "created" | "superseded" | "unchanged" | "updated";
type WriteResult = { id: string; action: WriteAction; version: number; supersededId?: string };
type ProvidedFields = { isStatic: boolean; metadata: boolean; forgetAfter: boolean; forgetReason: boolean };

// One memory write inside an open transaction: exact-dup check, near-dup supersede, or plain insert.
// Runs PER ITEM inside the batch transaction so items in the same request dedupe against each other.
async function writeMemory(
  tx: Tx,
  args: {
    spaceId: string;
    content: string;
    isStatic: boolean;
    isInference: boolean;
    metadata: unknown;
    forgetAfter: string | null;
    forgetReason: string | null;
    embedding: number[];
    model: string;
    dedupe: boolean;
    provided: ProvidedFields;
  },
): Promise<WriteResult> {
  const v = toVector(args.embedding);
  if (args.dedupe) {
    // md5 prefilter lets the partial expression index (migration 002) satisfy the lookup; the direct
    // text equality stays as the actual correctness check (md5 collisions are theoretical, but free
    // to guard against).
    const [exact] = await tx`
      SELECT id, version, is_static, metadata, forget_after, forget_reason FROM memory_entry
      WHERE org_id = ${ORG_ID} AND space_id = ${args.spaceId} AND is_latest = true
        AND is_forgotten = false AND md5(memory) = md5(${args.content}) AND memory = ${args.content}
      LIMIT 1`;
    if (exact) {
      // An exact-content resubmission may still carry NEW flags (the natural "refresh this fact's
      // expiry" pattern). Silently dropping them while echoing them back lied to the caller — apply
      // whatever was explicitly provided and report action "updated"; a bare resubmit stays "unchanged".
      const p = args.provided;
      if (!(p.isStatic || p.metadata || p.forgetAfter || p.forgetReason)) {
        return { id: exact.id, action: "unchanged", version: Number(exact.version) };
      }
      const isStatic = p.isStatic ? args.isStatic : !!exact.is_static;
      const metadata = p.metadata ? args.metadata : exact.metadata;
      const forgetAfter = p.forgetAfter ? args.forgetAfter : exact.forget_after;
      const forgetReason = p.forgetReason ? args.forgetReason : exact.forget_reason;
      await tx`
        UPDATE memory_entry
        SET is_static = ${isStatic}, metadata = ${metadata ? tx.json(metadata) : null},
            forget_after = ${forgetAfter}, forget_reason = ${forgetReason}, updated_at = now()
        WHERE id = ${exact.id}`;
      return { id: exact.id, action: "updated", version: Number(exact.version) };
    }

    const [nearest] = await tx`
      SELECT id, version, root_memory_id, source_count, 1 - (memory_embedding <=> ${v}::vector) AS similarity
      FROM memory_entry
      WHERE org_id = ${ORG_ID} AND space_id = ${args.spaceId} AND is_latest = true
        AND is_forgotten = false AND memory_embedding IS NOT NULL
      ORDER BY memory_embedding <=> ${v}::vector
      LIMIT 1`;
    if (nearest && Number(nearest.similarity) >= supersedeThreshold()) {
      const id = newId();
      const root = nearest.root_memory_id ?? nearest.id;
      // source_count = old + 1: a near-duplicate write is a RE-OBSERVATION of the fact, and the count
      // survives the version chain as a reinforcement signal (PATCH corrections carry it unchanged).
      await tx`
        INSERT INTO memory_entry
          (id, org_id, space_id, memory, is_static, is_inference, is_latest, version, parent_memory_id, root_memory_id,
           source_count, memory_relations, metadata, forget_after, forget_reason, memory_embedding, memory_embedding_model)
        VALUES
          (${id}, ${ORG_ID}, ${args.spaceId}, ${args.content}, ${args.isStatic}, ${args.isInference}, true, ${Number(nearest.version) + 1},
           ${nearest.id}, ${root}, ${Number(nearest.source_count ?? 1) + 1}, ${tx.json({ updates: [nearest.id] })},
           ${args.metadata ? tx.json(args.metadata) : null}, ${args.forgetAfter}, ${args.forgetReason},
           ${v}::vector, ${args.model})`;
      await tx`UPDATE memory_entry SET is_latest = false, updated_at = now() WHERE id = ${nearest.id}`;
      return { id, action: "superseded", version: Number(nearest.version) + 1, supersededId: nearest.id };
    }
  }

  const id = newId();
  await tx`
    INSERT INTO memory_entry
      (id, org_id, space_id, memory, is_static, is_inference, is_latest, version, root_memory_id,
       source_count, metadata, forget_after, forget_reason, memory_embedding, memory_embedding_model)
    VALUES
      (${id}, ${ORG_ID}, ${args.spaceId}, ${args.content}, ${args.isStatic}, ${args.isInference}, true, 1, ${id},
       1, ${args.metadata ? tx.json(args.metadata) : null}, ${args.forgetAfter}, ${args.forgetReason},
       ${v}::vector, ${args.model})`;
  return { id, action: "created", version: 1 };
}

// The storage-layer write path: space upsert -> batch embed -> per-item dedup/supersede inside one
// transaction -> grouping document + provenance. The HTTP route is a thin wrapper; other writers
// (proxy auto-capture, the future MCP server) call THIS so every write gets identical guarantees.
export type WriteMemoryItem = {
  content: string;
  isStatic?: boolean;
  isInference?: boolean;
  metadata?: unknown;
  forgetAfter?: string | null;
  forgetReason?: string | null;
};
export type WrittenMemory = WriteResult & {
  content: string;
  isStatic: boolean;
  forgetAfter: string | null;
  forgetReason: string | null;
  embedTruncated: boolean;
};

export async function writeMemories(
  { sql, embed }: Ctx,
  args: {
    containerTag: string;
    items: WriteMemoryItem[];
    dedupe?: boolean;
    documentSource?: string; // provenance tag on the grouping document ('api' | 'proxy_capture' | ...)
    documentTitle?: string;
  },
): Promise<{ documentId: string | null; results: WrittenMemory[] }> {
  const dedupe = args.dedupe !== false;

  // 1. upsert space -> spaceId
  const [space] = await sql`
    INSERT INTO space (id, container_tag, org_id)
    VALUES (${newId()}, ${args.containerTag}, ${ORG_ID})
    ON CONFLICT (container_tag, org_id) DO UPDATE SET updated_at = now()
    RETURNING id`;
  const spaceId = space!.id as string;

  // 2. embed contents
  const contents = args.items.map((m) => String(m.content));
  const vectors = await embed({ values: contents, taskType: "RETRIEVAL_DOCUMENT" });
  const model = embedModelName();

  // 3. build inputs (skip invalid vectors)
  const inputs = args.items.flatMap((m, i) => {
    const v = vectors[i];
    if (!v || !isValidVector(v)) return [];
    const forgetAfter: string | null = m.forgetAfter ?? null;
    return [{
      content: contents[i]!,
      isStatic: !!m.isStatic,
      isInference: !!m.isInference,
      metadata: m.metadata ?? null,
      forgetAfter,
      forgetReason: forgetAfter ? (m.forgetReason ?? null) : null,
      embedding: v,
      // Which fields the caller EXPLICITLY sent — an exact-dup hit applies these to the existing
      // row instead of silently dropping them (see writeMemory).
      provided: {
        isStatic: m.isStatic !== undefined,
        metadata: m.metadata !== undefined,
        forgetAfter: m.forgetAfter !== undefined,
        forgetReason: m.forgetReason !== undefined,
      },
      // Memories are embedded whole (never chunked); past the embedder's token limit the tail is
      // truncated at embed time. Surface it — silently pretending the whole text is searchable
      // is the failure mode this repo keeps hunting.
      embedTruncated: estimateTokens(contents[i]!) > EMBED_TOKEN_BUDGET,
    }];
  });
  if (inputs.length === 0) return { documentId: null, results: [] };

  // 4. one transaction: per-item write (sequential, so in-batch items dedupe against each other),
  //    then a grouping document + provenance links for the rows that actually landed.
  const docId = newId();
  const out = await sql.begin(async (tx) => {
    const results: WrittenMemory[] = [];
    let wrote = 0;
    for (const input of inputs) {
      const r = await writeMemory(tx, { spaceId, model, dedupe, ...input });
      results.push({
        ...r,
        content: input.content,
        isStatic: input.isStatic,
        forgetAfter: input.forgetAfter,
        forgetReason: input.forgetReason,
        embedTruncated: input.embedTruncated,
      });
      if (r.action !== "unchanged") wrote++;
    }
    const written = results.filter((r) => r.action !== "unchanged");
    if (wrote > 0) {
      const joined = written.map((r) => r.content).join("\n\n");
      await tx`
        INSERT INTO document (id, content, type, source, status, container_tags, title,
                              chunk_count, token_count, metadata, org_id)
        VALUES (${docId}, ${joined}, 'text', ${args.documentSource ?? "api"}, 'done', ${[args.containerTag]},
                ${args.documentTitle ?? "Direct memories (" + written.length + ")"}, 0, 0,
                ${tx.json({ eu_direct_memory: true })}, ${ORG_ID})`;
      await tx`
        INSERT INTO documents_to_spaces (document_id, space_id)
        VALUES (${docId}, ${spaceId}) ON CONFLICT DO NOTHING`;
      for (const r of written) {
        await tx`
          INSERT INTO memory_document_source (memory_entry_id, document_id, chunk_id, relevance_score)
          VALUES (${r.id}, ${docId}, ${null}, 100) ON CONFLICT DO NOTHING`;
      }
    }
    return { results, wroteDocument: wrote > 0 };
  });

  return { documentId: out.wroteDocument ? docId : null, results: out.results };
}

export function memoriesRoutes(ctx: Ctx) {
  const { sql, embed } = ctx;
  const app = new Hono();

  // POST /memories - write 1..100 memories with dedup/supersede (see header).
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

    const { documentId, results } = await writeMemories(ctx, {
      containerTag,
      dedupe: body.dedupe !== false,
      items: memories,
    });

    return c.json({
      documentId,
      memories: results.map((r) => ({
        id: r.id,
        memory: r.content,
        isStatic: r.isStatic,
        action: r.action,
        version: r.version,
        ...(r.supersededId ? { supersededId: r.supersededId } : {}),
        ...(r.embedTruncated ? { embedTruncated: true } : {}),
        createdAt: new Date().toISOString(),
        forgetAfter: r.forgetAfter,
        forgetReason: r.forgetReason,
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

  // GET /memories/:id - one memory + its full version chain (any version, forgotten included: this is
  // the inspection surface, so nothing is hidden here).
  app.get("/:id", async (c) => {
    const id = c.req.param("id");
    if (!ID_RE.test(id)) return c.json({ error: "invalid memory id" }, 400);
    const row = await loadMemory(sql, id);
    if (!row) return c.json({ error: "MemoryNotFound" }, 404);
    const root = row.root_memory_id ?? row.id;
    const chain = await sql`
      SELECT * FROM memory_entry
      WHERE org_id = ${ORG_ID} AND (root_memory_id = ${root} OR id = ${root})
      ORDER BY version ASC, created_at ASC`;
    return c.json({ memory: normalizeMemory(row), versions: chain.map(normalizeMemory) });
  });

  // PATCH /memories/:id - correct a memory. A content change writes a NEW VERSION (chain preserved);
  // flag-only changes (isStatic/metadata/forgetAfter/forgetReason) update in place.
  app.patch("/:id", async (c) => {
    const id = c.req.param("id");
    if (!ID_RE.test(id)) return c.json({ error: "invalid memory id" }, 400);
    const body = await c.req.json().catch(() => ({}));
    const hasContent = body.content !== undefined;
    const hasFlags =
      body.isStatic !== undefined || body.metadata !== undefined ||
      body.forgetAfter !== undefined || body.forgetReason !== undefined;
    if (!hasContent && !hasFlags) {
      return c.json({ error: "nothing to update: send content, isStatic, metadata, forgetAfter, or forgetReason" }, 400);
    }
    if (hasContent && (typeof body.content !== "string" || body.content.length < 1 || body.content.length > 10000)) {
      return c.json({ error: "content must be a string of 1..10000 chars" }, 400);
    }

    const row = await loadMemory(sql, id);
    if (!row) return c.json({ error: "MemoryNotFound" }, 404);
    if (!row.is_latest) {
      const root = row.root_memory_id ?? row.id;
      const [latest] = await sql`
        SELECT id FROM memory_entry
        WHERE org_id = ${ORG_ID} AND (root_memory_id = ${root} OR id = ${root}) AND is_latest = true
        LIMIT 1`;
      return c.json({ error: "memory is not the latest version; edit the latest instead", latestId: latest?.id ?? null }, 409);
    }

    const isStatic = body.isStatic !== undefined ? !!body.isStatic : !!row.is_static;
    const metadata = body.metadata !== undefined ? body.metadata : row.metadata;
    const forgetAfter = body.forgetAfter !== undefined ? body.forgetAfter : row.forget_after;
    const forgetReason = body.forgetReason !== undefined ? body.forgetReason : row.forget_reason;

    if (hasContent && body.content !== row.memory) {
      const [vec] = await embed({ values: [body.content], taskType: "RETRIEVAL_DOCUMENT" });
      if (!vec || !isValidVector(vec)) return c.json({ error: "content could not be embedded" }, 422);
      const newVersionId = newId();
      const root = row.root_memory_id ?? row.id;
      await sql.begin(async (tx) => {
        await tx`
          INSERT INTO memory_entry
            (id, org_id, space_id, memory, is_static, is_latest, version, parent_memory_id, root_memory_id,
             source_count, memory_relations, metadata, forget_after, forget_reason, memory_embedding, memory_embedding_model)
          VALUES
            (${newVersionId}, ${ORG_ID}, ${row.space_id}, ${body.content}, ${isStatic}, true, ${Number(row.version) + 1},
             ${row.id}, ${root}, ${Number(row.source_count ?? 1)}, ${tx.json({ updates: [row.id] })},
             ${metadata ? tx.json(metadata) : null}, ${forgetAfter}, ${forgetReason},
             ${toVector(vec)}::vector, ${embedModelName()})`;
        await tx`UPDATE memory_entry SET is_latest = false, updated_at = now() WHERE id = ${row.id}`;
      });
      const created = await loadMemory(sql, newVersionId);
      return c.json({
        memory: normalizeMemory(created),
        action: "versioned",
        supersededId: row.id,
        ...(estimateTokens(body.content) > EMBED_TOKEN_BUDGET ? { embedTruncated: true } : {}),
      });
    }

    await sql`
      UPDATE memory_entry
      SET is_static = ${isStatic}, metadata = ${metadata ? sql.json(metadata) : null},
          forget_after = ${forgetAfter}, forget_reason = ${forgetReason}, updated_at = now()
      WHERE org_id = ${ORG_ID} AND id = ${id}`;
    const updated = await loadMemory(sql, id);
    return c.json({ memory: normalizeMemory(updated), action: "updated" });
  });

  // POST /memories/:id/forget - soft-forget the WHOLE version chain (reversible with {undo:true}).
  // Forgotten memories drop out of GET /memories and /search (unless include.forgottenMemories) but
  // stay on disk and inspectable — that is the point: reversible, auditable forgetting.
  app.post("/:id/forget", async (c) => {
    const id = c.req.param("id");
    if (!ID_RE.test(id)) return c.json({ error: "invalid memory id" }, 400);
    const body = await c.req.json().catch(() => ({}));
    const undo = body.undo === true;
    const row = await loadMemory(sql, id);
    if (!row) return c.json({ error: "MemoryNotFound" }, 404);
    const ids = await chainIds(sql, row);
    const reason = undo ? null : (typeof body.reason === "string" ? body.reason : "forgotten via API");
    // Undo also clears forget_after: restoring a memory whose expiry already elapsed would otherwise
    // last only until the next sweep cycle silently re-forgets it — an un-forget must mean "keep it".
    const forgetAfterClause = undo ? sql`, forget_after = NULL` : sql``;
    const rows = await sql`
      UPDATE memory_entry
      SET is_forgotten = ${!undo}, forget_reason = ${reason}${forgetAfterClause}, updated_at = now()
      WHERE org_id = ${ORG_ID} AND id = ANY(${ids}::text[])
      RETURNING id`;
    return c.json({ forgotten: !undo, affected: rows.length, ids: rows.map((r) => r.id) });
  });

  // DELETE /memories/:id - HARD delete the whole version chain + its provenance links. The only
  // physical-removal path; everything else is versioned or flagged.
  app.delete("/:id", async (c) => {
    const id = c.req.param("id");
    if (!ID_RE.test(id)) return c.json({ error: "invalid memory id" }, 400);
    const row = await loadMemory(sql, id);
    if (!row) return c.json({ error: "MemoryNotFound" }, 404);
    const ids = await chainIds(sql, row);
    const deleted = await sql.begin(async (tx) => {
      await tx`DELETE FROM memory_document_source WHERE memory_entry_id = ANY(${ids}::text[])`;
      const rows = await tx`DELETE FROM memory_entry WHERE org_id = ${ORG_ID} AND id = ANY(${ids}::text[]) RETURNING id`;
      return rows.map((r) => r.id as string);
    });
    return c.json({ deleted: deleted.length, ids: deleted });
  });

  return app;
}
