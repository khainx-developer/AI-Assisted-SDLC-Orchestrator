# Autonomous mode

Let the orchestrator work through a set of tasks while you are away, without a decision from you at each stop. It decides only what you allowed in advance, writes down every such decision, and sets aside anything else so the rest of the queue keeps moving. In the morning you get one report.

Code only ever lands on each task's own branch. A run never merges, pushes, deletes, or moves a task to done: the end of a run's work on a task is "ready for your review".

## Quick start

```
node dist/cli/index.js autopilot start --repo D:/work/App --hours 8 --max-dispatches 40
# in the morning:
node dist/cli/index.js autopilot report
```

Or ask the orchestrator in chat ("work on these overnight"): it checks the policy, confirms the scope with you, enrolls the tasks and starts the runner in the background (`start_autonomous_run`). No terminal is needed; the runner's output is in `~/.ai-sdlc-orchestrator/autopilot/<run_id>.log`. If it ever stops (reboot), continue with `autopilot start --resume <run_id>`.

## Preparing a pack of tasks

Use one chat to register the whole pack and start one run. Do not open one chat per task: a run works the enrolled tasks one at a time, and parallel chats on one checkout collide unless the repo has `worktree` enabled.

**Make each ticket autopilot-friendly.** A run decides only what the documents already suggest and parks the rest, so a ticket should carry what a person would otherwise be asked mid-run:

- **Outcome**: one observable, testable sentence ("`GET /orders` returns 400 for a bad date"), not an activity ("improve orders").
- **Scope**: files or modules that may change, and what must not.
- **Acceptance criteria**: a short list the tests can check.
- **Defaults for likely questions**: the answer you would give ("use the existing `Money` type", "no new dependency"). With no suggestion the task parks.
- **Kind**: feature, bug, or investigation (an investigation ends with an answer, not code).
- **Depends on**: a hint to the agent; the workflow does not enforce ordering.

Keep out of unattended runs anything on the never-autonomous list (migration, auth, payment, secret, delete, drop table, breaking or irreversible changes): they park at the first gate. Do those with a person present.

Two steps: first have the agent **write** the pack, review and edit it, then paste it into the **assign** prompt.

### Step 1: prompt to write the pack

Fill in the goal and paste into the chat. It only produces tickets: no tasks are created and no work starts.

```
Write a task pack for autopilot. Do not create tasks, do not start any work, do not change files.

Goal: <what you want done overall, in a few sentences>
Repo: <ABSOLUTE PATH> (read it to ground the tickets in real files and existing patterns)
Base branch: <e.g. dev>
Human-only areas (never put these in the pack): <e.g. migrations, auth, payments>
Size: up to <N> tickets, each small enough for one task (one reviewable branch).

For each ticket write exactly this block:

N. <Title>
   Kind: feature | bug | investigation
   Outcome: <one observable, testable sentence>
   Scope: <files/modules allowed>. Out of scope: <not to touch>.
   Acceptance:
   - <criterion a test can check>
   Defaults if unsure: <your best answer to each question a worker would ask>
   Depends on: <ticket numbers or none>

Rules:
- Order the tickets so dependencies come first; keep independent ones independent.
- Every question you would ask me must be answered in "Defaults if unsure" with your recommended choice.
- Anything touching a human-only area, or breaking/irreversible, goes in a separate "Needs a human" list, not in the pack.
- Finish with: total tickets, the riskiest one, and anything you could not ground in the repo.
```

Review the output: tighten scope, fix the defaults, delete tickets you do not want. Save it (for example `tasks/pack.md`) or keep it in the chat.

### Step 2: prompt to assign the pack and start the run

Paste the reviewed pack where `<PACK>` is. Fill in and send:

