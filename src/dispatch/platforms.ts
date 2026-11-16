import type { PlatformOverride } from "../common/config.js";
import { dirname } from "node:path";

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
}

export interface Invocation {
  command: string;
  args: string[];
  stdin?: string;
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
}

const READ_TOOLS = ["Read", "Grep", "Glob", "WebSearch", "WebFetch"];

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
    return { command: ov.command ?? "claude", args: [...args, ...(ov.extra_args ?? [])], stdin: req.prompt };
  },
  parseOutput(out) {
    try {
      const j = JSON.parse(out);
      if (typeof j.result === "string") return j.result;
    } catch { /* not JSON: fall through */ }
    return out;
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
    return { command: ov.command ?? "copilot", args: [...args, ...(ov.extra_args ?? [])] };
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
    return { command: ov.command ?? "cursor-agent", args: [...args, ...(ov.extra_args ?? [])] };
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
    return { command: ov.command, args: (ov.args ?? []).map(sub), stdin: (ov.prompt_via ?? "stdin") === "stdin" ? req.prompt : undefined };
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
