/** `autopilot enable | disable | start | status | stop | report`: unattended runs of the orchestrator. See docs/autonomous-mode.md. */
import { resolve } from "node:path";
import { optionOf } from "../args.js";
import { loadConfig } from "../../config/config.js";
import { normRoot } from "../../shared/paths.js";
import { updatePolicy } from "../../workflow/policy.js";
import { Workflow } from "../../workflow/service.js";
import { buildInvocation, runTurn, tickPrompt } from "../../autopilot/agent.js";
import { autopilotLoop } from "../../autopilot/loop.js";
import { formatReport } from "../../autopilot/report.js";

const USAGE = `usage: autopilot enable | disable                       turn policy.autonomy.enabled on or off
       autopilot start --repo <path> [--tasks id,id] [--hours N] [--max-dispatches N]
                       [--platform copilot|claude] [--interval S] [--tick-timeout MIN]
       autopilot start --resume <run_id>                 carry on a run (after a crash or reboot)
       autopilot status [--run <run_id>]
       autopilot stop --run <run_id>
       autopilot report [--run <run_id>]                 the morning report (default: the latest run)`;

function latestRun(wf: Workflow, id?: string): string {
  if (id) return wf.autonomy.getRun(id).run_id;
  const r = wf.db.prepare("SELECT run_id FROM autonomy_runs ORDER BY started_at DESC LIMIT 1").get() as { run_id: string } | undefined;
  if (!r) { console.error("no runs yet"); process.exit(1); }
  return r.run_id;
}

export async function autopilotCommand(argv: string[]): Promise<void> {
  const sub = argv[1];
  const oi = (n: string) => optionOf(argv, n);
  if (sub === "enable" || sub === "disable") {
    updatePolicy({ autonomy: { enabled: sub === "enable" } });
    console.log(`policy.autonomy.enabled = ${sub === "enable"}`);
    return;
  }
  const wf = new Workflow();
  if (sub === "report") { console.log(formatReport(wf.autonomy.report(latestRun(wf, oi("run"))))); return; }
  if (sub === "status") {
    const id = latestRun(wf, oi("run"));
    const r = wf.autonomy.runnable(id);
    console.log(`${r.run.run_id} · ${r.run.status}${r.run.end_reason ? ` (${r.run.end_reason})` : ""} · sessions ${r.budget.used}/${r.budget.max} · ${r.open} open task(s), ${r.tasks.length} ready now, ${r.waiting} waiting on running sessions`);
    for (const t of r.tasks) console.log(`  ready: ${t.task_id} ${t.title} (${t.stage}; ${t.why})`);
    return;
  }
  if (sub === "stop") {
    if (!oi("run")) { console.error(USAGE); process.exit(1); }
    console.log(`run ${wf.autonomy.stopRun(oi("run")!, "stopped from the command line").run.status}; the loop exits after its current agent turn`);
    return;
  }
  if (sub !== "start") { console.error(USAGE); process.exit(1); }

  // ---- start / resume
  let run_id = oi("resume");
  if (!run_id) {
    if (!oi("repo")) { console.error(USAGE); process.exit(1); }
    try {
      const { run, enrolled } = wf.autonomy.startRun({
        project_root: resolve(oi("repo")!),
        task_ids: oi("tasks")?.split(",").map((s) => s.trim()).filter(Boolean),
        hours: oi("hours") ? Number(oi("hours")) : undefined,
        max_dispatches: oi("max-dispatches") ? Number(oi("max-dispatches")) : undefined,
      });
      run_id = run.run_id;
      console.log(`run ${run_id} started over ${normRoot(resolve(oi("repo")!))}: ${enrolled.length} task(s) enrolled${run.deadline ? `, ends ${run.deadline}` : ""}`);
    } catch (e: any) { console.error(`error: ${e.message}`); process.exit(1); }
  } else {
    wf.autonomy.getRun(run_id);
    console.log(`resuming ${run_id}`);
  }

  const cfg = loadConfig();
  const ap = { ...(cfg.autopilot ?? {}), ...(oi("platform") ? { platform: oi("platform") } : {}) };
  const intervalMs = (oi("interval") ? Number(oi("interval")) : ap.interval_seconds ?? 20) * 1000;
  const timeoutMs = (oi("tick-timeout") ? Number(oi("tick-timeout")) : ap.tick_timeout_minutes ?? 30) * 60_000;
  try { buildInvocation("probe", ap, cfg.default_platform); } catch (e: any) { wf.autonomy.stopRun(run_id, e.message); console.error(`error: ${e.message}`); process.exit(1); }
  const stamp = () => new Date().toTimeString().slice(0, 8);
  const rid = run_id;

  const result = await autopilotLoop({
    wf, run_id: rid, intervalMs,
    log: (l) => console.log(`[${stamp()}] ${l}`),
    turn: (t) => runTurn(buildInvocation(tickPrompt({ run_id: rid, task_id: t.task_id, stage: t.stage, project_root: t.project_root }), ap, cfg.default_platform), { cwd: t.project_root, timeoutMs }),
  });
  console.log(`\nrun ${rid} ended: ${result.reason} after ${result.turns} agent turn(s)\n`);
  console.log(formatReport(wf.autonomy.report(rid)));
}
