import { defineConfig } from "astro/config";

// Hosted on GitHub Pages as a project site. Keep `base` aligned with the repo name so
// generated asset URLs work under /bellamente/.
export default defineConfig({
  site: "https://the-little-ai-company.github.io",
  base: "/bellamente",
  markdown: {
    shikiConfig: {
      // ```prompt fences are agent-paste blocks: highlighted as plain text, but the fence name
      // survives into data-language="prompt" so DocsLayout can label + copy-button them.
      langAlias: { prompt: "text" },
    },
  },
});
