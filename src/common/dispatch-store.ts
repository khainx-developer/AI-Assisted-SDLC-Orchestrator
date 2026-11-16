import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { dataDir } from "./paths.js";

export const dispatchDir = (id: string) => join(dataDir(), "dispatches", id);
export const metaFile = (id: string) => join(dispatchDir(id), "meta.json");

export interface DispatchMeta {
  dispatch_id: string;
  kind: "analysis" | "coding" | "test-authoring" | "test";
  task_id: string;
  platform: string;
  project_root: string;
  status: "in-flight" | "completed" | "failed";
  pid?: number;
  started_at: string;
  finished_at?: string;
  /** wall-clock time of the session; lets you see whether analysis sessions spend their time locating code (design 9.8) */
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
