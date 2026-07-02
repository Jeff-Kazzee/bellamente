import { defineConfig } from "astro/config";

// GitHub Pages (project site): served under /bellamente/. If the site moves to a
// custom domain, drop `base` and update `site`.
export default defineConfig({
  site: "https://jeff-kazzee.github.io",
  base: "/bellamente",
});
