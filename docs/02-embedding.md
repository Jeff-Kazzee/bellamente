# 02 - Embedding

## Purpose
The single embed() used by writes, ingestion, and search.

## Contract
- type TaskType = QUESTION_ANSWERING | RETRIEVAL_QUERY | RETRIEVAL_DOCUMENT
- embed({ values: string[], taskType }): Promise<number[][]>   each row length EMBED_DIM (768)
- EMBED_DIM = 768 (port of kd0())

## Rules (verbatim from source)
- Query side: QUESTION_ANSWERING (v4) / RETRIEVAL_QUERY (v3). Document side: RETRIEVAL_DOCUMENT.
- Truncate input when len*2 > 36000 chars -> cut to 36000/2.
- Validate every vector: length === EMBED_DIM AND all finite; skip otherwise (matches $V2).
- Prewarm at boot unless MINIMEM_SKIP_EMBEDDING_PREWARM=1 (verbatim env behavior).

## Default model (chosen by A/B, `bun run bench`)
bge-base-en-v1.5 (Xenova/bge-base-en-v1.5) via transformers.js (ONNX), in-process.
- MIT licensed, 109M params, 768-d native (no truncation), CLS pooling.
- This is also the model the original Supermemory shipped (mP0 = "Xenova/bge-base-en-v1.5"),
  but it was selected here on merit, not fidelity - it WON the head-to-head.

A/B results (14 memories, 12 English queries, q8, CPU):
| Model | params | dim | ctx | license | Recall@1 | Recall@3 | MRR | ms/embed |
|-------|--------|-----|-----|---------|----------|----------|-----|----------|
| bge-base-en-v1.5 (DEFAULT) | 109M | 768 | 512 | MIT | 83.3% | 91.7% | 0.889 | 15 |
| Qwen3-Embedding-0.6B | 600M | 768 | 32K | Apache-2.0 | 83.3% | 91.7% | 0.896 | 105 |
| bge-small-en-v1.5 | 33M | 384 | 512 | MIT | 83.3% | 83.3% | 0.861 | 6 |
bge-base ties Qwen3 on quality at ~7x the speed / ~5.5x smaller -> best quality-per-resource.

## Per-model profiles (src/embed.ts)
Each model needs its own pooling + prompt format; PROFILES maps model id -> { pooling, query, doc }:
- bge-*: pooling "cls"; query prefix "Represent this sentence for searching relevant passages: "; doc raw.
- Qwen3: pooling "last_token"; query "Instruct: ...\nQuery:{t}"; doc raw.
- fallback: pooling "mean", raw prompts.
taskType RETRIEVAL_DOCUMENT -> doc(); QUESTION_ANSWERING/RETRIEVAL_QUERY -> query().
Matryoshka: slice to EMBED_DIM then L2-normalize (no-op when native == EMBED_DIM).

## Opt-ins
- Multilingual / 32K context (heavier ~5x): LOCAL_EMBED_MODEL=onnx-community/Qwen3-Embedding-0.6B-ONNX (keep EMBED_DIM=768).
- Ultralight 33M / 384-d: LOCAL_EMBED_MODEL=Xenova/bge-small-en-v1.5 (set EMBED_DIM=384 + schema vector(384)).
- Long-context Apache alt: nomic-embed-text-v1.5 (8192 ctx, 768-d, mean pooling, search_query/search_document
  prefixes) - add a profile + a valid transformers.js ONNX repo id.

## Context length note
512 tokens (~2000 chars) is ample for short + multi-sentence memories and 1075-char chunks. It is
NOT a memory cap - it is max text per embedding call. Only embedding long passages un-chunked or
multilingual needs Qwen3's 32K.

## Dev fallback provider: openai
EMBEDDING_PROVIDER=openai -> text-embedding-3-small with dimensions:768. Requires OPENAI_API_KEY.

## M2 (single binary)
Bundle the ONNX weights (or download-on-first-run to a data dir) so `bun build --compile` embeds
locally with no network.

## Acceptance
- embed() returns EMBED_DIM-length finite vectors for both task sides.
- Relevant query/document pairs out-rank irrelevant ones (verified: query->dark-mode 0.58 vs paris 0.31).
- Dim mismatch rejected before insert.
