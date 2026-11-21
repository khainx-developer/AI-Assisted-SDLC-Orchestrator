/** Unattended-run tools: start and stop a run, what to work on next, parking a task, deciding on a task's behalf within policy. */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { wf, run, tid } from "./shared.js";

export function registerAutonomyTools(server: McpServer): void {
  server.tool(
    "start_autonomous_run",
    "Begin an unattended run over a repo (only when the human asked for it, and policy.autonomy.enabled is true). Enrolls the given tasks, or every unfinished task of the repo. While the run is live, an enrolled task may be approved or have its open questions answered by you, only as far as the autonomous playbook and policy allow, each decision logged. Returns run_id, deadline and the enrolled task ids. Call get_playbook('autonomous') before working an enrolled task.",
    {
      project_root: z.string(), task_ids: z.array(z.string()).optional().describe("limit the run to these tasks; omit to enroll every unfinished task of the repo"),
      hours: z.number().positive().optional().describe("the run ends after this many hours"),
      max_dispatches: z.number().int().min(1).optional().describe("AI sessions the run may start; default policy.autonomy.max_dispatches_per_run"),
    },
    (a) => run(() => wf.autonomy.startRun(a))
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
