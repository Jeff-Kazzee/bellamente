// Test fixture (no .test suffix): prints the resolved embedder tier/model/dim/engine as JSON so the
// device-scaling test can assert it under different env configs (embed-common resolves at module load).
const m = await import("../src/embed-common");
process.stdout.write(JSON.stringify({ tier: m.EMBED_TIER, model: m.LOCAL_MODEL, dim: m.EMBED_DIM, engine: m.profile.engine, threshold: m.DEFAULT_SIMILARITY_THRESHOLD }));
process.exit(0);
