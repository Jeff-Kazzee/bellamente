// dashboard.ts - serves the self-contained "Inspect" visibility dashboard (one static HTML file, inline
// CSS + vanilla JS, no build step, no external assets -> stays WASM-clean and embeds in the single binary).
//
// The HTML shell is served PUBLIC (a browser can't attach a bearer header when you navigate to a page).
// It carries NO secret: the page prompts for EUNOIA_API_KEY, keeps it in the browser (localStorage), and
// sends it on its own /inspect, /search, /memories calls — which remain bearer-authed. So mount this route
// BEFORE the auth middleware in index.ts (same pattern as /health).
import { Hono } from "hono";
// `type:"text"` yields the file's text at runtime (and embeds it in the compiled binary, like schema.sql),
// but bun-types types `*.html` imports as HTMLBundle — so cast to the string it actually is.
import dashboardHtmlAsset from "../dashboard/index.html" with { type: "text" };
export const dashboardHtml = dashboardHtmlAsset as unknown as string;

// CSP for the public shell: the page is fully self-contained (inline CSS/JS, same-origin fetches, no
// external assets — verified: the only URL in the file is an SVG xmlns attribute). 'unsafe-inline' is
// required for the inline script/styles; the value of the policy is everything else it BLOCKS: external
// script injection, exfiltration to foreign origins (connect-src 'self'), framing, and form posts.
const DASHBOARD_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; " +
  "img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

export function dashboardRoutes() {
  const app = new Hono();
  app.get("/", (c) => {
    c.header("content-security-policy", DASHBOARD_CSP);
    return c.html(dashboardHtml);
  });
  return app;
}
