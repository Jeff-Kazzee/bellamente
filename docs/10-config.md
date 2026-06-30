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
| LOCAL_EMBED_MODEL | Xenova/bge-base-en-v1.5 | transformers.js model; src/embed.ts has a pooling/prompt profile per known model |
| LOCAL_EMBED_DTYPE | q8 | fp32 / fp16 / q8 / q4 |
| EMBED_DIM | 768 | output dim (must equal schema.sql vector(N)) |
| MINIMEM_SKIP_EMBEDDING_PREWARM | 0 | skip boot warmup (first request pays load cost) |
| OPENAI_API_KEY | (unset) | only if provider=openai |
| OPENAI_EMBED_MODEL | text-embedding-3-small | dev fallback embed model (dimensions:768) |

## Model choice (from `bun run bench`)
| Model | params | dim | ctx | license | notes |
|-------|--------|-----|-----|---------|-------|
| Xenova/bge-base-en-v1.5 (DEFAULT) | 109M | 768 | 512 | MIT | best quality/resource; ~15ms/embed |
| onnx-community/Qwen3-Embedding-0.6B-ONNX | 600M | 1024->768 | 32K | Apache-2.0 | multilingual + long context; ~7x slower |
| Xenova/bge-small-en-v1.5 | 33M | 384 | 512 | MIT | ultralight; set EMBED_DIM=384 + schema |

## Notes
- Default needs NO cloud and NO model server: the model runs in-process via transformers.js (ONNX).
  First run downloads weights to the HF cache; subsequent boots prewarm.
- 512-token context (~2000 chars) is ample for short + multi-sentence memories and our 1075-char
  chunks. Switch to Qwen3 only for multilingual or embedding long passages un-chunked.
- All config read once at boot; no hot reload in v1.
