# Cost and evals

## Cost per dispatch

Each finished dispatch records `usage` in its `meta.json`. Where the number comes from depends on the AI CLI:

| Platform | Tokens | Cost |
|---|---|---|
| Claude Code | `reported`: exact, from the CLI (cached input counted as input) | reported in USD |
| Copilot CLI, Cursor, custom | `estimated`: prompt sent plus text printed, about 4 characters per token | not available |

An estimate is a **lower bound**: a session that explores a repo reads far more than its prompt, and that reading is not counted. Use it to compare runs and spot the stage that is growing, not to bill. `node dist/cli/index.js dispatches usage --task <id>` (or ask the orchestrator, which has the `get_usage` tool) adds it up by kind, platform and task, and says how many numbers are exact.

There is no limit on a single running session: it cannot be stopped by token count, only by `dispatch_timeout_minutes`. What you can set is a **budget per task**, checked between dispatches:

```json
{ "budget": { "task_tokens": 400000, "task_cost_usd": 5, "action": "warn" },
  "projects": { "D:/work/ProjectA": { "budget": { "task_tokens": 150000, "action": "block" } } } }
```
- `task_tokens` counts input plus output of the task's finished dispatches; `task_cost_usd` counts only costs the CLI reported (Claude Code). Set either or both. A repo's `budget` overrides the global one field by field.
- `warn` (default): a dispatch that leaves the task at or over budget carries a `budget_warning`, and the orchestrator tells you and asks before dispatching more. Work is never stopped.
- `block`: once the task is over, new dispatches for it are refused with a message. You can ask the orchestrator to continue anyway (it passes `override_budget`), or raise the budget.
- Because estimated tokens are a lower bound, a task can be over budget before the numbers say so. For a Claude Code repo the numbers are exact. `get_usage` with `task_id` and `project_root` shows a task against its budget.

## Evals for skills and prompts

`evals/cases/*.json` are fixed sample stories, one or two per stage skill (`requirement-analysis`, `design-analysis`, `plan-creation`, `task-breakdown`, `code-review`). Each has a small fixture repo and **shape checks** on the document the skill produces: the template headings, numbered acceptance criteria, open questions in the `- **Q1.**` format the tooling reads, no design talk in a requirement, a Test Plan with at least two behaviours, "No split" answered exactly. `evals/golden/*.md` holds a known-good document for each case.

- `evals check` is free and runs inside `npm test`. It proves the checks accept the golden documents and reject broken ones, and that every analysis skill has a case.
- `evals run` sends each case through the real dispatch path (same prompt builder, same platform adapter, same read-only guard) in a throwaway repo, judges the document, saves the run under `~/.ai-sdlc-orchestrator/evals/results/`, and reports a **REGRESSION** when a case that passed last time fails now, with both skill versions (content hashes). Run it after editing a skill, and when you change the model. `--repeat N` runs each case N times and lists a case that passed some runs and failed others as **FLAKY** (not a regression, since some runs passed). It costs one real session per case per repeat, so try `--case requirement-retry` first.

What it does not do: judge whether the content is *good* (a wrong but well-formed requirement passes), run the orchestrator's own system prompt, or repeat a case to measure how often a flaky skill fails. Add a case when a real story goes wrong in a way the checks could have caught (`evals/cases/<name>.json` plus `evals/golden/<name>.md`; the name must match the file name).
