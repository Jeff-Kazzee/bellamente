# 02 - Embedding

## Purpose
The single embed() used by writes, ingestion, and search.

## Contract
- type TaskType = QUESTION_ANSWERING | RETRIEVAL_QUERY | RETRIEVAL_DOCUMENT
- embed({ values: string[], taskType }): Promise<number[][]>   each row length 768
- EMBED_DIM(): number   === 768 (port of kd0())

## Rules (verbatim)
- Query side: QUESTION_ANSWERING (v4) / RETRIEVAL_QUERY (v3).
- Document/memory side: RETRIEVAL_DOCUMENT.
- Truncate input when len*2 > 36000 chars -> cut to 36000/2.
- Validate every vector: length === 768 AND all finite; skip otherwise (matches $V2).
- Prewarm at boot unless MINIMEM_SKIP_EMBEDDING_PREWARM=1.

## Model [DESIGN - exact model not recoverable from source]
Bundle a local 768-d model whose API accepts task types (EmbeddingGemma-class is the
strong inference: 768-d + Google task types + local prewarm). Dev fallback adapter:
OpenAI text-embedding-3-small with dimensions:768 (taskType ignored).

## Acceptance
- Same string under RETRIEVAL_DOCUMENT and QUESTION_ANSWERING yields high self-similarity.
- Dim mismatch is rejected before insert.
