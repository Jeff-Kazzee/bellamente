// embed.ts - the single embedding singleton (Spec 02).
export type TaskType = "QUESTION_ANSWERING" | "RETRIEVAL_QUERY" | "RETRIEVAL_DOCUMENT";
export const EMBED_DIM = 768; // port of kd0()
const MAX_PAYLOAD_CHARS = 36000;

export type Embed = (args: { values: string[]; taskType: TaskType }) => Promise<number[][]>;

function truncate(values: string[]): string[] {
  const total = values.reduce((n, v) => n + v.length, 0) * 2;
  if (total <= MAX_PAYLOAD_CHARS) return values;
  const per = Math.floor(MAX_PAYLOAD_CHARS / 2 / values.length);
  return values.map((v) => (v.length > per ? v.slice(0, per) : v));
}

export function makeEmbed(): Embed {
  const provider = process.env.EMBEDDING_PROVIDER ?? "local";
  return async ({ values, taskType }) => {
    const input = truncate(values);
    if (provider === "openai") {
      // dev fallback: text-embedding-3-small with dimensions:768 (taskType ignored)
      // TODO: call OpenAI embeddings; assert each vector length === EMBED_DIM.
      void taskType;
      throw new Error("openai embed path not wired - see TODO in src/embed.ts");
    }
    // local 768-d model (EmbeddingGemma-class). TODO M2: bundle + prewarm.
    void input;
    throw new Error("local embed model not wired - see TODO in src/embed.ts");
  };
}

export function isValidVector(v: number[]): boolean {
  return v.length === EMBED_DIM && v.every((x) => Number.isFinite(x));
}
