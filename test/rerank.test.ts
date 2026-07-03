import { test, expect } from "bun:test";
import { mmrRerank, parseVector } from "../src/rerank";

test("parseVector accepts pgvector text and arrays, rejects unusable values", () => {
  expect(parseVector("[1,2,3]")).toEqual([1, 2, 3]);
  expect(parseVector(["1", 2])).toEqual([1, 2]);
  expect(parseVector(null)).toBeNull();
  expect(parseVector("not-a-vector")).toBeNull();
});

test("mmrRerank handles empty, singleton, zero-limit, and raw-score paths", () => {
  expect(mmrRerank([], 3)).toEqual([]);
  const only = { id: "only", score: 0.5, embedding: [1, 0] };
  expect(mmrRerank([only], 3)).toEqual([only]);
  expect(mmrRerank([only], 0)).toEqual([]);

  const ranked = mmrRerank(
    [
      { id: "a", score: 0.9, embedding: [1, 0] },
      { id: "b", score: 0.8, embedding: null },
    ],
    2,
    { normalizeScores: false },
  );
  expect(ranked.map((r) => r.id)).toEqual(["a", "b"]);
});