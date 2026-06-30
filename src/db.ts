// db.ts - the single DB singleton (Spec 01, 09).
// v1 dev: external Postgres via DATABASE_URL. M2: swap to PGlite + pgvector (embedded).
import { readFileSync } from "node:fs";
import { join } from "node:path";

export type Db = {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }>;
  // add transaction() when wiring a real client
};

export async function makeDb(): Promise<Db> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    // TODO M2: initialize PGlite (Postgres WASM) + load pgvector, embed into binary.
    throw new Error("DATABASE_URL not set. v1 dev mode requires external Postgres. (PGlite path = M2)");
  }
  // TODO: connect with a real driver (e.g. postgres.js / pg) and return an adapter.
  // Apply schema at boot (idempotent):
  const schema = readFileSync(join(import.meta.dir ?? __dirname, "..", "schema.sql"), "utf8");
  void schema; // await db.query(schema)
  throw new Error("db driver not wired yet - see TODO in src/db.ts");
}
