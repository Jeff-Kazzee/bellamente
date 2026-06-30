# 02 - Embedding

## Purpose
The single embed() used by writes, ingestion, and search.

## Contract
- type TaskType = QUESTION_ANSWERING | RETRIEVAL_QUERY | RETRIEVAL_DOCUMENT
- embed({ values: string[], taskType }): Promise<number[][]>  each row length EMBED_DIM (384)
- EMBED_DIM = 384 (must equal schema.sql vector(N))

## Rules
- Query side: QUESTION_ANSWERING / RETRIEVAL_QUERY. Document side: RETRIEVAL_DOCUMENT.
- Truncate input when len*2 > 36000 chars -> cut to 36000/2.
- Validate every vector: length === EMBED_DIM AND finite; skip otherwise.
- Prewarm at boot unless MINIMEM_SKIP_EMBEDDING_PREWARM=1.

## Default model (chosen by A/B, `bun run bench`)
multilingual-e5-small (Xenova/multilingual-e5-small) via transformers.js (ONNX), in-process.
- MIT, 118M params, 384-d native, mean pooling, prefixes "query: " / "passage: ".
- Picked on merit: ties bge-base on English AND is genuinely multilingual, smallest + fastest.

English A/B (14 mem, 12 queries, q8, CPU):
| Model | params | dim | license | EN R@1 | EN MRR | ms/embed |
|-------|--------|-----|---------|--------|--------|----------|
| multilingual-e5-small (DEFAULT) | 118M | 384 | MIT | 83% | 0.882 | ~7 |
| bge-base-en-v1.5 | 109M | 768 | MIT | 83% | 0.882 | ~11 |
| Qwen3-Embedding-0.6B | 600M | 768 | Apache-2.0 | 83% | 0.892 | ~110 |
| multilingual-e5-base | 278M | 768 | MIT | 75% | 0.833 | ~17 |

Multilingual verification (non-Latin cross-lingual: query in zh/ja/ko/ru/ar -> English memory):
- multilingual-e5-small: R@1 = 100% (all correct)
- bge-base-en-v1.5: R@1 = 40% (English/Latin-only; fails zh/ko/ar)
Confirmed live: Spanish query -> correct English memory at 0.82.

## Supported languages (multilingual-e5-small, ~100 from XLM-RoBERTa / CC100)
Strongest on high-resource languages; low-resource may degrade. Verified here: en, es, fr, de,
it, pt, zh, ja, ko, ru, ar. Full set (ISO codes):
af am ar as az be bg bn br bs ca cs cy da de el en eo es et eu fa fi fr fy ga gd gl gu ha he hi
hr hu hy id is it ja jv ka kk km kn ko ku ky la lo lt lv mg mk ml mn mr ms my ne nl no om or pa
pl ps pt ro ru sa sd si sk sl so sq sr su sv sw ta te th tl tr ug uk ur uz vi xh yi zh

## Per-model profiles (src/embed.ts)
PROFILES maps model id -> { pooling, query, doc }:
- e5 (multilingual-e5-*): pooling "mean"; query "query: {t}"; doc "passage: {t}".
- bge-*: pooling "cls"; query "Represent this sentence for searching relevant passages: {t}"; doc raw.
- Qwen3: pooling "last_token"; query "Instruct: ...\nQuery:{t}"; doc raw.
- fallback: pooling "mean", raw prompts.
Matryoshka: slice to EMBED_DIM then L2-normalize.

## Opt-ins (set EMBED_DIM to match + recreate DB)
- English-only, slightly higher MRR: Xenova/bge-base-en-v1.5 (768).
- 768-d multilingual: Xenova/multilingual-e5-base (768).
- Multilingual + 32K context: onnx-community/Qwen3-Embedding-0.6B-ONNX (768).

## Context length
e5-small reads up to 512 tokens (~2000 chars) per input - ample for short + multi-sentence
memories and our 1075-char chunks. It is max-text-per-embedding, not a memory cap. Use Qwen3
(32K) only to embed long passages un-chunked.

## Dev fallback provider: openai
EMBEDDING_PROVIDER=openai -> text-embedding-3-small (dimensions per EMBED_DIM). Needs OPENAI_API_KEY.

## Acceptance
- embed() returns EMBED_DIM-length finite vectors for both task sides.
- Relevant pairs out-rank irrelevant ones, cross-lingually for multilingual models.
- Dim mismatch rejected before insert.
