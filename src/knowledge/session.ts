import { analysisPrompt, loadSkill } from "../dispatch/prompt.js";
import { startAgentDispatch, getDispatch } from "../dispatch/runner.js";
import { loadConfig, projectConfig } from "../common/config.js";
import { learningsText } from "../common/learnings.js";
import { repoInstructionsText } from "../dispatch/repo-instructions.js";
import { projectRepos } from "../common/target.js";
import type { Session } from "./run.js";

/** A read-only analysis session through the normal dispatch path (restrictions, redaction, read-only guard apply). */
export function dispatchSession(repo: string, taskId = "knowledge"): Session {
  return async ({ skill: name, instructions, platform, readRoots }) => {
    const skill = loadSkill(name);
    const cfg = loadConfig();
    const proj = projectConfig(repo);
    const writer = proj?.analysis_platform ?? proj?.platform ?? cfg.analysis_platform ?? cfg.default_platform;
    const chosen = name === "claim-verification" ? (platform ?? proj?.review_platform ?? cfg.review_platform ?? writer) : writer;
    const repos = projectRepos(repo);
    const started = await startAgentDispatch({
      kind: "analysis", task_id: `${taskId}-${name}`, platformId: chosen, skill_version: skill.version, repos,
      req: { projectRoot: repo, extraReadRoots: readRoots, model: proj?.model,
        prompt: analysisPrompt({ skill: name, skillBody: skill.body, instructions, projectRoot: repo, readRoots, learnings: learningsText(repo), repoInstructions: repoInstructionsText(repo, undefined, repos) }) },
    });
    let m = getDispatch(started.dispatch_id);
    while (m.status === "in-flight") { await new Promise((r) => setTimeout(r, 4000)); m = getDispatch(started.dispatch_id); }
    return {
      artifact: m.artifact ?? "", platform: chosen ?? "default", skill_version: skill.version, duration_ms: m.duration_ms,
      input_tokens: m.usage?.input_tokens, output_tokens: m.usage?.output_tokens,
      error: m.status === "completed" ? (m.read_only_violation ? `read-only violation: ${JSON.stringify(m.read_only_violation)}` : undefined) : (m.error ?? `status ${m.status}`),
    };
  };
}
