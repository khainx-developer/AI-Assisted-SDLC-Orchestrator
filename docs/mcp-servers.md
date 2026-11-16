# MCP servers

Four MCP servers are used. Two are built in this repo, two are reused. The installer (`node dist/cli.js install ...`) registers all four; see [clients/README.md](../clients/README.md) for manual registration.

## Built here

### `workflow-state` ([src/workflow-state/server.ts](../src/workflow-state/server.ts))

State, policy, artifacts and learnings. Storage is SQLite (`workflow.db`) plus `policy.json` and `learnings/`.

| Group | Tools |
|---|---|
| Tasks | `create_task`, `get_task_state`, `find_task`, `list_pending_tasks`, `list_child_tasks`, `delete_task` |
| Stages and gates | `list_valid_transitions`, `transition_stage`, `approve_stage`, `check_gates` |
| Artifacts | `record_stage_artifact` (from a `dispatch_id`, no copying), `get_stage_artifact` |
| Open questions | `get_open_questions` (parsed list + ready-to-print reply with how to answer and Options), `answer_open_questions` (records answers as a new version, no model call) |
| Policy | `get_policy`, `update_policy` (validated; a bad patch is rejected) |
| Edge cases and search | `record_edge_case`, `search_precedent`, `list_zero_hit_searches` |
| Dispatch bookkeeping | `set_dispatch_status`, `check_file_overlap`, `update_linked_refs` |
| Spec proven wrong | `report_spec_wrong` (sends a task back to plan / design / requirement with the issue as an open question) |
| Learnings | `read_learnings`, `write_learning`, `remove_learning` (see [learnings.md](learnings.md)) |

### `dispatch` ([src/dispatch/server.ts](../src/dispatch/server.ts))

Starts worker sessions on any configured AI platform and reports results.

| Tool | Purpose |
|---|---|
| `dispatch_analysis_task` | Read-only session running a stage skill (requirement, design, plan, breakdown). Gets learnings and the repo's own instruction files injected |
| `dispatch_test_authoring_task` | Optional tests-first step: read+write session that writes only the failing tests; the files it wrote are frozen for the coding session |
| `dispatch_coding_task` | Read+write session on the task branch (never `main`/`master`). Gets learnings injected. Checks the plan's scope (`target_files`), frozen tests (`frozen_from_dispatch`) and reports `spec_wrong` |
| `run_tests` | Runs the repo's test command. `expect_fail` adds a `verdict` (red / vacuous / broken) for tests written first |
| `get_repo_settings` | `tests_first`, `scope_check`, `scope_allow` and test command for a repo |
| `get_dispatch_result` | Status and outcome of any dispatch (returns immediately; poll it) |
| `list_projects` | Registered repos |
| `list_platforms` | Configured AI platforms and routing |

## Reused, not built

| Server | Use |
|---|---|
| Atlassian (Jira) | Read tickets for `jira` mode. Post comments or move status only when `sync_jira_status` is on |
| GitHub | Find the PR for a task branch, read review comments and CI results |

Installer flags: `--no-integrations` skips these two; `--jira-server` and `--github-server` set their server key names.

## Not MCP: worker platforms

Dispatched work runs through the Claude, Copilot or Cursor CLI, or a custom command declared in `config.json`. These are execution platforms, not MCP servers. See design doc §5.4.
