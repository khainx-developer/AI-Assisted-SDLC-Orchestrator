import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { dataDir } from "../shared/paths.js";

/** Forward-slash spelling of a path, as stored in config.json. */
export const fwd = (p: string) => p.replaceAll("\\", "/");

/** Value of `--name <value>` in argv, if given. */
export function optionOf(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

/** The raw global config.json (not the validated, merged view from config/config.ts), for commands that edit it. */
export function readRawConfig(): { file: string; cfg: any } {
  const file = join(dataDir(), "config.json");
  const cfg = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : { default_platform: "claude", platforms: {} };
  return { file, cfg };
}
