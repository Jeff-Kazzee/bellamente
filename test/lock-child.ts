// Test fixture (NOT a test file — no .test suffix, so bun test skips it). A child process that races to
// acquire the embedded-DB single-writer lock and reports the outcome, used by the concurrency test.
import { acquireDbLock } from "../src/db";
const lockPath = process.argv[2]!;
try {
  const release = acquireDbLock(lockPath);
  process.stdout.write("ACQUIRED\n");
  release();
} catch {
  process.stdout.write("REFUSED\n");
}
process.exit(0);
