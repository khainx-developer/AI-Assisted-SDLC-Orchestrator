/** Unattended-run tools: start and stop a run, what to work on next, parking a task, deciding on a task's behalf within policy. */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { launchRunner, readRunnerLog } from "../../autopilot/runner-log.js";
import { wf, run, tid } from "./shared.js";

export function registerAutonomyTools(server: McpServer): void {
  server.tool(
    "start_autonomous_run",
    "Begin an unattended run over a repo (only when the human asked for it, and policy.autonomy.enabled is true). Enrolls the given tasks, or every unfinished task of the repo. While the run is live, an enrolled task may be approved or have its open questions answered by you, only as far as the autonomous playbook and policy allow, each decision logged. Also starts the background runner that works the tasks (no terminal needed; `runner.log` is its output file). Returns run_id, deadline, the enrolled task ids and the runner pid. Call get_playbook('autonomous') before working an enrolled task.",
    {
      project_root: z.string(), task_ids: z.array(z.string()).optional().describe("limit the run to these tasks; omit to enroll every unfinished task of the repo"),
      hours: z.number().positive().optional().describe("the run ends after this many hours"),
      max_dispatches: z.number().int().min(1).optional().describe("AI sessions the run may start; default policy.autonomy.max_dispatches_per_run"),
    },
    (a) => run(() => {
      const started = wf.autonomy.startRun(a);
      // the runner is started here, so the human does not need a terminal
      return { ...started, runner: launchRunner(started.run.run_id) };
    })
  );
  server.tool(
    "get_autonomous_run_status",
    "Progress of an unattended run right now: live or ended (and why), sessions and agent turns spent against their limits, deadline, how many tasks are still open or waiting, and the last lines of the background runner's log. Omit run_id for the latest run. Use it when the human asks how a run is going; for the per-task outcome use get_autonomous_run_report.",
    { run_id: z.string().optional(), log_lines: z.number().int().min(0).max(100).optional() },
    (a) => run(() => {
      const id = a.run_id ?? wf.autonomy.listRuns(1)[0]?.run_id;
      if (!id) throw new Error("no runs yet");
      return { ...wf.autonomy.status(id), runner_log: readRunnerLog(id, a.log_lines ?? 15) };
    })
  );
  server.tool(
    "list_autonomous_runs",
    "Recent unattended runs, newest first, with their status and end reason.",
    { limit: z.number().int().min(1).max(50).optional() },
    (a) => run(() => wf.autonomy.listRuns(a.limit ?? 10))
  );
  server.tool(
    "resume_autonomous_run",
    "Start the background runner again for an active run whose runner is gone (after a reboot or crash). Only when the human asks. Does nothing for a run that has ended.",
    { run_id: z.string() },
    (a) => run(() => {
      const r = wf.autonomy.getRun(a.run_id);
      if (!wf.autonomy.isLive(r)) throw new Error(`run ${r.run_id} is not active (${r.status}${r.end_reason ? `: ${r.end_reason}` : ""})`);
      return { run_id: r.run_id, runner: launchRunner(r.run_id) };
    })
  );
  server.tool(
    "stop_autonomous_run",
    "End a run now. Enrolled tasks stay as they are; from then on nothing is decided for them without the human.",
    { run_id: z.string(), reason: z.string().optional() },
    (a) => run(() => wf.autonomy.stopRun(a.run_id, a.reason))
  );
  server.tool(
    "get_autonomous_run_report",
    "The report of a run (the morning report): per task its outcome (done, parked, unfinished), branch and PR, the decisions and approvals made on the human's behalf, and for each parked task what it is waiting on and what the run would have done. Show it to the human as written.",
    { run_id: z.string() },
    (a) => run(() => wf.autonomy.report(a.run_id))
  );
  server.tool(
    "list_runnable_tasks",
    "Tasks of a run that can be given a turn now (not parked, not finished, no session still running). Also parks a task that has used its attempts without changing stage. `live` false means the run ended.",
    { run_id: z.string() },
    (a) => run(() => wf.autonomy.runnable(a.run_id))
  );
  server.tool(
    "park_task",
    "Set an enrolled task aside for a human so the run continues with the others. Use it whenever the playbook says to park, or when you would otherwise have to guess. `question` is what the human must decide; `suggested_answer` is what you would have chosen (they can accept it with one word). The task keeps its branch and documents.",
    { task_id: tid, reason: z.string(), question: z.string().optional(), suggested_answer: z.string().optional() },
    (a) => run(() => wf.autonomy.park(a.task_id, a.reason, a.question, a.suggested_answer))
  );
  server.tool(
    "mark_ready_for_review",
    "An enrolled task's run-work is finished: its code is on its branch and the tests pass (or an investigation is answered). Hands it to the human for review with a one-paragraph summary (what was done, branch, PR number, anything to look at first). A run never moves a task to done, merges or pushes; this is how it ends.",
    { task_id: tid, summary: z.string() },
    (a) => run(() => wf.autonomy.markReadyForReview(a.task_id, a.summary))
  );
  server.tool(
    "unpark_task",
    "Put a parked task back in its run, after the human answered or decided. Record their answer first (answer_open_questions, approve_stage with their name, or a revision).",
    { task_id: tid, note: z.string().optional() },
    (a) => run(() => wf.autonomy.unpark(a.task_id, a.note))
  );
  server.tool(
    "autonomous_answer_open_questions",
    "For an enrolled task in a live run: answer the open questions of a requirement or design by taking each question's own suggested answer, logging every one as an edge case. If any question has no suggested answer, or the task is on the never-autonomous list, the task is parked instead and nothing is invented (the result says `parked`). Use this, never answer_open_questions, while no human is available.",
    { task_id: tid, stage: z.string() },
    (a) => run(() => wf.autonomy.answerOpenQuestions(a.task_id, a.stage))
  );
}
