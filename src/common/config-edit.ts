import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { dataDir, normRoot } from "./paths.js";
import { PLATFORMS } from "../dispatch/platforms.js";

/**
 * One place that edits config.json, used by both the CLI (`sdlc-orchestrator config ...`) and the MCP tools, so the two
 * ways of changing settings validate the same way. Only the settings listed here can be set; anything else is refused.
 */

type Kind = "string" | "boolean" | "number" | "string[]" | "platform" | "scope_check" | "branch_pattern";
interface Spec { kind: Kind; help: string }

/** Settings that can be set per project (projects.<root>.<key>) and, for the ones marked global, for every project. */
export const PROJECT_SETTINGS: Record<string, Spec & { global?: boolean }> = {
  platform: { kind: "platform", help: "AI platform for all work on this repo" },
  analysis_platform: { kind: "platform", global: true, help: "platform for read-only analysis stages" },
  coding_platform: { kind: "platform", global: true, help: "platform for coding sessions" },
  review_platform: { kind: "platform", global: true, help: "platform for the independent code review" },
  model: { kind: "string", help: "model name as the repo's AI CLI expects it" },
  branch_pattern: { kind: "branch_pattern", global: true, help: "task branch name, e.g. feature/{key}" },
  test_command: { kind: "string", help: "command that runs the repo's tests" },
  tests_first: { kind: "boolean", global: true, help: "write failing tests in a separate session first and freeze them" },
  scope_check: { kind: "scope_check", global: true, help: "off | warn | fail: files touched outside the plan's scope" },
  scope_allow: { kind: "string[]", global: true, help: "extra paths always allowed by the scope check" },
  redact_secrets: { kind: "boolean", global: true, help: "remove secret-looking strings from prompts" },
  repo_instructions_max_chars: { kind: "number", global: true, help: "cap on characters of the repo's own instruction files put in analysis prompts (default 12000; 0 = none)" },
  worktree: { kind: "boolean", help: "give each task its own git worktree so stories can run in parallel (default false)" },
  worktree_setup: { kind: "string", help: "command run once in each new worktree, e.g. npm ci" },
};
export const GLOBAL_ONLY_SETTINGS: Record<string, Spec> = {
  default_platform: { kind: "platform", help: "platform used when nothing else is configured" },
  dispatch_timeout_minutes: { kind: "number", help: "a session running longer than this is killed" },
  dispatch_retention_days: { kind: "number", help: "finished dispatch folders older than this are deleted at startup (0 keeps all)" },
};

const configFile = () => process.env.SDLC_CONFIG ?? join(dataDir(), "config.json");

export function readRawConfig(): any {
  const f = configFile();
  return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : { default_platform: "claude", platforms: {} };
}
function writeRawConfig(cfg: any) {
  const f = configFile();
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, JSON.stringify(cfg, null, 2));
}

/** The key under which a repo is stored: the existing spelling if registered, else a forward-slash absolute path. */
function projectKey(cfg: any, root: string): string {
  const abs = normRoot(resolve(root));
  return Object.keys(cfg.projects ?? {}).find((k) => normRoot(k).toLowerCase() === abs.toLowerCase()) ?? abs;
}

function coerce(key: string, spec: Spec, raw: unknown, cfg: any): unknown {
  const bad = (m: string) => new Error(`${key}: ${m}`);
  const text = typeof raw === "string" ? raw.trim() : raw;
  switch (spec.kind) {
    case "boolean":
      if (typeof raw === "boolean") return raw;
      if (typeof text === "string" && /^(true|on|yes)$/i.test(text)) return true;
      if (typeof text === "string" && /^(false|off|no)$/i.test(text)) return false;
      throw bad("expected true or false");
    case "number": {
      const n = Number(raw);
      if (raw === "" || !Number.isFinite(n) || n < 0) throw bad("expected a number >= 0");
      return n;
    }
    case "string[]": {
      const list = Array.isArray(raw) ? raw : typeof text === "string" ? text.split(",").map((s) => s.trim()).filter(Boolean) : null;
      if (!list || list.some((x) => typeof x !== "string")) throw bad("expected a list of strings");
      return list;
    }
    case "scope_check":
      if (text === "off" || text === "warn" || text === "fail") return text;
      throw bad("expected off, warn or fail");
    case "platform": {
      if (typeof text !== "string" || !text) throw bad("expected a platform id");
      const known = new Set([...Object.keys(PLATFORMS).filter((p) => p !== "generic"), ...Object.keys(cfg.platforms ?? {})]);
      if (!known.has(text)) throw bad(`unknown platform '${text}' (built in: claude, copilot, cursor; or declare it under platforms in config.json)`);
      return text;
    }
    case "branch_pattern": {
      if (typeof text !== "string") throw bad("expected a pattern");
      const names = [...text.matchAll(/\{([^}]*)\}/g)].map((m) => m[1]);
      if (!names.some((n) => ["key", "jira_key", "task_id"].includes(n)) || names.some((n) => !["key", "jira_key", "task_id"].includes(n)))
        throw bad("must contain {key}, {jira_key} or {task_id} and use no other placeholder");
      return text;
    }
    default:
      if (typeof text !== "string" || !text) throw bad("expected non-empty text");
      return text;
  }
}

