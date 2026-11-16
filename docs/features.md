# Features

A one-page map. Each line links to where it is explained.

## Working a story
- **Three ways in:** a Jira key, a plain description, or resume by task id / Jira key / PR number. [README: Use it](../README.md#use-it), design §7
- **Triage by risk:** five flags decide the path. Small reversible changes go straight to implementation; breaking, irreversible or vague ones go through requirement, design and plan. Design §6.1
- **Dispatched analysis:** requirement, design, plan and breakdown run in read-only worker sessions so the orchestrator's context stays small. Design §5.2, §8.3
- **Versioned artifacts:** fixed templates, revisions stored as new versions, each stamped with skill version and platform. Design §9
- **Approval gates:** risky plans block implementation until you approve; optional auto-approve timeout. Design §6.5
- **Branch per task:** created automatically, never `main`. Name pattern is configurable globally or per repo (`branch set`, default `story/{key}`). [README: Configuration](../README.md#configuration), design §6.4
- **Test, retry, review:** capped retries, then review flagged `needs_attention`. Design §6.6
- **Tests first (optional):** a separate session writes the failing tests, they are checked to fail for the right reason (`red`, not `vacuous` or `broken`) and frozen, then the coding session must make them pass without editing them. Off by default; the orchestrator offers it only for bug fixes, logic and risky changes. [README: Tests first](../README.md#tests-first-scope-and-wrong-specs), design §6.8
- **Scope check:** the plan's "Files touched" is the allowed scope of the coding session; files changed outside it are reported (`warn`, default) or fail the dispatch (`fail`). Design §6.8
- **Spec proven wrong:** a coding session can say the plan itself is wrong. The task goes back to plan / design / requirement with the issue added as an open question, instead of being patched around; capped per task. Design §6.8
- **Multi-repo:** read-only context from other repos; one child task per repo for changes that span repos, with coordinated release. Design §6.7
- **Non-git workspace root:** list the git children as `child_repos`; analysis runs at the root, implementation as one child task per repo that inherits the workspace settings. [README: Configuration](../README.md#configuration)
- **Every reply ends with numbered options**, so there are no commands to remember. [README: Use it](../README.md#use-it)

## Memory and learning
- **Learnings:** durable notes about ticketing quirks, team habits and request phrasing, injected into every dispatch. [learnings.md](learnings.md)
- **Repo instruction files** are injected into analysis sessions as context. [learnings.md](learnings.md#how-notes-get-read)
- **Suggested repo-instruction additions:** codebase facts a session discovers are surfaced to you to commit to the repo, not hidden in a private store. [learnings.md](learnings.md#how-notes-get-written)
- **Edge cases and `edge-case-review`:** judgment calls are logged; recurring ones become a policy rule, a repo suggestion or a learning. Design §6.3, §8.2
- **Precedent search:** SQLite FTS5 over past artifacts and edge cases. No embeddings or code index, with stated triggers for revisiting. Design §9.6, §9.8

## Platforms and safety
- **Any AI platform** for hosting and for workers (Copilot CLI, Claude Code, Cursor, custom), chosen independently, per mode or per repo, with the AI model settable per platform or per repo (`model set`). Design §5.4
- **Read-only enforced twice:** by the platform CLI where possible, and by a git-status check after every analysis session. Design §5.2
- **Resilience:** in-flight dispatch guard against double dispatch, lost-process detection, daily backups of `workflow.db` and `learnings/`. Design §5.1

## Operating it
- **CLI:** install, repos, tasks. [README: Commands](../README.md#commands)
- **MCP servers:** [mcp-servers.md](mcp-servers.md)
- **Configuration and data dir:** [README: Configuration](../README.md#configuration)
- **Troubleshooting:** [README: Troubleshooting](../README.md#troubleshooting)
