import { loadConfig, projectConfig, type BudgetConfig } from "./config.js";
import { usageSummary } from "./usage.js";
import type { DispatchUsage } from "./dispatch-store.js";

export interface BudgetStatus {
  exceeded: boolean;
  action: "warn" | "block";
  used_tokens: number;
  used_cost_usd: number;
  limit_tokens?: number;
  limit_cost_usd?: number;
  /** true when none of the numbers counted are exact (estimates are a lower bound, so real use is higher) */
  estimated_only: boolean;
  message: string;
}

/** The budget in force for a repo: global values, each overridden by the repo's own. Null when none is set. */
export function budgetFor(root: string): (Required<Pick<BudgetConfig, "action">> & BudgetConfig) | null {
  const g = loadConfig().budget ?? {};
  const p = projectConfig(root)?.budget ?? {};
  const task_tokens = p.task_tokens ?? g.task_tokens;
  const task_cost_usd = p.task_cost_usd ?? g.task_cost_usd;
  if (!task_tokens && !task_cost_usd) return null;
  const action = (p.action ?? g.action) === "block" ? "block" : "warn";
  return { task_tokens, task_cost_usd, action };
}

/**
 * How much a task has used against its budget. `extra` is a dispatch that has just finished but is not saved yet.
 * Tokens are input plus output of finished dispatches. Cost only counts dispatches whose CLI reported one.
 * Because estimated tokens are a lower bound, a task can be over budget before this says so; it never says so wrongly early.
 */
export function budgetStatus(taskId: string, root: string, extra?: DispatchUsage): BudgetStatus | null {
  const b = budgetFor(root);
  if (!b) return null;
  const t = usageSummary({ taskId }).total;
  const used_tokens = t.input_tokens + t.output_tokens + (extra ? extra.input_tokens + extra.output_tokens : 0);
  const used_cost_usd = t.cost_usd + (extra?.cost_usd ?? 0);
  const reportedAny = t.reported > 0 || extra?.source === "reported";
  const overTokens = !!b.task_tokens && used_tokens >= b.task_tokens;
  const overCost = !!b.task_cost_usd && used_cost_usd >= b.task_cost_usd;
  const parts: string[] = [];
  if (b.task_tokens) parts.push(`${used_tokens} of ${b.task_tokens} tokens${reportedAny ? "" : " (estimated, a lower bound)"}`);
  if (b.task_cost_usd) parts.push(`$${used_cost_usd.toFixed(2)} of $${b.task_cost_usd.toFixed(2)}${used_cost_usd === 0 && !reportedAny ? " (this platform reports no cost)" : ""}`);
  const exceeded = overTokens || overCost;
  return {
    exceeded, action: b.action, used_tokens, used_cost_usd, limit_tokens: b.task_tokens, limit_cost_usd: b.task_cost_usd, estimated_only: !reportedAny,
    message: `Task ${taskId} has used ${parts.join(" and ")}, ${exceeded ? "over" : "within"} its budget (${b.action === "block" ? "new dispatches are refused once it is over" : "warning only"}).`,
  };
}
