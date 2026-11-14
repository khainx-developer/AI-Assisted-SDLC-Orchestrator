---
name: triage-task
description: Orchestrator meta-skill. Computes the five triage flags consistently for create_task.
---
# triage-task

Run inline on every new task. Produce the flags object passed to `create_task`. Do not read the codebase deeply; use the task text, and a `search_precedent` call if useful. When unsure, pick the HEAVY value and say why in the task description.

| Flag | Rule |
|---|---|
| files_affected | Rough count of files/modules. A guess is fine. |
| reversible | false for migrations, schema changes, deletions, data rewrites, anything hard to revert after it ships. |
| breaking | true if it touches a public API, shared library or another consumer's contract. |
| has_precedent | true if a similar pattern plausibly exists in the repo. |
| requirement_clarity | `high` if explicit input/output/acceptance criteria are given (a Jira ticket with filled Acceptance Criteria is high automatically). `low` for vague or one-line ad-hoc requests. |

Heavy = breaking OR not reversible OR clarity low. The server applies this; you only supply honest flags.
