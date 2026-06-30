# eunoia

Single-binary personal memory server - a minimal, faithful re-implementation of
Supermemory's memory subsystem (store facts, recall them semantically, and an
OpenAI-compatible proxy that auto-injects memory + profile).

Reverse-engineered from the decompiled bundle in the sibling `sm-decomp` project.
Clean-room: no decompiled code is copied in; algorithms are ported from documented behavior.

## Status
- Core loop (write -> embed -> store -> cosine recall): WIRED + verified end-to-end on pgvector.
- Embeddings: LOCAL + in-process by default (no cloud, no server) - Qwen3-Embedding-0.6B via
  transformers.js (ONNX), Matryoshka-truncated to 768. OpenAI is an optional dev fallback.
- M2 single binary (PGlite + bundled model + `bun build --compile`): TODO.
- M3 proxy upstream-forward + tool-call interception: TODO (tool + profile injection wired).

## Architecture (one process)
One Hono app + two singletons: `sql` (pgvector) and `embed` (768-d, local). Every feature is a
route module sharing `ctx = { sql, embed }`. The proxy calls search/profile in-process.

```
src/index.ts     entrypoint: singletons + embed prewarm + mount routes + bearer auth + listen
src/db.ts        DB singleton (postgres.js; applies schema.sql at boot). M2 -> PGlite.
src/embed.ts     embed({ values, taskType }) -> 768-d; local Qwen3 (transformers.js) + OpenAI fallback
src/util.ts      newId(22), toVector(), ORG_ID, DEFAULT_CONTAINER_TAG
src/memories.ts  POST/GET /memories          (port of $V2)
src/search.ts    POST /search + searchMemories()  (cosine, threshold 0.4, dedup, cap 25)
src/profile.ts   GET/PUT /profile + injection template + loadProfile()
src/proxy.ts     POST /v1/chat/completions   (tool + profile injection; forward = M3)
schema.sql       full pgvector DDL (applied at boot)
docs/            PRD + 11 subsystem specs
```

## Quick start (dev)
```
cp .env.example .env          # set EUNOIA_API_KEY (defaults are local-embeddings, no cloud)
bun install
bun pm trust --all            # allow onnxruntime-node native install
docker run -d --name eunoia-pg -p 5433:5432 -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=eunoia pgvector/pgvector:pg16
bun run dev                   # first boot downloads Qwen3-Embedding-0.6B (~600MB q8) and prewarms
```

Example:
```
curl -s localhost:8080/health
curl -s localhost:8080/memories -H "authorization: Bearer $EUNOIA_API_KEY" \
  -H 'content-type: application/json' \
  -d '{"containerTag":"user_123","memories":[{"content":"John prefers dark mode","isStatic":true}]}'
curl -s localhost:8080/search -H "authorization: Bearer $EUNOIA_API_KEY" \
  -H 'content-type: application/json' \
  -d '{"q":"what theme does John like","containerTag":"user_123"}'
```

## Embeddings: local by default
Qwen3-Embedding-0.6B runs in-process via transformers.js (ONNX) - no cloud API, no model server.
Instruction-aware (queries get an `Instruct:` prefix; documents raw) and Matryoshka-truncated to
768 so the schema is unchanged. Swap `LOCAL_EMBED_MODEL` for nomic-embed-text-v2, bge-m3,
granite-embedding, or Qwen3-Embedding-4B; set `EMBEDDING_PROVIDER=openai` for a cloud fallback.
See docs/02-embedding.md.

## Build single binary (M2)
```
bun run build      # -> ./eunoia  (PGlite + bundled model embedded)
./eunoia
```

## API
- POST /memories  - create 1..100 memories
- GET  /memories  - list latest, non-forgotten
- POST /search    - semantic recall (cosine, threshold 0.4)
- GET/PUT /profile
- POST /v1/chat/completions - OpenAI-compatible proxy
See docs/PRD.md and docs/08-api.md.

## Provenance / fidelity
Specs mark "verbatim" (from decompiled source) vs "[DESIGN]" (designed here). The local embedding
model name was not recoverable from the decompiled bundle, so Qwen3-Embedding-0.6B was selected as
a current (2026) 768-d, instruction-aware, in-process replacement.
