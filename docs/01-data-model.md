# 01 - Data Model

## Purpose
Persistent schema (trimmed from verbatim decompiled DDL). Full DDL lives in /schema.sql.

## Enums
- chunk_type: text, image
- document_status: unknown, queued, extracting, chunking, embedding, indexing, done, failed
- task_type: memory, superrag
- memory_relation: updates, extends, derives

## memory_entry (core columns)
- id char(22) PK
- org_id varchar(22) NOT NULL          (single-tenant: constant)
- space_id char(22) NOT NULL           (= container tag's space)
- user_id char(22)
- memory text NOT NULL
- is_static boolean NOT NULL DEFAULT false
- is_inference boolean NOT NULL DEFAULT false   (never true in v1: no extractor)
- is_forgotten boolean NOT NULL DEFAULT false
- is_latest boolean NOT NULL DEFAULT true
- version integer NOT NULL DEFAULT 1
- parent_memory_id char(22)
- root_memory_id char(22)
- forget_after timestamp
- forget_reason text
- source_count integer NOT NULL DEFAULT 1
- memory_relations json DEFAULT empty
- metadata json
- created_at / updated_at timestamp DEFAULT now()
- memory_embedding vector(768)
- memory_embedding_model text
- INDEX idx_memory_entry_embedding_hnsw USING hnsw (memory_embedding vector_cosine_ops)

## Supporting tables (minimal)
- space(id, container_tag, org_id, metadata json, entity_context text; UNIQUE container_tag+org_id)
- document(id, content, type, source, status, task_type DEFAULT memory, container_tags text[],
           chunk_count, token_count, metadata json, org_id, created_at)
- memory_document_source(memory_entry_id, document_id, chunk_id, relevance_score DEFAULT 100,
           metadata; PK memory_entry_id+document_id)
- chunk(...) only needed when ingestion lands (Spec 05).

## Migrations
Applied at boot, idempotent, tracked in drizzle.__drizzle_migrations(hash, created_at)
keyed by content hash (verbatim mechanism).

## IDs
22-char nanoid-style. On first version root_memory_id = id.
