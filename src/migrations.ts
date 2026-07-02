// migrations.ts - ordered, append-only schema migrations, run at boot after schema.sql.
//
// WHY THIS EXISTS: schema.sql is all CREATE TABLE IF NOT EXISTS — on an EXISTING install it is a no-op,
// so a schema change shipped only there silently never reaches existing databases (there is no ALTER
// path). Changes to already-shipped tables/indexes go HERE as a new numbered migration; schema.sql is
// updated to the same final shape in the same commit, so a FRESH install creates it directly.
//
// RULES (read before editing):
//  1. NEVER edit or reorder a migration that has shipped — append a new one with the next id.
//  2. Every migration MUST be idempotent (IF NOT EXISTS / guarded DO $$ blocks): a fresh install runs
//     the full list against the already-final schema that schema.sql just created.
//  3. Update schema.sql to the post-migration shape in the same commit (rule 2 makes this safe).
//  4. A migration's SQL and its schema_migrations row commit in ONE transaction — a failure leaves the
//     DB at the previous version, never half-applied.
import type { DB } from "./pg-shim";

export type Migration = { id: number; name: string; up: string };

export const MIGRATIONS: Migration[] = [
  {
    id: 1,
    name: "hot-filter-indexes",
    // The list/search hot filters ran unindexed: memory listing filters (org_id, is_latest,
    // is_forgotten) with a created_at sort; lifecycle routes walk version chains by root_memory_id and
    // spaces by space_id; document search filters org_id and container_tags (@> needs GIN); document
    // deletion cascades through memory_document_source by document_id.
    up: `
      CREATE INDEX IF NOT EXISTS idx_memory_entry_latest
        ON memory_entry (org_id, is_latest, is_forgotten, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_memory_entry_space ON memory_entry (space_id);
      CREATE INDEX IF NOT EXISTS idx_memory_entry_root ON memory_entry (root_memory_id);
      CREATE INDEX IF NOT EXISTS idx_document_org ON document (org_id);
      CREATE INDEX IF NOT EXISTS idx_document_container_tags ON document USING gin (container_tags);
      CREATE INDEX IF NOT EXISTS idx_memory_document_source_document
        ON memory_document_source (document_id);
    `,
  },
  {
    id: 2,
    name: "dedup-md5-index",
    // The exact-duplicate check filters on text equality; a plain btree on `memory` would exceed
    // Postgres's index row-size cap for long memories (content allows 10k chars), so index the md5
    // instead — the query pairs `md5(memory) = md5($content)` (index-seekable) with the direct
    // equality check for correctness. Partial: only latest, non-forgotten rows are ever probed.
    up: `
      CREATE INDEX IF NOT EXISTS idx_memory_entry_dedup
        ON memory_entry (org_id, space_id, md5(memory))
        WHERE is_latest = true AND is_forgotten = false;
    `,
  },
  {
    id: 3,
    name: "memory-fulltext-index",
    // searchMemories() gained a full-text keyword leg (SPEC-P1.3): without an index every memory search
    // would seq-scan to_tsvector over all latest memories. Same 'simple' (language-neutral) GIN shape as
    // idx_chunk_content, so the two hybrid searches stay symmetric.
    up: `
      CREATE INDEX IF NOT EXISTS idx_memory_entry_fulltext
        ON memory_entry USING gin (to_tsvector('simple', memory));
    `,
  },
];

/** Apply every migration not yet recorded in schema_migrations, in id order. Returns applied ids.
 *  `migrations` is injectable for tests only; production always runs the module list. */
export async function runMigrations(sql: DB, migrations: Migration[] = MIGRATIONS): Promise<number[]> {
  await sql`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id integer PRIMARY KEY,
      name text NOT NULL,
      applied_at timestamp NOT NULL DEFAULT now()
    )`;
  const rows = await sql`SELECT id FROM schema_migrations`;
  const done = new Set(rows.map((r) => Number(r.id)));
  const applied: number[] = [];
  for (const m of [...migrations].sort((a, b) => a.id - b.id)) {
    if (done.has(m.id)) continue;
    await sql.begin(async (tx) => {
      await tx.unsafe(m.up);
      await tx`INSERT INTO schema_migrations (id, name) VALUES (${m.id}, ${m.name})`;
    });
    applied.push(m.id);
    console.log(`[db] applied migration ${m.id}: ${m.name}`);
  }
  return applied;
}
