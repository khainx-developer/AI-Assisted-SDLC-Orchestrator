/**
 * One turn of the orchestrator agent, started headlessly. The agent is the same installed orchestrator the human chats with
 * (`sdlc-orchestrator install`), so it has the workflow-state and dispatch tools; the runner only tells it which task to advance.
 *
 * Built-in invocations: copilot (verified against `copilot --help`) and claude (not yet run against the real CLI, see BACKLOG.md).
 * Any other CLI is described in config.json under `autopilot` (command, args with {prompt}).
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { extname } from "node:path";
import type { AutopilotConfig } from "../config/config.js";
import { resolveExe, killTree } from "../dispatch/process.js";

export interface AgentInvocation {
  command: string;
  args: string[];
  stdin?: string;
}

export interface TurnResult {
  ok: boolean;
  /** the end of what the agent printed (its one-line report) */
  output: string;
  exit_code: number | null;
  timed_out: boolean;
  error?: string;
}

/** What one agent turn is told. Kept to one line: it travels as a command-line argument on some CLIs. */
export function tickPrompt(a: { run_id: string; task_id: string; stage: string; project_root: string }): string {
  return (
    `AUTONOMOUS TURN. Run ${a.run_id}, task ${a.task_id} (repo ${a.project_root}, now at stage ${a.stage}). No human is available and none will answer. ` +
    `Call get_playbook with name "autonomous" first and follow it exactly. Advance only this task, as far as the playbook allows in this turn. ` +
    `Your whole reply is ONE line: the stage reached and what you did, or "parked: <reason>".`
  );
}

const platformFor = (id: string | undefined) => (id === "copilot" || id === "claude" ? id : null);

export function buildInvocation(prompt: string, cfg: AutopilotConfig | undefined, defaultPlatform: string): AgentInvocation {
  const c = cfg ?? {};
  if (c.command) {
    const withPrompt = (c.args ?? []).some((x) => x.includes("{prompt}"));
    return { command: c.command, args: (c.args ?? []).map((x) => x.replaceAll("{prompt}", prompt)), stdin: withPrompt ? undefined : prompt };
  }
  const agent = c.agent ?? "orchestrator";
  const platform = platformFor(c.platform) ?? platformFor(defaultPlatform);
  if (platform === "copilot") {
    // deny rules win over --allow-all-tools: the orchestrator only calls its MCP tools and never needs files or a shell
    return { command: "copilot", args: ["--agent", agent, "-p", prompt, "--silent", "--no-color", "--no-ask-user", "--allow-all-tools", "--deny-tool", "write", "--deny-tool", "shell"] };
  }
  if (platform === "claude") {
    return {
      command: "claude",
      args: ["-p", "--agent", agent, "--output-format", "text", "--permission-mode", "acceptEdits", "--allowedTools", "mcp__workflow-state,mcp__dispatch", "--disallowedTools", "Edit,Write,MultiEdit,NotebookEdit,Bash"],
      stdin: prompt,
    };
  }
  throw new Error(`autopilot has no built-in way to run '${c.platform ?? defaultPlatform}': use --platform copilot|claude, or set autopilot.command and autopilot.args in config.json`);
}

/** Run one agent turn to its end or its timeout. Never throws: a failure is a result, and the task's attempt count handles repeats. */
export function runTurn(inv: AgentInvocation, opts: { cwd: string; timeoutMs: number }): Promise<TurnResult> {
  return new Promise((resolve) => {
    if (!existsSync(opts.cwd)) {
      resolve({ ok: false, output: "", exit_code: null, timed_out: false, error: `could not start '${inv.command}': the repo folder ${opts.cwd} does not exist` });
      return;
    }
    const exe = resolveExe(inv.command);
    const isShim = process.platform === "win32" && /\.(cmd|bat)$/i.test(extname(exe));
    let out = "";
    let timedOut = false;
    let child;
    try {
      child = spawn(exe, inv.args, { cwd: opts.cwd, shell: isShim, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    } catch (e: any) {
      resolve({ ok: false, output: "", exit_code: null, timed_out: false, error: `could not start '${exe}': ${e.message}` });
      return;
    }
    const keep = (b: Buffer) => { out = (out + b.toString("utf8")).slice(-4000); };
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    child.stdin.on("error", () => { /* the CLI may exit before reading stdin */ });
    child.stdin.end(inv.stdin ?? "");
    const timer = setTimeout(() => { timedOut = true; killTree(child.pid); }, opts.timeoutMs);
    child.on("error", (e) => { clearTimeout(timer); resolve({ ok: false, output: out.trim(), exit_code: null, timed_out: false, error: `could not start '${exe}': ${e.message}` }); });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0 && !timedOut, output: out.trim(), exit_code: code, timed_out: timedOut, ...(timedOut ? { error: "timed out" } : {}) });
    });
  });
}
