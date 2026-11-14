import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadConfig } from "../common/config.js";
import { PLATFORMS, resolvePlatform } from "./platforms.js";
import { analysisPrompt, codingPrompt, loadSkill, bundledSkillsDir } from "./prompt.js";
import { startAgentDispatch, startTestDispatch, getDispatch, ensureBranch, detectTestCommand } from "./runner.js";

const server = new McpServer({ name: "dispatch", version: "0.1.0" });

type Result = { content: { type: "text"; text: string }[]; isError?: boolean };
async function run(fn: () => unknown | Promise<unknown>): Promise<Result> {
  try { return { content: [{ type: "text", text: JSON.stringify(await fn(), null, 2) }] }; }
  catch (e: any) { return { content: [{ type: "text", text: e?.message ?? String(e) }], isError: true }; }
}

/** Precedence: explicit tool arg > per-project override > per-mode default > default_platform. */
function pickPlatform(mode: "analysis" | "coding", root: string, explicit?: string) {
  const cfg = loadConfig();
  const proj = cfg.projects?.[root];
  return explicit ?? (mode === "analysis" ? proj?.analysis_platform ?? proj?.platform ?? cfg.analysis_platform : proj?.coding_platform ?? proj?.platform ?? cfg.coding_platform) ?? cfg.default_platform;
}

const platformArg = z.string().optional().describe("AI platform for this dispatch (claude | copilot | cursor | any id declared in config.json). Omit to use configured routing.");

server.tool(
  "list_projects", "Repos registered in the global config (sdlc-orchestrator repos / install --repo), with per-repo overrides. Use to let the user pick a repo.", {},
  () => run(() => Object.entries(loadConfig().projects ?? {}).map(([root, o]) => ({ project_root: root, name: root.split(/[\/]/).filter(Boolean).pop(), ...o })))
);

server.tool(
  "list_platforms", "AI platforms available for dispatch and which is configured for analysis/coding.", {},
  () => run(() => {
    const cfg = loadConfig();
    return {
      default_platform: cfg.default_platform, analysis_platform: cfg.analysis_platform ?? null, coding_platform: cfg.coding_platform ?? null,
      built_in: Object.values(PLATFORMS).filter((p) => p.id !== "generic").map((p) => ({ id: p.id, label: p.label, command: p.command, enforces_read_only: p.enforcesReadOnly })),
      custom: Object.keys(cfg.platforms).filter((k) => !PLATFORMS[k]),
    };
  })
);

server.tool(
  "dispatch_analysis_task",
  "Start a READ-ONLY session on the chosen AI platform running a stage skill (requirement-analysis, task-breakdown, design-analysis, plan-creation). Returns a dispatch_id immediately; poll get_dispatch_result. The result's `artifact` field is the clean stage artifact (store that, not `output`); pass skill_version and platform through to record_stage_artifact.",
  {
    task_id: z.string(), project_root: z.string(), stage: z.string(), skill: z.string(), instructions: z.string(),
    additional_read_roots: z.array(z.string()).optional(), platform: platformArg, model: z.string().optional(),
  },
  (a) => run(async () => {
    const cfg = loadConfig();
    const skill = loadSkill(a.skill, cfg.skills_dir ?? bundledSkillsDir);
    const roots = a.additional_read_roots ?? [];
    const m = await startAgentDispatch({
      kind: "analysis", task_id: a.task_id, platformId: pickPlatform("analysis", a.project_root, a.platform), skill_version: skill.version,
      req: { projectRoot: a.project_root, extraReadRoots: roots, model: a.model, prompt: analysisPrompt({ skill: a.skill, skillBody: skill.body, instructions: a.instructions, projectRoot: a.project_root, readRoots: roots }) },
    });
    return { dispatch_id: m.dispatch_id, platform: m.platform, skill_version: skill.version, status: m.status };
  })
);

server.tool(
  "dispatch_coding_task",
  "Start a read+write coding session on the chosen AI platform, on the task's branch (created if missing; never main). The session follows the repo's own agent/skill conventions. Returns a dispatch_id immediately; poll get_dispatch_result.",
  {
    task_id: z.string(), project_root: z.string(), stage: z.string(), branch: z.string().describe("use `branch` from get_task_state"),
    instructions: z.string(), target_files: z.array(z.string()).optional(), additional_read_roots: z.array(z.string()).optional(),
    platform: platformArg, model: z.string().optional(),
  },
  (a) => run(async () => {
    if (/^(main|master)$/.test(a.branch)) throw new Error("refusing to dispatch coding work onto main/master");
    await ensureBranch(a.project_root, a.branch);
    const roots = a.additional_read_roots ?? [];
    const m = await startAgentDispatch({
      kind: "coding", task_id: a.task_id, platformId: pickPlatform("coding", a.project_root, a.platform), branch: a.branch,
      req: { projectRoot: a.project_root, extraReadRoots: roots, model: a.model, prompt: codingPrompt({ instructions: a.instructions, projectRoot: a.project_root, branch: a.branch, readRoots: roots, targetFiles: a.target_files }) },
    });
    return { dispatch_id: m.dispatch_id, platform: m.platform, branch: a.branch, status: m.status };
  })
);

server.tool(
  "run_tests", "Run the repo's test command (config.json projects.<root>.test_command, else auto-detected). Returns a dispatch_id; result has passed + output tail.",
  { task_id: z.string(), project_root: z.string() },
  (a) => run(() => {
    const cmd = detectTestCommand(a.project_root);
    if (!cmd) throw new Error(`no test command detected for ${a.project_root}; set projects."<root>".test_command in config.json`);
    const m = startTestDispatch(a.task_id, a.project_root, cmd);
    return { dispatch_id: m.dispatch_id, command: cmd, status: m.status };
  })
);

server.tool(
  "get_dispatch_result", "Status and outcome of a dispatch. status in-flight | completed | failed. Coding results include files_changed, success, needs_clarification/question, pr_number; analysis results include output and read_only_violation if the session touched files.",
  { dispatch_id: z.string() },
  (a) => run(() => getDispatch(a.dispatch_id))
);

// resolvePlatform is re-exported for tests/tools that want to validate config up front
export { resolvePlatform };
await server.connect(new StdioServerTransport());
