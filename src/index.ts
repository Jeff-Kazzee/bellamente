// index.ts - the only entrypoint. Builds singletons, mounts all routes, listens.
import { Hono } from "hono";
import { makeDb, type DB } from "./db";
import { makeEmbed, prewarmEmbed, type Embed } from "./embed";
import { memoriesRoutes, sweepExpiredMemories } from "./memories";
import { documentsRoutes } from "./documents";
import { searchRoutes } from "./search";
import { profileRoutes } from "./profile";
import { proxyRoutes } from "./proxy";
import { inspectRoutes } from "./inspect";
import { dashboardRoutes } from "./dashboard";
import { diskUsedBytes, diskBudgetMb } from "./paths";
import { brandEnv } from "./env";
import { timingSafeEqual } from "node:crypto";

const API_KEY = brandEnv("API_KEY");
const EXPECTED_AUTH = API_KEY ? "Bearer " + API_KEY : null;
const PORT = Number(process.env.PORT ?? 8080);
// Bind LOOPBACK by default: this is a single-user local service holding memories and (in traces) full
// conversation text — Bun's default 0.0.0.0 would expose it to the whole LAN behind only the bearer key.
// Opt into wider exposure explicitly with BELLA_HOST=0.0.0.0 (or a specific interface).
const HOST = brandEnv("HOST") ?? "127.0.0.1";

// Constant-time bearer comparison (avoids leaking the key via response-timing on byte-by-byte compare).
function authOk(header: string): boolean {
  if (!EXPECTED_AUTH) return false;
  const a = Buffer.from(header);
  const b = Buffer.from(EXPECTED_AUTH);
  return a.length === b.length && timingSafeEqual(a, b); // length differs first (cheap, not secret)
}

// Subcommands: `bella doctor` runs the health/resource check and exits (no server); `bella serve`
// (or no subcommand) boots the server — `serve` is accepted explicitly so command examples read
// naturally, but the default path is identical.
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
      `[storage] WARNING: Bellamente is using ${usedMb.toFixed(0)} MB on disk, over the ` +
        `${budget} MB budget (BELLA_DISK_BUDGET_MB). Run \`bella doctor\` for details.`,
    );
  }
}

// Build the full HTTP app. Exported so tests can exercise routing + auth without booting the server.
// PUBLIC routes (/health, and the dashboard shell at /) are registered BEFORE the bearer middleware, so they
// respond without a key — same pattern the health check already relies on.
export function buildApp(ctx: { sql: DB; embed: Embed }) {
  const app = new Hono();

  // The `service` tag is the doctor's authenticity CONTRACT (old binaries check it too) — it stays
  // "eunoia" through the staged rebrand; `brand` carries the public name (BRAND.md).
  app.get("/health", (c) => c.json({ ok: true, service: "eunoia", brand: "bellamente" }));
  app.route("/", dashboardRoutes()); // the inspect dashboard shell (public HTML; its API calls are still authed)

  app.use("*", async (c, next) => {
    if (c.req.path === "/health" || c.req.path === "/") return next(); // defensive: keep public even if reordered
    if (!EXPECTED_AUTH) return c.json({ error: "BELLA_API_KEY not configured (legacy EUNOIA_API_KEY also works)" }, 500);
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
  startForgetSweep(sql);
  console.log(`bellamente listening on ${HOST}:${PORT}`);
  return { app, port: PORT };
}

// forget_after expiry sweep (Spec 00 boot step 5): once at boot, then on an interval. Lives in main()
// so tests importing buildApp never start a timer. BELLA_FORGET_SWEEP_INTERVAL_MS=0 disables.
function startForgetSweep(sql: DB) {
  const raw = Number(brandEnv("FORGET_SWEEP_INTERVAL_MS") ?? 3_600_000);
  const intervalMs = Number.isFinite(raw) ? Math.round(raw) : 3_600_000;
  const sweep = () =>
    sweepExpiredMemories(sql).catch((e) =>
      console.warn("[memories] forget_after sweep failed:", e instanceof Error ? e.message : String(e)),
    );
  void sweep();
  if (intervalMs > 0) setInterval(sweep, Math.max(intervalMs, 60_000));
}

// Boot only when this is the server entry: `bun run` (import.meta.main) OR the compiled standalone binary
// (import.meta.url lives in the bunfs — import.meta.main is FALSE there). When index.ts is merely IMPORTED
// (e.g. tests exercising buildApp), neither holds, so main() — which opens the DB and prewarms the embedder —
// does not run.
const isStandalone = import.meta.url.includes("$bunfs") || /%7ebun|~bun/i.test(import.meta.url);
let served: { port: number; hostname: string; fetch: (req: Request, ...rest: any[]) => Response | Promise<Response> } = {
  port: PORT,
  hostname: HOST,
  fetch: () => new Response("eunoia: not booted", { status: 503 }),
};
if (import.meta.main || isStandalone) {
  const { app, port } = await main();
  served = { port, hostname: HOST, fetch: app.fetch };
}
export default served;
