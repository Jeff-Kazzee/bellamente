# Bellamente website

Astro site for bellamente — design "La Macchina" (the chosen green direction; both
original candidates are preserved in `design-preview.html`).

```
bun install
bun run dev       # local dev server
bun run build     # -> dist/ (static)
bun run preview   # serve the built site (respects the /bellamente base)
```

Deploy: build, then publish `dist/` to the `gh-pages` branch (Pages stays off until
the v0.0.1 release goes public). `astro.config.mjs` sets `base: "/bellamente"` for
GitHub project pages — drop it if the site moves to a custom domain.
