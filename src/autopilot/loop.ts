/**
 * The unattended-run loop. Each round: ask the workflow which tasks of the run can take a turn, give each one agent turn (one at a
 * time, so two stories never fight over a checkout), then wait. All state lives in workflow.db, so a crashed or restarted runner
 * resumes where it was and an agent turn needs no memory of the previous one.
 *
 * The loop ends when the run is stopped, its deadline passes, its session budget is spent, nothing is left that a turn can advance,
 * or nothing has moved for too long (sessions that never finish).
 */
import type { Workflow } from "../workflow/service.js";
import type { TurnResult } from "./agent.js";

export interface LoopOptions {
  wf: Workflow;
  run_id: string;
  /** give one task one agent turn */
  turn: (t: { task_id: string; title: string; stage: string; project_root: string }) => Promise<TurnResult>;
  intervalMs: number;
  /** give up when nothing is runnable and nothing finished for this long (default 45 min) */
  idleLimitMs?: number;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
}

export interface LoopResult {
  reason: "stopped" | "deadline" | "budget" | "done" | "stalled" | "agent_unavailable";
  turns: number;
}

export async function autopilotLoop(o: LoopOptions): Promise<LoopResult> {
  const { wf, run_id } = o;
  const sleep = o.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  const log = o.log ?? (() => {});
  const idleLimit = o.idleLimitMs ?? 45 * 60_000;
  let turns = 0;
  let lastMove = Date.now();
  let startFailures = 0; // consecutive turns where the agent CLI could not even be started

  const over = (): LoopResult["reason"] | null => {
    const run = wf.autonomy.getRun(run_id);
    if (run.status !== "active") return "stopped";
    if (run.deadline && Date.parse(run.deadline) <= Date.now()) { wf.autonomy.finishRun(run_id, "deadline reached"); return "deadline"; }
    if (wf.autonomy.budget(run).exhausted) { wf.autonomy.finishRun(run_id, "session budget spent"); return "budget"; }
    return null;
  };

  for (;;) {
    let end = over();
    if (end) return { reason: end, turns };
    const r = wf.autonomy.runnable(run_id);
    if (!r.open) {
      wf.autonomy.finishRun(run_id, "every task is done or parked");
      return { reason: "done", turns };
    }
    if (!r.tasks.length) {
      if (Date.now() - lastMove > idleLimit) {
        wf.autonomy.finishRun(run_id, `no task could advance for ${Math.round(idleLimit / 60_000)} minutes (sessions that never finished?)`);
        return { reason: "stalled", turns };
      }
      log(`waiting on ${r.waiting} running session(s)`);
      await sleep(o.intervalMs);
      continue;
    }
    for (const t of r.tasks) {
      end = over();
      if (end) return { reason: end, turns };
      const task = wf.getTask(t.task_id);
      if (task.parked_reason) continue; // parked by an earlier turn of this round
      wf.autonomy.logTick(run_id, t.task_id, task.stage);
      log(`turn ${turns + 1}: ${t.task_id} "${t.title}" at ${task.stage} (${t.why})`);
      const res = await o.turn({ task_id: t.task_id, title: t.title, stage: task.stage, project_root: task.project_root });
      turns++;
      startFailures = res.error?.startsWith("could not start") ? startFailures + 1 : 0;
      if (startFailures >= 2) {
        wf.autonomy.stopRun(run_id, `the orchestrator agent could not be started: ${res.error}`);
        log(`  -> stopping: ${res.error}`);
        return { reason: "agent_unavailable", turns };
      }
      const after = wf.getTask(t.task_id);
      if (after.stage !== task.stage || after.parked_reason || after.dispatch_id !== task.dispatch_id) lastMove = Date.now();
      log(`  -> ${res.ok ? "" : `[${res.timed_out ? "timed out" : res.error ?? `exit ${res.exit_code}`}] `}${(res.output.split(/\r?\n/).filter(Boolean).pop() ?? "(no output)").slice(0, 200)}`);
    }
    await sleep(o.intervalMs);
  }
}
