# Features and AI practices

## What it can do

- **Three ways in:** a Jira key, a plain description, or resume by task id, Jira key or PR number.
- **Triage by risk:** small reversible changes skip straight to coding; risky or vague ones get requirement, design and plan first.
- **Versioned documents:** fixed templates, each revision kept, stamped with the skill version and AI platform that wrote it. Open and edit them in any editor.
- **Approval gates** on risky plans, with an optional auto-approve timeout.
- **Big stories split for review**, one child task per part, with a progress table on the parent.
- **Branch per task**, never `main`, with a configurable name pattern.
- **Tests first (optional)** with the tests frozen, a **scope check** against the plan, and **wrong-spec handling** that sends a task back instead of patching around it.
- **Test, retry, review** with capped retries, then flagged for a human.
- **Any AI platform** (Copilot CLI, Claude Code, Cursor, or a custom command) for the chat and for the workers, chosen independently, with the model settable per platform or per repo.
- **Read-only enforced twice** for analysis: by the platform CLI where possible and by a git check afterwards.
- **Memory:** durable team notes (learnings), the repo's own instruction files, and full-text search over past decisions.
- **Resilience:** double-dispatch guard, lost-process detection, cancel, timeout, live elapsed time and last output, daily backups, automatic pruning of old session folders.
- **Workspaces and multi-repo:** read context from other repos; split changes that span repos into one task per repo.

## AI practices: covered and roadmap

Practices the community commonly expects when AI does software delivery, and where this project stands.

**Covered**

| Area | What you get |
|---|---|
| Context | Fresh one-shot worker sessions, a small orchestrator, hand-off through Markdown documents |
| Memory | Learnings, repo instruction files (capped; files the AI CLI reads itself are not repeated, agents and skills are indexed), full-text search over past decisions |
| Control | Approval gates, read-only analysis (enforced twice), a branch per task, never `main` |
| Checks done by code | Scope check, frozen tests, double-dispatch guard, tests with capped retries |
| Process | Triage by risk, requirement → design → plan, big-story split, wrong-spec return |
| Independent review | Optional read-only review of the branch diff on a different platform or model than the coder, with a verdict and findings; see [workflow.md](workflow.md) |
| Traceability | Versioned documents stamped with skill version and platform, task history, PR lookup |
| Operations | Model pinning, timeout, cancel, lost-process detection, daily backups, pruning |
| Portability | Copilot CLI, Claude Code, Cursor or a custom command, chosen separately for chat and workers |
| Feedback loop | `edge-case-review` turns recurring problems into rules, repo-instruction suggestions or learnings. The server counts logged edge cases and tasks out of test retries since the last review; at `edge_case_review_after` (policy, default 5, 0 = off) the orchestrator offers the review as one option, never runs it unasked |
| Evals | `evals check` (free, offline) and `evals run` (live) test the five stage skills (four analysis skills and `code-review`) against fixed sample stories (8 cases), with `--repeat N` to measure flakiness. A free offline test also checks that the orchestrator prompt and skills only name tools that exist; see [Evals](cost-and-evals.md#evals-for-skills-and-prompts) |
| Data handling | Secret redaction on every prompt (on by default) and an untrusted-content warning in every dispatch; see [Data handling](security.md#data-handling-and-secrets) |
| Restricted workers | Secret files and risky commands are denied to worker sessions through each CLI's own rules, plus an optional OS sandbox; each dispatch records what was and was not enforced; see [Restrictions](security.md#restricting-what-workers-can-touch) |
| Team sharing | `shared_dir` in `config.json` moves `policy.json` and `learnings/` into a folder the team keeps in git; tasks and documents stay private. Sync is plain git; see [learnings.md](learnings.md) |
| Cost visibility | Every dispatch records token use; `dispatches usage` and the `get_usage` tool add it up per task, kind and platform; see [Cost](cost-and-evals.md#cost-per-dispatch). A per-task budget can warn or block further dispatches |
| Project knowledge | The agent co-writes Markdown docs from your instructions and selected source files, then publishes them one way, from your local files to Confluence, when you ask. No repo-wide scan; edits made on Confluence are never pulled back (you are warned before they are overwritten), and deletions are never propagated. See [knowledge-pipeline.md](knowledge-pipeline.md) |

**Roadmap:** knowledge synthesis and freshness tracking remain in [BACKLOG.md](../BACKLOG.md).
