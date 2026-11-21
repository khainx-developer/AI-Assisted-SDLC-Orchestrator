import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
/** Rare orchestrator flows kept out of the always-loaded system prompt and read on demand through get_playbook. */
export const bundledPlaybooksDir = join(here, "..", "..", "orchestrator-agent", "playbooks");

export function listPlaybooks(dir = bundledPlaybooksDir): string[] {
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".md")).map((f) => f.slice(0, -3)).sort() : [];
}

export function readPlaybook(name: string, dir = bundledPlaybooksDir): string {
  if (!/^[a-z0-9-]+$/.test(name)) throw new Error(`invalid playbook name '${name}'`);
  const file = join(dir, `${name}.md`);
  if (!existsSync(file)) throw new Error(`playbook '${name}' not found; available: ${listPlaybooks(dir).join(", ") || "none"}`);
  return readFileSync(file, "utf8");
}
