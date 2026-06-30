# 05 - Ingestion and Chunking

## Purpose
document -> chunks -> (optional) memories.

## What is faithful (verbatim from source)
- chunk_size default 1075 (char-based; organization_settings.chunk_size).
- status pipeline: extracting -> chunking -> embedding -> indexing -> done.
- chunk row: { content, embedded_content, position, type }.
- task_type gates memory generation:
  - "memory" (default) = full context layer with SuperRAG built in.
  - "superrag" = chunked and searchable, NO memory extraction.
- Filesystem allowlist controls which paths trigger memory generation; non-matching docs
  ingest as superrag.

## [DESIGN - not in source]
The actual splitter loop (overlap value) and the LLM memory-extraction prompt + schema are
absent from the decompiled bundle. v1 ships:
- Deterministic char splitter: window=1075, overlap=100 [DECISION], prefer paragraph/sentence
  boundaries.
- Memory generation OFF in v1 (non-goal). When built later: LLM call producing
  { memories: [{ memory, isStatic, isInference:true, forgetAfter?, relations? }] }, written via
  Spec 03 row builder + memory_document_source links.

## Acceptance (v1)
- Documents chunk + embed + become searchable in searchMode="documents".
- No is_inference=true rows created.
