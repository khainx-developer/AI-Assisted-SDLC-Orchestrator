/** Worker-session tools: start analysis, review, test-authoring and coding sessions, run tests, poll and cancel dispatches, usage. */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { loadConfig, projectConfig, repoSettings, repoInstructionsMax } from "../../config/config.js";
import { frozenFilesFrom } from "../../stores/dispatch-store.js";
import { budgetStatus } from "../../stores/budget.js";
import { usageSummary } from "../../stores/usage.js";
import { learningsText } from "../../stores/learnings.js";
import { projectRepos, requireGitRepo } from "../../dispatch/target.js";
import { branchDiff, chooseReviewer, reviewInstructions } from "../../dispatch/review.js";
import { analysisPrompt, codingPrompt, testAuthoringPrompt, loadSkill, bundledSkillsDir } from "../../dispatch/prompt.js";
import { repoInstructionsText } from "../../dispatch/repo-instructions.js";
import { prepareWorkDir, existingWorktree, removeWorktree } from "../../dispatch/checkout.js";
import { startAgentDispatch, startTestDispatch, getDispatch, cancelDispatch, detectTestCommand } from "../../dispatch/runner.js";
import { run, pickPlatform, knowledgeFor, overrideBudgetArg, baseArg, platformArg } from "./shared.js";

