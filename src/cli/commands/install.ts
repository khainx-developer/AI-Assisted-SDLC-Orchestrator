/**
 * sdlc-orchestrator install --target <copilot-cli|claude|cursor|all> [--mode global|repo] [--repo <path>] ...
 * Writes the orchestrator agent/rule file and registers the two MCP servers for the chosen AI tool.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { dataDir } from "../../shared/paths.js";
import { parseJsonc } from "../../shared/jsonc.js";
import { DEFAULT_BRANCH_PATTERN } from "../../config/config.js";
import { trustCopilotFolder } from "../../dispatch/copilot-trust.js";
import { fwd, optionOf } from "../args.js";
import { HELP } from "../help.js";

/** This repository's root (dist/cli/commands is three levels below it). */
const here = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

export function installCommand(argv: string[]): void {
  const opt = (n: string) => optionOf(argv, n);
  const flag = (n: string) => argv.includes(`--${n}`);

  const target = opt("target");
  const repoArgs = argv.flatMap((a, i) => (a === "--repo" && argv[i + 1] ? [resolve(argv[i + 1])] : []));
  const modeRaw = opt("mode") ?? opt("scope") ?? "global";
  const scope: "user" | "repo" = modeRaw === "repo" ? "repo" : "user";
  let repo: string | undefined;
  const dry = flag("dry-run");
  const fail = (m: string): never => { console.error(`error: ${m}\n\n${HELP}`); process.exit(1); };

  if (target === "copilot") fail("--target copilot is not supported; use copilot-cli");
  if (!target || !["copilot-cli", "claude", "cursor", "all"].includes(target)) fail("--target must be copilot-cli, claude, cursor or all");
  if (!/^(global|user|repo)$/.test(modeRaw)) fail("--mode must be global or repo");
  if (scope === "repo" && !repoArgs.length) fail("--mode repo needs --repo <path>");
  for (const r of repoArgs) if (!existsSync(r)) fail(`repo path does not exist: ${r}`);

  // The chat agent cannot read files from this repo, so the skills it runs inline are embedded in its prompt.
  // (Stage skills are different: dispatch injects those into the worker session.)
  const INLINE_SKILLS = ["triage-task", "jira-intake", "edge-case-review"];
  const inlineSkills = INLINE_SKILLS.map((n) =>
    readFileSync(join(here, "orchestrator-agent", "skills", n, "SKILL.md"), "utf8").replace(/^---[\s\S]*?---\s*/, "")
  ).join("\n\n");
  const prompt =
    readFileSync(join(here, "orchestrator-agent", "SYSTEM_PROMPT.md"), "utf8") +
    "\n\n# Built-in skills (already loaded below)\nThe skills named in this prompt (`triage-task`, `jira-intake`, `edge-case-review`) are written out in full here. " +
    "Never search the repository or disk for skill files, and never ask the user for them. The repository's own skills are used by dispatched coding sessions, not by you.\n\n" +
    inlineSkills;
  const servers = {
    "workflow-state": { command: "node", args: [fwd(join(here, "dist", "mcp", "workflow", "server.js"))] },
    dispatch: { command: "node", args: [fwd(join(here, "dist", "mcp", "dispatch", "server.js"))] },
  };

  const integrations = !flag("no-integrations");
  const jiraKey = opt("jira-server") ?? "com.atlassian/atlassian-mcp-server";
  const githubKey = opt("github-server") ?? "io.github.github/github-mcp-server";
  const remote: Record<string, any> = {
    [jiraKey]: { url: "https://mcp.atlassian.com/v2/mcp" },
    [githubKey]: { url: "https://api.githubcopilot.com/mcp/" },
  };

  function write(file: string, content: string) {
    console.log(`${dry ? "[dry-run] would write" : "wrote"} ${file}`);
    if (dry) return;
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  }

  function mergeMcp(file: string, withType: boolean, cli = false) {
    const entries: Record<string, any> = Object.fromEntries(
      Object.entries(servers).map(([k, v]) => [k, cli ? { type: "local", ...v, tools: ["*"] } : withType ? { type: "stdio", ...v } : v])
    );
    const extra = integrations
      ? Object.fromEntries(Object.entries(remote).map(([k, v]) => [k, cli ? { type: "http", ...v, tools: ["*"] } : withType ? { type: "http", ...v } : v]))
      : {};
    let cfg: any = {};
    if (existsSync(file)) {
      const parsed = parseJsonc(readFileSync(file, "utf8"));
      if (!parsed) {
        console.log(`! ${file} is not valid JSON; left untouched. Add this under "mcpServers":\n${JSON.stringify(entries, null, 2)}`);
        return;
      }
      cfg = parsed.data;
      if (!dry) copyFileSync(file, `${file}.bak`);
      if (parsed.hadComments) console.log(`! ${file} contained comments; they are not preserved (original saved as ${file}.bak)`);
    }
    // integrations are only added when absent, so an existing (possibly customised) entry is never overwritten
    const existing = cfg.mcpServers ?? {};
    const add = Object.fromEntries(Object.entries(extra).filter(([k]) => !(k in existing)));
    cfg.mcpServers = { ...existing, ...add, ...entries };
    write(file, JSON.stringify(cfg, null, 2));
  }

  function installCopilotCli() {
    // Always user-global under ~/.copilot — never write into the repo. --repo only updates config.json.
    for (const r of repoArgs) {
      if (trustCopilotFolder(r, { dryRun: dry }))
        console.log(`${dry ? "[dry-run] would trust" : "trusted"} Copilot CLI folder ${fwd(resolve(r))}`);
    }
    const agent = `---\ndescription: SDLC orchestrator. Triages tasks and drives requirement, design, plan, implementation, test and review across AI platforms.\n---\n${prompt}`;
    const dir = join(process.env.COPILOT_HOME ?? join(homedir(), ".copilot"));
    write(join(dir, "agents", "orchestrator.agent.md"), agent);
    mergeMcp(join(dir, "mcp-config.json"), true, true);
  }

  function installClaude() {
    const agent = `---\nname: orchestrator\ndescription: SDLC orchestrator. Use to start, resume or inspect tasks that move through requirement, design, plan, implementation, test and review.\n---\n${prompt}`;
    if (scope === "repo") {
      write(join(repo!, ".claude", "agents", "orchestrator.md"), agent);
      mergeMcp(join(repo!, ".mcp.json"), false);
      return;
    }
    write(join(homedir(), ".claude", "agents", "orchestrator.md"), agent);
    const cmds = Object.entries(servers).map(([k, v]) => `claude mcp add --scope user ${k} -- ${v.command} "${v.args[0]}"`);
    console.log(`user-scope MCP servers for Claude Code are registered with its own CLI; run:\n  ${cmds.join("\n  ")}`);
  }

  function installCursor() {
    // Always user-global: MCP in ~/.cursor/mcp.json, @orchestrator-agent in ~/.cursor/agents/.
    // --repo only registers the project in config.json (see writeConfig); nothing is written into the repo.
    mergeMcp(join(homedir(), ".cursor", "mcp.json"), false);
    const agent = `---\nname: orchestrator-agent\ndescription: SDLC orchestrator. Triages tasks and drives requirement, design, plan, implementation, test and review.\n---\n${prompt}`;
    write(join(homedir(), ".cursor", "agents", "orchestrator-agent.md"), agent);
  }

  function writeConfig() {
    const dp = opt("platform"), ap = opt("analysis-platform"), cp = opt("coding-platform"), tc = opt("test-command");
    // sole install target implies that platform for registered repos (copilot-cli → dispatch id "copilot")
    const sole = targets.length === 1 ? targets[0] : null;
    const autoPlatform = !dp && (sole === "cursor" || sole === "copilot-cli")
      ? (sole === "copilot-cli" ? "copilot" : sole)
      : undefined;
    const file = join(dataDir(), "config.json");
    const cfg = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : { default_platform: "claude", platforms: {} };
    // seed the default branch naming once; never overwrite a pattern the user already chose
    const seed = cfg.branch_pattern === undefined;
    if (seed) cfg.branch_pattern = DEFAULT_BRANCH_PATTERN;
    if (!seed && !dp && !ap && !cp && !repoArgs.length) return;
    for (const r of repoArgs) {
      cfg.projects = cfg.projects ?? {};
      cfg.projects[fwd(r)] = {
        ...(cfg.projects[fwd(r)] ?? {}),
        ...(tc ? { test_command: tc } : {}),
        ...(autoPlatform ? { platform: autoPlatform } : {}),
      };
      console.log(`registered repo ${fwd(r)}${autoPlatform ? ` (platform: ${autoPlatform})` : ""}`);
    }
    if (dp) cfg.default_platform = dp;
    if (ap) cfg.analysis_platform = ap;
    if (cp) cfg.coding_platform = cp;
    write(file, JSON.stringify(cfg, null, 2));
  }

  if (!existsSync(join(here, "dist", "mcp", "workflow", "server.js"))) fail("project is not built; run `npm run build` first");
  const targets = target === "all" ? ["copilot-cli", "claude", "cursor"] : [target!];
  const fns = { "copilot-cli": installCopilotCli, claude: installClaude, cursor: installCursor } as Record<string, () => void>;
  const userGlobalTargets = new Set(["copilot-cli", "cursor"]);
  for (const t of targets) {
    // copilot-cli / cursor: always user-global; --repo is handled only by writeConfig
    if (!userGlobalTargets.has(t) && scope === "repo") {
      for (const r of repoArgs) { repo = r; console.log(`\n== ${t} (repo: ${r}) ==`); fns[t](); }
    } else {
      console.log(`\n== ${t} (global) ==`);
      repo = undefined;
      fns[t]();
    }
  }
  writeConfig();
  console.log("\nDone. Start a new session, then use the orchestrator (Claude Code: orchestrator subagent; Cursor: @orchestrator-agent; Copilot CLI: orchestrator agent).");
}
