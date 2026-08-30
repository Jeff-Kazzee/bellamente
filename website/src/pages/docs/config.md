---
layout: ../../layouts/DocsLayout.astro
title: Config
description: Every BELLA_* environment variable. All of them optional — zero config is the default.
---

# Config

**Everything is optional.** Bellamente runs with zero configuration; these knobs tune it.

## Auth & network

| Variable | Default | What it does |
|---|---|---|
| `BELLA_HOST` | `127.0.0.1` | Bind address. Anything beyond loopback auto-generates and enforces an API key. |
| `PORT` | `8080` | Listen port. |
| `BELLA_API_KEY` | unset | Require this bearer key everywhere (overrides auto-generation). |

## Upstream model (the proxy)

| Variable | Default | What it does |
|---|---|---|
| `BELLA_UPSTREAM_BASE_URL` | `http://127.0.0.1:11434/v1` | Your local model server (Ollama, LM Studio, llama.cpp, vLLM). |
| `BELLA_UPSTREAM_API_KEY` | unset | Only needed for non-local upstreams (which must opt in explicitly). |
| `BELLA_UPSTREAM_TIMEOUT_MS` | `120000` | Deadline for buffered upstream exchanges. |
| `BELLA_STREAM_IDLE_TIMEOUT_MS` | `120000` | Stall detector for streamed responses (per pending read). |
| `BELLA_STREAM_DECISION_HOLD_CHARS` | `512` | How much streamed answer text is held while classifying a turn, so models that narrate before calling `searchMemory` still get the memory round. `0` = pipe immediately. |

## Capture

| Variable | Default | What it does |
|---|---|---|
| `BELLA_PROXY_CAPTURE` | on | `0` disables auto-capture entirely. |
| `BELLA_CAPTURE_DISTILL` | on | `0` skips the local-LLM distillation pass (regex heuristics only). |

## Embeddings

| Variable | Default | What it does |
|---|---|---|
| `BELLA_EMBED_TIER` | auto | `quality` (multilingual-e5-small, WASM) or `light` (static Model2Vec — low-RAM safe). Auto-picked by device RAM and **pinned per data dir**. |
| `BELLA_EMBED_MIN_RAM_GB` | `7` | Below this total RAM, auto picks the light tier. |
| `LOCAL_EMBED_MODEL` / `EMBED_DIM` | unset | Pin a specific model (dimension change requires a fresh DB). |
| `EMBEDDING_PROVIDER` | `local` | `openai` enables the optional cloud fallback (requires `OPENAI_API_KEY`). |

## Storage & safety

| Variable | Default | What it does |
|---|---|---|
| `BELLA_HOME` | OS app dirs | Put everything under one folder (portable install). |
| `BELLA_DATA_DIR` / `BELLA_CACHE_DIR` / `BELLA_LOG_DIR` / `BELLA_MODEL_DIR` | OS app dirs | Relocate individual pieces. |
| `DATABASE_URL` | embedded | Use external Postgres+pgvector instead of the embedded DB (advanced). |
| `BELLA_DISK_BUDGET_MB` | `0` (off) | Soft disk cap; `bella doctor` reports usage. |
| `BELLA_TRACE_RETENTION` | `1000` | How many recall/proxy traces to keep (`0` = never prune). |
| `BELLA_SUPERSEDE_THRESHOLD` | engine-aware | Cosine floor for supersede-on-write. |
| `SEARCH_THRESHOLD` | per-model | Recall similarity floor. |
| `BELLA_RECENCY_WEIGHT` | `0.15` | How much freshness matters in memory ranking (`0` = pure relevance; max `1`). An infinitely old memory keeps `1 − weight` of its relevance — decayed, never buried. |
| `BELLA_RECENCY_TAU_DAYS` | `90` | The freshness half-life-ish time scale: how fast a memory's recency boost fades. |

Run `bella doctor` any time — it verifies the DB, model, ports, and disk against your config.

## Embedded database lock

The embedded DB (default, no `DATABASE_URL`) is guarded by a single-writer PID lock at
`<data dir>/db.lock`: every `bella` process refuses to open the store while another process's lock
is intact, so two cooperating Bellamente processes never open the same store at once — that
would silently corrupt it. Bellamente **never automatically removes or reuses another process's
lock, even one that belonged to a process that has since exited** — deleting it automatically would
risk two writers racing during the removal itself. If startup fails with `BELLA_DB_LOCKED`,
`bella doctor` reports whether the recorded pid is confirmed running, confirmed not running, or its
status could not be determined — a dead or unresolved lock is always reported as a failing check,
never as healthy. To recover: **first stop (or confirm stopped) every process that could start
Bellamente against this data directory** — a lock check followed by a rename is only safe when
nothing else can win the race to reclaim or restart in between. With startup serialized that way,
confirm via your OS process list whether the recorded pid is actually running, and only once you're
certain it is not, **rename** (never delete) the lock file so the incident stays diagnosable, then
start again. `bella` itself does not perform this recovery for you — there is no automatic or
background reclaim of another process's lock.
