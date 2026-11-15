import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync } from "node:fs";

export function dataDir(): string {
  const d = process.env.SDLC_DATA_DIR ?? join(homedir(), ".ai-sdlc-orchestrator");
  mkdirSync(d, { recursive: true });
  return d;
}

/** One spelling per repo: forward slashes, no trailing slash, upper-case drive letter. */
export function normRoot(p: string): string {
  let r = p.trim().split("\\").join("/").replace(/\/+$/, "");
  if (/^[a-z]:/.test(r)) r = r[0].toUpperCase() + r.slice(1);
  return r;
}
