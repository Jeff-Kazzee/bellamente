# Bellamente Roadmap

**v0.0.3 is an early release.** It is usable and it is honest — and it is not at all complete.
This page is the actual backlog, in priority order. If a feature you need is listed below, it does
not exist yet.

Also on the website: https://the-little-ai-company.github.io/bellamente/roadmap

## Now — current in v0.0.3

- Memory lifecycle: write with dedup/supersede, versioned corrections, reversible forgetting,
  hard delete, full version-chain reads.
- Memory recall: semantic + full-text (exact names, codes, rare tokens), rank-fused,
  recency-weighted, with an MMR diversity pass. Hybrid document search (vector + full-text,
  rank-fused).
- Time-aware facts: `valid_from` / `valid_to` validity windows with "as of" recall.
- Export / import: your memory is one versioned JSON file you can take anywhere
  (embeddings regenerated locally on import).
- Drop-in `/v1/chat/completions` proxy with memory grounding on **buffered and streamed** chats
  (the model's `searchMemory` call is intercepted even mid-stream).
- Auto-capture with **local LLM distillation**: durable facts extracted from your chats by your own
  local model — heuristic fallback, sensitive-content exclusion, every capture traced and reversible.
- Recall traces (`/inspect`) + a dashboard with edit / forget / delete / history.
- Retrieval eval harness: `bun run bench` loads fixtures through HTTP routes and prints recall@k, MRR,
  latency p50/p95, and route-vector-vs-brute-force recall and exact-vs-route delta.
- One binary; embedded Postgres + pgvector; local device-scaled embeddings; loopback by default;
  append-only migrations.
- Public direct downloads currently publish tested Windows x64 and Linux x64 binaries only.
- Coverage-gated behavior test suite.
- Native MCP server (`bella mcp`): 9 memory tools over stdio JSON-RPC on the same local store —
  search, write, correct (versioned), forget (reversible), list, history (version chain), document
  ingest + list, and recall-trace inspect.
- Bug reporting (`bella report`): assembles a **content-free** GitHub bug report (redacted
  diagnostics + errors grouped by fingerprint — codes and counts, never messages/stacks/content) and
  prints a prefilled issue link. The binary sends nothing; you review and submit it yourself.

## Next — the trust loop, finished

- Richer trust views: rejected-capture reasons, version diffs, provenance trees.

## Later — memory-system parity

- Review queue for inferred (auto-captured) memories: approve / decline before they're trusted.
- Profile rebuild rules, pinned facts, profile+search in one call.
- Context-window preview: see exactly what your agent will see, before it sees it.
- Local folder-memory contract (a watched directory that IS your memory).
- Reranking + result diversity; usage analytics; scoped API keys.

## Someday — bigger bets (plugins over bloat)

- Memory graph view + export.
- Optional cross-encoder reranker (downloaded on demand, device-scaled).
- Content extractors (PDF, code, web) and connectors (filesystem/Obsidian first).
- SDKs, editor integrations, desktop shell.

## What will never change

Local-first by default. No telemetry. Every recall traceable. Every correction versioned.
Forgetting reversible and audited. If a feature can't be made inspectable, it doesn't ship.
