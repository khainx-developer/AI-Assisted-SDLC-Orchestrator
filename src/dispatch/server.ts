import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadConfig, projectConfig, repoSettings } from "../common/config.js";
import { frozenFilesFrom, pruneDispatches } from "../common/dispatch-store.js";
import { usageSummary } from "../common/usage.js";
import { projectRepos, requireGitRepo } from "../common/target.js";
import { PLATFORMS, resolvePlatform } from "./platforms.js";
import { analysisPrompt, codingPrompt, testAuthoringPrompt, loadSkill, bundledSkillsDir } from "./prompt.js";
import { learningsText } from "../common/learnings.js";
import { repoInstructionsText } from "./repo-instructions.js";
import { startAgentDispatch, startTestDispatch, getDispatch, cancelDispatch, ensureBranch, detectTestCommand } from "./runner.js";

const server = new McpServer({ name: "dispatch", version: "0.1.0" });

type Result = { content: { type: "text"; text: string }[]; isError?: boolean };
async function run(fn: () => unknown | Promise<unknown>): Promise<Result> {
  try { return { content: [{ type: "text", text: JSON.stringify(await fn(), null, 2) }] }; }
  catch (e: any) { return { content: [{ type: "text", text: e?.message ?? String(e) }], isError: true }; }
}

/** Precedence: explicit tool arg > per-project override > per-mode default > default_platform. */
function pickPlatform(mode: "analysis" | "coding", root: string, explicit?: string) {
  const cfg = loadConfig();
  const proj = projectConfig(root);
  return explicit ?? (mode === "analysis" ? proj?.analysis_platform ?? proj?.platform ?? cfg.analysis_platform : proj?.coding_platform ?? proj?.platform ?? cfg.coding_platform) ?? cfg.default_platform;
}

const platformArg = z.string().nullish().describe("AI platform for this dispatch (claude | copilot | cursor | any id declared in config.json). Omit or pass null to use configured routing.");

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
  "Start a READ-ONLY session on the chosen AI platform running a stage skill (requirement-analysis, task-breakdown, design-analysis, plan-creation). Returns a dispatch_id immediately; poll get_dispatch_result. The result's `artifact` field is the clean stage document; store it with record_stage_artifact(dispatch_id=...) rather than copying the text (skill_version and platform are recorded from the dispatch).",
  {
    task_id: z.string(), project_root: z.string(), stage: z.string(), skill: z.string(), instructions: z.string(),
    additional_read_roots: z.array(z.string()).optional(), platform: platformArg, model: z.string().optional().describe("one-off override of projects.<root>.model and platforms.<id>.model"),
  },
  (a) => run(async () => {
    const cfg = loadConfig();
    const skill = loadSkill(a.skill, cfg.skills_dir ?? bundledSkillsDir);
    const roots = a.additional_read_roots ?? [];
    const repos = projectRepos(a.project_root); // a workspace's analysis runs at its root and may read every child
    const m = await startAgentDispatch({
      kind: "analysis", task_id: a.task_id, platformId: pickPlatform("analysis", a.project_root, a.platform ?? undefined), skill_version: skill.version, repos,
      req: { projectRoot: a.project_root, extraReadRoots: roots, model: a.model ?? projectConfig(a.project_root)?.model, prompt: analysisPrompt({ skill: a.skill, skillBody: skill.body, instructions: a.instructions, projectRoot: a.project_root, readRoots: roots, learnings: learningsText(a.project_root), repoInstructions: repoInstructionsText(a.project_root, undefined, repos) }) },
    });
    return { dispatch_id: m.dispatch_id, platform: m.platform, skill_version: skill.version, status: m.status };
  })
);

server.tool(
  "get_repo_settings",
  "Per-repo switches for the write sessions: tests_first (write failing tests in a separate session and freeze them), scope_check (off | warn | fail: what happens when a coding session touches files outside the plan's scope), scope_allow (extra always-allowed paths) and the test command. Read once before the implementation stage.",
  { project_root: z.string() },
  (a) => run(() => repoSettings(a.project_root))
);

