// export.ts - portability (SPEC-P1.9, issue #41): GET /export serializes chains/profiles/documents
// to a stable versioned JSON; POST /import RESTORES it — direct chain inserts with fresh ids
// (id remap), verbatim version numbers/flags/validity windows, embeddings ALWAYS regenerated
// through the local embedder (the file never carries vectors), documents re-ingested through the
// real chunking path. Import is a restore, NOT a re-observation: pushing versions through the
// dedup/supersede path would re-stamp windows and renumber chains.
import { Hono } from "hono";
import type { DB } from "./db";
import type { Embed } from "./embed";
import { isValidVector, embedModelName } from "./embed";
import { ingestDocument } from "./documents";
import { newId, toVector, ORG_ID, DEFAULT_CONTAINER_TAG } from "./util";

type Ctx = { sql: DB; embed: Embed };

const FORMAT = "bellamente-export";
const VERSION = 1;

const iso = (v: unknown): string | null => (v == null ? null : v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString());

type ExportVersion = {
  exportId: string; parentExportId: string | null; version: number; isLatest: boolean;
  memory: string; isStatic: boolean; isInference: boolean; isForgotten: boolean;
  forgetAfter: string | null; forgetReason: string | null; metadata: unknown;
  sourceCount: number; memoryRelations: Record<string, string[]> | null;
  createdAt: string | null; updatedAt: string | null; validFrom: string | null; validTo: string | null;
};

export function exportRoutes(ctx: Ctx) {
  const { sql } = ctx;
  const app = new Hono();
  app.get("/", async (c) => {
    const tag = c.req.query("containerTag");
    const tagClause = tag ? sql`AND container_tag = ${tag}` : sql``;
    const spaces = await sql`SELECT id, container_tag, metadata FROM space WHERE org_id = ${ORG_ID} ${tagClause} ORDER BY container_tag`;

    const containers = [];
    for (const space of spaces) {
      const rows = await sql`
        SELECT * FROM memory_entry WHERE org_id = ${ORG_ID} AND space_id = ${space.id}
        ORDER BY created_at ASC, version ASC`;
      // Group into chains by root; versions ordered within.
      const byRoot = new Map<string, any[]>();
      for (const r of rows) {
        const root = r.root_memory_id ?? r.id;
        if (!byRoot.has(root)) byRoot.set(root, []);
        byRoot.get(root)!.push(r);
      }
      const chains = [...byRoot.values()].map((vs) => ({
        versions: vs
          .sort((a, b) => Number(a.version) - Number(b.version))
          .map((r): ExportVersion => ({
            exportId: r.id, parentExportId: r.parent_memory_id ?? null,
            version: Number(r.version), isLatest: !!r.is_latest,
            memory: r.memory, isStatic: !!r.is_static, isInference: !!r.is_inference,
            isForgotten: !!r.is_forgotten, forgetAfter: iso(r.forget_after),
            forgetReason: r.forget_reason ?? null, metadata: r.metadata ?? null,
            sourceCount: Number(r.source_count ?? 1),
            memoryRelations: r.memory_relations && Object.keys(r.memory_relations).length ? r.memory_relations : null,
            createdAt: iso(r.created_at), updatedAt: iso(r.updated_at),
            validFrom: iso(r.valid_from), validTo: iso(r.valid_to),
          })),
      }));
      const profile = (space.metadata?.profile as Record<string, unknown>) ?? null;
      if (chains.length || profile) containers.push({ containerTag: space.container_tag, profile, chains });
    }

    // Only REAL ingested documents (they have chunks); the grouping documents writeMemories creates
    // for provenance are chunk-less and regenerate implicitly — exporting them would re-ingest
    // noise as searchable docs.
    const docTagClause = tag ? sql`AND container_tags @> ARRAY[${tag}]::text[]` : sql``;
    const docs = await sql`
      SELECT id, title, content, container_tags, metadata FROM document d
      WHERE org_id = ${ORG_ID} ${docTagClause}
        AND EXISTS (SELECT 1 FROM chunk WHERE document_id = d.id)
      ORDER BY created_at ASC`;
    const docIds = docs.map((d) => d.id);
    const memIds = containers.flatMap((ct) => ct.chains.flatMap((ch) => ch.versions.map((v) => v.exportId)));
    const provRows = docIds.length && memIds.length
      ? await sql`
          SELECT memory_entry_id, document_id FROM memory_document_source
          WHERE document_id = ANY(${docIds}::text[]) AND memory_entry_id = ANY(${memIds}::text[])`
      : [];

    return c.json({
      format: FORMAT, version: VERSION, exportedAt: new Date().toISOString(),
      embedModel: embedModelName(), // informational only: import always re-embeds locally
      containers,
      documents: docs.map((d) => ({
        exportId: d.id, title: d.title ?? null, content: d.content,
        containerTags: d.container_tags ?? [DEFAULT_CONTAINER_TAG], metadata: d.metadata ?? null,
      })),
      provenance: provRows.map((p) => ({ memoryExportId: p.memory_entry_id, documentExportId: p.document_id })),
    });
  });
  return app;
}

