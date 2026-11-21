# Autonomous mode

Let the orchestrator work through a set of tasks while you are away, without a decision from you at each stop. It decides only what you allowed in advance, writes down every such decision, and sets aside anything else so the rest of the queue keeps moving. In the morning you get one report.

Code only ever lands on each task's own branch. A run never merges, pushes, deletes, or moves a task to done: the end of a run's work on a task is "ready for your review".

## Quick start

```
node dist/cli/index.js autopilot enable                      # once: policy.autonomy.enabled = true
node dist/cli/index.js autopilot start --repo D:/work/App --hours 8 --max-dispatches 40
# in the morning:
node dist/cli/index.js autopilot report
```

Or ask the orchestrator in chat ("work on these overnight"): it checks the policy, confirms the scope with you, enrolls the tasks (`start_autonomous_run`) and tells you the one command to start the runner (`autopilot start --resume <run_id>`).

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
  "enabled": false,
  "answer_questions": "accept_suggested",
  "plan_gate": "auto_approve",
  "breakdown": "auto_approve",
  "max_children": 6,
  "never_autonomous": { "breaking": true, "irreversible": true, "keywords": ["migration", "auth", "payment", "secret", "delete", "drop table"] },
  "max_attempts_per_task": 4,
  "max_dispatches_per_run": 40
}
```

An existing `policy.json` needs no edit: the block defaults to off. `enabled` is the master switch; with it off, no run can start and no autonomous approval is accepted.

## The runner's agent (`config.json`, block `autopilot`)

```json
"autopilot": { "platform": "copilot", "agent": "orchestrator", "interval_seconds": 20, "tick_timeout_minutes": 30 }
```

`platform` is `copilot` or `claude` (default: from `default_platform`). Any other CLI: `"command": "mytool", "args": ["run", "{prompt}"]` (without `{prompt}` the instruction goes to stdin). The orchestrator agent must be installed for that tool first (`install --target ...`). The agent is started with file writes and shell commands denied: it only calls its MCP tools.

**Verification status.** The Copilot invocation was checked against `copilot --help`; the Claude Code one has not been run against the real CLI yet (see [BACKLOG.md](../BACKLOG.md)). Check a first run with one task and `--hours 1` before trusting it overnight.

## The morning report

`autopilot report` (or `get_autonomous_run_report` in chat) lists, per task: **ready for your review** (branch, PR, summary), **needs you** (parked, with the question and what the run would have chosen, so a yes is one word), done, unfinished, and every decision made on your behalf. To answer a parked task, reply in chat; the orchestrator records your decision with the normal tools and calls `unpark_task`. If you disagree with a decision the run made, say so and the task goes back to that stage.

## Limits to know about

- Budgets are checked between turns: one turn can start a few sessions before the run notices the `max_dispatches` limit.
- Autonomy is as good as the suggested answers in the analysis documents. They are shown in the report for exactly that reason, and the never-autonomous list is the guard for the areas where a wrong guess is expensive.
- Turns run one at a time. Tasks on one repo checkout never run in parallel unless the repo has `worktree` enabled.
