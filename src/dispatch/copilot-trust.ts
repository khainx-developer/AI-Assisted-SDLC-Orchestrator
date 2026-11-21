import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseJsonc } from "../shared/jsonc.js";

interface TrustOptions {
  copilotHome?: string;
  dryRun?: boolean;
}

function sameFolder(a: string, b: string): boolean {
  const left = resolve(a);
  const right = resolve(b);
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

/** Add only the explicitly selected project folder to Copilot CLI's workspace trust list. */
export function trustCopilotFolder(folder: string, options: TrustOptions = {}): boolean {
  const home = options.copilotHome ?? process.env.COPILOT_HOME ?? join(homedir(), ".copilot");
  const configFile = join(home, "config.json");
  let config: Record<string, unknown> = {};

  if (existsSync(configFile)) {
    const parsed = parseJsonc(readFileSync(configFile, "utf8"));
    if (!parsed || !parsed.data || typeof parsed.data !== "object" || Array.isArray(parsed.data))
      throw new Error(`cannot update Copilot CLI trust in ${configFile}: expected a JSON/JSONC object; fix the config or add the folder to trustedFolders manually`);
    config = parsed.data;
  }

  const trusted = config.trustedFolders ?? [];
  if (!Array.isArray(trusted) || trusted.some((x) => typeof x !== "string"))
    throw new Error(`cannot update Copilot CLI trust in ${configFile}: trustedFolders must be an array of paths`);
  if (trusted.some((path) => sameFolder(path, folder))) return false;
  if (options.dryRun) return true;

  mkdirSync(home, { recursive: true });
  if (existsSync(configFile)) copyFileSync(configFile, `${configFile}.bak`);
  config.trustedFolders = [...trusted, resolve(folder)];
  writeFileSync(configFile, JSON.stringify(config, null, 2));
  return true;
}
