import { readFileSync, existsSync } from "node:fs";
import { join, resolve, isAbsolute } from "node:path";
import { dataDir, normRoot } from "./paths.js";
import type { RestrictionsConfig } from "./restrictions.js";

export type ScopeCheck = "off" | "warn" | "fail";

/** Spending limit per task, in tokens (input + output of finished dispatches) and/or reported USD. Estimated tokens are a lower bound. */
export interface BudgetConfig {
  task_tokens?: number;
  task_cost_usd?: number;
  /** warn (default): the result carries a budget_warning. block: new dispatches for the task are refused once it is over, unless override_budget is passed */
  action?: "warn" | "block";
}

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
  projects?: Record<string, { model?: string; branch_pattern?: string; slug?: string; platform?: string; analysis_platform?: string; coding_platform?: string; test_command?: string;
    /** write the failing tests in a separate session first and freeze them (default false) */
    tests_first?: boolean;
    /** what to do when a coding session changes files outside the plan's scope (default "warn") */
    scope_check?: ScopeCheck;
    /** extra paths/globs always allowed by the scope check, e.g. lockfiles */
    scope_allow?: string[];
    /** remove secret-looking strings from prompts sent to the AI CLI (default true) */
    redact_secrets?: boolean;
    /** per-repo spending limit; each field overrides the global budget */
    budget?: BudgetConfig;
    /** what worker sessions on this repo may not touch; lists add to the global ones, switches override them */
    restrictions?: RestrictionsConfig;
    /** platform for the independent code review of this repo's tasks; default: any configured platform other than the one that wrote the code */
    review_platform?: string;
    /** Workspace mode: project_root itself is NOT a git repo; these child directories (relative to project_root, or absolute) are. Branches, coding dispatches and tests run per child repo. */
    child_repos?: string[] }>;
  /** branch name for coding work, e.g. "feature/{key}". Placeholders: {key} (Jira key, else task id), {jira_key}, {task_id}. Default "story/{key}". Per-repo value wins. */
  branch_pattern?: string;
  /** global defaults for the three per-repo settings above; a repo's own value wins */
  tests_first?: boolean;
  scope_check?: ScopeCheck;
  scope_allow?: string[];
  /** global default for projects.<root>.redact_secrets (default true) */
  redact_secrets?: boolean;
  /** extra regex sources for team-specific token formats, removed from prompts like the built-in patterns */
  redact_extra?: string[];
  /** spending limit per task; a repo's own budget overrides it field by field */
  budget?: BudgetConfig;
  /** secret files, commands and sandbox for worker sessions (on by default with a short built-in list) */
  restrictions?: RestrictionsConfig;
  /** global default for projects.<root>.review_platform */
  review_platform?: string;
  /** a folder the team shares (usually a git clone): policy.json and learnings/ live there instead of the private data folder. Tasks, documents and dispatches stay local. */
  shared_dir?: string;
  platforms: Record<string, PlatformOverride>;
  dispatch_timeout_minutes: number;
  /** finished dispatch folders (prompt, raw output) older than this are deleted when the dispatch server starts; 0 keeps everything */
  dispatch_retention_days?: number;
  /** directory holding SKILL.md folders; defaults to bundled orchestrator-agent/skills */
  skills_dir?: string;
}

export const DEFAULT_CONFIG: OrchestratorConfig = {
  default_platform: "claude",
  platforms: {},
  dispatch_timeout_minutes: 30,
  dispatch_retention_days: 14,
};

/** Where policy.json and learnings/ live: config.shared_dir when set, else the private data folder. A relative path is taken from the data folder. */
export function teamDir(): string {
  const s = loadConfig().shared_dir;
  return s ? resolve(dataDir(), s) : dataDir();
}

export function loadConfig(): OrchestratorConfig {
  const file = process.env.SDLC_CONFIG ?? join(dataDir(), "config.json");
  if (!existsSync(file)) return DEFAULT_CONFIG;
  const user = JSON.parse(readFileSync(file, "utf8"));
  return { ...DEFAULT_CONFIG, ...user, platforms: { ...DEFAULT_CONFIG.platforms, ...(user.platforms ?? {}) } };
}

type ProjectEntry = NonNullable<OrchestratorConfig["projects"]>[string];

