import { defineConfig } from "astro/config";

// Hosted on Vercel at the domain root (no base path — GitHub Pages' /bellamente prefix is gone,
// which also removes the base-concatenation class of link bugs). Update `site` if a custom
// domain replaces the vercel.app URL.
export default defineConfig({
  site: "https://bellamente.vercel.app",
});
