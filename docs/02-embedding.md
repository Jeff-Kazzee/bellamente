# 02 - Embedding

## Purpose
The single embed() used by writes, ingestion, and search.

## Contract
- type TaskType = QUESTION_ANSWERING | RETRIEVAL_QUERY | RETRIEVAL_DOCUMENT
- embed({ values: string[], taskType }): Promise<number[][]>   each row length EMBED_DIM (768)
- EMBED_DIM = 768 (port of kd0())

## Rules (verbatim from source)
- Query side: QUESTION_ANSWERING (v4) / RETRIEVAL_QUERY (v3).
- Document/memory side: RETRIEVAL_DOCUMENT.
- Truncate input when len*2 > 36000 chars -> cut to 36000/2.
- Validate every vector: length === EMBED_DIM AND all finite; skip otherwise (matches $V2).
- Prewarm at boot unless MINIMEM_SKIP_EMBEDDING_PREWARM=1 (verbatim env behavior).

## Default provider: local, in-process (no cloud, no server)
Model: Qwen3-Embedding-0.6B via transformers.js (@huggingface/transformers v4),
ONNX build onnx-community/Qwen3-Embedding-0.6B-ONNX.

Why this model (selected June 2026, replaces the earlier EmbeddingGemma idea):
- Small sibling of the current #1 MTEB family (Qwen3-Embedding 8B).
- Instruction-aware -> maps cleanly to our taskType.
- Matryoshka (MRL) supports any dim 32..1024 -> we truncate to 768, so schema is unchanged.
- ONNX + transformers.js -> runs in the Bun process; no Ollama/no server.

Mechanics (verified working under Bun + onnxruntime-node):
- pipeline("feature-extraction", LOCAL_EMBED_MODEL, { dtype }) ; dtype in fp32|fp16|q8 (default q8).
- pooling: "last_token", normalize: false (we do MRL truncate + L2-normalize ourselves).
- Query format (Qwen3): `Instruct: ${EMBED_QUERY_INSTRUCTION}\nQuery:${text}`.
- Document format: raw text (asymmetric retrieval).
- MRL: slice vector to EMBED_DIM, then L2-normalize.
- First run downloads the model (~600MB at q8) to the HF cache; prewarmed at boot.

Verified: query "what color theme does John like" ranks "John prefers dark mode" (cos ~0.51)
well above unrelated memories, which fall under the 0.4 threshold.

## Swappable
- LOCAL_EMBED_MODEL: any transformers.js feature-extraction model (e.g. nomic-embed-text-v2,
  bge-m3, granite-embedding, or Qwen3-Embedding-4B for more quality). If a model is not MRL or
  has a different native dim, set EMBED_DIM to match and update schema.sql vector(N).
- LOCAL_EMBED_DTYPE: fp32 | fp16 | q8 (size/speed/quality trade-off).

## Dev fallback provider: openai
EMBEDDING_PROVIDER=openai -> text-embedding-3-small with dimensions:768 (taskType ignored).
Requires OPENAI_API_KEY. Only for quick cloud-based dev; not needed for normal operation.

## M2 (single binary)
Bundle the ONNX weights (or download-on-first-run to a data dir) so `bun build --compile`
yields a binary that embeds locally with no network.

## Acceptance
- embed() returns EMBED_DIM-length finite vectors for both task sides.
- Relevant query/document pairs out-rank irrelevant ones.
- Dim mismatch is rejected before insert.