export function importRoutes(ctx: Ctx) {
  const { sql, embed } = ctx;
  const app = new Hono();
  app.post("/", async (c) => {
    const body = (await c.req.json().catch(() => null)) as any;
    if (!body || body.format !== FORMAT) return c.json({ error: `format must be "${FORMAT}"` }, 400);
    if (body.version !== VERSION) return c.json({ error: `unsupported export version ${body.version}; this build imports version ${VERSION}` }, 400);

    const imported = { chains: 0, versions: 0, documents: 0, profiles: 0 };
    const skipped = { chains: 0, documents: 0 };
    const failed = { chains: 0 };
    let embedFailures = 0;
    const memIdMap = new Map<string, string>(); // exportId -> new id (for provenance re-linking)

    for (const container of body.containers ?? []) {
      const containerTag = typeof container.containerTag === "string" && container.containerTag ? container.containerTag : DEFAULT_CONTAINER_TAG;
      const [space] = await sql`
        INSERT INTO space (id, container_tag, org_id)
        VALUES (${newId()}, ${containerTag}, ${ORG_ID})
        ON CONFLICT (container_tag, org_id) DO UPDATE SET updated_at = now()
        RETURNING id`;
      const spaceId = space!.id as string;

      if (container.profile != null) {
        await sql`
          UPDATE space SET metadata = jsonb_set(coalesce(metadata, '{}')::jsonb, '{profile}', ${sql.json(container.profile)}::jsonb), updated_at = now()
          WHERE id = ${spaceId}`;
        imported.profiles++;
      }

      for (const chain of container.chains ?? []) {
        const versions: ExportVersion[] = chain?.versions ?? [];
        // Validate the chain BEFORE touching the DB: non-empty, unique exportIds, every parent
        // resolves inside the SAME chain. A broken chain fails alone; others still import (B5).
        const chainMap = new Map<string, string>();
        for (const v of versions) if (typeof v?.exportId === "string") chainMap.set(v.exportId, newId());
        const valid = versions.length > 0 && chainMap.size === versions.length &&
          versions.every((v) => typeof v.memory === "string" && v.memory.length > 0 &&
            (v.parentExportId == null || chainMap.has(v.parentExportId)));
        if (!valid) { failed.chains++; continue; }

        // Chain-level dedup (B4): if the target space already holds this chain's LATEST content as
        // its own latest version, the whole chain is a re-import — skip it. Forgotten status does
        // NOT exempt: a forgotten chain re-imported would otherwise duplicate on every restore.
        const latest = versions.find((v) => v.isLatest) ?? versions[versions.length - 1]!;
        const [dup] = await sql`
          SELECT 1 AS hit FROM memory_entry
          WHERE org_id = ${ORG_ID} AND space_id = ${spaceId} AND is_latest = true
            AND md5(memory) = md5(${latest.memory}) AND memory = ${latest.memory}
          LIMIT 1`;
        if (dup) { skipped.chains++; continue; }

        // Regenerate embeddings locally, OUTSIDE the tx (embedding can be slow; the file never
        // carries vectors — B2). A failed vector imports as NULL: keyword recall still finds it.
        let vectors: number[][] = [];
        try {
          vectors = await embed({ values: versions.map((v) => v.memory), taskType: "RETRIEVAL_DOCUMENT" });
        } catch {
          vectors = [];
        }
        const model = embedModelName();
        const rootNewId = chainMap.get(versions[0]!.exportId)!;

        try {
          await sql.begin(async (tx) => {
            for (let i = 0; i < versions.length; i++) {
              const v = versions[i]!;
              const vec = vectors[i];
              const hasVec = !!vec && isValidVector(vec);
              if (!hasVec) embedFailures++;
              // Remap relations through the chain map; ids from outside the file are dropped
              // rather than leaked verbatim into the new store.
              let relations: Record<string, string[]> | null = null;
              if (v.memoryRelations && typeof v.memoryRelations === "object") {
                relations = {};
                for (const [k, arr] of Object.entries(v.memoryRelations)) {
                  if (!Array.isArray(arr)) continue;
                  const mapped = arr.filter((id) => chainMap.has(id)).map((id) => chainMap.get(id)!);
                  if (mapped.length) relations[k] = mapped;
                }
                if (!Object.keys(relations).length) relations = null;
              }
              await tx`
                INSERT INTO memory_entry
                  (id, org_id, space_id, memory, is_static, is_inference, is_latest, is_forgotten, version,
                   parent_memory_id, root_memory_id, source_count, memory_relations, metadata,
                   forget_after, forget_reason, created_at, updated_at, valid_from, valid_to,
                   memory_embedding, memory_embedding_model)
                VALUES
                  (${chainMap.get(v.exportId)!}, ${ORG_ID}, ${spaceId}, ${v.memory}, ${!!v.isStatic}, ${!!v.isInference},
                   ${!!v.isLatest}, ${!!v.isForgotten}, ${Number(v.version) || 1},
                   ${v.parentExportId ? chainMap.get(v.parentExportId)! : null}, ${rootNewId},
                   ${Number(v.sourceCount) || 1}, ${relations ? tx.json(relations) : null},
                   ${v.metadata != null ? tx.json(v.metadata) : null},
                   ${v.forgetAfter ?? null}::timestamp, ${v.forgetReason ?? null},
                   COALESCE(${v.createdAt ?? null}::timestamp, now()), COALESCE(${v.updatedAt ?? null}::timestamp, now()),
                   ${v.validFrom ?? null}::timestamptz, ${v.validTo ?? null}::timestamptz,
                   ${hasVec ? toVector(vec!) : null}::vector, ${hasVec ? model : null})`;
            }
          });
          for (const [expId, id] of chainMap) memIdMap.set(expId, id);
          imported.chains++;
          imported.versions += versions.length;
        } catch {
          failed.chains++;
        }
      }
    }

    // Documents re-ingest through the REAL chunking path (chunks/embeddings regenerate); exact
    // (title, content) matches in the target are re-imports — skip.
    const docIdMap = new Map<string, string>();
    for (const d of body.documents ?? []) {
      if (typeof d?.content !== "string" || !d.content) continue;
      const [dup] = await sql`
        SELECT id FROM document
        WHERE org_id = ${ORG_ID} AND title IS NOT DISTINCT FROM ${d.title ?? null}
          AND md5(content) = md5(${d.content}) AND content = ${d.content}
        LIMIT 1`;
      if (dup) { skipped.documents++; if (typeof d.exportId === "string") docIdMap.set(d.exportId, dup.id); continue; }
      const tag = Array.isArray(d.containerTags) && typeof d.containerTags[0] === "string" ? d.containerTags[0] : DEFAULT_CONTAINER_TAG;
      const { documentId } = await ingestDocument(ctx, { title: d.title ?? undefined, content: d.content, containerTag: tag });
      if (typeof d.exportId === "string") docIdMap.set(d.exportId, documentId);
      imported.documents++;
    }

    // Provenance re-links at DOCUMENT level from the two id maps (chunk-level identity does not
    // survive re-chunking — documented limitation).
    for (const p of body.provenance ?? []) {
      const memId = memIdMap.get(p?.memoryExportId);
      const docId = docIdMap.get(p?.documentExportId);
      if (!memId || !docId) continue;
      await sql`
        INSERT INTO memory_document_source (memory_entry_id, document_id)
        VALUES (${memId}, ${docId}) ON CONFLICT DO NOTHING`;
    }

    return c.json({ imported, skipped, failed, embedFailures });
  });
  return app;
}
