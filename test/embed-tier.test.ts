// Device-scaled embedder tier selection (the "don't crash old laptops" safety): e5-small on capable
// machines, static Model2Vec on low-RAM machines, with explicit overrides winning + fail-safe env handling.
import { test, expect } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  DEFAULT_SIMILARITY_THRESHOLD,
  EMBED_DIM_EXPLICIT,
  LOCAL_DTYPE,
  ONNX_FILE,
  embedModelName,
  formatForTask,
  isValidVector,
  mrl,
  onnxRelPath,
  profile,
  truncatePayload,
} from "../src/embed-common";
import { makeEmbed, prewarmEmbed } from "../src/embed";

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

async function resolveCommon(over: Record<string, string | undefined>): Promise<typeof import("../src/embed-common")> {
  const touched = [
    "BELLA_EMBED_TIER",
    "BELLA_EMBED_MIN_RAM_GB",
    "LOCAL_EMBED_MODEL",
    "LOCAL_EMBED_DTYPE",
    "EMBED_DIM",
    "EMBEDDING_PROVIDER",
    "OPENAI_EMBED_MODEL",
  ];
  const prior = new Map(touched.map((key) => [key, process.env[key]]));
  try {
    for (const key of touched) delete process.env[key];
    for (const [key, value] of Object.entries(over)) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
    return await import(`../src/embed-common.ts?case=${seq++}`);
  } finally {
    for (const key of touched) {
      const value = prior.get(key);
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  }
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

test("embed-common helper edges keep payloads bounded and vectors normalized", () => {
  const long = "x".repeat(20000);
  const short = ["tiny", "payload"];
  expect(truncatePayload(short)).toBe(short);
  const truncated = truncatePayload([long, long]);
  expect(truncated.every((value) => value.length <= 9000)).toBe(true);
  expect(formatForTask("needle", "RETRIEVAL_DOCUMENT").length).toBeGreaterThan(0);
  expect(formatForTask("needle", "QUESTION_ANSWERING").length).toBeGreaterThan(0);
  expect(formatForTask("needle", "RETRIEVAL_QUERY")).toBe(formatForTask("needle", "QUESTION_ANSWERING"));
  expect(mrl([0, 0, 0], 2)).toEqual([0, 0]);
  expect(mrl([3, 4, 99], 2)).toEqual([0.6, 0.8]);
  expect(isValidVector([1])).toBe(false);
  expect(onnxRelPath()).toContain("onnx");
  expect(LOCAL_DTYPE).toBe("q8");
  expect(ONNX_FILE.fp32).toBe("model.onnx");
  expect(ONNX_FILE.fp16).toBe("model_fp16.onnx");
  expect(ONNX_FILE.q8).toBe("model_quantized.onnx");
  expect(ONNX_FILE.int8).toBe("model_quantized.onnx");
  expect(ONNX_FILE.q4).toBe("model_q4.onnx");
  expect(typeof EMBED_DIM_EXPLICIT).toBe("boolean");
  expect(DEFAULT_SIMILARITY_THRESHOLD).toBe(profile.threshold);
  expect(embedModelName()).toBeTruthy();
});

test("model profiles apply the right prompt, pooling, engine, dtype, and threshold", async () => {
  const bge = await resolveCommon({ LOCAL_EMBED_MODEL: "Xenova/bge-small-en-v1.5", LOCAL_EMBED_DTYPE: "fp16" });
  expect(bge.profile).toMatchObject({ pooling: "cls", engine: "wasm", threshold: 0.4 });
  expect(bge.formatForTask("needle", "RETRIEVAL_QUERY")).toContain("Represent this sentence");
  expect(bge.formatForTask("needle", "RETRIEVAL_DOCUMENT")).toBe("needle");
  expect(bge.onnxRelPath()).toEqual(["Xenova", "bge-small-en-v1.5", "onnx", "model_fp16.onnx"]);

  const qwen = await resolveCommon({ LOCAL_EMBED_MODEL: "onnx-community/Qwen3-Embedding-0.6B-ONNX" });
  expect(qwen.profile).toMatchObject({ pooling: "last_token", engine: "wasm", threshold: 0.4 });
  expect(qwen.formatForTask("needle", "QUESTION_ANSWERING")).toContain("Instruct:");

  const staticModel = await resolveCommon({ LOCAL_EMBED_MODEL: "minishlab/potion-base-8M" });
  expect(staticModel.profile).toMatchObject({ pooling: "mean", engine: "static", threshold: 0.1 });
  expect(staticModel.formatForTask("needle", "RETRIEVAL_QUERY")).toBe("needle");
  expect(staticModel.DEFAULT_SIMILARITY_THRESHOLD).toBe(0.1);

  const unknownStatic = await resolveCommon({ LOCAL_EMBED_MODEL: "minishlab/custom-local-model" });
  expect(unknownStatic.profile).toMatchObject({ engine: "static", threshold: 0.1 });

  const unknownWasm = await resolveCommon({ LOCAL_EMBED_MODEL: "example/custom-transformer", LOCAL_EMBED_DTYPE: "unknown" });
  expect(unknownWasm.profile).toMatchObject({ engine: "wasm", threshold: 0.4 });
  expect(unknownWasm.onnxRelPath()).toEqual(["example", "custom-transformer", "onnx", "model_quantized.onnx"]);

  const openai = await resolveCommon({ EMBEDDING_PROVIDER: "openai", OPENAI_EMBED_MODEL: "text-embedding-3-large" });
  expect(openai.DEFAULT_SIMILARITY_THRESHOLD).toBe(0.4);
  const prev = process.env.OPENAI_EMBED_MODEL;
  process.env.OPENAI_EMBED_MODEL = "text-embedding-3-large";
  try {
    expect(openai.embedModelName()).toBe("text-embedding-3-large");
  } finally {
    if (prev == null) delete process.env.OPENAI_EMBED_MODEL;
    else process.env.OPENAI_EMBED_MODEL = prev;
  }
});

test("embed singleton handles empty batches and prewarm skip/warm paths without forcing a model download", async () => {
  const embed = makeEmbed();
  await expect(embed({ values: [], taskType: "RETRIEVAL_DOCUMENT" })).resolves.toEqual([]);

  const priorSkip = process.env.BELLA_SKIP_EMBEDDING_PREWARM;
  const priorLog = console.log;
  const logs: string[] = [];
  const calls: unknown[] = [];
  const fakeEmbed = async (args: Parameters<typeof embed>[0]) => {
    calls.push(args);
    return [[1]];
  };
  console.log = (...args: unknown[]) => {
    logs.push(args.join(" "));
  };
  try {
    process.env.BELLA_SKIP_EMBEDDING_PREWARM = "1";
    await prewarmEmbed(fakeEmbed);
    expect(calls).toHaveLength(0);
    expect(logs.some((line) => line.includes("skipping local embedding model prewarm"))).toBe(true);

    logs.length = 0;
    delete process.env.BELLA_SKIP_EMBEDDING_PREWARM;
    await prewarmEmbed(fakeEmbed);
    expect(calls).toEqual([{ values: ["warmup"], taskType: "RETRIEVAL_DOCUMENT" }]);
    expect(logs.some((line) => line.includes("[embeddings] prewarming"))).toBe(true);
    expect(logs.some((line) => line.includes("[embeddings] ready"))).toBe(true);
  } finally {
    console.log = priorLog;
    if (priorSkip == null) delete process.env.BELLA_SKIP_EMBEDDING_PREWARM;
    else process.env.BELLA_SKIP_EMBEDDING_PREWARM = priorSkip;
  }
});
