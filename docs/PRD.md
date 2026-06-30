# minimem - Product Requirements Document

## 1. Summary
minimem is a single-binary personal memory server. It stores facts and documents,
makes them semantically searchable via 768-d vector search, and exposes an
OpenAI-compatible chat proxy that auto-injects relevant memories and a user profile into
any LLM call. It is a faithful, minimal re-implementation of Supermemory's memory
subsystem, distilled from decompiled source.

## 2. Goals
- G1 Store a fact in one API call and recall it semantically (POST /memories -> POST /search).
- G2 Run as one executable with zero external deps (embedded Postgres + embedded model).
- G3 Drop-in OpenAI-compatible proxy (/v1/chat/completions) that injects memory + profile.
- G4 Faithful data model (memory_entry with versioning, forgetting, static/inference flags).

## 3. Non-goals (v1)
- Connectors (Notion/GDrive/Gmail/etc.).
- Multi-tenant orgs/auth beyond a single API key.
- LLM-based memory extraction from documents (prompt NOT in decompiled source; v1 = direct-write only).
- Reranking / query-rewrite (present but gated off: ENABLE_RERANK=false, ENABLE_QUERY_REWRITE=false).
- Cloudflare/Turbopuffer path.

## 4. Users and primary flows
- Developer/agent builder: stores facts, searches them, points an OpenAI SDK at the proxy.
- Flow A (write/recall): POST /memories -> POST /search.
- Flow B (transparent memory): point OpenAI client baseURL at minimem; it injects
  supermemoryToolSearch + profile, intercepts the tool call, returns a grounded answer.

## 5. Functional requirements
- FR1 Create 1-100 memories per call; embed; persist; index. (verbatim: $V2)
- FR2 Fields: memory, isStatic, forgetAfter, forgetReason, metadata, version, isLatest,
      rootMemoryId, parentMemoryId, isForgotten, isInference. (verbatim DDL)
- FR3 Semantic search: cosine, threshold default 0.4, exclude non-latest/forgotten/expired. (verbatim)
- FR4 Versioning: update -> v+1, old isLatest=false, rootMemoryId constant. (verbatim)
- FR5 Forgetting: forgetAfter auto-expiry + isForgotten soft delete. (verbatim)
- FR6 Proxy injects tool + profile, intercepts <=5 queries, 10s timeout, <=25 merged results. (verbatim)
- FR7 Profile injection from space.metadata.profile using exact [ADDITIONAL CONTEXT] template. (verbatim)

## 6. Non-functional requirements
- Single binary <= ~300MB; cold start < 5s (incl. embedding prewarm; skippable via env).
- Search p95 < 150ms at 10k memories (HNSW).
- Embedding dim MUST equal 768 (validated per-vector, like V.length !== kd0()).

## 7. Locked decisions
- D1 Runtime: Bun, packaged via bun build --compile.
- D2 Storage: PGlite + pgvector (embedded). Dev fallback: external Postgres via env.
- D3 Embeddings: local bundled model, 768-d, Google-style taskType. Dev fallback: OpenAI
     text-embedding-3-small (dimensions:768).
- D4 Auth: single static MINIMEM_API_KEY bearer.
- D5 Distance: pgvector cosine with HNSW vector_cosine_ops. [DESIGN: operator inferred from index DDL]

## 8. Milestones
- M1 Core loop: db + embed + /memories + /search (external PG, OpenAI embeds).
- M2 Single binary: swap to PGlite + local model, --compile.
- M3 Proxy: /v1/chat/completions + profile injection.
- M4 Lifecycle: versioning, forgetting, list/get, expiry cron.

## 9. Spec suite (this folder)
00-architecture, 01-data-model, 02-embedding, 03-memory-write, 04-search,
05-ingestion-chunking, 06-proxy, 07-profile, 08-api, 09-build-packaging, 10-config.

## 10. Provenance
Specs grounded in the decompiled Supermemory bundle (sm-decomp).
- "verbatim" = lifted directly from decompiled source.
- "[DESIGN ...]" = not present/recoverable in source; designed for this project.
