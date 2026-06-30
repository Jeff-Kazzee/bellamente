// Allow importing .sql files as text (Bun embeds them into the compiled binary).
declare module "*.sql" {
  const content: string;
  export default content;
}
