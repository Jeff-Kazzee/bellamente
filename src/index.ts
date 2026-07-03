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
import { exportRoutes, importRoutes } from "./export";
import { dashboardRoutes } from "./dashboard";
import { diskUsedBytes, diskBudgetMb } from "./paths";
import { brandEnv } from "./env";
import { resolveAuth, bearerOk, type AuthConfig } from "./auth";

const PORT = Number(process.env.PORT ?? 8080);
// Bind LOOPBACK by default: this is a single-user local service holding memories and (in traces) full
// conversation text — Bun's default 0.0.0.0 would expose it to the whole LAN. Opt into wider exposure
// explicitly with BELLA_HOST=0.0.0.0 (or a specific interface) — doing so auto-enables auth (src/auth.ts).
const HOST = brandEnv("HOST")?.trim() || "127.0.0.1";

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
// respond without a key — same pattern the health check already relies on. `auth` defaults to the
// zero-config resolution for the configured host (src/auth.ts); tests pass it explicitly.
export function buildApp(ctx: { sql: DB; embed: Embed }, auth: AuthConfig = resolveAuth(HOST)) {
  const app = new Hono();

  // The `service` tag is the doctor's authenticity CONTRACT (doctor checks it before trusting a port).
  // `auth` tells clients (incl. the dashboard gate) whether a bearer key is needed at all.
  app.get("/health", (c) => c.json({ ok: true, service: "bellamente", brand: "bellamente", auth: auth.required ? "required" : "none" }));
  app.route("/", dashboardRoutes()); // the inspect dashboard shell (public HTML; its API calls follow the auth mode)

  app.use("*", async (c, next) => {
    if (!auth.required) return next(); // zero-config loopback: no key, no friction
    if (c.req.path === "/health" || c.req.path === "/") return next(); // defensive: keep public even if reordered
    if (!bearerOk(c.req.header("authorization") ?? "", auth.key!)) return c.json({ error: "Unauthorized" }, 401);
    await next();
  });

  app.route("/memories", memoriesRoutes(ctx));
  app.route("/documents", documentsRoutes(ctx)); // ingestion: the populate path for document/hybrid search
  app.route("/search", searchRoutes(ctx));
  app.route("/profile", profileRoutes(ctx));
  app.route("/inspect", inspectRoutes({ sql: ctx.sql }));
  app.route("/export", exportRoutes(ctx)); // portability: your memory is a file you can take anywhere (SPEC-P1.9)
  app.route("/import", importRoutes(ctx));
  app.route("/v1", proxyRoutes(ctx));

  return app;
}

async function main() {
  // Boot sequence (Spec 00): paths/budget -> db -> migrations -> embed prewarm -> listen.
  warnIfOverDiskBudget();
  const sql = await makeDb();
  const embed = makeEmbed();
  await prewarmEmbed(embed);
  const auth = resolveAuth(HOST);
  const app = buildApp({ sql, embed }, auth);
  startForgetSweep(sql);
  // Auth disclosure at every boot: which mode, and how to change it.
  console.log(
    auth.source === "none"
      ? "[auth] no API key needed on loopback — zero config. Set BELLA_API_KEY to require one; setting BELLA_HOST beyond loopback auto-generates one."
      : auth.source === "generated"
        ? `[auth] BELLA_HOST exposes beyond loopback — using the auto-generated key in the data dir ('apikey' file). BELLA_API_KEY overrides.`
        : "[auth] API key from BELLA_API_KEY.",
  );
  // Disclosure, not fine print: auto-capture state is announced at every boot (privacy review).
  const { captureEnabled } = await import("./capture");
  console.log(
    captureEnabled()
      ? "[capture] chat auto-capture is ON — every capture is traced and reversible; BELLA_PROXY_CAPTURE=0 disables"
      : "[capture] chat auto-capture is OFF (BELLA_PROXY_CAPTURE)",
  );
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
  fetch: () => new Response("bellamente: not booted", { status: 503 }),
};
if (import.meta.main || isStandalone) {
  const { app, port } = await main();
  served = { port, hostname: HOST, fetch: app.fetch };
}
export default served;
