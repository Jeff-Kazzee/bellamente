// Allow importing .sql files as text (Bun embeds them into the compiled binary).
declare module "*.sql" {
  const content: string;
  export default content;
}

// Build-time virtual module injected by build.ts (ort-embed-libs plugin). Lists the target's ORT
// dependent shared libs as embedded files for src/runtime.ts to extract + preload. Absent in dev.
declare module "eunoia:ort-libs" {
  export const ortLibFiles: { name: string; src: string; preload?: boolean }[];
}