```
Create a pack of tasks for autopilot in repo <ABSOLUTE PATH>.
Base branch: <branch, e.g. dev>. Source: adhoc (or jira with the keys given).

Rules for the whole pack:
- Create one task per ticket below with create_task; do not start any work yet.
- If a ticket is too big, break it down (up to <N, max 6> parts) and enroll the children.
- Do not enroll tasks that touch: <areas to keep human-only>.
- Do not merge, push or mark anything done.

Tickets:
<PACK>

Run:
- Check the autonomy policy, then show me the task list and scope, and wait for my OK.
- After I confirm, start an autonomous run (start_autonomous_run) for exactly these tasks:
  hours: <e.g. 8>, max dispatches: <e.g. 40>.
- Then tell me the run id and how to see status and the report.
```

Shorter forms of step 2:

```
Register these Jira tickets as tasks in <repo>: <KEY-1, KEY-2, KEY-3>.
Triage each, break down the big ones, then start an autopilot run for them
for <8> hours with at most <40> dispatches. Confirm the scope with me first.
```

```
Read tasks/pack.md (tickets in the format above), create one task per ticket, and start an autopilot run for them. Confirm first.
```

To start from the terminal instead, create the tasks in chat (step 2 without the Run section), then run `autopilot start` as in the quick start. Without task names the run covers every unfinished task of the repo, so check `list_pending_tasks` first if the repo has older tasks you do not want worked.

## How a run works

1. **Enroll.** A run covers the tasks you name, or every unfinished task of the repo. Children created from an enrolled parent's breakdown join the run.
2. **Rounds.** The runner (`sdlc-orchestrator autopilot`) asks the workflow which enrolled tasks can take a turn (not parked, not finished, no session still running), and gives each one turn of the orchestrator agent, one task at a time. Each turn is a fresh headless start of the same installed orchestrator agent, told only the run, the task and to follow the `autonomous` playbook. All state is in `workflow.db`, so a crash or reboot loses nothing: `autopilot start --resume <run_id>`.
3. **Decide or park.** Where the normal flow would stop for you, the agent follows the playbook, and the server checks every autonomous decision against `policy.autonomy`. A refusal, or any case without a safe default, parks the task.
4. **Finish.** A task whose code is on its branch with passing tests, or an answered investigation, is handed over with a summary (`mark_ready_for_review`).
5. **End.** The run ends when you stop it, its deadline passes, its session budget is spent, every task is finished or set aside, or nothing has moved for 45 minutes. If the agent CLI cannot even be started twice in a row, the run stops at once with that reason.

## What it may decide, and what parks

| Where the flow would stop for you | In a run |
|---|---|
| Open questions in a requirement or design | Takes the document's own **suggested answer** and logs each as an edge case. A question with no suggestion parks the task. (`answer_questions: "park"` parks instead.) |
| Plan gate (risky tasks) | Approves as `autonomous:<run_id>`, unless the task is on the never-autonomous list, the plan still has open questions, or `plan_gate` is `park`. |
| Breakdown of a big story | Approves up to `max_children` parts; more parks the parent. A split parent is only an overview; its children are worked. |
| Coding session needs clarification | Parks, with its question. |
| Spec proven wrong | The usual send-back (capped by `max_spec_wrong_returns`), then the new open question is handled as above or parks. |
| Frozen test edited, out-of-scope files, failed or timed-out session | One retry (failures: up to `max_dispatch_retries`), out-of-scope files are kept and logged, then it parks. |
| Tests still failing at `max_test_retries` | Parks with the failing tests. Never reported as done. |
| `max_attempts_per_task` turns with no change of stage | Parked by the server. This is what stops a stuck task looping all night. |
| Offers that cost a session (AI review, tests first when off) | Skipped. |

The **never-autonomous list** (`policy.autonomy.never_autonomous`) makes a task park at its first gate instead of being decided for: breaking changes, irreversible changes, and a keyword list (default: migration, auth, payment, secret, delete, drop table) matched at a word start in the title, description and the document being approved. The defaults are cautious: because the plan gate applies to breaking or irreversible work by default, a stock policy parks every gated plan. Turn `breaking` or `irreversible` off only if you accept an unattended approval of that kind of change.

## Policy (`policy.json`, block `autonomy`)

