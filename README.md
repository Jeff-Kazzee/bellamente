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
- Embeddings: LOCAL + in-process, DEVICE-SCALED (no cloud, no model server). Capable machines use
  multilingual-e5-small (WASM worker, 384-d — best quality + multilingual); low-RAM machines auto-fall-back
  to a pure-TS static Model2Vec model (potion-retrieval-32M, ~440 MB, never crashes). The chosen model/dim
  is pinned per data dir. OpenAI is an optional dev fallback.
- Database: EMBEDDED by default - PGlite (Postgres compiled to WASM) + pgvector, running
  in-process inside the binary. No Docker, no server. Verified in the compiled binary
  (initdb, `<=>` cosine, full-text, transactional writes, persistence across restart).
  `DATABASE_URL` stays as an advanced override for external Postgres.
- M2 standalone binary: in progress. The HTTP server + embedded DB compile and run.
- M3 proxy upstream-forward + tool-call interception: TODO (tool + profile injection wired).

## Architecture (one process)
One Hono app + two singletons: `sql` (pgvector) and `embed` (384-d, local). Every
feature is a route module sharing `ctx = { sql, embed }`. The proxy calls
search/profile in-process.

```
src/index.ts     entrypoint: singletons + embed prewarm + mount routes + bearer auth + listen
src/db.ts        DB handle: embedded PGlite (Postgres in WASM) by default; DATABASE_URL = external-PG override; applies schema.sql at boot
src/pg-shim.ts   porsager-compatible `sql` tag over PGlite (so the tuned SQL runs unchanged)
src/embed.ts     embed({ values, taskType }); device-scaled tier -> WASM worker (e5) or static engine; OpenAI fallback
src/embed-model2vec.ts  pure-TS static Model2Vec ("potion") engine for the low-RAM tier (no worker, never crashes)
src/util.ts      newId(22), toVector(), ORG_ID, DEFAULT_CONTAINER_TAG
src/memories.ts  POST/GET /memories
src/search.ts    POST /search + searchMemories()  (cosine, per-model threshold, dedup, cap 25)
src/profile.ts   GET/PUT /profile + injection template + loadProfile()
src/proxy.ts     POST /v1/chat/completions   (tool + profile injection; forward = M3)
schema.sql       full pgvector DDL (applied at boot)
docs/            PRD + 11 subsystem specs
```

## Quick start (dev)
```
cp .env.example .env          # set EUNOIA_API_KEY (defaults: local embeddings + embedded DB, no cloud, no Docker)
bun install
bun run dev                   # first boot creates the embedded DB, downloads the embedding model, and prewarms
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

## Embeddings: local + device-scaled
Eunoia picks the embedder by device RAM so it "just works" without crashing low-end machines:
- **quality** (default, capable machines): `Xenova/multilingual-e5-small` (WASM worker, 384-d) — best
  quality + multilingual; query/passage prefixes, mean pooling, L2-normalized.
- **light** (auto on < ~7 GB RAM): `minishlab/potion-retrieval-32M` — a pure-TS static Model2Vec model
  (~440 MB, no worker, never OOM-crashes). The threaded-WASM OOM is uncatchable, so the tier is chosen
  proactively by total RAM.

Override with `EUNOIA_EMBED_TIER=quality|light`, `EUNOIA_EMBED_MIN_RAM_GB`, or pin `LOCAL_EMBED_MODEL`
(`EMBED_DIM` auto-follows a known model). The chosen `{model, dim}` is pinned at first DB init
(`<data>/embedder.json`), so a later RAM/hardware change won't flip it and break your stored memories.
`EMBEDDING_PROVIDER=openai` is an optional cloud fallback. See `docs/02-embedding.md` for local design docs.

## Build single binary (M2)
```
bun run build      # -> ./eunoia / eunoia.exe
./eunoia
```

## API
- POST /memories  - create 1..100 memories
- GET  /memories  - list latest, non-forgotten
- POST /search    - semantic recall (cosine, per-model similarity floor)
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
