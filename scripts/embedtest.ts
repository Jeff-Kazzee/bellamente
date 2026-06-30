// Temporary P0a smoke test: prove the worker-thread embedder returns valid vectors.
import { makeEmbed, EMBED_DIM, isValidVector } from "../src/embed";

const embed = makeEmbed();
const t0 = Date.now();
const [v] = await embed({ values: ["the cat sat on the mat"], taskType: "RETRIEVAL_DOCUMENT" });
console.log("[embedtest] first embed: dim =", v?.length, "EMBED_DIM =", EMBED_DIM, "valid =", v ? isValidVector(v) : false, "| ms =", Date.now() - t0);

const t1 = Date.now();
const [q1] = await embed({ values: ["where did the cat sit?"], taskType: "QUESTION_ANSWERING" });
const [q2] = await embed({ values: ["quarterly tax filing deadlines"], taskType: "QUESTION_ANSWERING" });
const cos = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * b[i], 0);
console.log("[embedtest] warm embeds ms =", Date.now() - t1);
console.log("[embedtest] cosine(doc, relevant query) =", cos(v!, q1!).toFixed(4));
console.log("[embedtest] cosine(doc, irrelevant query) =", cos(v!, q2!).toFixed(4));
console.log("[embedtest] PASS =", v && isValidVector(v) && cos(v!, q1!) > cos(v!, q2!));
process.exit(0);