export function addProject(root: string, opts: { requireExists?: boolean } = {}): { project_root: string; added: boolean } {
  const abs = resolve(root);
  if (opts.requireExists !== false && !existsSync(abs)) throw new Error(`not found: ${normRoot(abs)}`);
  const cfg = readRawConfig();
  cfg.projects = cfg.projects ?? {};
  const key = projectKey(cfg, root);
  const added = !cfg.projects[key];
  cfg.projects[key] ??= {};
  writeRawConfig(cfg);
  return { project_root: key, added };
}

export function removeProject(root: string): { project_root: string; removed: boolean } {
  const cfg = readRawConfig();
  const key = projectKey(cfg, root);
  const removed = !!cfg.projects?.[key];
  if (removed) { delete cfg.projects[key]; writeRawConfig(cfg); }
  return { project_root: key, removed };
}

/** Set (or, with value null, unset) one setting for a repo, or globally when `root` is omitted. */
export function updateSetting(root: string | undefined, key: string, value: unknown): { scope: string; key: string; value: unknown; unset: boolean } {
  const cfg = readRawConfig();
  const unset = value === null || value === undefined;
  // platforms.<id>.model: the model a platform uses everywhere
  const pm = /^platforms\.([A-Za-z0-9_-]+)\.model$/.exec(key);
  if (pm) {
    if (root) throw new Error("platforms.<id>.model is global; for one repo set 'model' on the repo");
    cfg.platforms = cfg.platforms ?? {};
    if (unset) { if (cfg.platforms[pm[1]]) delete cfg.platforms[pm[1]].model; }
    else cfg.platforms[pm[1]] = { ...(cfg.platforms[pm[1]] ?? {}), model: coerce(key, { kind: "string", help: "" }, value, cfg) };
    writeRawConfig(cfg);
    return { scope: "global", key, value: cfg.platforms[pm[1]]?.model ?? null, unset };
  }
  if (root) {
    const spec = PROJECT_SETTINGS[key];
    if (!spec) throw new Error(`'${key}' cannot be set per repo. Settable: ${Object.keys(PROJECT_SETTINGS).join(", ")}`);
    const pk = projectKey(cfg, root);
    if (!cfg.projects?.[pk]) throw new Error(`${pk} is not registered; add it first (add_project, or: sdlc-orchestrator repos add <path>)`);
    if (unset) delete cfg.projects[pk][key];
    else cfg.projects[pk][key] = coerce(key, spec, value, cfg);
    writeRawConfig(cfg);
    return { scope: pk, key, value: cfg.projects[pk][key] ?? null, unset };
  }
  const spec = GLOBAL_ONLY_SETTINGS[key] ?? (PROJECT_SETTINGS[key]?.global ? PROJECT_SETTINGS[key] : undefined);
  if (!spec) {
    const ok = [...Object.keys(GLOBAL_ONLY_SETTINGS), ...Object.entries(PROJECT_SETTINGS).filter(([, v]) => v.global).map(([k]) => k), "platforms.<id>.model"];
    throw new Error(`'${key}' cannot be set globally. Settable: ${ok.join(", ")}`);
  }
  if (key === "default_platform" && unset) throw new Error("default_platform cannot be unset");
  if (unset) delete cfg[key]; else cfg[key] = coerce(key, spec, value, cfg);
  writeRawConfig(cfg);
  return { scope: "global", key, value: cfg[key] ?? null, unset };
}

/** What is configured: the global settings and every registered repo (or just `root`). */
export function describeConfig(root?: string) {
  const cfg = readRawConfig();
  const global: Record<string, unknown> = {};
  const globalKeys = [...Object.keys(GLOBAL_ONLY_SETTINGS), ...Object.entries(PROJECT_SETTINGS).filter(([, v]) => v.global).map(([k]) => k)];
  for (const k of globalKeys) if (cfg[k] !== undefined) global[k] = cfg[k];
  const platforms = Object.fromEntries(Object.entries<any>(cfg.platforms ?? {}).map(([id, p]) => [id, { model: p?.model ?? null, command: p?.command ?? null }]));
  const want = root ? projectKey(cfg, root) : undefined;
  const projects = Object.fromEntries(Object.entries<any>(cfg.projects ?? {}).filter(([k]) => !want || k === want));
  return { global, platforms, projects, project_settings: Object.fromEntries(Object.entries(PROJECT_SETTINGS).map(([k, v]) => [k, v.help])) };
}
