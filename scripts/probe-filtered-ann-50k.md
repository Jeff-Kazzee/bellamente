# P1.5 Filtered-ANN Probe Evidence

Generated on 2026-07-04 at the **production over-fetch LIMIT** with:

```bash
bun run probe:ann -- --rows 50000 --dim 384 --ef 40,100,200
```

The default LIMIT is now `10 * Q.RESULTS_PER_QUERY = 150` — the real production over-fetch
(`src/search.ts`). The earlier evidence probed `--limit 10`, a query production never issues, and
its "both legs use HNSW → no knob needed" reading did not survive the correct LIMIT (PR #93 review
finding F1). The full local run (SQL shapes + every `EXPLAIN ANALYZE` plan) is saved at
`C:\tmp\bellamente-p1.5-probe-50k.md`. This tracked note preserves the evidence for the PR even
though `docs/` is intentionally ignored in this repository.

## Summary (50k rows, dim 384, LIMIT 150)

| target | ef_search | returned | latency ms | planner |
|---|---:|---:|---:|---|
| memories | 40 | 150 | 219.9 | seq-scan |
| chunks | 40 | 40 | 2.8 | vector-index |
| memories | 100 | 150 | 276.1 | seq-scan |
| chunks | 100 | 100 | 3.7 | vector-index |
| memories | 200 | 150 | 234.4 | seq-scan |
| chunks | 200 | 150 | 3.3 | vector-index |

At LIMIT 150 the conclusion flips: one leg is starved and the other does not use its HNSW index at
all. Two independent production gaps, both tracked in **issue #105** (not decided by this probe):

**Gap 1 — chunk leg starved to `ef_search`.** The chunk leg uses `idx_chunk_embedding_hnsw` but
returns only `min(ef_search, LIMIT)`: **40** rows at pgvector's default `ef_search = 40`, 100 at
100, 150 at 200. Production over-fetches 150 candidates (`limit * Q.RESULTS_PER_QUERY`) but the
RRF/MMR fusion pool receives ~27% of them at the default — the exact "index returns too few
candidates" footgun P1.5 was commissioned to detect.

**Gap 2 — memory leg abandons HNSW.** At LIMIT 150 the memory leg does not use
`idx_memory_entry_embedding_hnsw`: the planner chooses a Seq Scan on `memory_entry` + top-N
heapsort (220–276 ms here at 50k; the review's independent run measured 545–590 ms). Results are
exact (recall is fine), but latency scales linearly with corpus size and raising `ef_search` cannot
fix a seq-scan.

## Tuning recommendation

Do **not** add a `BELLA_HNSW_EF_SEARCH` knob from this probe. Remediation candidates — session
`SET hnsw.ef_search >= LIMIT`, `hnsw.iterative_scan` (bundled pgvector is 0.8.1), or a
corpus-size-thresholded plan choice for the memory leg — each need recall-vs-latency measurement,
which is the scope of **issue #105**. This probe classifies query plans and row-fill; it does not
measure recall quality. Keep over-fetching until #105 lands.

## Method notes

- Plan shapes for every `(target, ef_search)` cell (`EXPLAIN ANALYZE` full output) are in the saved
  local run file above; the memory leg's `Seq Scan on memory_entry` + top-N heapsort and the chunk
  leg's `Index Scan using idx_chunk_embedding_hnsw` are stable across all probed `ef_search` values.
- Selective-filter variant: `--spaces N` seeds rows across N spaces so the probed tag matches 1/N of
  the corpus; this run used a single space (`--spaces 1`), the most-favorable case — truncation
  appeared anyway, so the risk is understated here, not overstated.
- `hnsw.iterative_scan` is sweepable via `--iterative relaxed_order|strict_order` (default `off`).
- Latency is single-shot wall-clock around `EXPLAIN ANALYZE` (plan classification, not a load
  benchmark); `vectorFor()` is a near-degenerate distribution — sufficient for plan/row-fill
  evidence, not for recall-quality claims.
