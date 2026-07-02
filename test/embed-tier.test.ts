// Device-scaled embedder tier selection (the "don't crash old laptops" safety): e5-small on capable
// machines, static Model2Vec on low-RAM machines, with explicit overrides winning + fail-safe env handling.
import { test, expect } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";

let seq = 0;
async function resolve(over: Record<string, string>): Promise<any> {
  const base = { ...process.env } as Record<string, string>;
  for (const k of ["BELLA_EMBED_TIER", "BELLA_EMBED_MIN_RAM_GB", "LOCAL_EMBED_MODEL", "EMBED_DIM", "EMBEDDING_PROVIDER"]) delete base[k];
  base.BELLA_DATA_DIR = join(tmpdir(), `bella-tier-test-${process.pid}-${seq++}`); // fresh dir -> no persisted marker
  const p = Bun.spawn([process.execPath, join(import.meta.dir, "embed-tier-probe.ts")], { env: { ...base, ...over }, stdout: "pipe", stderr: "pipe" });
  const out = await new Response(p.stdout).text();
  await p.exited;
  return JSON.parse(out.trim());
}

test("auto: low total RAM -> light Model2Vec (never crashes); ample RAM -> e5 quality", async () => {
  const light = await resolve({ BELLA_EMBED_MIN_RAM_GB: "999999" }); // any machine is 'below' -> light
  expect(light).toMatchObject({ tier: "light", model: "minishlab/potion-retrieval-32M", dim: 512, engine: "static" });
  expect(light.threshold).toBe(0.1);
  const quality = await resolve({ BELLA_EMBED_MIN_RAM_GB: "0" }); // any machine is 'above' -> quality
  expect(quality).toMatchObject({ tier: "quality", model: "Xenova/multilingual-e5-small", dim: 384, engine: "wasm" });
  expect(quality.threshold).toBe(0.4);
});

test("BELLA_EMBED_TIER=quality overrides a low-RAM machine", async () => {
  const forced = await resolve({ BELLA_EMBED_TIER: "quality", BELLA_EMBED_MIN_RAM_GB: "999999" });
  expect(forced).toMatchObject({ tier: "quality", model: "Xenova/multilingual-e5-small", dim: 384 });
});

test("explicit LOCAL_EMBED_MODEL wins and EMBED_DIM auto-follows", async () => {
  const pinned = await resolve({ LOCAL_EMBED_MODEL: "minishlab/potion-multilingual-128M", BELLA_EMBED_MIN_RAM_GB: "0" });
  expect(pinned).toMatchObject({ model: "minishlab/potion-multilingual-128M", dim: 256, engine: "static" });
});

test("blank/junk env is treated as UNSET (fails SAFE toward the light tier, no dim=0/model='' traps)", async () => {
  // Empty MIN_RAM_GB must NOT fail-open to quality on a low-RAM box.
  const blankMin = await resolve({ BELLA_EMBED_MIN_RAM_GB: "  " });
  expect(blankMin.dim).toBeGreaterThan(0); // not the Number('')=0 trap
  const junkMin = await resolve({ BELLA_EMBED_MIN_RAM_GB: "eight" });
  expect(junkMin.dim).toBeGreaterThan(0);
  // Blank model/dim must behave like unset, not model='' / dim=0.
  const blankModel = await resolve({ LOCAL_EMBED_MODEL: "", EMBED_DIM: "", BELLA_EMBED_MIN_RAM_GB: "999999" });
  expect(blankModel).toMatchObject({ model: "minishlab/potion-retrieval-32M", dim: 512 });
});

test("OpenAI provider keeps its own dim (384) + threshold (0.4), ignoring the device tier", async () => {
  const openai = await resolve({ EMBEDDING_PROVIDER: "openai", BELLA_EMBED_MIN_RAM_GB: "999999" }); // low-RAM would pick 512/0.1
  expect(openai.dim).toBe(384);
  expect(openai.threshold).toBe(0.4);
});
