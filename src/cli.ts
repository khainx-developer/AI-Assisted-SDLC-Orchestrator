#!/usr/bin/env node
/**
 * sdlc-orchestrator install --target <copilot|claude|cursor|all> [--scope user|repo] [--repo <path>] ...
 * Writes the orchestrator agent/rule file and registers the two MCP servers for the chosen AI tool.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { dataDir } from "./common/paths.js";

const HELP = `sdlc-orchestrator install [options]

  --target <t>        copilot (VS Code) | copilot-cli (~/.copilot) | claude | cursor | all        (required)
  --mode <m>          global (default): agent + servers for all projects; repos named with --repo are
                      registered in the global config
                      repo: for claude only, also put the agent file inside each --repo
                      (copilot, copilot-cli, cursor: always user-global; --repo only updates config.json)
  --repo <path>       repository; repeat for several. Registered in ~/.ai-sdlc-orchestrator/config.json
  --platform <p>      default AI platform for dispatched work: claude | copilot | cursor | <custom id>
                      (copilot/copilot-cli/cursor + --repo: defaults each repo's platform unless you pass --platform)
  --analysis-platform <p>   platform for read-only analysis stages
  --coding-platform <p>     platform for coding sessions
  --profile <name>    copilot only: VS Code profile folder name (default profile if omitted)
  --insiders          copilot only: target VS Code Insiders
  --no-integrations   do not register/allow the Jira (Atlassian) and GitHub MCP servers
  --jira-server <name>    MCP server key for Jira (default com.atlassian/atlassian-mcp-server)
  --github-server <name>  MCP server key for GitHub (default io.github.github/github-mcp-server)
  --test-command <c>  test command to record for the registered repo(s)
  --dry-run           show what would be written, change nothing
  -h, --help

sdlc-orchestrator repos list | add <path>... | remove <path>...   manage registered repos in the global config
sdlc-orchestrator model show [--repo <path>]                        AI model per repo (overrides the platform's model; a one-off model on a dispatch overrides both)
sdlc-orchestrator model set <name> --repo <path>                   model name as the repo's AI CLI expects it
sdlc-orchestrator model reset --repo <path>
sdlc-orchestrator branch show [--repo <path>]                      branch naming pattern in effect (default task/{key})
sdlc-orchestrator branch set <pattern> [--repo <path>]             e.g. feature/{key}; without --repo sets the global pattern
sdlc-orchestrator branch reset [--repo <path>]                     back to the default (or the global pattern, for a repo)
`;

const argv = process.argv.slice(2);
if (argv[0] === "tasks") { await tasksCommand(argv.slice(1)); process.exit(0); }
if (argv[0] === "repos") { reposCommand(argv.slice(1)); process.exit(0); }
if (argv[0] === "model") { modelCommand(argv.slice(1)); process.exit(0); }
if (argv[0] === "branch") { await branchCommand(argv.slice(1)); process.exit(0); }
if (argv[0] !== "install" || argv.includes("-h") || argv.includes("--help")) {
  console.log(HELP);
  process.exit(argv[0] === "install" || argv.length === 0 ? 0 : 1);
}
const opt = (n: string) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };
const flag = (n: string) => argv.includes(`--${n}`);

const target = opt("target");
const repoArgs = argv.flatMap((a, i) => (a === "--repo" && argv[i + 1] ? [resolve(argv[i + 1])] : []));
const modeRaw = opt("mode") ?? opt("scope") ?? "global";
const scope: "user" | "repo" = modeRaw === "repo" ? "repo" : "user";
let repo: string | undefined;
const dry = flag("dry-run");
const fail = (m: string): never => { console.error(`error: ${m}\n\n${HELP}`); process.exit(1); };

if (!target || !["copilot", "copilot-cli", "claude", "cursor", "all"].includes(target)) fail("--target must be copilot, copilot-cli, claude, cursor or all");
if (!/^(global|user|repo)$/.test(modeRaw)) fail("--mode must be global or repo");
if (scope === "repo" && !repoArgs.length) fail("--mode repo needs --repo <path>");
for (const r of repoArgs) if (!existsSync(r)) fail(`repo path does not exist: ${r}`);

const here = resolve(dirname(fileURLToPath(import.meta.url)), "..");
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
function fwd(p: string) { return p.replaceAll("\\", "/"); }
const servers = {
  "workflow-state": { command: "node", args: [fwd(join(here, "dist", "workflow-state", "server.js"))] },
  dispatch: { command: "node", args: [fwd(join(here, "dist", "dispatch", "server.js"))] },
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

/** Parses JSON, tolerating // comment lines and trailing commas (VS Code style). Returns null if still unparseable. */
function readJsonc(file: string): { data: any; hadComments: boolean } | null {
  const raw = readFileSync(file, "utf8");
  try { return { data: JSON.parse(raw), hadComments: false }; } catch { /* try relaxed */ }
  try {
    const relaxed = raw.split(/\r?\n/).filter((l) => !/^\s*\/\//.test(l)).join("\n").replace(/,(\s*[}\]])/g, "$1");
    return { data: JSON.parse(relaxed), hadComments: true };
  } catch { return null; }
}

function mergeMcp(file: string, key: "servers" | "mcpServers", withType: boolean, cli = false) {
  const entries: Record<string, any> = Object.fromEntries(
    Object.entries(servers).map(([k, v]) => [k, cli ? { type: "local", ...v, tools: ["*"] } : withType ? { type: "stdio", ...v } : v])
  );
  const extra = integrations
    ? Object.fromEntries(Object.entries(remote).map(([k, v]) => [k, cli ? { type: "http", ...v, tools: ["*"] } : withType ? { type: "http", ...v } : v]))
    : {};
  let cfg: any = {};
  if (existsSync(file)) {
    const parsed = readJsonc(file);
    if (!parsed) {
      console.log(`! ${file} is not valid JSON; left untouched. Add this under "${key}":\n${JSON.stringify(entries, null, 2)}`);
      return;
    }
    cfg = parsed.data;
    if (!dry) copyFileSync(file, `${file}.bak`);
    if (parsed.hadComments) console.log(`! ${file} contained comments; they are not preserved (original saved as ${file}.bak)`);
  }
  // integrations are only added when absent, so an existing (possibly customised) entry is never overwritten
  const existing = cfg[key] ?? {};
  const add = Object.fromEntries(Object.entries(extra).filter(([k]) => !(k in existing)));
  cfg[key] = { ...existing, ...add, ...entries };
  if (key === "servers" && !cfg.inputs && !cli) cfg.inputs = [];
  write(file, JSON.stringify(cfg, null, 2));
}

function vscodeUserDir() {
  const app = flag("insiders") ? "Code - Insiders" : "Code";
  const base = process.platform === "win32" ? join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), app)
    : process.platform === "darwin" ? join(homedir(), "Library", "Application Support", app)
    : join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), app);
  return opt("profile") ? join(base, "User", "profiles", opt("profile")!) : join(base, "User");
}

