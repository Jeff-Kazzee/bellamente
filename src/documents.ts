// documents.ts - ingest a document: chunk -> embed chunks -> store (Spec 05).
// task_type='superrag' (chunked + searchable, no memory extraction).
import type { DB } from "./db";
import { type Embed, isValidVector, embedModelName } from "./embed";
import { chunkMarkdown, type ChunkOptions } from "./chunk";
import { newId, toVector, ORG_ID } from "./util";

type Ctx = { sql: DB; embed: Embed };

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
): Promise<{ documentId: string; chunkCount: number; flags: Record<string, number> }> {
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

  await sql.begin(async (tx) => {
    await tx`
      INSERT INTO document (id, content, type, source, status, task_type, container_tags,
                            filepath, chunk_count, title, metadata, org_id)
      VALUES (${docId}, ${input.content}, 'text', 'file', 'done', 'superrag', ${[input.containerTag]},
              ${input.filepath ?? null}, ${chunks.length}, ${input.title}, ${tx.json({ rag: true })}, ${ORG_ID})`;
    await tx`
      INSERT INTO documents_to_spaces (document_id, space_id)
      VALUES (${docId}, ${spaceId}) ON CONFLICT DO NOTHING`;
    for (let i = 0; i < chunks.length; i++) {
      const c = chunks[i]!;
      const v = vectors[i];
      if (!v || !isValidVector(v)) continue;
      await tx`
        INSERT INTO chunk (id, document_id, content, embedded_content, position, type,
                           metadata, embedding, embedding_model)
        VALUES (${newId()}, ${docId}, ${c.content}, ${c.embeddedContent}, ${c.position}, 'text',
                ${tx.json({ headingPath: c.headingPath, flags: c.flags })},
                ${toVector(v)}::vector, ${model})`;
    }
  });

  return { documentId: docId, chunkCount: chunks.length, flags };
}
