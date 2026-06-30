// paths.ts - SAFE per-user storage locations. Eunoia only ever writes under the OS-conventional
// app-data directory (or an explicit EUNOIA_HOME). NEVER next to the exe, NEVER cwd, NEVER system dirs.
//   Windows: %LOCALAPPDATA%\Eunoia        (e.g. C:\Users\<you>\AppData\Local\Eunoia)
//   macOS:   ~/Library/Application Support/Eunoia
//   Linux:   $XDG_DATA_HOME/eunoia        (default ~/.local/share/eunoia)
// Override everything with EUNOIA_HOME=<abs path>. mkdir is recursive + non-destructive.
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync } from "node:fs";

function baseDir(): string {
  if (process.env.EUNOIA_HOME) return process.env.EUNOIA_HOME;
  const home = homedir();
  if (process.platform === "win32") {
    return join(process.env.LOCALAPPDATA ?? join(home, "AppData", "Local"), "Eunoia");
  }
  if (process.platform === "darwin") {
    return join(home, "Library", "Application Support", "Eunoia");
  }
  return join(process.env.XDG_DATA_HOME ?? join(home, ".local", "share"), "eunoia");
}

function ensure(p: string): string {
  mkdirSync(p, { recursive: true });
  return p;
}

export const dataDir = (): string => ensure(baseDir());
export const modelsDir = (): string => ensure(join(baseDir(), "models")); // embedding model weights cache
export const dbDir = (): string => ensure(join(baseDir(), "db")); // embedded Postgres (PGlite) data — M2
export const runtimeDir = (): string => ensure(join(baseDir(), "runtime")); // extracted native libs (ORT) — M2
export const logsDir = (): string => ensure(join(baseDir(), "logs"));
