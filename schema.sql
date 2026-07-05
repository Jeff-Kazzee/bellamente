-- bellamente schema (pgvector). Applied at boot, idempotent.
-- NOTE: the vector(384) columns below are TEMPLATED — db.ts rewrites 384 -> EMBED_DIM before applying this
-- schema. The literal 384 is just the default (multilingual-e5-small). On a FRESH database the columns are
-- created at EMBED_DIM. On an EXISTING database, CREATE TABLE IF NOT EXISTS is a no-op, so the columns KEEP
-- their original dimension — switching the model's dimension is NOT automatic; makeDb() detects the
-- mismatch at boot and refuses to start, telling you to wipe the data dir (or migrate/re-embed) to change it.
CREATE EXTENSION IF NOT EXISTS vector;

DO $$ BEGIN
  CREATE TYPE chunk_type AS ENUM ('text','image');
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
  CREATE TYPE document_status AS ENUM ('unknown','queued','extracting','chunking','embedding','indexing','done','failed');
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
  CREATE TYPE task_type AS ENUM ('memory','superrag');
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
  CREATE TYPE memory_relation AS ENUM ('updates','extends','derives');
EXCEPTION WHEN duplicate_object THEN null; END $$;

CREATE TABLE IF NOT EXISTS space (
  id char(22) PRIMARY KEY,
  container_tag varchar(255),
  org_id varchar(22) NOT NULL,
  owner_id char(22),
  entity_context text,
  metadata json,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now(),
  CONSTRAINT unique_container_tag_per_org UNIQUE (container_tag, org_id)
);

