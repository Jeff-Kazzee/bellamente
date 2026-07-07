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

Agents that read project instructions (Claude Code, Cursor, Codex, etc.) can use Bellamente
directly over HTTP — paste this into your agent's instructions:

```prompt
This machine runs Bellamente, a local memory service, at http://127.0.0.1:8080 (no auth on localhost).
- To REMEMBER a durable fact: POST /memories with JSON {"memories":[{"content":"<the fact>"}]}
- To RECALL: POST /search with JSON {"q":"<what you need to know>"} — results include content and a similarity score.
- Recall before starting work on a topic; remember stable facts (preferences, decisions, environment details) when you learn them.
- NEVER store secrets — API keys, passwords, tokens, private keys, or credentials. Use your judgment; if a fact contains a secret, leave the secret out.
- Every response returns an x-bella-trace-id header; the human can audit any recall at http://127.0.0.1:8080/.
```

## Give an MCP-native agent memory directly

Agents that speak MCP (Claude Desktop, Claude Code, Cursor, Cline, Codex) can use Bellamente as a
native tool server — no HTTP glue, no copy-pasted prompt:

```sh
claude mcp add bellamente -- bella mcp
```

`bella mcp` speaks JSON-RPC over stdio and exposes nine tools on the SAME local memory store `bella
serve` uses (no second database, no separate write path): `memory_search`, `memory_write`,
`memory_correct` (change a specific memory by id, recording a new version), `memory_forget`
(reversible soft-forget only — it never hard-deletes), `memory_list`, `memory_history` (a memory's
full version chain, forgotten versions included — the inspect-and-trust view), `document_ingest`,
`document_list`, and `trace_inspect`. Every search is recorded as a recall trace you can read back
with `trace_inspect` (optionally filtered by `kind`), exactly like the dashboard's Traces view.

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

## Secrets are never stored

Bellamente is used by intelligent agents, so the **first line of defense is the agent itself**: the MCP tool
descriptions and the HTTP agent-instructions above tell the calling agent to use its judgment and never store
secrets. That's where the real intelligence lives — the agent understands what's sensitive.

As a **deterministic backstop** for when an agent slips, every memory write — manual `POST /memories`, MCP
`memory_write`, batch, corrections, and auto-capture — also passes through a credential gate before it is
embedded or stored. Detected credentials are stripped from the memory **content and its structured metadata**
and replaced with a `[redacted: <kind>]` marker; the raw value never reaches the store. The gate works two ways:

- **Known formats** (zero false positives): private keys (PEM blocks), AWS access keys, GitHub / GitLab tokens,
  Slack tokens, Stripe live keys, npm / HuggingFace tokens, and OpenAI / Anthropic / Google API keys.
- **Labeled values (provider-agnostic)**: any value explicitly labeled as a secret — `api key = …`, `token: …`,
  `AUTH_TOKEN=…`, `the password is …` — is redacted **whatever the provider**, because it keys on the label, not
  the format. (The value must look like a token, so English like "the password is required" is left alone.)

The surrounding context survives (`"prod key is [redacted: OpenAI API key], in vault X"`), and the API/MCP
response reports what was redacted. On the auto-capture path, the local distillation model is additionally asked
to drop credentials outright.

**Honest limits — this is deliberate.** A secret is defined by intent, not shape, so no deterministic gate
catches *everything*: a bare, unlabeled random token, or a password that is an ordinary word, can slip through.
We deliberately do **not** use high-entropy heuristics — they would shred the git SHAs, UUIDs, and base64 blobs
you legitimately store, and worst of all on auto-capture, which writes silently. The gate is tuned to **not**
eat real developer memories: documented placeholders like AWS `AKIAIOSFODNN7EXAMPLE`, `sk_test_` keys, JWTs, and
git SHAs are left alone. Storing a real credential deliberately? Send `allowSecrets: true` on that write.

## The dashboard

Open `http://127.0.0.1:8080/` in a browser. Three views:

- **Traces** — every search/proxy/capture event: what was retrieved, scores, latency, what was
  injected into the model.
- **Search** — a recall playground with the same knobs the API has.
- **Memory** — browse, edit (creates a new version), forget (reversible), delete, and view the full
  version history of every memory.

Nothing is silently overwritten: edits version, forgetting is auditable, hard delete says what it
takes with it.

## Report a bug — `bella report`

When something breaks, `bella report` assembles a bug report for you — but it opens nothing and
sends nothing. It prints a **content-free** summary and a prefilled GitHub `issues/new` link; you
review exactly what will be shared, then click submit on GitHub yourself. Consistent with "never
phones home", the binary transmits nothing.

```sh
bella report
```

What the report contains: version, OS, the embedder tier/model, disk + storage **sizes**, and your
recent errors grouped by fingerprint — **codes and counts only**, never messages, stacks, file
contents, or conversation text. Storage locations are reduced to directory names + sizes (never the
absolute path, which would carry your username), and the database is shown as a mode
(`embedded`/`external`) — never the connection URL.

If `bella mcp` or another process is holding the local database, run `bella report` with it stopped
to include the full error list; a running `bella serve` on localhost is read through its
content-free errors endpoint automatically.
