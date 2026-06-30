# 10 - Configuration (env)

## Core
| Env | Default | Effect |
|-----|---------|--------|
| MINIMEM_API_KEY | (required) | bearer auth |
| PORT | 8080 | HTTP listen port |
| SEARCH_THRESHOLD | 0.4 | default cosine cutoff |
| ORG_ID | sm_default_org | single-tenant constant org id |
| DEFAULT_CONTAINER_TAG | sm_project_default | default space / container tag |

## Database
| Env | Default | Effect |
|-----|---------|--------|
| DATABASE_URL | (unset) | external Postgres+pgvector (M1 dev). M2 -> embedded PGlite |
| PGLITE_DATA_DIR | embedded | data dir for embedded Postgres (M2) |

## Embeddings
| Env | Default | Effect |
|-----|---------|--------|
| EMBEDDING_PROVIDER | local | local (in-process, no cloud) or openai (dev fallback) |
| LOCAL_EMBED_MODEL | onnx-community/Qwen3-Embedding-0.6B-ONNX | transformers.js feature-extraction model |
| LOCAL_EMBED_DTYPE | q8 | fp32 / fp16 / q8 (size vs quality) |
| EMBED_QUERY_INSTRUCTION | "Given a search query, retrieve relevant memories and passages that answer the query" | Qwen3 query instruction (documents embedded raw) |
| EMBED_DIM | 768 | output dim (MRL truncation). Must equal schema.sql vector(N) |
| MINIMEM_SKIP_EMBEDDING_PREWARM | 0 | skip boot warmup (first request pays load cost) |
| OPENAI_API_KEY | (unset) | only if provider=openai |
| OPENAI_EMBED_MODEL | text-embedding-3-small | dev fallback embed model (dimensions:768) |

## Notes
- Default operation needs NO cloud API and NO model server: the local provider runs the model
  in-process via transformers.js (ONNX). First run downloads weights (~600MB at q8) to the HF
  cache; subsequent boots prewarm from cache.
- Original hardcodes SELF_HOSTED=true and deletes cloud env at startup.
- All config is read once at boot; no hot reload in v1.