const sameRoot = (a: string, b: string) => normRoot(a) === normRoot(b); // normRoot already folds slashes and drive-letter case
const absChildren = (root: string, e?: ProjectEntry) => (e?.child_repos ?? []).map((c) => normRoot(isAbsolute(c) ? c : resolve(root, c)));

/**
 * The `projects.<root>` entry for a repo, matched regardless of slash/case-of-drive spelling.
 * A child repo of a registered workspace with no entry of its own inherits the workspace's settings (platform, model,
 * branch_pattern, test_command), minus `child_repos` and `slug`, so a task rooted at a child repo behaves like any single-repo task.
 */
export function projectConfig(root: string): ProjectEntry | undefined {
  const projects = loadConfig().projects ?? {};
  const own = Object.entries(projects).find(([k]) => sameRoot(k, root))?.[1];
  if (own) return own;
  const ws = workspaceOf(root);
  const parent = ws && Object.entries(projects).find(([k]) => sameRoot(k, ws))?.[1];
  if (!parent) return undefined;
  const { child_repos: _children, slug: _slug, ...inherited } = parent;
  return inherited;
}

/** The registered workspace root that lists `root` among its child_repos, if any (as spelled in config.json). */
export function workspaceOf(root: string): string | undefined {
  return Object.entries(loadConfig().projects ?? {}).find(([k, v]) => absChildren(k, v).some((c) => sameRoot(c, root)))?.[0];
}

/** Workspace mode: absolute paths of the git child repos under a non-git root ([] = normal single-repo mode). */
export function childRepos(root: string): string[] {
  const entry = Object.entries(loadConfig().projects ?? {}).find(([k]) => sameRoot(k, root));
  return absChildren(root, entry?.[1]);
}

/** Settings for the checks after a write session; the repo's value wins over the global one. */
export function repoSettings(root: string): { tests_first: boolean; scope_check: ScopeCheck; scope_allow: string[]; test_command: string | null } {
  const cfg = loadConfig();
  const p = projectConfig(root);
  const mode = p?.scope_check ?? cfg.scope_check ?? "warn";
  return {
    tests_first: p?.tests_first ?? cfg.tests_first ?? false,
    scope_check: ["off", "warn", "fail"].includes(mode) ? mode : "warn",
    scope_allow: [...(cfg.scope_allow ?? []), ...(p?.scope_allow ?? [])],
    test_command: p?.test_command ?? null,
  };
}

/** Secret redaction switches for prompts sent to the AI CLI. On unless switched off for the repo or globally. */
export function redactSettings(root: string): { redact_secrets: boolean; redact_extra: string[] } {
  const cfg = loadConfig();
  return { redact_secrets: projectConfig(root)?.redact_secrets ?? cfg.redact_secrets ?? true, redact_extra: cfg.redact_extra ?? [] };
}

export const DEFAULT_BRANCH_PATTERN = "story/{key}";

/** Branch name for a task: per-repo pattern, else global pattern, else story/{key}. */
export function branchName(t: { task_id: string; project_root: string; linked_refs?: { jira_key?: string } }, patternOverride?: string): string {
  const cfg = loadConfig();
  const proj = projectConfig(t.project_root);
  const pattern = patternOverride ?? proj?.branch_pattern ?? cfg.branch_pattern ?? DEFAULT_BRANCH_PATTERN;
  const jira = t.linked_refs?.jira_key;
  const vars: Record<string, string> = { key: jira ?? t.task_id, jira_key: jira ?? t.task_id, task_id: t.task_id };
  const unknown = [...pattern.matchAll(/\{([^}]*)\}/g)].map((m) => m[1]).filter((n) => !(n in vars));
  if (unknown.length) throw new Error(`branch_pattern '${pattern}' uses unknown placeholder(s): ${unknown.join(", ")} (allowed: key, jira_key, task_id)`);
  if (!/\{(key|jira_key|task_id)\}/.test(pattern)) throw new Error(`branch_pattern '${pattern}' must contain {key}, {jira_key} or {task_id}, or every task would share one branch`);
  const name = pattern.replace(/\{([^}]*)\}/g, (_, n) => vars[n]);
  // a valid, conservative git ref name; never main/master
  if (!/^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/.test(name) || name.includes("..") || name.endsWith(".lock") || /^(main|master)$/.test(name))
    throw new Error(`branch_pattern '${pattern}' gives invalid or protected branch name '${name}'`);
  return name;
}
