// index.ts - the only entrypoint. Builds singletons, mounts all routes, listens.
import { Hono } from "hono";
import { makeDb, type DB } from "./db";
import { makeEmbed, prewarmEmbed, type Embed } from "./embed";
import { memoriesRoutes } from "./memories";
import { documentsRoutes } from "./documents";
import { searchRoutes } from "./search";
import { profileRoutes } from "./profile";
import { proxyRoutes } from "./proxy";
import { inspectRoutes } from "./inspect";
import { dashboardRoutes } from "./dashboard";
import { diskUsedBytes, diskBudgetMb } from "./paths";
import { timingSafeEqual } from "node:crypto";

const API_KEY = process.env.EUNOIA_API_KEY;
const EXPECTED_AUTH = API_KEY ? "Bearer " + API_KEY : null;
const PORT = Number(process.env.PORT ?? 8080);

// Constant-time bearer comparison (avoids leaking the key via response-timing on byte-by-byte compare).
function authOk(header: string): boolean {
  if (!EXPECTED_AUTH) return false;
  const a = Buffer.from(header);
  const b = Buffer.from(EXPECTED_AUTH);
  return a.length === b.length && timingSafeEqual(a, b); // length differs first (cheap, not secret)
}

// Subcommand: `eunoia doctor` runs the health/resource check and exits (no server).
if (process.argv[2] === "doctor") {
  const { runDoctor } = await import("./doctor");
  process.exit(await runDoctor());
}

function warnIfOverDiskBudget() {
  const budget = diskBudgetMb();
  if (budget <= 0) return;
  const usedMb = diskUsedBytes() / (1024 * 1024);
  if (usedMb > budget) {
    console.warn(
      `[storage] WARNING: Eunoia is using ${usedMb.toFixed(0)} MB on disk, over the ` +
        `${budget} MB budget (EUNOIA_DISK_BUDGET_MB). Run \`eunoia doctor\` for details.`,
    );
  }
}

// Build the full HTTP app. Exported so tests can exercise routing + auth without booting the server.
// PUBLIC routes (/health, and the dashboard shell at /) are registered BEFORE the bearer middleware, so they
// respond without a key — same pattern the health check already relies on.
export function buildApp(ctx: { sql: DB; embed: Embed }) {
  const app = new Hono();

  // `service` tag lets `eunoia doctor` confirm the responder is actually Eunoia (not another process on the port).
  app.get("/health", (c) => c.json({ ok: true, service: "eunoia" }));
  app.route("/", dashboardRoutes()); // the inspect dashboard shell (public HTML; its API calls are still authed)

  app.use("*", async (c, next) => {
    if (c.req.path === "/health" || c.req.path === "/") return next(); // defensive: keep public even if reordered
    if (!EXPECTED_AUTH) return c.json({ error: "EUNOIA_API_KEY not configured" }, 500);
    if (!authOk(c.req.header("authorization") ?? "")) return c.json({ error: "Unauthorized" }, 401);
    await next();
  });

  app.route("/memories", memoriesRoutes(ctx));
  app.route("/documents", documentsRoutes(ctx)); // ingestion: the populate path for document/hybrid search
  app.route("/search", searchRoutes(ctx));
  app.route("/profile", profileRoutes(ctx));
  app.route("/inspect", inspectRoutes({ sql: ctx.sql }));
  app.route("/v1", proxyRoutes(ctx));

  return app;
}

async function main() {
  // Boot sequence (Spec 00): paths/budget -> db -> migrations -> embed prewarm -> listen.
  warnIfOverDiskBudget();
  const sql = await makeDb();
  const embed = makeEmbed();
  await prewarmEmbed(embed);
  const app = buildApp({ sql, embed });
  console.log("eunoia listening on :" + PORT);
  return { app, port: PORT };
}

// Boot only when this is the server entry: `bun run` (import.meta.main) OR the compiled standalone binary
// (import.meta.url lives in the bunfs — import.meta.main is FALSE there). When index.ts is merely IMPORTED
// (e.g. tests exercising buildApp), neither holds, so main() — which opens the DB and prewarms the embedder —
// does not run.
const isStandalone = import.meta.url.includes("$bunfs") || /%7ebun|~bun/i.test(import.meta.url);
let served: { port: number; fetch: (req: Request, ...rest: any[]) => Response | Promise<Response> } = {
  port: PORT,
  fetch: () => new Response("eunoia: not booted", { status: 503 }),
};
if (import.meta.main || isStandalone) {
  const { app, port } = await main();
  served = { port, fetch: app.fetch };
}
export default served;
