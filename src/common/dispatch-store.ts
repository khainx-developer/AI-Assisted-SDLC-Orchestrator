import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { dataDir } from "./paths.js";

export const dispatchDir = (id: string) => join(dataDir(), "dispatches", id);
export const metaFile = (id: string) => join(dispatchDir(id), "meta.json");

export interface DispatchUsage {
  /** reported: from the AI CLI itself. estimated: prompt size + printed text only, a lower bound (see common/usage.ts) */
  source: "reported" | "estimated";
  input_tokens: number;
  output_tokens: number;
  /** only when the CLI reports it */
  cost_usd?: number;
}

export interface DispatchMeta {
  dispatch_id: string;
  kind: "analysis" | "coding" | "test-authoring" | "test";
  task_id: string;
  platform: string;
  /** the model the session was asked to use (the per-dispatch, repo or platform setting); absent when the CLI picked its own default */
  model?: string;
  project_root: string;
  status: "in-flight" | "completed" | "failed";
  pid?: number;
  started_at: string;
  finished_at?: string;
  /** last time the session wrote anything to stdout/stderr (updated at most every 10s) and how much it has written; a liveness signal for in-flight dispatches */
  last_activity_at?: string;
  output_bytes?: number;
  /** the last ~500 characters the session printed, refreshed with last_activity_at; empty for CLIs that only print at the end */
  progress_tail?: string;
  /** wall-clock time of the session; lets you see whether analysis sessions spend their time locating code (docs/architecture.md, decisions) */
  duration_ms?: number;
  skill_version?: string;
  branch?: string;
  // outcome
  output?: string;
  /** analysis only: the cleaned stage artifact (use this, not output) */
  artifact?: string;
  exit_code?: number | null;
  error?: string;
  stderr_tail?: string;
  files_changed?: string[];
  read_only_violation?: string[];
  success?: boolean;
  needs_clarification?: boolean;
  question?: string | null;
  pr_number?: number | null;
  summary?: string;
  passed?: boolean;
  /** size of the prompt sent, a rough cost signal next to duration_ms */
  prompt_chars?: number;
  /** secret-looking strings removed from the prompt before it was sent: kind -> count (never the values) */
  redacted?: Record<string, number>;
  /** secret-looking strings in what the session printed (kind -> count). A warning: the text is stored as printed */
  secrets_in_output?: Record<string, number>;
  /** coding: secret-looking strings in the files the session wrote or changed (path -> kind -> count). A warning, never a block */
  secrets_in_files?: Record<string, Record<string, number>>;
  /** what the platform adapter enforced for this session (secret-file and command denials, sandbox) and what it could not */
  restrictions?: { applied: string[]; not_enforced: string[] };
  /** token use (and cost where the CLI reports it); set when the session ends */
  usage?: DispatchUsage;
  /** set when this dispatch left its task at or over the configured budget */
  budget_warning?: string;
  /** write sessions: files whose content this session changed (files_changed is everything dirty afterwards) */
  files_touched?: string[];
  /** coding: this session says the plan/design/requirement is wrong; hand to report_spec_wrong */
  spec_wrong?: boolean;
  spec_issue?: string | null;
  /** coding / test-authoring: files this session touched outside the declared scope, and the mode that applied */
  scope_violation?: string[];
  scope_check?: "warn" | "fail";
  /** test-authoring: the test files to freeze; coding: the frozen files it was told not to edit */
  frozen_files?: string[];
  /** coding: frozen files it edited or deleted anyway (fails the dispatch); originals are copied to frozen_backup */
  frozen_test_violation?: string[];
  frozen_backup?: string;
  /** test run: set when expect_fail was given. red = ran and failed, vacuous = passed, broken = could not run */
  verdict?: "red" | "vacuous" | "broken";
}

/** The test files a finished test-authoring dispatch froze, for the coding dispatch that must not edit them. */
export function frozenFilesFrom(task_id: string, dispatch_id: string): string[] {
  const m = readDispatchMeta(dispatch_id);
  if (m.kind !== "test-authoring") throw new Error(`dispatch ${dispatch_id} is a ${m.kind} dispatch, not test-authoring`);
  if (m.task_id !== task_id) throw new Error(`dispatch ${dispatch_id} belongs to task ${m.task_id}, not ${task_id}`);
  if (m.status !== "completed") throw new Error(`dispatch ${dispatch_id} is ${m.status}${m.error ? `: ${m.error}` : ""}; there are no tests to freeze yet`);
  if (!m.frozen_files?.length) throw new Error(`dispatch ${dispatch_id} wrote no test files`);
  return m.frozen_files;
}

/** The most recently finished dispatch of a kind for a task, or null. */
export function latestDispatch(task_id: string, kind: DispatchMeta["kind"]): DispatchMeta | null {
  const root = join(dataDir(), "dispatches");
  if (!existsSync(root)) return null;
  let best: DispatchMeta | null = null;
  for (const id of readdirSync(root)) {
    try {
      const m = readDispatchMeta(id);
      if (m.task_id !== task_id || m.kind !== kind || m.status === "in-flight") continue;
      if (!best || (m.finished_at ?? "") > (best.finished_at ?? "")) best = m;
    } catch { /* unreadable folder */ }
  }
  return best;
}

export function readDispatchMeta(id: string): DispatchMeta {
  if (!/^d_[0-9a-f]{8}$/.test(id)) throw new Error("invalid dispatch_id");
  if (!existsSync(metaFile(id))) throw new Error(`unknown dispatch_id '${id}'`);
  return JSON.parse(readFileSync(metaFile(id), "utf8"));
}

/**
 * The stage artifact of a finished analysis dispatch, with the provenance to record alongside it. Lets the workflow server
 * store a document straight from the dispatch result, so the orchestrating model never has to copy it back out.
 */
export function completedArtifact(task_id: string, dispatch_id: string): { content: string; skill_version?: string; platform: string } {
  const m = readDispatchMeta(dispatch_id);
  if (m.kind !== "analysis") throw new Error(`dispatch ${dispatch_id} is a ${m.kind} dispatch; only analysis dispatches produce artifacts`);
  if (m.task_id !== task_id) throw new Error(`dispatch ${dispatch_id} belongs to task ${m.task_id}, not ${task_id}`);
  if (m.status !== "completed") throw new Error(`dispatch ${dispatch_id} is ${m.status}${m.error ? `: ${m.error}` : ""}; nothing to store`);
  if (!m.artifact?.trim()) throw new Error(`dispatch ${dispatch_id} produced no artifact`);
  return { content: m.artifact, skill_version: m.skill_version, platform: m.platform };
}

/**
 * Delete the folders of dispatches that finished more than `days` ago. In-flight and unreadable ones are always kept.
 * Stage artifacts live in the workflow database, so this only drops prompts, raw output and frozen-test backups.
 * `dryRun` lists what would go without deleting.
 */
export function pruneDispatches(days: number, dryRun = false): { removed: string[]; kept: number } {
  const root = join(dataDir(), "dispatches");
  const removed: string[] = [];
  let kept = 0;
  if (!existsSync(root)) return { removed, kept };
  const cutoff = Date.now() - days * 86_400_000;
  for (const id of readdirSync(root)) {
    try {
      const m = readDispatchMeta(id);
      const t = Date.parse(m.finished_at ?? "") || 0;
      if (m.status === "in-flight" || !t || t > cutoff) { kept++; continue; }
      if (!dryRun) rmSync(dispatchDir(id), { recursive: true, force: true });
      removed.push(id);
    } catch { kept++; }
  }
  return { removed, kept };
}
