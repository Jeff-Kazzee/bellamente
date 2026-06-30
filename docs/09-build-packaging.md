# 09 - Build and Packaging

## Goal
One self-contained executable, zero external deps.

## Build
- bun build src/index.ts --compile --outfile minimem
- Run: ./minimem

## Embedded database
- PGlite (Postgres compiled to WASM) + pgvector extension, bundled into the binary.
- Data dir from PGLITE_DATA_DIR (else embedded default path).
- Encrypted local storage unlocked with a machine-id-derived key (port of startup unlock).
- Dev fallback: set DATABASE_URL to use external Postgres instead of PGlite.

## Embedded model
- Bundle local 768-d model weights/runtime; prewarm at boot.
- Skippable via MINIMEM_SKIP_EMBEDDING_PREWARM=1 (first request then pays warmup cost).

## Targets (verbatim platform guard)
- darwin-arm64, darwin-x64, linux-arm64, linux-x64.

## Self-update (optional)
Original pulls GitHub releases tagged server-vX.Y.Z. Out of scope for v1.

## Acceptance
- ./minimem runs on a clean box with no Postgres, no node_modules, and (if model is local)
  no network.
