# 10 - Configuration (env)

## Core
| Env | Default | Effect |
|-----|---------|--------|
| MINIMEM_API_KEY | (required) | bearer auth |
| PORT | 8080 | HTTP listen port |
| SEARCH_THRESHOLD | 0.4 | default cosine cutoff |
| ORG_ID | minimem_default_org | single-tenant constant org id |
| DEFAULT_CONTAINER_TAG | default | default space / container tag |

## Database
| Env | Default | Effect |
|-----|---------|--------|
| DATABASE_URL | (unset) | external Postgres+pgvector (M1 dev). M2 -> embedded PGlite |
| PGLITE_DATA_DIR | embedded | data dir for embedded Postgres (M2) |

## Embeddings
| Env | Default | Effect |
|-----|---------|--------|
| EMBEDDING_PROVIDER | local | local (in-process, no cloud) or openai (dev fallback) |
| LOCAL_EMBED_MODEL | Xenova/multilingual-e5-small | transformers.js model; src/embed.ts has a pooling/prompt profile per model |
| LOCAL_EMBED_DTYPE | q8 | fp32 / fp16 / q8 / q4 |
| EMBED_DIM | 384 | output dim; MUST equal schema.sql vector(N). Changing it requires recreating tables |
| MINIMEM_SKIP_EMBEDDING_PREWARM | 0 | skip boot warmup |
| OPENAI_API_KEY | (unset) | only if provider=openai |
| OPENAI_EMBED_MODEL | text-embedding-3-small | dev fallback embed model |

## Model choice (from `bun run bench`)
| Model | params | dim | ctx | license | notes |
|-------|--------|-----|-----|---------|-------|
| Xenova/multilingual-e5-small (DEFAULT) | 118M | 384 | 512 | MIT | ties bge on English, verified multilingual, smallest/fastest |
| Xenova/bge-base-en-v1.5 | 109M | 768 | 512 | MIT | English-only; slightly higher MRR |
| Xenova/multilingual-e5-base | 278M | 768 | 512 | MIT | 768-d multilingual |
| onnx-community/Qwen3-Embedding-0.6B-ONNX | 600M | 768 | 32K | Apache-2.0 | multilingual + long context; ~7-15x slower |

## Notes
- Default needs NO cloud and NO model server (transformers.js / ONNX, in-process).
- Multilingual: ~100 languages (XLM-RoBERTa). See docs/02-embedding for the list.
- Config read once at boot; no hot reload in v1.
