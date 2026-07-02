import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PAGES = join(ROOT, "website", "src", "pages");
const PUBLIC = join(ROOT, "website", "public");
const SITE = "https://bellamente.vercel.app";

const RELEASE_DOWNLOADS = [
  "https://github.com/Jeff-Kazzee/bellamente/releases/download/v0.0.1/bella-windows-x64.exe",
  "https://github.com/Jeff-Kazzee/bellamente/releases/download/v0.0.1/bella-darwin-arm64",
  "https://github.com/Jeff-Kazzee/bellamente/releases/download/v0.0.1/bella-darwin-x64",
  "https://github.com/Jeff-Kazzee/bellamente/releases/download/v0.0.1/bella-linux-x64",
  "https://github.com/Jeff-Kazzee/bellamente/releases/download/v0.0.1/SHA256SUMS.txt",
];

const INDEXABLE_URLS = [
  `${SITE}/`,
  `${SITE}/docs/`,
  `${SITE}/docs/using/`,
  `${SITE}/docs/api/`,
  `${SITE}/docs/config/`,
  `${SITE}/roadmap/`,
  `${SITE}/changelog/`,
  `${SITE}/llms.txt`,
  `${SITE}/llms-full.md`,
];

function readPage(path: string) {
  return readFileSync(join(PAGES, path), "utf8");
}

function readPublic(path: string) {
  return readFileSync(join(PUBLIC, path), "utf8");
}

test("homepage gives users one-click downloads for every v0.0.1 binary", () => {
  const home = readPage("index.astro");
  for (const download of RELEASE_DOWNLOADS) {
    expect(home).toContain(download);
  }
  expect(home).not.toContain('class="db-btn primary" href="https://github.com/Jeff-Kazzee/bellamente/releases/latest"');
});

test("roadmap says items can ship out of order and points to the changelog", () => {
  const roadmap = readPage("roadmap.astro");
  expect(roadmap).toContain("ship out of order");
  expect(roadmap).toContain("multiple items may land together");
  expect(roadmap).toContain('href="/changelog"');
});

test("changelog page records shipped releases with direct downloads", () => {
  expect(existsSync(join(PAGES, "changelog.astro"))).toBe(true);
  const changelog = readPage("changelog.astro");
  expect(changelog).toContain("Bellamente v0.0.1");
  for (const download of RELEASE_DOWNLOADS) {
    expect(changelog).toContain(download);
  }
});

test("static crawler files expose sitemap, robots policy, and complete llms context", () => {
  expect(existsSync(join(PUBLIC, "sitemap.xml"))).toBe(true);
  expect(existsSync(join(PUBLIC, "robots.txt"))).toBe(true);
  expect(existsSync(join(PUBLIC, "llms.txt"))).toBe(true);

  const sitemap = readPublic("sitemap.xml");
  expect(sitemap).toContain('<?xml version="1.0" encoding="UTF-8"?>');
  expect(sitemap).toContain('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">');
  for (const url of INDEXABLE_URLS) {
    expect(sitemap).toContain(`<loc>${url}</loc>`);
  }

  const robots = readPublic("robots.txt");
  expect(robots).toContain("User-agent: *");
  expect(robots).toContain("Allow: /");
  expect(robots).toContain(`Sitemap: ${SITE}/sitemap.xml`);

  const llms = readPublic("llms.txt");
  expect(llms.startsWith("# Bellamente\n"));
  expect(llms).toContain("> Bellamente is a local-first memory service for AI agents");
  expect(llms).toContain("## Full Site Documents");
  expect(llms).toContain("## Agent Use Guidance");
  expect(llms).toContain("service: \"bellamente\"");
  for (const download of RELEASE_DOWNLOADS) {
    expect(llms).toContain(download);
  }
});

test("agent Markdown docs are available as one full ingest file and section-level parts", () => {
  // one full ingest file; per-topic ingest is the rendered docs (Markdown lives in the repo)
  expect(existsSync(join(PUBLIC, "llms-full.md"))).toBe(true);
  expect(readPublic("llms-full.md")).toContain("# Bellamente Agent Context Pack");

  const llms = readPublic("llms.txt");
  expect(llms).toContain("## Markdown Documents");
  expect(llms).toContain("https://bellamente.vercel.app/llms-full.md");
  expect(llms).toContain("https://bellamente.vercel.app/docs/using/");
  expect(llms).toContain("https://bellamente.vercel.app/docs/api/");

  const full = readPublic("llms-full.md");
  expect(full).toContain("## Full Site Documents");
  expect(full).toContain("## Section Documents");
  expect(full).toContain("service: \"bellamente\"");
  for (const download of RELEASE_DOWNLOADS) {
    expect(full).toContain(download);
  }
});

test("public pages have absolute canonicals, social metadata, and structured trust signals", () => {
  const pages = [
    ["index.astro", `${SITE}/`],
    ["roadmap.astro", `${SITE}/roadmap/`],
    ["changelog.astro", `${SITE}/changelog/`],
  ] as const;

  for (const [page, canonical] of pages) {
    const source = readPage(page);
    expect(source).toContain(`<link rel="canonical" href="${canonical}" />`);
    expect(source).toContain(`<meta property="og:url" content="${canonical}" />`);
    expect(source).toContain('<meta name="twitter:card" content="summary_large_image" />');
    expect(source).toContain('application/ld+json');
    expect(source).toContain('The Little AI Co');
  }
});

test("docs pages exist in the repo, render on the site, and carry the agent prompt block", () => {
  for (const page of ["index.md", "using.md", "api.md", "config.md"]) {
    expect(existsSync(join(PAGES, "docs", page))).toBe(true);
    expect(readPage(join("docs", page))).toContain("layout: ../../layouts/DocsLayout.astro");
  }
  // the copy-paste agent integration prompt is fenced as ```prompt so the site labels + copy-buttons it
  expect(readPage(join("docs", "using.md"))).toContain("```prompt");
  const layout = readFileSync(join(ROOT, "website", "src", "layouts", "DocsLayout.astro"), "utf8");
  expect(layout).toContain("copy-btn");
  expect(layout).toContain("FOR YOUR AGENT");
});

test("home and roadmap link to the docs", () => {
  expect(readPage("index.astro")).toContain('href="/docs"');
  expect(readPage("roadmap.astro")).toContain('href="/docs"');
});