export function registerSessionTools(server: McpServer): void {
  server.tool(
    "dispatch_analysis_task",
    "Start a READ-ONLY session on the chosen AI platform running a stage skill (requirement-analysis, task-breakdown, design-analysis, plan-creation). Knowledge pages: when the user names a folder or module, dispatch a worker with skill module-analysis (or conventions, domain-rules, decision-mining), task_id and stage \"knowledge\", and the folder in instructions; never survey the repository on your own initiative. Returns a dispatch_id immediately; poll get_dispatch_result. The result's `artifact` field is the clean stage document; store it with record_stage_artifact(dispatch_id=...) rather than copying the text (skill_version and platform are recorded from the dispatch).",
    {
      task_id: z.string(), project_root: z.string(), stage: z.string(), skill: z.string(), instructions: z.string(),
      additional_read_roots: z.array(z.string()).optional(), platform: platformArg, override_budget: overrideBudgetArg, model: z.string().optional().describe("one-off override of projects.<root>.model and platforms.<id>.model"),
    },
    (a) => run(async () => {
      const cfg = loadConfig();
      const skill = loadSkill(a.skill, cfg.skills_dir ?? bundledSkillsDir);
      const roots = a.additional_read_roots ?? [];
      const kn = knowledgeFor(a.project_root);
      const repos = projectRepos(a.project_root); // a workspace's analysis runs at its root and may read every child
      const platformId = pickPlatform("analysis", a.project_root, a.platform ?? undefined);
      const m = await startAgentDispatch({
        kind: "analysis", overrideBudget: a.override_budget, task_id: a.task_id, platformId, skill_version: skill.version, repos,
        req: { projectRoot: a.project_root, extraReadRoots: [...roots, ...kn.roots], model: a.model ?? projectConfig(a.project_root)?.model, prompt: analysisPrompt({ skill: a.skill, skillBody: skill.body, instructions: a.instructions, projectRoot: a.project_root, readRoots: roots, learnings: learningsText(a.project_root), knowledge: kn.text, repoInstructions: repoInstructionsText(a.project_root, repoInstructionsMax(a.project_root), repos, platformId) }) },
      });
      return { dispatch_id: m.dispatch_id, platform: m.platform, skill_version: skill.version, status: m.status };
    })
  );
  
  server.tool(
    "dispatch_review_task",
    "Independent AI code review of a finished task branch: a READ-ONLY session, on a different platform or model than the one that wrote the code where possible, reads the diff against the base branch and judges it against the requirement and plan. Offer it as a numbered option after tests pass (it costs one session); never run it silently. Returns a dispatch_id immediately; poll get_dispatch_result. The `artifact` of the result is the review (Verdict approve | changes-requested, numbered Findings with severity and evidence, Plan compliance, Tests): show it to the human, do NOT record it as a stage document and do NOT act on it yourself. This call reports whether the reviewer is `independent` of the coder and why; if it is not, tell the human. A changes-requested verdict is advice: the human decides whether to send the task back to implementation.",
    {
      task_id: z.string(), project_root: z.string(), branch: z.string().describe("use `branch` from get_task_state"),
      base_branch: z.string().optional().describe("branch the change is measured against; default main, else master"),
      context: z.string().describe("the requirement's acceptance criteria and the plan's steps and Test Plan (fetch with get_stage_artifact)"),
      additional_read_roots: z.array(z.string()).optional(), platform: platformArg, override_budget: overrideBudgetArg,
      model: z.string().optional().describe("a model different from the coder's also counts as independent when the platform is the same"),
    },
    (a) => run(async () => {
      requireGitRepo(a.project_root);
      const cfg = loadConfig();
      const skill = loadSkill("code-review", cfg.skills_dir ?? bundledSkillsDir);
      const diff = await branchDiff(a.project_root, a.branch, a.base_branch);
      const choice = chooseReviewer({ taskId: a.task_id, projectRoot: a.project_root, explicit: a.platform ?? undefined, model: a.model, fallback: pickPlatform("analysis", a.project_root) });
      const roots = a.additional_read_roots ?? [];
      const kn = knowledgeFor(a.project_root);
      const repos = projectRepos(a.project_root);
      // the repo-wide model belongs to the platform that usually works on it; on another platform it may not exist, so only an explicit model is passed there
      const model = a.model ?? (choice.platform === choice.coded_by?.platform ? projectConfig(a.project_root)?.model : undefined);
      const m = await startAgentDispatch({
        kind: "analysis", overrideBudget: a.override_budget, task_id: a.task_id, platformId: choice.platform, skill_version: skill.version, repos,
        req: { projectRoot: a.project_root, extraReadRoots: [...roots, ...kn.roots], model, prompt: analysisPrompt({ skill: "code-review", skillBody: skill.body, instructions: reviewInstructions({ context: a.context, branch: a.branch, diff }), projectRoot: a.project_root, readRoots: roots, learnings: learningsText(a.project_root), knowledge: kn.text, repoInstructions: repoInstructionsText(a.project_root, repoInstructionsMax(a.project_root), repos, choice.platform) }) },
      });
      return {
        dispatch_id: m.dispatch_id, platform: m.platform, skill_version: skill.version, status: m.status,
        independent: choice.independent, independence: choice.reason, coded_by: choice.coded_by,
        base: diff.base, files_in_diff: diff.files.length, diff_truncated: diff.truncated, files_not_shown: diff.omitted,
      };
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
      base_branch: baseArg,
      test_paths: z.array(z.string()).optional().describe("where tests belong (files, dirs or globs). Files written elsewhere are reported as scope_violation; those inside become the frozen set"),
      additional_read_roots: z.array(z.string()).optional(), platform: platformArg, override_budget: overrideBudgetArg, model: z.string().optional().describe("a smaller model is usually enough for this step"),
    },
    (a) => run(async () => {
      if (/^(main|master)$/.test(a.branch)) throw new Error("refusing to dispatch work onto main/master");
      requireGitRepo(a.project_root);
      const workDir = await prepareWorkDir(a.project_root, a.branch, a.task_id, a.base_branch);
      const roots = a.additional_read_roots ?? [];
      const kn = knowledgeFor(a.project_root);
      const m = await startAgentDispatch({
        workDir: workDir === a.project_root ? undefined : workDir, kind: "test-authoring", overrideBudget: a.override_budget, task_id: a.task_id, platformId: pickPlatform("coding", a.project_root, a.platform ?? undefined), branch: a.branch, testPaths: a.test_paths,
        req: { projectRoot: a.project_root, extraReadRoots: [...roots, ...kn.roots], model: a.model ?? projectConfig(a.project_root)?.model, prompt: testAuthoringPrompt({ instructions: a.instructions, projectRoot: workDir, branch: a.branch, readRoots: roots, testPaths: a.test_paths, learnings: learningsText(a.project_root), knowledge: kn.text }) },
      });
      return { dispatch_id: m.dispatch_id, platform: m.platform, branch: a.branch, status: m.status, worktree: m.worktree };
    })
  );
  
  server.tool(
    "dispatch_coding_task",
    "Start a read+write coding session on the chosen AI platform, on the task's branch (created if missing; never main). The session follows the repo's own agent/skill conventions. `target_files` is the plan's allowed scope: files this session touches outside it come back as scope_violation (a warning unless the repo's scope_check is fail). Pass frozen_from_dispatch after a test-authoring step: those tests are frozen and editing one fails the dispatch (frozen_test_violation). If the session finds the plan itself is wrong it returns spec_wrong + spec_issue: hand that to report_spec_wrong (workflow-state), do not retry. Returns a dispatch_id immediately; poll get_dispatch_result.",
    {
      task_id: z.string(), project_root: z.string(), stage: z.string(), branch: z.string().describe("use `branch` from get_task_state (named by branch_pattern in config.json, default story/{key}); if get_task_state shows branch_error, report it instead of dispatching"),
      instructions: z.string(), target_files: z.array(z.string()).optional().describe("the plan's 'Files touched': files, directories or globs this session may change"),
      additional_read_roots: z.array(z.string()).optional(),
      base_branch: baseArg,
      frozen_from_dispatch: z.string().optional().describe("dispatch_id of a completed dispatch_test_authoring_task of this task; its test files are frozen"),
      platform: platformArg, override_budget: overrideBudgetArg, model: z.string().optional(),
    },
    (a) => run(async () => {
      if (/^(main|master)$/.test(a.branch)) throw new Error("refusing to dispatch coding work onto main/master");
      requireGitRepo(a.project_root);
      const frozenFiles = a.frozen_from_dispatch ? frozenFilesFrom(a.task_id, a.frozen_from_dispatch) : undefined;
      const workDir = await prepareWorkDir(a.project_root, a.branch, a.task_id, a.base_branch);
      const roots = a.additional_read_roots ?? [];
      const kn = knowledgeFor(a.project_root, a.target_files ?? []);
      const m = await startAgentDispatch({
        workDir: workDir === a.project_root ? undefined : workDir, kind: "coding", overrideBudget: a.override_budget, task_id: a.task_id, platformId: pickPlatform("coding", a.project_root, a.platform ?? undefined), branch: a.branch, targetFiles: a.target_files, frozenFiles,
        req: { projectRoot: a.project_root, extraReadRoots: [...roots, ...kn.roots], model: a.model ?? projectConfig(a.project_root)?.model, prompt: codingPrompt({ instructions: a.instructions, projectRoot: workDir, branch: a.branch, readRoots: roots, targetFiles: a.target_files, frozenFiles, learnings: learningsText(a.project_root), knowledge: kn.text }) },
      });
      return { dispatch_id: m.dispatch_id, platform: m.platform, branch: a.branch, status: m.status, worktree: m.worktree, frozen_files: frozenFiles ?? [] };
    })
  );
  
  server.tool(
    "run_tests", "Run the repo's test command (config.json projects.<root>.test_command, else auto-detected). Returns a dispatch_id; result has passed + output tail + duration_ms. With expect_fail=true (after a test-authoring step) the result also has `verdict`: red = the tests ran and failed (what you want before the code exists), vacuous = they passed so they check nothing new, broken = the suite could not run (import/compile error, nothing collected). Heuristic on the output: show it to the human, do not decide alone.",
    { task_id: z.string(), project_root: z.string(), expect_fail: z.boolean().optional() },
    (a) => run(() => {
      requireGitRepo(a.project_root);
      const cmd = detectTestCommand(a.project_root);
      if (!cmd) throw new Error(`no test command detected for ${a.project_root}; set projects."<root>".test_command in config.json`);
      const m = startTestDispatch(a.task_id, a.project_root, cmd, a.expect_fail ?? false, existingWorktree(a.project_root, a.task_id));
      return { dispatch_id: m.dispatch_id, command: cmd, status: m.status };
    })
  );
  
  server.tool(
    "get_dispatch_result", "Status and outcome of a dispatch. Pass wait_seconds (max 55) to block until it finishes instead of returning immediately; use it when polling. status in-flight | completed | failed. Coding results include files_changed (everything dirty) and files_touched (what this session changed), success, needs_clarification/question, pr_number, spec_wrong/spec_issue, scope_violation and frozen_test_violation; test-authoring results include frozen_files; analysis results include `artifact` (the clean stage document) and read_only_violation if the session touched files. To keep your context small the raw `output` is left out when an artifact was extracted; pass include_raw=true to get it. To store the artifact, call record_stage_artifact with this dispatch_id; do not copy the text. If `budget_warning` is present the task is at or over its spending limit: tell the human and ask before dispatching more. If `secrets_in_output` or `secrets_in_files` is present, a secret-looking string (kind, count, never the value) appeared in what the session printed or in a file it wrote: tell the human before anything is committed, pushed or recorded, and name the files; it may be a fake test value, so say it is a warning, not proof. If `restrictions` is present, `applied` lists the secret-file, command and sandbox rules the platform enforced for the session and `not_enforced` what it could not (tell the human about anything under `not_enforced`). If `redacted` is present, secret-looking strings (kind -> count) were removed from the prompt before it was sent: tell the human, and suggest keeping secrets out of tickets and repo files.",
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
    "remove_worktree", "Delete a task's git worktree (only exists when projects.<root>.worktree is true). By default the branch and its commits stay; with delete_branch=true the task branch is deleted too (refused if it is not merged unless force=true). Use delete_branch=true when the human says to close the task with its worktree: transition the task to done first, then call this. Refuses while a session runs in it or when it has uncommitted work; pass force=true only if the human agreed to discard that work. Offer it once the task is merged or abandoned; do not call it unprompted.",
    { task_id: z.string(), project_root: z.string(), force: z.boolean().optional(), delete_branch: z.boolean().optional(), branch: z.string().optional().describe("branch to delete when the worktree is already gone; defaults to the worktree's branch") },
    (a) => run(() => removeWorktree(a.project_root, a.task_id, a.force ?? false, a.delete_branch ?? false, a.branch))
  );
  
  server.tool(
    "get_usage", "Token use (and cost where the AI CLI reports it) of finished dispatches, in total and by kind, platform and task. Pass task_id for one task. Tokens marked `reported` are exact; `estimated` ones are a lower bound (prompt sent plus text printed). Use when the human asks what a task or stage cost. With task_id and project_root the answer also shows the task against its budget, if one is configured.",
    { task_id: z.string().optional(), project_root: z.string().optional(), days: z.number().int().min(1).optional().describe("only dispatches finished in the last N days") },
    (a) => run(() => ({ ...usageSummary({ taskId: a.task_id, days: a.days }), budget: a.task_id && a.project_root ? budgetStatus(a.task_id, a.project_root) : undefined }))
  );
}
