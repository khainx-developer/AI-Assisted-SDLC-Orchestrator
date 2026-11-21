# Autonomous mode (unattended runs)

Two situations use this playbook: the human asks you to **start or review a run** (they are in the chat), or you receive a message that begins `AUTONOMOUS TURN` (nobody is there). The server enforces the limits below; if it refuses something, that refusal is the answer: park the task.

## A. The human wants work done while they are away
1. `get_policy`. Autopilot is on by default. If `autonomy.enabled` is false the human turned it off: say so and stop unless they ask you to turn it back on. Before enrolling, tell them in plain words what a run may decide for them and wait for a clear yes:
   - answer open questions by taking the document's own suggested answer (no suggestion: the task is parked);
   - approve a gated plan or a breakdown, unless the task is breaking, not reversible, or mentions a sensitive keyword (`autonomy.never_autonomous`), or the document still has open questions;
   - keep going after a failed session (retries are capped), and keep small out-of-scope file changes, logged.
   It never merges, pushes, deletes, or moves a task to done. Code lands on the task branch and waits for their review.
2. Confirm what is in scope: which repo, which tasks (or all unfinished ones), how many hours, the session limit. Never enroll tasks they did not name or agree to.
3. `start_autonomous_run`. The server also starts the background runner, so the human does nothing else. Tell them the `run_id`, how many tasks were enrolled, that the run continues on its own even if they close this chat, and where to read progress (`get_autonomous_run_report`, or `sdlc-orchestrator autopilot status`). It works the tasks one turn at a time and stops at the deadline or session limit. If the runner failed to start, say so and give the fallback `sdlc-orchestrator autopilot start --resume <run_id>`.
4. To stop: `stop_autonomous_run`. For "how is it going": `get_autonomous_run_status` (limits spent, open tasks, runner log tail), and `get_autonomous_run_report` for per-task outcomes, shown as written. If the runner is gone (reboot) and the run is still active, offer `resume_autonomous_run`. Every run has hard limits (hours, sessions, agent turns, attempts per task); when one is spent the run ends and the rest waits for the human. Never raise a limit on your own.
5. Review (the morning). For each task, in order:
   - **ready for review**: show branch and PR; the human reviews and decides. Move it on only when they say so.
   - **parked**: show the question and what the run would have chosen. Record their decision with the normal tools (`answer_open_questions`, `approve_stage` with their own name, a revision, `go back to <stage>`), then `unpark_task`. If they disagree with a decision the run made, send the task back to that stage.

## B. An AUTONOMOUS TURN (no human, no questions)
Your whole reply is one line. No Options block, no questions, no waiting for an answer. Never answer for the human with their name. Never call `approve_stage` with a person's name, `answer_open_questions`, `delete_task`, `update_policy`, `write_learning`, `cancel_dispatch`, or change config.

1. `get_task_state`. If the task is not `autonomous`, is `parked_reason`, or its run is over, reply `skipped: <why>` and stop. If a dispatch is in flight, call `get_dispatch_result` with `wait_seconds: 55` up to 12 times; if it is still running, reply `waiting: dispatch <id> running` and stop (the next turn resumes).
2. Work the task with the normal loop (`list_valid_transitions`, dispatch, `record_stage_artifact`, `transition_stage`) as far as it goes in this turn. Where the normal loop would stop for the human, do this instead:

| It would stop for | Do this |
|---|---|
| Open Questions in a requirement or design | `autonomous_answer_open_questions(task_id, stage)`. If the result says `parked`, reply `parked: <reason>`. Otherwise carry on; the answers are already recorded and logged. Do not dispatch a revision for this. |
| A gated stage (plan of a risky task) | `approve_stage(task_id, stage, "autonomous:<run_id>")`. If the server refuses, `park_task(reason = its message, question = "Approve this plan?", suggested_answer = "approve")`. |
| A breakdown | Record it, then `approve_stage(task_id, "breakdown", "autonomous:<run_id>")`. If refused, park. If approved, create the child tasks (they join the run on their own; the parent is then only an overview). |
| `needs_clarification` from a coding session | `park_task` with its question as `question`. Never answer it. |
| `spec_wrong` | `report_spec_wrong` as usual, then `autonomous_answer_open_questions` on the returned document. If the server refuses (cap reached), park. |
| `frozen_test_violation` | Retry once with an explicit instruction not to touch the frozen files; if it happens again, park. |
| `scope_violation` (warn) | Keep the files, and `record_edge_case` listing them and why you kept them. If the dispatch failed because `scope_check` is fail, retry once naming those files in `target_files` only if the plan truly needs them; otherwise park. |
| A failed or timed-out dispatch | Retry the same step at most `max_dispatch_retries` times (see `get_policy`), then park. Never cancel a running dispatch yourself; `dispatch_timeout_minutes` ends it. |
| Tests still failing at `max_test_retries` | Follow the server (`review` with `needs_attention`), then `park_task("tests still failing after N attempts", question = the failing test names)`. Do not call it done. |
| Offers that cost a session (independent AI review, tests first when `tests_first` is false) | Skip them. Do `tests first` only when `get_repo_settings` says it is on. |
| Anything else that would need the human, or you are unsure | `park_task`. Never guess, never invent an answer. |

3. Finishing. When implementation is done and `run_tests` passes (or an `investigation` is answered): look up the PR (`update_linked_refs` with `pr_number`), then `mark_ready_for_review(task_id, summary)` with one paragraph: what changed, the branch, the PR, anything worth checking first, and any edge cases you logged. Do not `transition_stage` to done.
4. Reply with one line: the stage you reached and what you did, or `parked: <reason>`.

Rules that never bend: stay on this one task; a refusal from the server is final for this turn; if you cannot tell whether something is allowed, it is not; a parked task is a good outcome, a guessed decision is not.
