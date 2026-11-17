import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { dataDir } from "./paths.js";
import { readDispatchMeta, type DispatchMeta, type DispatchUsage } from "./dispatch-store.js";

/** Rough size of a text in tokens (about 4 characters each). Only used when the AI CLI reports nothing. */
export const estimateTokens = (chars: number) => Math.ceil(Math.max(0, chars) / 4);

/**
 * Token use of one dispatch. `reported` comes from the AI CLI itself (exact, includes everything the session read).
 * `estimated` is only the prompt we sent plus the text it printed: a LOWER BOUND, since a session that explores a repo
 * reads far more than the prompt. Use it to compare runs, not to bill.
 */
export function dispatchUsage(reported: Omit<DispatchUsage, "source"> | null, promptChars: number, outputChars: number): DispatchUsage {
  if (reported) return { source: "reported", ...reported };
  return { source: "estimated", input_tokens: estimateTokens(promptChars), output_tokens: estimateTokens(outputChars) };
}

export interface UsageRow {
  dispatches: number;
  input_tokens: number;
  output_tokens: number;
  /** summed only over dispatches whose CLI reported a cost */
  cost_usd: number;
  /** how many of the dispatches carry an exact (reported) number; the rest are lower-bound estimates */
  reported: number;
  duration_ms: number;
}

const empty = (): UsageRow => ({ dispatches: 0, input_tokens: 0, output_tokens: 0, cost_usd: 0, reported: 0, duration_ms: 0 });

function add(row: UsageRow, m: DispatchMeta) {
  const u = m.usage;
  row.dispatches++;
  row.duration_ms += m.duration_ms ?? 0;
  if (!u) return;
  row.input_tokens += u.input_tokens;
  row.output_tokens += u.output_tokens;
  row.cost_usd += u.cost_usd ?? 0;
  if (u.source === "reported") row.reported++;
}

export interface UsageSummary {
  total: UsageRow;
  by_kind: Record<string, UsageRow>;
  by_platform: Record<string, UsageRow>;
  by_task: Record<string, UsageRow>;
  note: string;
}

/**
 * Add up the usage of finished dispatches. Optionally one task only, or only the last `days` days.
 * Shell test runs (kind "test") use no AI and are skipped.
 */
export function usageSummary(opts: { taskId?: string; days?: number } = {}): UsageSummary {
  const root = join(dataDir(), "dispatches");
  const s: UsageSummary = {
    total: empty(), by_kind: {}, by_platform: {}, by_task: {},
    note: "Tokens marked reported come from the AI CLI. Estimated ones count only the prompt sent and the text printed (a lower bound: files the session read are not included). Cost is only available where the CLI reports it (Claude Code).",
  };
  if (!existsSync(root)) return s;
  const cutoff = opts.days ? Date.now() - opts.days * 86_400_000 : 0;
  for (const id of readdirSync(root)) {
    let m: DispatchMeta;
    try { m = readDispatchMeta(id); } catch { continue; }
    if (m.kind === "test" || m.status === "in-flight") continue;
    if (opts.taskId && m.task_id !== opts.taskId) continue;
    if (cutoff && (Date.parse(m.finished_at ?? m.started_at) || 0) < cutoff) continue;
    for (const [bucket, key] of [[s.by_kind, m.kind], [s.by_platform, m.platform], [s.by_task, m.task_id]] as const) add((bucket[key] ??= empty()), m);
    add(s.total, m);
  }
  return s;
}

/** One-line human summary of a row, for the CLI. */
export function formatRow(r: UsageRow): string {
  const cost = r.cost_usd ? `, $${r.cost_usd.toFixed(2)}` : "";
  const exact = r.reported === r.dispatches ? "reported" : r.reported ? `${r.reported} of ${r.dispatches} reported, rest estimated` : "estimated, lower bound";
  return `${r.dispatches} dispatch(es), ${r.input_tokens} in / ${r.output_tokens} out tokens (${exact})${cost}, ${Math.round(r.duration_ms / 1000)}s`;
}