```json
"autonomy": {
  "enabled": true,
  "answer_questions": "accept_suggested",
  "plan_gate": "auto_approve",
  "breakdown": "auto_approve",
  "max_children": 6,
  "never_autonomous": { "breaking": true, "irreversible": true, "keywords": ["migration", "auth", "payment", "secret", "delete", "drop table"] },
  "max_attempts_per_task": 4,
  "max_dispatches_per_run": 40,
  "max_turns_per_run": 100,
  "max_hours_per_run": 8
}
```

Autopilot is available by default; nothing to turn on. Tasks are never autonomous unless you ask for a run (in chat: "run autopilot for this task"). An existing `policy.json` needs no edit. `enabled` is the master switch: `sdlc-orchestrator autopilot disable` (or `"enabled": false`) stops any run from starting and any autonomous approval from being accepted.

## Limits: a run cannot burn tokens without end

Every run is capped, and the server and runner enforce it, not the prompt:

| Limit | Default | What happens at the limit |
|---|---|---|
| `max_hours_per_run` | 8 | The run always has a deadline, even if you ask for none or for more hours |
| `max_dispatches_per_run` (or `--max-dispatches`) | 40 | No more worker sessions |
| `max_turns_per_run` | 100 | No more orchestrator agent turns (each one is an LLM session) |
| `max_attempts_per_task` | 4 | A task with no progress after this many turns is parked |
| idle | 45 min | Nothing could advance: the run ends |

When one is spent the run ends with that reason, and unfinished tasks wait for you. Limits are checked between turns, so one turn can overshoot a little. Watch usage with `sdlc-orchestrator dispatches usage` and task budgets (see [cost-and-evals.md](cost-and-evals.md)).

## Controlling and following a run

From chat: ask "how is the run going?" (`get_autonomous_run_status`), "show the report", "stop the run", "resume it". From the CLI:

```
sdlc-orchestrator autopilot list                  # recent runs
sdlc-orchestrator autopilot status [--run id]     # state, limits spent, open tasks
sdlc-orchestrator autopilot logs [--tail 80]      # the background runner's output
sdlc-orchestrator autopilot start --resume <id>   # restart a run's runner (reboot, crash)
sdlc-orchestrator autopilot stop --run <id>
sdlc-orchestrator autopilot report
```

## The runner's agent (`config.json`, block `autopilot`)

```json
"autopilot": { "platform": "copilot", "agent": "sdlc-orchestrator", "interval_seconds": 20, "tick_timeout_minutes": 30 }
```

Set these from the CLI instead of editing the file: `sdlc-orchestrator config set autopilot.platform copilot` (also `autopilot.agent`, `autopilot.command`, `autopilot.interval_seconds`, `autopilot.tick_timeout_minutes`; `config unset` removes one).

`platform` is `copilot` or `claude` (default: from `default_platform`). Any other CLI: `"command": "mytool", "args": ["run", "{prompt}"]` (without `{prompt}` the instruction goes to stdin). The orchestrator agent must be installed for that tool first (`install --target ...`). The agent is started with file writes and shell commands denied: it only calls its MCP tools.

**Verification status.** The Copilot invocation was checked against `copilot --help`; the Claude Code one has not been run against the real CLI yet (see [BACKLOG.md](../BACKLOG.md)). Check a first run with one task and `--hours 1` before trusting it overnight.

## The morning report

`autopilot report` (or `get_autonomous_run_report` in chat) lists, per task: **ready for your review** (branch, PR, summary), **needs you** (parked, with the question and what the run would have chosen, so a yes is one word), done, unfinished, and every decision made on your behalf. To answer a parked task, reply in chat; the orchestrator records your decision with the normal tools and calls `unpark_task`. If you disagree with a decision the run made, say so and the task goes back to that stage.

## Limits to know about

- Budgets are checked between turns: one turn can start a few sessions before the run notices the `max_dispatches` limit.
- Autonomy is as good as the suggested answers in the analysis documents. They are shown in the report for exactly that reason, and the never-autonomous list is the guard for the areas where a wrong guess is expensive.
- Turns run one at a time. Tasks on one repo checkout never run in parallel unless the repo has `worktree` enabled.