server.tool(
  "dispatch_test_authoring_task",
  "Start a read+write session that writes ONLY the failing tests for a task, from the plan's Test Plan, before any production code exists (the optional tests-first step of implementation). Same branch rules as dispatch_coding_task. When it completes, `frozen_files` lists the test files to freeze; then run_tests with expect_fail=true and check `verdict` is red, and pass this dispatch_id as frozen_from_dispatch to dispatch_coding_task. Returns a dispatch_id immediately; poll get_dispatch_result.",
  {
    task_id: z.string(), project_root: z.string(), branch: z.string().describe("use `branch` from get_task_state"),
    instructions: z.string().describe("the plan's Test Plan and the requirement's acceptance criteria; the repo's test conventions are found by the session itself"),
    test_paths: z.array(z.string()).optional().describe("where tests belong (files, dirs or globs). Files written elsewhere are reported as scope_violation; those inside become the frozen set"),
    additional_read_roots: z.array(z.string()).optional(), platform: platformArg, model: z.string().optional().describe("a smaller model is usually enough for this step"),
  },
  (a) => run(async () => {
    if (/^(main|master)$/.test(a.branch)) throw new Error("refusing to dispatch work onto main/master");
    requireGitRepo(a.project_root);
    await ensureBranch(a.project_root, a.branch);
    const roots = a.additional_read_roots ?? [];
    const m = await startAgentDispatch({
      kind: "test-authoring", task_id: a.task_id, platformId: pickPlatform("coding", a.project_root, a.platform ?? undefined), branch: a.branch, testPaths: a.test_paths,
      req: { projectRoot: a.project_root, extraReadRoots: roots, model: a.model ?? projectConfig(a.project_root)?.model, prompt: testAuthoringPrompt({ instructions: a.instructions, projectRoot: a.project_root, branch: a.branch, readRoots: roots, testPaths: a.test_paths, learnings: learningsText(a.project_root) }) },
    });
    return { dispatch_id: m.dispatch_id, platform: m.platform, branch: a.branch, status: m.status };
  })
);

server.tool(
  "dispatch_coding_task",
  "Start a read+write coding session on the chosen AI platform, on the task's branch (created if missing; never main). The session follows the repo's own agent/skill conventions. `target_files` is the plan's allowed scope: files this session touches outside it come back as scope_violation (a warning unless the repo's scope_check is fail). Pass frozen_from_dispatch after a test-authoring step: those tests are frozen and editing one fails the dispatch (frozen_test_violation). If the session finds the plan itself is wrong it returns spec_wrong + spec_issue: hand that to report_spec_wrong (workflow-state), do not retry. Returns a dispatch_id immediately; poll get_dispatch_result.",
  {
    task_id: z.string(), project_root: z.string(), stage: z.string(), branch: z.string().describe("use `branch` from get_task_state (named by branch_pattern in config.json, default story/{key}); if get_task_state shows branch_error, report it instead of dispatching"),
    instructions: z.string(), target_files: z.array(z.string()).optional().describe("the plan's 'Files touched': files, directories or globs this session may change"),
    additional_read_roots: z.array(z.string()).optional(),
    frozen_from_dispatch: z.string().optional().describe("dispatch_id of a completed dispatch_test_authoring_task of this task; its test files are frozen"),
    platform: platformArg, model: z.string().optional(),
  },
  (a) => run(async () => {
    if (/^(main|master)$/.test(a.branch)) throw new Error("refusing to dispatch coding work onto main/master");
    requireGitRepo(a.project_root);
    const frozenFiles = a.frozen_from_dispatch ? frozenFilesFrom(a.task_id, a.frozen_from_dispatch) : undefined;
    await ensureBranch(a.project_root, a.branch);
    const roots = a.additional_read_roots ?? [];
    const m = await startAgentDispatch({
      kind: "coding", task_id: a.task_id, platformId: pickPlatform("coding", a.project_root, a.platform ?? undefined), branch: a.branch, targetFiles: a.target_files, frozenFiles,
      req: { projectRoot: a.project_root, extraReadRoots: roots, model: a.model ?? projectConfig(a.project_root)?.model, prompt: codingPrompt({ instructions: a.instructions, projectRoot: a.project_root, branch: a.branch, readRoots: roots, targetFiles: a.target_files, frozenFiles, learnings: learningsText(a.project_root) }) },
    });
    return { dispatch_id: m.dispatch_id, platform: m.platform, branch: a.branch, status: m.status, frozen_files: frozenFiles ?? [] };
  })
);

