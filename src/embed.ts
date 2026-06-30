// embed.ts - the single embedding singleton (Spec 02).
export type TaskType = "QUESTION_ANSWERING" | "RETRIEVAL_QUERY" | "RETRIEVAL_DOCUMENT";
export const EMBED_DIM = 768; // port of kd0()
const MAX_PAYLOAD_CHARS = 36000;

export type Embed = (args: { values: string[]; taskType: TaskType }) => Promise<number[][]>;

export function embedModelName(): string {
  return process.env.EMBEDDING_PROVIDER === "openai"
    ? (process.env.OPENAI_EMBED_MODEL ?? "text-embedding-3-small")
    : "local-768";
}

function truncate(values: string[]): string[] {
  const total = values.reduce((n, v) => n + v.length, 0) * 2;
  if (total <= MAX_PAYLOAD_CHARS) return values;
  const per = Math.floor(MAX_PAYLOAD_CHARS / 2 / Math.max(values.length, 1));
  return values.map((v) => (v.length > per ? v.slice(0, per) : v));
}

export function isValidVector(v: number[]): boolean {
  return v.length === EMBED_DIM && v.every((x) => Number.isFinite(x));
}

export function makeEmbed(): Embed {
  const provider = process.env.EMBEDDING_PROVIDER ?? "local";

  return async ({ values, taskType }) => {
    const input = truncate(values);

    if (provider === "openai") {
      // Dev fallback: text-embedding-3-small with dimensions:768 (taskType not used by OpenAI).
      void taskType;
      const key = process.env.OPENAI_API_KEY;
      if (!key) throw new Error("OPENAI_API_KEY required when EMBEDDING_PROVIDER=openai");
      const res = await fetch("https://api.openai.com/v1/embeddings", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model: process.env.OPENAI_EMBED_MODEL ?? "text-embedding-3-small",
          input,
          dimensions: EMBED_DIM,
        }),
      });
      if (!res.ok) throw new Error(`OpenAI embeddings HTTP ${res.status}: ${await res.text()}`);
      const json = (await res.json()) as { data: { index: number; embedding: number[] }[] };
      return json.data
        .slice()
        .sort((a, b) => a.index - b.index)
        .map((d) => d.embedding);
    }

    // local 768-d model (EmbeddingGemma-class). TODO M2: bundle + prewarm.
    void input;
    throw new Error("local embed model not wired yet (set EMBEDDING_PROVIDER=openai for M1).");
  };
}
