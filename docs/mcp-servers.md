# MCP servers

Four MCP servers are used. Two are built in this repo, two are reused. The installer (`node dist/cli/index.js install ...`) registers all four; see [clients/README.md](../clients/README.md) for manual registration.

## Built here

### `workflow-state` ([src/mcp/workflow/](../src/mcp/workflow/))

State, policy, artifacts and learnings. Storage is SQLite (`workflow.db`) plus `policy.json` and `learnings/`.

| Group | Tools |
|---|---|
| Tasks | `create_task`, `get_task_state`, `find_task`, `list_pending_tasks`, `list_child_tasks`, `delete_task` |
| Stages and gates | `list_valid_transitions`, `transition_stage`, `approve_stage`, `check_gates` |
| Artifacts | `record_stage_artifact` (from a `dispatch_id`, no copying), `get_stage_artifact` |
| Open questions | `get_open_questions` (parsed list + ready-to-print reply with how to answer and Options), `answer_open_questions` (records answers as a new version, no model call) |
| Policy | `get_policy`, `update_policy` (validated; a bad patch is rejected) |
| Edge cases and search | `record_edge_case`, `search_precedent`, `list_zero_hit_searches` |
| Change log | `record_change`, `list_changes`, `fold_changes`: small change requests made after the documents were written; sessions follow the log on top of the documents, so nothing is regenerated |
| Review prompt | `get_review_signal` (is an `edge-case-review` due: problems since the last review vs `edge_case_review_after`), `mark_edge_cases_reviewed` |
| Dispatch bookkeeping | `set_dispatch_status`, `check_file_overlap` (also says whether the other story has the same `base_branch`), `update_linked_refs`, `set_task_base` |
| Spec proven wrong | `report_spec_wrong` (sends a task back to plan / design / requirement with the issue as an open question) |
| Learnings | `read_learnings`, `write_learning`, `remove_learning` (see [learnings.md](learnings.md)) |
| Unattended runs | `start_autonomous_run`, `stop_autonomous_run`, `list_runnable_tasks`, `autonomous_answer_open_questions`, `park_task`, `unpark_task`, `mark_ready_for_review`, `get_autonomous_run_report`; `approve_stage` also accepts an `autonomous:<run_id>` approver, which the server checks against `policy.autonomy` (see [autonomous-mode.md](autonomous-mode.md)) |

### `dispatch` ([src/mcp/dispatch/](../src/mcp/dispatch/))

Starts worker sessions on any configured AI platform and reports results. Dispatches are always asynchronous: a `dispatch_*` call returns a `dispatch_id` and `get_dispatch_result` is how the outcome comes back. How a session runs and what is checked afterwards: [architecture.md](architecture.md).

| Tool | Purpose |
|---|---|
| `dispatch_analysis_task` | Read-only session running a stage skill (requirement, design, plan, breakdown). Gets learnings and the repo's own instruction files injected |
| `read_project_source_files` | Reads only exact user-named relative paths (up to 12 files); no directory listing, globbing, recursive traversal or project scan. Secret-like files are denied, size-capped and redacted |
| `list_knowledge_documents` | Lists Markdown documents in one project's separate knowledge store; does not inspect the source repo |
| `read_knowledge_document` | Reads one Markdown document from the separate knowledge store; rejects traversal and symlinks |
| `read_knowledge_document_for_sync` | Reads a Markdown document for publishing only when it passes the secret-pattern check |
| `write_knowledge_document` | Creates or explicitly overwrites one Markdown knowledge document outside the source repo; overwrite is off by default |
| `configure_knowledge_sync` | Stores the user-selected Confluence site, space and parent identifiers locally; makes no remote request |
| `get_knowledge_sync_state` | Lists local page mappings and last-synced hashes |
| `read_knowledge_sync_baseline` | Reads the last-synced content for one mapped document |
| `reconcile_knowledge_document` | Compares local and remote content against the baseline; never writes either side |
| `record_knowledge_sync_baseline` | Records a successful, user-approved remote write/adoption and its local baseline |
| `dispatch_test_authoring_task` | Optional tests-first step: read+write session that writes only the failing tests; the files it wrote are frozen for the coding session |
| `dispatch_coding_task` | Read+write session on the task branch (never `main`/`master`), in the repo checkout, starting a new branch from the task's `base_branch`. Refused while another task's write session is running in the same repo. Gets learnings injected. Checks the plan's scope (`target_files`), frozen tests (`frozen_from_dispatch`) and reports `spec_wrong` |
| `dispatch_review_task` | Optional independent code review: read-only session on a different platform or model than the coder (`review_platform` in config.json), given the branch diff against `base_branch` (default `main`, else `master`) plus the requirement and plan as `context`. The call reports `independent` and why; the result's `artifact` is the review (verdict, findings, plan compliance, tests). Advice only, not recorded as a stage document |
| `run_tests` | Runs the repo's test command. `expect_fail` adds a `verdict` (red / vacuous / broken) for tests written first |
| `get_repo_settings` | `tests_first`, `scope_check`, `scope_allow` and test command for a repo |
| `get_dispatch_result` | Status and outcome of any dispatch. `wait_seconds` (max 55) holds the call until it finishes. While running it reports `elapsed_seconds`, `quiet_seconds` and `progress_tail` (the session's last printed output, when the CLI streams any). `redacted` lists secret-looking strings removed from the prompt (kind to count, never the values). `secrets_in_output` / `secrets_in_files` warn that a secret-looking string appeared in what the session printed or in a file it wrote (kind and count, never the value). `restrictions` says which secret-file, command and sandbox rules the platform enforced for the session and which it could not |
| `cancel_dispatch` | Stops an in-flight dispatch (kills the CLI and its child processes) and records it as failed so the stage can be retried. Only after the human chooses it |
| `get_usage` | Token use (and cost where the CLI reports it) of finished dispatches, in total and by kind, platform and task. `task_id` narrows it to one story. Estimated numbers are a lower bound. With `task_id` and `project_root` it also shows the task against its budget. All `dispatch_*` tools take `override_budget` (only after the human agrees) to continue past a `block` budget |
| `list_projects` | Registered repos |
| `get_config` | All settings, global and per project, and which ones can be changed |
| `add_project`, `remove_project` | Register or unregister a repo (asks the human first) |
| `update_config` | Set or unset one setting (`worktree`, `platform`, `model`, `test_command`, ...); same validation as `sdlc-orchestrator config set` |
| `remove_worktree` | Delete a task's git worktree; refuses uncommitted work unless forced |
| `list_platforms` | Configured AI platforms and routing |

## Reused, not built

| Server | Use |
|---|---|
| Atlassian (Jira and Confluence) | Read Jira tickets; optionally read/search/create/update Confluence project-knowledge pages when the user explicitly starts a sync |
| GitHub | Find the PR for a task branch, read review comments and CI results |

Installer flags: `--no-integrations` skips these two; `--jira-server` and `--github-server` set their server key names.

## Not MCP: worker platforms

Dispatched work runs through the Claude, Copilot or Cursor CLI, or a custom command declared in `config.json`. These are execution platforms, not MCP servers. How platforms are chosen and configured: [Configuration](configuration.md).
