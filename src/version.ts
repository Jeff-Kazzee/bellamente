// version.ts - the single runtime version constant. `src/` had no version string and no `--version`; the
// real version lives only in the four packaging files (root package.json, packages/npm, packages/pypi
// pyproject + __init__.py) and had already drifted (mcp.ts hardcoded "0.0.1"). This is the one value `src/`
// imports (today: the `bella report` body). It is duplicated from root package.json on purpose for now and a
// test pins the two together so they cannot silently drift; P5's coordinated 0.1.0 bump makes this the source
// the packaging files sync to.
export const VERSION = "0.0.3";
