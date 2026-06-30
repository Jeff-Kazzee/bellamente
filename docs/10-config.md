# 10 - Configuration (env)

| Env | Default | Effect |
|-----|---------|--------|
| MINIMEM_API_KEY | (required) | bearer auth |
| PGLITE_DATA_DIR | embedded | data dir for embedded Postgres |
| DATABASE_URL | (unset) | use external Postgres instead of PGlite (dev) |
| MINIMEM_SKIP_EMBEDDING_PREWARM | 0 | skip model warmup (faster boot, slow first req) |
| EMBEDDING_PROVIDER | local | local | openai (dev fallback) |
| OPENAI_API_KEY | (unset) | only if provider=openai |
| OPENAI_EMBED_MODEL | text-embedding-3-small | dev fallback embed model (dimensions:768) |
| SEARCH_THRESHOLD | 0.4 | override default cosine cutoff |
| PORT | 8080 | HTTP listen port |
| ORG_ID | sm_default_org | single-tenant constant org id |
| DEFAULT_CONTAINER_TAG | sm_project_default | default space/container tag |

## Notes
- Original hardcodes SELF_HOSTED=true and deletes cloud env at startup.
- All secrets are read once at boot; no hot reload in v1.
