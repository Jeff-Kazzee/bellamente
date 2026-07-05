// Bellamente local CI. GitHub Actions may be unavailable on this repo, so this is the canonical
// gate to run before pushing or merging release-facing work.

type Gate = {
  name: string;
  command: string[];
  cwd?: string;
};

const gates: Gate[] = [
  { name: "install from lockfile", command: ["bun", "install", "--frozen-lockfile"] },
  { name: "dependency audit", command: ["bun", "audit", "--audit-level=moderate"] },
  { name: "typecheck", command: ["bunx", "tsc", "--noEmit"] },
  { name: "tests with aggregate coverage gate", command: ["bun", "run", "test"] },
  { name: "full functionality release smoke", command: ["bun", "run", "smoke"] },
  { name: "binary build", command: ["bun", "run", "build"] },
  { name: "website install from lockfile", command: ["bun", "install", "--frozen-lockfile"], cwd: "website" },
  { name: "website build", command: ["bun", "run", "build"], cwd: "website" },
  { name: "whitespace diff check", command: ["git", "diff", "--check"] },
];

const results: string[] = [];

for (const gate of gates) {
  console.log(`\n=== ${gate.name} ===`);
  console.log(`$ ${gate.cwd ? `(cd ${gate.cwd} && ${gate.command.join(" ")})` : gate.command.join(" ")}`);
  const proc = Bun.spawn(gate.command, {
    stdout: "inherit",
    stderr: "inherit",
    env: process.env,
    cwd: gate.cwd,
  });
  const code = await proc.exited;
  if (code !== 0) {
    results.push(`FAIL ${gate.name}`);
    console.error(`\n===== LOCAL CI =====\n${results.join("\n")}\nFAIL ${gate.name} exited ${code}`);
    process.exit(code);
  }
  results.push(`PASS ${gate.name}`);
}

console.log(`\n===== LOCAL CI =====\n${results.join("\n")}\nALL GATES PASS`);
