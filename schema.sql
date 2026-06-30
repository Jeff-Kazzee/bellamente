-- minimem schema (pgvector). Applied at boot, idempotent.
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
  memory_embedding vector(768),
  memory_embedding_model text
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

CREATE TABLE IF NOT EXISTS chunk (
  id char(22) PRIMARY KEY,
  document_id char(22) NOT NULL,
  content text NOT NULL,
  embedded_content text,
  position integer NOT NULL,
  type chunk_type NOT NULL DEFAULT 'text',
  metadata json,
  created_at timestamp NOT NULL DEFAULT now(),
  embedding vector(768),
  embedding_model text
);

CREATE INDEX IF NOT EXISTS idx_memory_entry_embedding_hnsw
  ON memory_entry USING hnsw (memory_embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS idx_chunk_embedding_hnsw
  ON chunk USING hnsw (embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS idx_chunk_document ON chunk (document_id);
CREATE INDEX IF NOT EXISTS idx_chunk_content
  ON chunk USING gin (to_tsvector('english', content));
