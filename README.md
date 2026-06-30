# eunoia

Eunoia is a local-first memory substrate for AI agents. It stores durable facts
and source documents, recalls them semantically, and gives chat clients a small
OpenAI-compatible proxy for injecting relevant memory and profile context.

The product thesis is simple: agents need a well-ordered mind that stays close
to the user, remains inspectable, and can run without a hosted memory service.
Eunoia keeps the core small enough to reason about while leaving room for richer
recall traces, document ingestion, and profile-aware workflows.

## Status
- Core loop (write -> embed -> store -> cosine recall): WIRED + verified end-to-end on pgvector.
- Embeddings: LOCAL + worker-threaded by default (no cloud, no model server) -
  multilingual-e5-small via transformers.js (ONNX), 384 dimensions. OpenAI is an
  optional dev fallback.
- M2 standalone binary: in progress. The HTTP server compiles; Windows native ONNX
  packaging is still being hardened.
- M3 proxy upstream-forward + tool-call interception: TODO (tool + profile injection wired).

## Architecture (one process)
One Hono app + two singletons: `sql` (pgvector) and `embed` (384-d, local). Every
feature is a route module sharing `ctx = { sql, embed }`. The proxy calls
search/profile in-process.

```
src/index.ts     entrypoint: singletons + embed prewarm + mount routes + bearer auth + listen
src/db.ts        DB singleton (postgres.js; applies schema.sql at boot). M2 -> PGlite.
src/embed.ts     embed({ values, taskType }) -> 384-d; local e5 (transformers.js) + OpenAI fallback
src/util.ts      newId(22), toVector(), ORG_ID, DEFAULT_CONTAINER_TAG
src/memories.ts  POST/GET /memories
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
bun run dev                   # first boot downloads the local embedding model and prewarms
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
Eunoia defaults to `Xenova/multilingual-e5-small` via transformers.js (ONNX) in a
worker thread. It uses query/document prefixes, mean pooling, and L2-normalized
384-d vectors. Set `LOCAL_EMBED_MODEL` and `EMBED_DIM` together when trying a
different local model, or set `EMBEDDING_PROVIDER=openai` for a cloud fallback.
See `docs/02-embedding.md` if you keep local design docs in this checkout.

## Build single binary (M2)
```
bun run build      # -> ./eunoia / eunoia.exe
./eunoia
```

## API
- POST /memories  - create 1..100 memories
- GET  /memories  - list latest, non-forgotten
- POST /search    - semantic recall (cosine, threshold 0.4)
- GET/PUT /profile
- POST /v1/chat/completions - OpenAI-compatible proxy
See docs/PRD.md and docs/08-api.md.

## Design principles
- Local-first by default: no hosted memory account, no model server, no cloud
  embeddings unless you opt in.
- Inspectable recall: memories and chunks are stored in plain database tables with
  scores, provenance fields, and room for recall tracing.
- Small core: one process, one database handle, one embedding path, and route modules
  that call each other directly.
- Agent-friendly surface: direct memory writes, semantic search, profile context, and
  a proxy path that can become transparent memory for OpenAI-compatible clients.
