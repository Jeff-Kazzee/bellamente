# 04 - Search

## Purpose
searchMemories() - recall, verbatim port.

## Input
- q: string
- limit: 1..100 (default 10)
- threshold: default 0.4
- filters?, containerTag
- include: { forgottenMemories?, documents?, relatedMemories?, summaries? }
- searchMode: "memories" (default) | "documents" | "hybrid"

## Constants (qT)
RESULTS_PER_QUERY=15, MAX_COMBINED_RESULTS=25, SIMILARITY_THRESHOLD=0.4,
SEARCH_TIMEOUT_MS=10000, ENABLE_RERANK=false, ENABLE_QUERY_REWRITE=false.

## Algorithm
1. embed([q], taskType=QUESTION_ANSWERING).
2. Vector search memory_embedding cosine, limit*RESULTS_PER_QUERY candidates,
   keep similarity >= threshold. [DESIGN: similarity = 1 - (memory_embedding <=> query)]
3. Dual-pass recency: a date-filtered pass gets min(1, sim+0.1) boost; merge by id keep max.
4. Exclude unless include.forgottenMemories:
   is_latest=true AND is_forgotten=false AND (forget_after IS NULL OR forget_after > now()).
5. Dedup by id; cap at MAX_COMBINED_RESULTS=25; map to result shape.
6. Whole search under a 10s race; on timeout return empty.

## Filters (port of Pn)
- exact: metadata->>'k' = 'v'
- OR: array of values
- string_contains -> ILIKE
- neq
- container tag: container_tags @> ARRAY[..]::text[]

## Acceptance
- Threshold respected; forgotten/expired excluded by default; never returns > 25.
