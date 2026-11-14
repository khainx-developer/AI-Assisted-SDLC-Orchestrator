import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync } from "node:fs";

export function dataDir(): string {
  const d = process.env.SDLC_DATA_DIR ?? join(homedir(), ".ai-sdlc-orchestrator");
  mkdirSync(d, { recursive: true });
  return d;
}
