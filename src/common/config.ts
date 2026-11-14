import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { dataDir } from "./paths.js";

export interface PlatformOverride {
  command?: string;
  extra_args?: string[];
  /** generic platform only: arg template; {prompt} / {prompt_file} are substituted */
  args?: string[];
  prompt_via?: "stdin" | "arg" | "file";
  model?: string;
}

export interface OrchestratorConfig {
  /** platform used when a dispatch call does not name one */
  default_platform: string;
  /** optional per-mode override, e.g. analysis on one tool, coding on another */
  analysis_platform?: string;
  coding_platform?: string;
  /** per-repo override keyed by absolute project_root */
  projects?: Record<string, { platform?: string; analysis_platform?: string; coding_platform?: string; test_command?: string }>;
  platforms: Record<string, PlatformOverride>;
  dispatch_timeout_minutes: number;
  /** directory holding SKILL.md folders; defaults to bundled orchestrator-agent/skills */
  skills_dir?: string;
}

export const DEFAULT_CONFIG: OrchestratorConfig = {
  default_platform: "claude",
  platforms: {},
  dispatch_timeout_minutes: 30,
};

export function loadConfig(): OrchestratorConfig {
  const file = process.env.SDLC_CONFIG ?? join(dataDir(), "config.json");
  if (!existsSync(file)) return DEFAULT_CONFIG;
  const user = JSON.parse(readFileSync(file, "utf8"));
  return { ...DEFAULT_CONFIG, ...user, platforms: { ...DEFAULT_CONFIG.platforms, ...(user.platforms ?? {}) } };
}
