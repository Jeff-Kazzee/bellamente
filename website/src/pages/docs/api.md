---
layout: ../../layouts/DocsLayout.astro
title: API reference
description: Every route — memories, documents, search, profile, inspect, the chat proxy, and health.
---

# API reference

Base URL: `http://127.0.0.1:8080`. JSON in, JSON out. On localhost no auth is needed;
when a key is active, send `Authorization: Bearer <key>` (see [config](/docs/config)).

## Memories

| Route | What it does |
|---|---|
| `POST /memories` | Write 1–100 memories. Exact duplicates → `unchanged`; near-duplicates supersede as a **new version** (old kept); else `created`. `{"dedupe":false}` bypasses. |
| `GET /memories` | List latest, non-forgotten memories. |
| `GET /memories/:id` | One memory + its **full version chain** (forgotten versions included — inspection hides nothing). |
| `PATCH /memories/:id` | Content change → new version (409 + `latestId` if the target isn't latest). Flag-only changes update in place. |
| `POST /memories/:id/forget` | Soft-forget the whole chain; `{"undo":true}` reverses it. |
| `DELETE /memories/:id` | Hard-delete the chain + provenance links. The only true eraser. |

```sh
curl -s localhost:8080/memories -H 'content-type: application/json' \
  -d '{"containerTag":"user_123","memories":[{"content":"John prefers dark mode","isStatic":true}]}'
```

## Documents

| Route | What it does |
|---|---|
| `POST /documents` | Ingest `{title?, content, containerTag?}` — structure-aware markdown chunking, embedded and searchable. |
| `GET /documents` / `GET /documents/:id` | List / read a document with its chunks and quality flags. |
| `DELETE /documents/:id` | Delete document + chunks + links. |

## Search

```sh
curl -s localhost:8080/search -H 'content-type: application/json' \
  -d '{"q":"what theme does John like","searchMode":"memories"}'
```

`searchMode`: `memories` (semantic recall), `documents` (vector + full-text over chunks,
rank-fused), or `hybrid` (both lists fused). Responses include per-result similarity and a
`traceId` — the receipt.

## Profile

`GET /profile` / `PUT /profile` — static + dynamic facts injected as context on proxied chats.

## Inspect (the receipts)

`GET /inspect` — recent traces. `GET /inspect/:id` — one trace: what was searched, retrieved,
injected, scores, latency, and status (`answered`, `streamed`, `capture`, errors...).

## Chat proxy

`POST /v1/chat/completions` — OpenAI-compatible. Forwards to your local model
(`BELLA_UPSTREAM_BASE_URL`), injects the `searchMemory` tool + profile context, runs the memory
round when the model asks (buffered **and** streamed), and traces everything. Diagnostic headers on
every response:

| Header | Meaning |
|---|---|
| `x-bella-trace-id` | The trace for this turn (open it in `/inspect`). |
| `x-bella-memory-round` | `true` when recall results were injected into the final answer. |
| `x-bella-context-modified` | `true` when tool/profile context was injected. |
| `x-bella-search-results` | How many memories fed the answer. |
| `x-bella-streaming` | `true` when the body streams. |

## Health

`GET /health` → `{"ok":true,"service":"bellamente","auth":"none"|"required"}` — no auth, ever.