server.tool(
  "run_tests", "Run the repo's test command (config.json projects.<root>.test_command, else auto-detected). Returns a dispatch_id; result has passed + output tail + duration_ms. With expect_fail=true (after a test-authoring step) the result also has `verdict`: red = the tests ran and failed (what you want before the code exists), vacuous = they passed so they check nothing new, broken = the suite could not run (import/compile error, nothing collected). Heuristic on the output: show it to the human, do not decide alone.",
  { task_id: z.string(), project_root: z.string(), expect_fail: z.boolean().optional() },
  (a) => run(() => {
    requireGitRepo(a.project_root);
    const cmd = detectTestCommand(a.project_root);
    if (!cmd) throw new Error(`no test command detected for ${a.project_root}; set projects."<root>".test_command in config.json`);
    const m = startTestDispatch(a.task_id, a.project_root, cmd, a.expect_fail ?? false);
    return { dispatch_id: m.dispatch_id, command: cmd, status: m.status };
  })
);

server.tool(
  "get_dispatch_result", "Status and outcome of a dispatch. Pass wait_seconds (max 55) to block until it finishes instead of returning immediately; use it when polling. status in-flight | completed | failed. Coding results include files_changed (everything dirty) and files_touched (what this session changed), success, needs_clarification/question, pr_number, spec_wrong/spec_issue, scope_violation and frozen_test_violation; test-authoring results include frozen_files; analysis results include `artifact` (the clean stage document) and read_only_violation if the session touched files. To keep your context small the raw `output` is left out when an artifact was extracted; pass include_raw=true to get it. To store the artifact, call record_stage_artifact with this dispatch_id; do not copy the text. If `redacted` is present, secret-looking strings (kind -> count) were removed from the prompt before it was sent: tell the human, and suggest keeping secrets out of tickets and repo files.",
  { dispatch_id: z.string(), include_raw: z.boolean().optional(), wait_seconds: z.number().int().min(0).max(55).optional() },
  (a) => run(async () => {
    // Long-poll: hold the call until the dispatch finishes (or the wait elapses) so the agent does not burn its checks in a few seconds
    const until = Date.now() + (a.wait_seconds ?? 0) * 1000;
    while (getDispatch(a.dispatch_id).status === "in-flight" && Date.now() < until) await new Promise((r) => setTimeout(r, 2000));
    const { output, ...rest } = getDispatch(a.dispatch_id);
    return a.include_raw || !rest.artifact ? { ...rest, output } : rest;
  })
);

server.tool(
  "cancel_dispatch", "Stop an in-flight dispatch (kills the AI CLI and its child processes) and record it as failed with the given reason, so the stage can be retried. Use when a dispatch looks stalled and the human chose to cancel; never cancel on your own.",
  { dispatch_id: z.string(), reason: z.string().optional() },
  (a) => run(() => cancelDispatch(a.dispatch_id, a.reason))
);

server.tool(
  "get_usage", "Token use (and cost where the AI CLI reports it) of finished dispatches, in total and by kind, platform and task. Pass task_id for one task. Tokens marked `reported` are exact; `estimated` ones are a lower bound (prompt sent plus text printed). Use when the human asks what a task or stage cost.",
  { task_id: z.string().optional(), days: z.number().int().min(1).optional().describe("only dispatches finished in the last N days") },
  (a) => run(() => usageSummary({ taskId: a.task_id, days: a.days }))
);

// housekeeping: drop old finished dispatch folders at startup (never in-flight ones)
try { const d = loadConfig().dispatch_retention_days ?? 14; if (d > 0) pruneDispatches(d); } catch { /* housekeeping must not block startup */ }

// resolvePlatform is re-exported for tests/tools that want to validate config up front
export { resolvePlatform };
await server.connect(new StdioServerTransport());