function installCopilot() {
  // Always user-global for GitHub Copilot in VS Code — never write into the repo.
  // Agent + MCP live in the VS Code user folder so Copilot Chat can see them; --repo only updates config.json.
  const agent = `---\ndescription: SDLC orchestrator. Triages tasks and drives requirement, design, plan, implementation, test and review across AI platforms.\ntools: [${["workflow-state/*", "dispatch/*", ...(integrations ? [`${jiraKey}/*`, `${githubKey}/*`] : [])].map((t) => `'${t}'`).join(", ")}]\n---\n${prompt}`;
  const dir = vscodeUserDir();
  write(join(dir, "prompts", "orchestrator.agent.md"), agent);
  mergeMcp(join(dir, "mcp.json"), "servers", true);
}

function installCopilotCli() {
  // Always user-global under ~/.copilot — never write into the repo. --repo only updates config.json.
  const agent = `---
description: SDLC orchestrator. Triages tasks and drives requirement, design, plan, implementation, test and review across AI platforms.
---
${prompt}`;
  const dir = join(process.env.COPILOT_HOME ?? join(homedir(), ".copilot"));
  write(join(dir, "agents", "orchestrator.agent.md"), agent);
  mergeMcp(join(dir, "mcp-config.json"), "mcpServers", true, true);
}

function installClaude() {
  const agent = `---\nname: orchestrator\ndescription: SDLC orchestrator. Use to start, resume or inspect tasks that move through requirement, design, plan, implementation, test and review.\n---\n${prompt}`;
  if (scope === "repo") {
    write(join(repo!, ".claude", "agents", "orchestrator.md"), agent);
    mergeMcp(join(repo!, ".mcp.json"), "mcpServers", false);
    return;
  }
  write(join(homedir(), ".claude", "agents", "orchestrator.md"), agent);
  const cmds = Object.entries(servers).map(([k, v]) => `claude mcp add --scope user ${k} -- ${v.command} "${v.args[0]}"`);
  console.log(`user-scope MCP servers for Claude Code are registered with its own CLI; run:\n  ${cmds.join("\n  ")}`);
}

function installCursor() {
  // Always user-global: MCP in ~/.cursor/mcp.json, @orchestrator-agent in ~/.cursor/agents/.
  // --repo only registers the project in config.json (see writeConfig); nothing is written into the repo.
  mergeMcp(join(homedir(), ".cursor", "mcp.json"), "mcpServers", false);
  const agent = `---\nname: orchestrator-agent\ndescription: SDLC orchestrator. Triages tasks and drives requirement, design, plan, implementation, test and review.\n---\n${prompt}`;
  write(join(homedir(), ".cursor", "agents", "orchestrator-agent.md"), agent);
}

function writeConfig() {
  const dp = opt("platform"), ap = opt("analysis-platform"), cp = opt("coding-platform"), tc = opt("test-command");
  // sole install target implies that platform for registered repos (copilot-cli → dispatch id "copilot")
  const sole = targets.length === 1 ? targets[0] : null;
  const autoPlatform = !dp && (sole === "cursor" || sole === "copilot" || sole === "copilot-cli")
    ? (sole === "copilot-cli" ? "copilot" : sole)
    : undefined;
  if (!dp && !ap && !cp && !repoArgs.length) return;
  const file = join(dataDir(), "config.json");
  const cfg = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : { default_platform: "claude", platforms: {} };
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

if (!existsSync(join(here, "dist", "workflow-state", "server.js"))) fail("project is not built; run `npm run build` first");
const targets = target === "all" ? ["copilot", "copilot-cli", "claude", "cursor"] : [target!];
const fns = { copilot: installCopilot, "copilot-cli": installCopilotCli, claude: installClaude, cursor: installCursor } as Record<string, () => void>;
const userGlobalTargets = new Set(["copilot", "copilot-cli", "cursor"]);
for (const t of targets) {
  // copilot / copilot-cli / cursor: always user-global; --repo is handled only by writeConfig
  if (!userGlobalTargets.has(t) && scope === "repo") {
    for (const r of repoArgs) { repo = r; console.log(`\n== ${t} (repo: ${r}) ==`); fns[t](); }
  } else {
    console.log(`\n== ${t} (global) ==`);
    repo = undefined;
    fns[t]();
  }
}
writeConfig();
console.log("\nDone. Reload the tool, then use the orchestrator (Claude Code: orchestrator subagent; Cursor: @orchestrator-agent; Copilot: orchestrator agent).");

function reposCommand(a: string[]) {
  const file = join(dataDir(), "config.json");
  const cfg = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : { default_platform: "claude", platforms: {} };
  cfg.projects = cfg.projects ?? {};
  const [sub, ...paths] = a;
  if (sub === "add") {
    for (const p of paths) {
      const k = fwd(resolve(p));
      if (!existsSync(resolve(p))) { console.error(`not found: ${k}`); continue; }
      cfg.projects[k] = cfg.projects[k] ?? {};
      console.log(`added ${k}`);
    }
  } else if (sub === "remove") {
    for (const p of paths) { delete cfg.projects[fwd(resolve(p))]; console.log(`removed ${fwd(resolve(p))}`); }
  } else if (sub !== "list") { console.error("usage: repos list | add <path>... | remove <path>..."); process.exit(1); }
  if (sub !== "list") writeFileSync(file, JSON.stringify(cfg, null, 2));
  const keys = Object.keys(cfg.projects);
  console.log(keys.length ? keys.join("\n") : "(no repos registered)");
}

function modelCommand(a: string[]) {
  const file = join(dataDir(), "config.json");
  const cfg = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : { default_platform: "claude", platforms: {} };
  const [sub, ...rest] = a;
  const ri = rest.indexOf("--repo");
  const repoArg = ri >= 0 ? rest[ri + 1] : undefined;
  if (ri >= 0 && !repoArg) { console.error("--repo needs a path"); process.exit(1); }
  const key = repoArg ? fwd(resolve(repoArg)) : undefined;
  const platformOf = (v: any) => v?.platform ?? v?.coding_platform ?? v?.analysis_platform ?? cfg.coding_platform ?? cfg.default_platform;
  if (sub === "show") {
    console.log("platform models (platforms.<id>.model):");
    for (const [id, p] of Object.entries<any>(cfg.platforms ?? {})) console.log(`  ${id}: ${p?.model ?? "(CLI default)"}`);
    const rows = Object.entries<any>(cfg.projects ?? {}).filter(([k]) => !key || k === key);
    for (const [k, v] of rows) console.log(`${k}: ${v?.model ?? `(platform default, ${platformOf(v)}: ${cfg.platforms?.[platformOf(v)]?.model ?? "CLI default"})`}`);
    return;
  }
  if (sub === "set") {
    const name = rest.filter((_, i) => ri < 0 || (i !== ri && i !== ri + 1))[0];
    if (!name || !key) { console.error("usage: model set <name> --repo <path>"); process.exit(1); }
    cfg.projects = cfg.projects ?? {};
    cfg.projects[key] = { ...(cfg.projects[key] ?? {}), model: name };
    writeFileSync(file, JSON.stringify(cfg, null, 2));
    console.log(`${key}: model set to ${name}. A wrong name fails instantly at no cost. Reload your tool so the servers reread config.json.`);
    return;
  }
  if (sub === "reset") {
    if (!key) { console.error("usage: model reset --repo <path>"); process.exit(1); }
    if (cfg.projects?.[key]) delete cfg.projects[key].model;
    writeFileSync(file, JSON.stringify(cfg, null, 2));
    console.log(`${key}: model reset to the platform's model.`);
    return;
  }
  console.error("usage: model show | set <name> --repo <path> | reset --repo <path>");
  process.exit(1);
}

async function branchCommand(a: string[]) {
  const { branchName, DEFAULT_BRANCH_PATTERN } = await import("./common/config.js");
  const file = join(dataDir(), "config.json");
  const cfg = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : { default_platform: "claude", platforms: {} };
  const [sub, ...rest] = a;
  const ri = rest.indexOf("--repo");
  const repoArg = ri >= 0 ? rest[ri + 1] : undefined;
  if (ri >= 0 && !repoArg) { console.error("--repo needs a path"); process.exit(1); }
  const positional = rest.filter((_, i) => i !== ri && i !== ri + 1 || ri < 0);
  const repoKey = repoArg ? fwd(resolve(repoArg)) : undefined;
  const sample = (root: string, pattern: string) => {
    const jira = branchName({ task_id: "task_ab12cd34", project_root: root, linked_refs: { jira_key: "PROJ-123" } }, pattern);
    const adhoc = branchName({ task_id: "task_ab12cd34", project_root: root }, pattern);
    return `${jira}   (no Jira key: ${adhoc})`;
  };
  if (sub === "show") {
    const global = cfg.branch_pattern ?? DEFAULT_BRANCH_PATTERN;
    console.log(`global: ${global}${cfg.branch_pattern ? "" : "  (default)"}
  e.g. ${sample("/repo", global)}`);
    const rows = Object.entries<any>(cfg.projects ?? {}).filter(([k, v]) => v?.branch_pattern && (!repoKey || k === repoKey));
    for (const [k, v] of rows) console.log(`${k}: ${v.branch_pattern}
  e.g. ${sample(k, v.branch_pattern)}`);
    if (repoKey && !rows.length) console.log(`${repoKey}: no override, uses the global pattern`);
    return;
  }
  if (sub === "set") {
    const pattern = positional[0];
    if (!pattern) { console.error("usage: branch set <pattern> [--repo <path>]"); process.exit(1); }
    try { console.log(`e.g. ${sample(repoKey ?? "/repo", pattern)}`); } catch (e: any) { console.error(`error: ${e.message}`); process.exit(1); }
    if (repoKey) { cfg.projects = cfg.projects ?? {}; cfg.projects[repoKey] = { ...(cfg.projects[repoKey] ?? {}), branch_pattern: pattern }; }
    else cfg.branch_pattern = pattern;
    writeFileSync(file, JSON.stringify(cfg, null, 2));
    console.log(`${repoKey ?? "global"} branch pattern set to ${pattern}. Reload your tool so the servers reread config.json.`);
    return;
  }
  if (sub === "reset") {
    if (repoKey) { if (cfg.projects?.[repoKey]) delete cfg.projects[repoKey].branch_pattern; } else delete cfg.branch_pattern;
    writeFileSync(file, JSON.stringify(cfg, null, 2));
    console.log(`${repoKey ?? "global"} branch pattern reset.`);
    return;
  }
  console.error("usage: branch show | set <pattern> | reset  [--repo <path>]");
  process.exit(1);
}

async function tasksCommand(a: string[]) {
  const { Workflow } = await import("./workflow-state/service.js");
  const wf = new Workflow();
  const [sub, ref, ...rest] = a;
  if (sub === "list") {
    const rows = wf.db.prepare("SELECT task_id, stage, title, project_root, needs_attention, dispatch_status FROM tasks ORDER BY created_at DESC LIMIT 30").all() as any[];
    for (const r of rows) console.log(`${r.task_id}  ${r.stage.padEnd(15)} ${r.needs_attention ? "[attention] " : ""}${r.dispatch_status === "in-flight" ? "[running] " : ""}${r.title}  (${r.project_root})`);
    if (!rows.length) console.log("(no tasks)");
  } else if (sub === "show" && ref) {
    const t = wf.findTask(ref);
    console.log(`${t.task_id}  ${t.title}\nstage: ${t.stage}  branch: ${t.branch}  flags: ${JSON.stringify(t.flags)}\nrefs: ${JSON.stringify(t.linked_refs)}  dispatch: ${t.dispatch_status ?? "-"}`);
    console.log("\nhistory:");
    for (const h of t.history as any[]) console.log(`  ${h.created_at}  ${h.from_stage ?? "-"} -> ${h.to_stage}  (${h.reason})`);
    const si = rest.indexOf("--stage");
    const want = si >= 0 ? rest[si + 1] : undefined;
    for (const art of t.artifacts as any[]) {
      if (want && art.stage !== want) continue;
      const x: any = wf.getArtifact(t.task_id, art.stage);
      console.log(`\n=== ${art.stage} v${x.version}  skill=${x.skill_version ?? "-"}  platform=${x.platform ?? "-"}  built from=${JSON.stringify(x.input_refs)} ===\n${x.content}`);
    }
    const ec = wf.db.prepare("SELECT description, decision FROM edge_cases WHERE task_id=?").all(t.task_id) as any[];
    if (ec.length) console.log("\nedge cases:\n" + ec.map((e) => `  - ${e.description} -> ${e.decision}`).join("\n"));
  } else if (sub === "remove" && ref) {
    const t = wf.findTask(ref);
    if (!rest.includes("--yes")) { console.log(`would permanently remove ${t.task_id} "${t.title}" and its artifacts; re-run with --yes to confirm`); return; }
    console.log(JSON.stringify(wf.deleteTask(t.task_id, rest.includes("--with-children")), null, 2));
  } else console.error("usage: tasks list | tasks show <task_id|jira-key|pr#> [--stage requirement|design|plan] | tasks remove <ref> --yes [--with-children]");
}
