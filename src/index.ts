// index.ts - the only entrypoint. Builds singletons, mounts all routes, listens.
import { Hono } from "hono";
import { makeDb } from "./db";
import { makeEmbed, prewarmEmbed } from "./embed";
import { memoriesRoutes } from "./memories";
import { searchRoutes } from "./search";
import { profileRoutes } from "./profile";
import { proxyRoutes } from "./proxy";

const API_KEY = process.env.MINIMEM_API_KEY;
const PORT = Number(process.env.PORT ?? 8080);

async function main() {
  // Boot sequence (Spec 00): db -> migrations -> embed prewarm -> listen.
  const sql = await makeDb();
  const embed = makeEmbed();
  await prewarmEmbed(embed);
  const ctx = { sql, embed };

  const app = new Hono();

  // health is public; everything else requires the bearer key.
  app.get("/health", (c) => c.json({ ok: true }));

  app.use("*", async (c, next) => {
    if (c.req.path === "/health") return next();
    if (!API_KEY) return c.json({ error: "MINIMEM_API_KEY not configured" }, 500);
    const auth = c.req.header("authorization") ?? "";
    if (auth !== "Bearer " + API_KEY) return c.json({ error: "Unauthorized" }, 401);
    await next();
  });

  app.route("/memories", memoriesRoutes(ctx));
  app.route("/search", searchRoutes(ctx));
  app.route("/profile", profileRoutes(ctx));
  app.route("/v1", proxyRoutes(ctx));

  console.log("minimem listening on :" + PORT);
  return { app, port: PORT };
}

const { app, port } = await main();
export default { port, fetch: app.fetch };
