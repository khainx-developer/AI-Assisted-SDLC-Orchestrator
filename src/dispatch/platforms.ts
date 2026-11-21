import type { PlatformOverride } from "../config/config.js";
import { dirname, join } from "node:path";
import type { Restrictions, RestrictionsReport } from "../config/restrictions.js";

/**
 * A platform adapter turns a platform-neutral request into one headless CLI invocation of that
 * AI tool. Everything platform-specific (flags, how read-only is enforced, how the prompt is
 * delivered, how output is unwrapped) lives here and nowhere else. Adding a platform = adding
 * one entry to PLATFORMS (or declaring a `generic` platform in config.json with no code at all).
 */
export interface DispatchRequest {
  mode: "analysis" | "coding";
  prompt: string;
  /** written to disk by the runner when the platform needs file delivery */
  promptFile: string;
  projectRoot: string;
  extraReadRoots: string[];
  model?: string;
  /** secret files, commands and sandbox this session must not use; undefined = none */
  restrictions?: Restrictions;
}

export interface Invocation {
  command: string;
  args: string[];
  stdin?: string;
  /** files the runner writes before starting the CLI (e.g. a settings file passed by path, which avoids shell-quoting JSON) */
  files?: { path: string; content: string }[];
  /** what was enforced and what this CLI cannot enforce */
  restrictions?: RestrictionsReport;
}

export interface Platform {
  id: string;
  label: string;
  command: string;
  /** can the CLI itself restrict an analysis session to read-only? If not, the runner still verifies via git status. */
  enforcesReadOnly: boolean;
  /** default prompt delivery; "arg" auto-degrades to "file" when quoting would be unsafe (Windows .cmd shims) */
  promptVia: "stdin" | "arg" | "file";
  /** can the CLI be given extra readable directories natively? Otherwise they are only named in the prompt. */
  supportsAddDir: boolean;
  build(req: DispatchRequest, ov: PlatformOverride, promptArg: string): Invocation;
  /** unwrap CLI-specific envelope to the model's final text */
  parseOutput(stdout: string): string;
  /** exact token use and cost, when the CLI prints them (Claude Code does); otherwise the runner estimates */
  parseUsage?(stdout: string): { input_tokens: number; output_tokens: number; cost_usd?: number } | null;
}

const READ_TOOLS = ["Read", "Grep", "Glob", "WebSearch", "WebFetch"];

/**
 * Claude Code takes permission rules through a settings file (`--settings <path>`): deny rules beat every allow, including
 * --allowedTools. A Read deny also covers file commands it recognises in Bash (cat, head, tail), but not a script that opens the
 * file itself, so the sandbox is the real boundary, and it is not available on native Windows.
 */
function claudeRestrictions(req: DispatchRequest): { settings?: { path: string; content: string }; report: RestrictionsReport } {
  const x = req.restrictions;
  const report: RestrictionsReport = { applied: [], not_enforced: [] };
  if (!x?.enabled) return { report };
  const deny: string[] = [];
  for (const p of x.deny_read) deny.push(`Read(${p})`, `Edit(${p})`);
  if (x.deny_read.length) report.applied.push(`deny_read (${x.deny_read.length} patterns)`);
  const settings: Record<string, unknown> = {};
  if (req.mode === "coding") {
    for (const c of x.deny_commands) deny.push(`Bash(${c} *)`);
    if (x.deny_commands.length) report.applied.push(`deny_commands (${x.deny_commands.length})`);
    if (x.sandbox) {
      settings.sandbox = { enabled: true, allowUnsandboxedCommands: false, failIfUnavailable: true };
      report.applied.push("sandbox (the session fails if the platform has none)");
    }
  }
  if (!deny.length && !Object.keys(settings).length) return { report };
  settings.permissions = { deny };
  return { settings: { path: join(dirname(req.promptFile), "restrictions.settings.json"), content: JSON.stringify(settings, null, 2) }, report };
}

const claude: Platform = {
  id: "claude", label: "Claude Code", command: "claude", enforcesReadOnly: true, promptVia: "stdin", supportsAddDir: true,
  build(req, ov) {
    const args = ["-p", "--output-format", "json"];
    if (req.model ?? ov.model) args.push("--model", (req.model ?? ov.model)!);
    for (const d of req.extraReadRoots) args.push("--add-dir", d);
    if (req.mode === "analysis") {
      args.push("--allowedTools", READ_TOOLS.join(","), "--disallowedTools", "Edit,Write,MultiEdit,NotebookEdit,Bash");
    } else {
      args.push("--permission-mode", "acceptEdits", "--allowedTools", "Bash,Read,Grep,Glob,Edit,Write");
    }
    const r = claudeRestrictions(req);
    if (r.settings) args.push("--settings", r.settings.path);
    return { command: ov.command ?? "claude", args: [...args, ...(ov.extra_args ?? [])], stdin: req.prompt, files: r.settings ? [r.settings] : undefined, restrictions: r.report };
  },
  parseOutput(out) {
    try {
      const j = JSON.parse(out);
      if (typeof j.result === "string") return j.result;
    } catch { /* not JSON: fall through */ }
    return out;
  },
  parseUsage(out) {
    try {
      const j = JSON.parse(out);
      const u = j.usage;
      if (!u || typeof u.output_tokens !== "number") return null;
      // cached input counts too: it is still context the model read
      const input = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
      return { input_tokens: input, output_tokens: u.output_tokens, ...(typeof j.total_cost_usd === "number" ? { cost_usd: j.total_cost_usd } : {}) };
    } catch { return null; }
  },
};