CREATE TABLE IF NOT EXISTS document (
  id char(22) PRIMARY KEY,
  content text,
  type text DEFAULT 'text',
  source varchar(255),
  status document_status NOT NULL DEFAULT 'unknown',
  task_type task_type NOT NULL DEFAULT 'memory',
  container_tags text[],
  filepath text,
  chunk_count integer NOT NULL DEFAULT 0,
  token_count integer,
  title text,
  metadata json,
  org_id char(22) NOT NULL,
  user_id char(22),
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS documents_to_spaces (
  document_id char(22) NOT NULL,
  space_id char(22) NOT NULL,
  PRIMARY KEY (document_id, space_id)
);

CREATE TABLE IF NOT EXISTS memory_entry (
  id char(22) PRIMARY KEY,
  org_id varchar(22) NOT NULL,
  space_id char(22) NOT NULL,
  user_id char(22),
  memory text NOT NULL,
  is_static boolean NOT NULL DEFAULT false,
  is_inference boolean NOT NULL DEFAULT false,
  is_forgotten boolean NOT NULL DEFAULT false,
  is_latest boolean NOT NULL DEFAULT true,
  version integer NOT NULL DEFAULT 1,
  parent_memory_id char(22),
  root_memory_id char(22),
  forget_after timestamp,
  forget_reason text,
  source_count integer NOT NULL DEFAULT 1,
  memory_relations json DEFAULT '{}'::json,
  metadata json,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now(),
  memory_embedding vector(384),
  memory_embedding_model text,
  valid_from timestamptz,
  valid_to timestamptz
);

CREATE TABLE IF NOT EXISTS memory_document_source (
  memory_entry_id char(22) NOT NULL,
  document_id char(22) NOT NULL,
  chunk_id char(22),
  relevance_score integer DEFAULT 100,
  metadata json,
  added_at timestamp NOT NULL DEFAULT now(),
  PRIMARY KEY (memory_entry_id, document_id)
);

CREATE TABLE IF NOT EXISTS recall_trace (
  id char(22) PRIMARY KEY,
  org_id varchar(22) NOT NULL,
  kind text NOT NULL,
  status text NOT NULL DEFAULT 'ok',
  user_id text,
  container_tag varchar(255),
  query text,
  queries json NOT NULL DEFAULT '[]'::json,
  search_mode text,
  result_count integer NOT NULL DEFAULT 0,
  injected_count integer NOT NULL DEFAULT 0,
  latency_ms integer NOT NULL DEFAULT 0,
  retrieved json NOT NULL DEFAULT '[]'::json,
  injected json NOT NULL DEFAULT '[]'::json,
  request json NOT NULL DEFAULT '{}'::json,
  metadata json NOT NULL DEFAULT '{}'::json,
  created_at timestamp NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS chunk (
  id char(22) PRIMARY KEY,
  document_id char(22) NOT NULL,
  content text NOT NULL,
  embedded_content text,
  position integer NOT NULL,
  type chunk_type NOT NULL DEFAULT 'text',
  metadata json,
  created_at timestamp NOT NULL DEFAULT now(),
  embedding vector(384),
  embedding_model text
);

CREATE INDEX IF NOT EXISTS idx_memory_entry_embedding_hnsw
  ON memory_entry USING hnsw (memory_embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS idx_chunk_embedding_hnsw
  ON chunk USING hnsw (embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS idx_chunk_document ON chunk (document_id);
CREATE INDEX IF NOT EXISTS idx_recall_trace_created
  ON recall_trace (org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_recall_trace_kind_created
  ON recall_trace (org_id, kind, created_at DESC);
-- full-text leg for hybrid search; 'simple' = language-neutral (multilingual default)
CREATE INDEX IF NOT EXISTS idx_chunk_content
  ON chunk USING gin (to_tsvector('simple', content));

-- Hot-filter indexes (also shipped to existing installs as migration 001 — keep both in sync; see
-- src/migrations.ts rules).
CREATE INDEX IF NOT EXISTS idx_memory_entry_latest
  ON memory_entry (org_id, is_latest, is_forgotten, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_memory_entry_space ON memory_entry (space_id);
CREATE INDEX IF NOT EXISTS idx_memory_entry_root ON memory_entry (root_memory_id);
CREATE INDEX IF NOT EXISTS idx_document_org ON document (org_id);
CREATE INDEX IF NOT EXISTS idx_document_container_tags ON document USING gin (container_tags);
CREATE INDEX IF NOT EXISTS idx_memory_document_source_document
  ON memory_document_source (document_id);
-- exact-dup write check: md5 keeps the key under the btree row-size cap for 10k-char memories
CREATE INDEX IF NOT EXISTS idx_memory_entry_dedup
  ON memory_entry (org_id, space_id, md5(memory))
  WHERE is_latest = true AND is_forgotten = false;
-- full-text leg for hybrid MEMORY search; 'simple' = language-neutral, matching idx_chunk_content
-- (also shipped to existing installs as migration 003 — keep both in sync)
CREATE INDEX IF NOT EXISTS idx_memory_entry_fulltext
  ON memory_entry USING gin (to_tsvector('simple', memory));

-- Append-only error store (PR #2): mirrors recall_trace conventions. Every captured failure lands here
-- content-free (redacted at the store boundary in src/error-store.ts), grouped by fingerprint on read and
-- self-pruned to ERROR_RETENTION. No migration needed: this is a brand-new table, so CREATE TABLE IF NOT
-- EXISTS reaches existing installs too (schema.sql re-runs at every boot — see db.ts makeDb).
CREATE TABLE IF NOT EXISTS error_event (
  id char(22) PRIMARY KEY,
  org_id varchar(22) NOT NULL,
  ts timestamp NOT NULL DEFAULT now(),
  severity text NOT NULL DEFAULT 'error',
  category text NOT NULL DEFAULT 'unknown',
  code text NOT NULL,
  fingerprint text NOT NULL,
  message_redacted text,
  stack_fingerprint text,
  request_shape json NOT NULL DEFAULT '{}'::json,
  trace_id text,
  count integer NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_error_event_created
  ON error_event (org_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_error_event_fingerprint
  ON error_event (org_id, fingerprint, ts DESC);
