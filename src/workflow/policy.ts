import { z } from "zod";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, copyFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { teamDir } from "../config/config.js";

const Gate = z.object({
  stage: z.string(),
  when: z.enum(["always", "risky"]).default("risky"),
  auto_approve_after_hours: z.number().positive().nullable().optional(),
});

/**
 * Unattended runs. Off by default. Enrolled tasks (see workflow/autonomy.ts) may take the decisions below themselves, each one logged;
 * anything else parks the task so the run carries on with the others.
 */
const AutonomySchema = z.object({
  enabled: z.boolean().default(false),
  /** open questions in a requirement or design: take the document's suggested answer (questions without one park the task), or park */
  answer_questions: z.enum(["accept_suggested", "park"]).default("accept_suggested"),
  /** gated stages (usually the plan of risky work): approve automatically unless the task matches never_autonomous, or always park */
  plan_gate: z.enum(["auto_approve", "park"]).default("auto_approve"),
  /** a split into child tasks: approve it, or park for a human */
  breakdown: z.enum(["auto_approve", "park"]).default("auto_approve"),
  /** a breakdown into more parts than this parks the parent */
  max_children: z.number().int().min(1).default(6),
  /** tasks that are never approved or answered by the run; they park at their first gate */
  never_autonomous: z
    .object({
      breaking: z.boolean().default(true),
      irreversible: z.boolean().default(true),
      /** matched (case-insensitive, at a word start) in the title, description and the stage document being approved */
      keywords: z.array(z.string()).default(["migration", "auth", "payment", "secret", "delete", "drop table"]),
    })
    .prefault({}),
  /** consecutive runner ticks on one task without it changing stage before it is parked */
  max_attempts_per_task: z.number().int().min(1).default(4),
  /** AI sessions one run may start; the runner stops when it is spent */
  max_dispatches_per_run: z.number().int().min(1).default(40),
});
export type AutonomyPolicy = z.infer<typeof AutonomySchema>;

export const PolicySchema = z
  .object({
    version: z.string(),
    stages: z.array(z.string()).min(1),
    terminal_stages: z.array(z.string()),
    transitions: z.record(z.string(), z.array(z.string())),
    heavy_pipeline: z.array(z.string()),
    light_start_stage: z.string(),
    heavy_start_stage: z.string(),
    requires_human_approval: z.array(Gate),
    max_test_retries: z.number().int().min(0),
    max_dispatch_retries: z.number().int().min(0),
    /** stages a task may be sent back to when implementation proves the spec wrong (report_spec_wrong); defaults keep older policy.json files valid */
    spec_wrong_return_to: z.array(z.string()).default(["requirement", "design", "plan"]),
    /** how many times one task may be sent back that way before it needs a human decision */
    max_spec_wrong_returns: z.number().int().min(0).default(2),
    /** problems logged (edge cases, plus tasks that used up their test retries) since the last review before the orchestrator offers edge-case-review; 0 turns the offer off */
    edge_case_review_after: z.number().int().min(0).default(5),
    /** unattended-run rules; see AutonomySchema. Older policy.json files without it get the defaults (disabled) */
    autonomy: AutonomySchema.prefault({}),
    sync_jira_status: z.boolean(),
    jira_checkpoints: z.record(z.string(), z.string()),
  })
  .superRefine((p, ctx) => {
    const known = new Set(p.stages);
    const bad = (m: string) => ctx.addIssue({ code: "custom", message: m });
    for (const [from, tos] of Object.entries(p.transitions)) {
      if (!known.has(from)) bad(`transitions: unknown stage '${from}'`);
      for (const t of tos) if (!known.has(t)) bad(`transitions.${from}: unknown target '${t}'`);
    }
    for (const s of p.stages) if (!(s in p.transitions)) bad(`transitions: missing entry for stage '${s}'`);
    for (const s of [...p.terminal_stages, ...p.heavy_pipeline, p.light_start_stage, p.heavy_start_stage])
      if (!known.has(s)) bad(`unknown stage '${s}' referenced`);
    for (const g of p.requires_human_approval) if (!known.has(g.stage)) bad(`gate: unknown stage '${g.stage}'`);
    for (const s of p.spec_wrong_return_to) if (!known.has(s)) bad(`spec_wrong_return_to: unknown stage '${s}'`);
  });
export type Policy = z.infer<typeof PolicySchema>;

const here = dirname(fileURLToPath(import.meta.url));
const defaultPolicyPath = join(here, "..", "..", "config", "policy.default.json");

export function policyPath(): string {
  return join(teamDir(), "policy.json");
}

export function loadPolicy(): Policy {
  const p = policyPath();
  if (!existsSync(p)) { mkdirSync(dirname(p), { recursive: true }); copyFileSync(defaultPolicyPath, p); }
  return PolicySchema.parse(JSON.parse(readFileSync(p, "utf8")));
}

export function policyVersion(p: Policy): string {
  return `${p.version}-${createHash("sha1").update(JSON.stringify(p)).digest("hex").slice(0, 8)}`;
}

function merge(base: any, patch: any): any {
  if (patch === null || typeof patch !== "object" || Array.isArray(patch)) return patch;
  const out = { ...(base ?? {}) };
  for (const [k, v] of Object.entries(patch)) out[k] = merge(out[k], v);
  return out;
}

/** Validates BEFORE writing; throws on invalid so a typo fails at edit time, not at use time. */
export function updatePolicy(patch: unknown): Policy {
  const next = PolicySchema.parse(merge(loadPolicy(), patch));
  writeFileSync(policyPath(), JSON.stringify(next, null, 2));
  return next;
}