const copilot: Platform = {
  id: "copilot", label: "GitHub Copilot CLI", command: "copilot", enforcesReadOnly: true, promptVia: "arg", supportsAddDir: true,
  build(req, ov, promptArg) {
    // --silent: only the agent's reply (no tool trace); --no-ask-user: never block waiting for a human in a headless run
    const args = ["-p", promptArg, "--silent", "--no-color", "--no-ask-user"];
    if (req.model ?? ov.model) args.push("--model", (req.model ?? ov.model)!);
    for (const d of req.extraReadRoots) args.push("--add-dir", d);
    if (req.mode === "analysis") args.push("--deny-tool", "write", "--deny-tool", "shell");
    else args.push("--allow-all-tools");
    // deny rules win over every allow, --allow-all-tools included. read()/write() rules cover Copilot's own file tools, not shell commands.
    const x = req.restrictions;
    const report: RestrictionsReport = { applied: [], not_enforced: [] };
    if (x?.enabled) {
      for (const p of x.deny_read) args.push("--deny-tool", `read(${p})`, "--deny-tool", `write(${p})`);
      if (x.deny_read.length) report.applied.push(`deny_read (${x.deny_read.length} patterns; Copilot's file tools only, not shell commands)`);
      if (req.mode === "coding") {
        for (const c of x.deny_commands) args.push("--deny-tool", `shell(${c})`);
        if (x.deny_commands.length) report.applied.push(`deny_commands (${x.deny_commands.length}; matched by command and first subcommand)`);
        if (x.sandbox) { args.push("--sandbox"); report.applied.push("sandbox (--sandbox)"); }
      }
    }
    return { command: ov.command ?? "copilot", args: [...args, ...(ov.extra_args ?? [])], restrictions: report };
  },
  parseOutput: (o) => o,
};

const cursor: Platform = {
  id: "cursor", label: "Cursor Agent CLI", command: "cursor-agent", enforcesReadOnly: false, promptVia: "arg", supportsAddDir: false,
  build(req, ov, promptArg) {
    // Without --force, cursor-agent only proposes changes, which is its read-only mode.
    // --trust is required for headless runs: otherwise the CLI exits asking for an interactive
    // workspace-trust prompt (dispatch already chose project_root; no human is at that TTY).
    const args = ["-p", promptArg, "--output-format", "text", "--trust"];
    if (req.model ?? ov.model) args.push("--model", (req.model ?? ov.model)!);
    if (req.mode === "coding") args.push("--force");
    // Cursor takes deny rules only from its own config files (~/.cursor/cli-config.json, <repo>/.cursor/cli.json). This tool never edits
    // those, so the only restriction it can pass is the sandbox flag.
    const x = req.restrictions;
    const report: RestrictionsReport = { applied: [], not_enforced: [] };
    if (x?.enabled) {
      if (req.mode === "coding" && x.sandbox) { args.push("--sandbox", "enabled"); report.applied.push("sandbox (--sandbox enabled)"); }
      if (x.deny_read.length) report.not_enforced.push("deny_read: Cursor only reads deny rules from its own config files; add Read(...) entries to ~/.cursor/cli-config.json yourself");
      if (req.mode === "coding" && x.deny_commands.length) report.not_enforced.push("deny_commands: same, add Shell(...) entries to Cursor's config");
    }
    return { command: ov.command ?? "cursor-agent", args: [...args, ...(ov.extra_args ?? [])], restrictions: report };
  },
  parseOutput: (o) => o,
};

/** Any other CLI, declared purely in config.json via `args` with {prompt}/{prompt_file}/{mode}/{model} placeholders. */
const generic: Platform = {
  id: "generic", label: "Custom CLI", command: "", enforcesReadOnly: false, promptVia: "stdin", supportsAddDir: false,
  build(req, ov, promptArg) {
    if (!ov.command) throw new Error("generic platform needs platforms.<id>.command in config.json");
    const sub = (s: string) =>
      s.replaceAll("{prompt}", promptArg).replaceAll("{prompt_file}", req.promptFile).replaceAll("{mode}", req.mode)
        .replaceAll("{model}", req.model ?? ov.model ?? "").replaceAll("{project_root}", req.projectRoot);
    const x = req.restrictions;
    const report: RestrictionsReport = { applied: [], not_enforced: [] };
    if (x?.enabled && (x.deny_read.length || (req.mode === "coding" && (x.deny_commands.length || x.sandbox)))) report.not_enforced.push("a custom CLI has no restriction support here: secret-file and command rules, and the sandbox, are not applied");
    return { command: ov.command, args: (ov.args ?? []).map(sub), stdin: (ov.prompt_via ?? "stdin") === "stdin" ? req.prompt : undefined, restrictions: report };
  },
  parseOutput: (o) => o,
};

export const PLATFORMS: Record<string, Platform> = { claude, copilot, cursor, generic };

export function promptAccessRequest(req: DispatchRequest, platform: Platform, promptVia: "stdin" | "arg" | "file"): DispatchRequest {
  if (promptVia !== "file" || !platform.supportsAddDir) return req;
  const promptDir = dirname(req.promptFile);
  if (req.extraReadRoots.includes(promptDir)) return req;
  return { ...req, extraReadRoots: [...req.extraReadRoots, promptDir] };
}

/** Resolve a configured platform id. Any id in config.json that is not built in is treated as `generic`. */
export function resolvePlatform(id: string, cfgPlatforms: Record<string, PlatformOverride>): { platform: Platform; override: PlatformOverride } {
  const override = cfgPlatforms[id] ?? {};
  const base = PLATFORMS[id];
  if (base) return { platform: base, override };
  if (!override.command) throw new Error(`unknown platform '${id}': built-ins are ${Object.keys(PLATFORMS).filter((p) => p !== "generic").join(", ")}; or declare it in config.json with a command`);
  return { platform: { ...generic, id, label: id, promptVia: override.prompt_via ?? "stdin" }, override };
}
