# P1.5 Filtered-ANN Probe Evidence

Generated on 2026-07-03 with:

```bash
bun run probe:ann -- --rows 50000 --dim 384 --ef 40,100,200 --limit 10
```

The full local run output was also saved at `C:\tmp\bellamente-p1.5-probe-50k.md`.
This tracked note preserves the evidence needed for the PR even though `docs/` is
intentionally ignored in this repository.

## Summary

| target | ef_search | returned | latency ms | planner |
|---|---:|---:|---:|---|
| memories | 40 | 10 | 16.8 | vector-index |
| chunks | 40 | 10 | 7.2 | vector-index |
| memories | 100 | 10 | 6.4 | vector-index |
| chunks | 100 | 10 | 4.3 | vector-index |
| memories | 200 | 10 | 7.1 | vector-index |
| chunks | 200 | 10 | 3.8 | vector-index |

## Tuning Recommendation

Do not add `BELLA_HNSW_EF_SEARCH` from this probe. PGlite engaged HNSW for both
filtered, production-shaped vector query legs at 50k rows, and this script is a
plan/latency probe, not a recall-vs-brute-force quality probe. Keep the current
over-fetch behavior and revisit `hnsw.ef_search` only with recall evidence.

## Plan Evidence

Relevant `EXPLAIN ANALYZE` lines:

```text
Index Scan using idx_memory_entry_embedding_hnsw on memory_entry
Index Scan using idx_chunk_embedding_hnsw on chunk c
```

Those index scans appeared for every probed `ef_search` value: 40, 100, and 200.
