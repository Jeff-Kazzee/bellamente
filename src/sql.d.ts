// Allow importing .sql files as text (Bun embeds them into the compiled binary).
declare module "*.sql" {
  const content: string;
  export default content;
}

// type:"file" imports return the (extracted) path string. Targeted so normal .mjs imports are unaffected.
declare module "*ort-wasm-simd-threaded.wasm" {
  const path: string;
  export default path;
}
declare module "*ort-wasm-simd-threaded.mjs" {
  const path: string;
  export default path;
}
