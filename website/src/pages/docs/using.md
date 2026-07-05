---
layout: ../../layouts/DocsLayout.astro
title: Using it
description: Connect a chat client or agent, memory grounding on streamed chats, auto-capture, and the dashboard.
---

# Using Bellamente

## Connect any OpenAI-compatible client

Change one base URL. Bellamente sits between your client and your local model server
(Ollama, LM Studio, llama.cpp, vLLM — anything speaking `/v1/chat/completions`):

```sh
# your client talks to Bellamente...
OPENAI_BASE_URL=http://127.0.0.1:8080/v1
# ...Bellamente talks to your model (default: http://127.0.0.1:11434/v1, i.e. Ollama)
BELLA_UPSTREAM_BASE_URL=http://127.0.0.1:11434/v1
```

On every chat turn the proxy offers your model a `searchMemory` tool, runs the recall locally when
the model calls it, re-invokes your model with the results, and returns only the final answer —
**on buffered and streamed chats alike**. The response headers tell you what happened
(`x-bella-memory-round: true` means memory grounded that answer).

## Give a coding agent memory today

Any CLI-like agent that can read docs and make HTTP requests can use Bellamente directly over HTTP.
Start by pointing it at the public agent docs:

https://the-little-ai-company.github.io/bellamente/llms.txt

Then paste this local instruction block where that agent keeps project or tool instructions:

```prompt
This machine runs Bellamente, a local memory service, at http://127.0.0.1:8080 (no auth on localhost).
- Read https://the-little-ai-company.github.io/bellamente/llms.txt for current Bellamente docs and boundaries.
- To REMEMBER a durable fact: POST /memories with JSON {"memories":[{"content":"<the fact>"}]}
- To RECALL: POST /search with JSON {"q":"<what you need to know>"} — results include content and a similarity score.
- Recall before starting work on a topic; remember stable facts (preferences, decisions, environment details) when you learn them.
- Every response returns an x-bella-trace-id header; the human can audit any recall at http://127.0.0.1:8080/.
```

Bellamente is harness-neutral: use the CLI, HTTP API, or proxy directly. Do not commit generated
agent-harness config bundles into a project just to use Bellamente. A native MCP server —
`bella mcp` — is on the [roadmap](/bellamente/roadmap).

## Measure retrieval quality

Run the deterministic E2E benchmark from the repo root:

```sh
bun run bench
```

It loads fixtures through `POST /memories` and `POST /documents`, queries `POST /search` in
`memories`, `documents`, and `hybrid` modes, then reports recall@1/5/10, MRR, p50/p95 latency, and
route-vector-vs-brute-force recall. The default run uses `embedder=deterministic-hash` so it measures the
retrieval pipeline reproducibly. At this fixture size PGlite does not engage HNSW, so the vector comparison is an exact-vs-route delta; the 50k-row P1.5/#39 probe is where real ANN-loss behavior is measured. Set `BELLA_EVAL_REAL_EMBED=1` to use the active local embedder.
Latest checked deterministic run (`seed=20260702`, 110 queries): memories R@1/R@10/MRR
`84.1%/100.0%/0.920`, documents `100.0%/100.0%/1.000`, hybrid `100.0%/100.0%/1.000`, exact-vs-route delta@10
`0.0%`. Hybrid recall is an any-gold hit across the paired memory/document golds; the document and hybrid rows are deterministic ceiling checks, not a broad claim about every document corpus.

## Your memory is a file

`curl localhost:8080/export > bellamente-backup.json` — chains, validity windows, forgotten flags,
profiles, and documents in one portable JSON. Restore anywhere with
`curl -X POST localhost:8080/import -H 'content-type: application/json' -d @bellamente-backup.json`;
embeddings regenerate locally on the way in, so the same file works across machines and embedder
tiers. Re-importing is a safe no-op.

## Auto-capture: it remembers for you

After each answered chat turn, Bellamente conservatively captures durable first-person facts
("I prefer metric units") through the same dedup path as manual writes. A small LLM pass through
**your own local model** distills facts (never a cloud call); regex heuristics are the fallback.

- Credentials, financial IDs, and medical disclosures are **excluded and never stored** — and the
  filter is re-applied to everything the LLM extracts.
- Every capture is traced and reversible; captured memories are marked `is_inference` so they are
  forever distinguishable from things you stored deliberately.
- Kill switches: `BELLA_PROXY_CAPTURE=0` (capture off), `BELLA_CAPTURE_DISTILL=0` (heuristics only).

## The dashboard

Open `http://127.0.0.1:8080/` in a browser. Three views:

- **Traces** — every search/proxy/capture event: what was retrieved, scores, latency, what was
  injected into the model.
- **Search** — a recall playground with the same knobs the API has.
- **Memory** — browse, edit (creates a new version), forget (reversible), delete, and view the full
  version history of every memory.

Nothing is silently overwritten: edits version, forgetting is auditable, hard delete says what it
takes with it.
