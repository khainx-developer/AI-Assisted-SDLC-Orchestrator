import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { loadConfig, projectConfig } from "../config/config.js";
import { latestDispatch } from "../stores/dispatch-store.js";

const execFileP = promisify(execFile);

/** How much of the diff goes into the prompt. Past this the rest is listed by name only, and the reviewer is told. */
export const MAX_DIFF_CHARS = 80_000;

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileP("git", args, { cwd, maxBuffer: 256 * 1024 * 1024 });
  return stdout;
}

/** The branch the change is measured against: the explicit one, else main, else master. */
export async function detectBase(root: string, explicit?: string): Promise<string> {
  const candidates = explicit ? [explicit] : ["main", "master"];
  for (const c of candidates) {
    try { await git(root, "rev-parse", "--verify", "--quiet", c); return c; } catch { /* try the next */ }
  }
  throw new Error(explicit ? `base branch '${explicit}' not found in ${root}` : `no main or master branch in ${root}; pass base_branch`);
}

export interface BranchDiff {
  base: string;
  /** `git diff --stat` of the whole change */
  stat: string;
  /** the patch, cut at MAX_DIFF_CHARS */
  patch: string;
  truncated: boolean;
  files: string[];
  /** files whose patch was cut off or left out */
  omitted: string[];
}

/** The change on `branch` since it left `base` (three-dot diff, so changes made on base afterwards are not counted). */
export async function branchDiff(root: string, branch: string, base?: string): Promise<BranchDiff> {
  const b = await detectBase(root, base);
  const range = `${b}...${branch}`;
  const [stat, names, full] = await Promise.all([git(root, "diff", "--stat", range), git(root, "diff", "--name-only", range), git(root, "diff", "--no-color", range)]);
  const files = names.split(/\r?\n/).filter(Boolean);
  if (!files.length) throw new Error(`no changes between ${b} and ${branch}: nothing to review`);
  if (full.length <= MAX_DIFF_CHARS) return { base: b, stat: stat.trim(), patch: full, truncated: false, files, omitted: [] };
  // keep whole files while they fit, so the reviewer never sees half a hunk of a file it thinks is complete
  const parts = full.split(/^(?=diff --git )/m);
  let used = 0;
  const kept: string[] = [], omitted: string[] = [];
  for (const p of parts) {
    const name = /^diff --git a\/(.+?) b\//.exec(p)?.[1] ?? "(unknown)";
    if (used + p.length <= MAX_DIFF_CHARS) { kept.push(p); used += p.length; } else omitted.push(name);
  }
  return { base: b, stat: stat.trim(), patch: kept.join(""), truncated: true, files, omitted };
}

/** The TASK INPUT for the code-review skill. */
export function reviewInstructions(a: { context: string; branch: string; diff: BranchDiff }): string {
  const d = a.diff;
  return [
    `Review the change on branch '${a.branch}' against '${d.base}'.`,
    "",
    "WHAT THE CHANGE WAS SUPPOSED TO DO (requirement and plan):",
    a.context.trim(),
    "",
    `FILES CHANGED (${d.files.length}):`,
    d.stat,
    "",
    d.truncated
      ? `THE DIFF IS TRUNCATED. These files are not shown in full or at all; you may read them in the repo, but say in your verdict that you could not review them from the diff: ${d.omitted.join(", ")}`
      : "THE FULL DIFF:",
    "```diff",
    d.patch.trimEnd(),
    "```",
  ].join("\n");
}

export interface ReviewChoice {
  platform: string;
  /** true when the reviewer differs from the coder in platform or in model, so it is not marking its own homework */
  independent: boolean;
  reason: string;
  coded_by: { platform: string; model?: string } | null;
}

/**
 * Which platform reviews. Precedence: the platform named on the call, the repo's `review_platform`, the global
 * `review_platform`, then any configured platform other than the one that wrote the code, then the analysis platform.
 * `independent` says whether the result differs from the coder in platform or model.
 */
export function chooseReviewer(a: { taskId: string; projectRoot: string; explicit?: string; model?: string; fallback: string }): ReviewChoice {
  const cfg = loadConfig();
  const coded = latestDispatch(a.taskId, "coding");
  const coded_by = coded ? { platform: coded.platform, model: coded.model } : null;
  const configured = projectConfig(a.projectRoot)?.review_platform ?? cfg.review_platform;
  const others = [...new Set([cfg.default_platform, ...Object.keys(cfg.platforms)])].filter((p) => p !== coded?.platform);
  const platform = a.explicit ?? configured ?? (coded ? others[0] : undefined) ?? a.fallback;
  const via = a.explicit ? "named on the call" : configured ? "review_platform in config.json" : coded && others[0] ? "another configured platform" : "the analysis platform";
  if (!coded) return { platform, independent: false, coded_by, reason: `No finished coding dispatch is recorded for this task, so independence cannot be checked. Reviewing on ${platform} (${via}).` };
  const otherPlatform = platform !== coded.platform;
  const otherModel = !!a.model && !!coded.model && a.model !== coded.model;
  const independent = otherPlatform || otherModel;
  const why = otherPlatform ? `reviewer ${platform} differs from coder ${coded.platform} (${via})` : otherModel ? `same platform ${platform}, but model ${a.model} differs from the coder's ${coded.model}` : `the reviewer is the same platform${coded.model ? ` and model (${coded.model})` : ""} as the coder`;
  return { platform, independent, coded_by, reason: independent ? why : `NOT independent: ${why}. Set review_platform in config.json, or pass platform or model, to get a second opinion from something else.` };
}
