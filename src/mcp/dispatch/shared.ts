import { z } from "zod";
import { loadConfig, projectConfig, knowledgeInPrompts } from "../../config/config.js";
import { knowledgeIndex } from "../../knowledge/index-block.js";

/** The knowledge index for a worker prompt, plus the folder to add to its read-only roots. Empty when switched off or when there are no pages. */
export function knowledgeFor(projectRoot: string, taskFiles: string[] = []): { text: string | null; roots: string[] } {
  if (!knowledgeInPrompts(projectRoot)) return { text: null, roots: [] };
  const k = knowledgeIndex(projectRoot, taskFiles);
  return k ? { text: k.text, roots: [k.dir] } : { text: null, roots: [] };
}

export type Result = { content: { type: "text"; text: string }[]; isError?: boolean };
export async function run(fn: () => unknown | Promise<unknown>): Promise<Result> {
  try { return { content: [{ type: "text", text: JSON.stringify(await fn(), null, 2) }] }; }
  catch (e: any) { return { content: [{ type: "text", text: e?.message ?? String(e) }], isError: true }; }
}

/** Precedence: explicit tool arg > per-project override > per-mode default > default_platform. */
export function pickPlatform(mode: "analysis" | "coding", root: string, explicit?: string) {
  const cfg = loadConfig();
  const proj = projectConfig(root);
  return explicit ?? (mode === "analysis" ? proj?.analysis_platform ?? proj?.platform ?? cfg.analysis_platform : proj?.coding_platform ?? proj?.platform ?? cfg.coding_platform) ?? cfg.default_platform;
}

export const overrideBudgetArg = z.boolean().optional().describe("only after the human agreed: go ahead although the task is over its budget (see budget in config.json)");
export const baseArg = z.string().nullish().describe("use `base_branch` from get_task_state: a new task branch starts from it. Ignored when the branch already exists");
export const platformArg = z.string().nullish().describe("AI platform for this dispatch (claude | copilot | cursor | any id declared in config.json). Omit or pass null to use configured routing.");
