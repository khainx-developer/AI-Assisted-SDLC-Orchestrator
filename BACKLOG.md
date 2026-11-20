# Backlog

Work not done yet, most valuable first. Items come from the community research of 2026-11-18 and from loose ends of earlier work. Move an item to the README's "covered" table when it ships, and delete it here.

## To build

From the workflow review of 2026-11-18, most valuable first. Research sources were mostly blogs and preprints, so treat the figures as indicative.

1. **Run all evals live and verify the Claude adapter.** Run the six unrun cases and `evals run --repeat 3`, and try the Claude Code adapter against the real CLI (also covers the restricted-workers check under Done recently). Unblocks every skill change below, because without it an improvement cannot be told from noise. Check the current headless/SDK billing policy first (one source claimed a change in mid-2026; unconfirmed).
2. **Better independent review.** Research reports frontier models catching only about 15-31% of issues human reviewers flag on a diff alone. Give the reviewer the acceptance criteria as a checklist and let it read callers and tests around the diff. Add a deterministic pass first (lint, typecheck, test coverage of the changed lines). Track how often a human overrules the review; if it approves every time, revisit (see architecture.md decisions).
3. **Compute triage flags from the repo.** `files_affected` and `has_precedent` are estimated from ticket text and drive the heavy/light split. Add a small read-only dispatch at task creation that computes them, and use the data to check the split.
4. **Close the review loop.** When review finds problems, send them back to implementation automatically within the retry cap, instead of a human relaying them.
5. **Tests first as the default for heavy tasks.** Today it is off and only offered for some tasks. Specs define intent, tests define success; heavy tasks already pay for a plan. Add a `bug-repro` skill that writes a failing reproduction before the plan for bug fixes.
6. **Cost caps per kind.** Per-kind timeout and token cap (analysis stalls should be caught sooner), and a skip-design shortcut when `has_precedent` is true and the change is not breaking.
7. **Hooks for in-session enforcement (Claude Code).** Block a write outside the plan's scope or a secret read as it happens, instead of failing the dispatch afterwards. Could also give Claude workers structured output and a live tail via the Agent SDK (streaming progress is listed as open in architecture.md).
8. **Orchestrator prompt eval.** Evals do not run the orchestrator's own system prompt; routing mistakes there cost more than a bad document.
10. **Project knowledge synthesis and freshness.** The agent drafts user-directed Markdown from chat context and exact user-selected source files, saves approved drafts outside the target repo, and supports user-approved bidirectional Confluence sync. Do not add automatic repository scanning or survey generation; it is unsuitable for large repositories. Remaining work: synthesis across manually selected documents and freshness tracking. See [docs/knowledge-pipeline.md](docs/knowledge-pipeline.md).
9. **Archive finished changes as a delta against the repo's spec** (idea borrowed from OpenSpec), so later requirement stages start from what the system does now. Not adopting Spec Kit or OpenSpec themselves.


## Parked

- **Sparse worktrees.** Worktree per task is built again (`projects.<root>.worktree`, default off). A 20 GB repo still needs a full extra copy per story; add `worktree_sparse` (create the worktree without a checkout, then check out only the listed folders).

## Done recently

- Untrusted content: the warning in every dispatch prompt now also covers what the session fetches or runs itself (web, tool and MCP output, command output), and the README says plainly that this is an instruction to the model, not a control.

- Output scan: warns when a session's printed output or a file it wrote contains a secret-looking string (`secrets_in_output`, `secrets_in_files`). Warning only, same patterns and switch as prompt redaction.

- Restricted workers: secret-file and command deny rules per platform (Claude, Copilot enforced; Cursor and custom CLIs reported as not enforced) plus an optional sandbox. Not yet tried against a real session: check that Claude honours `--settings` deny rules with `acceptEdits`, that Copilot accepts the `read()`/`write()` rule forms, and that `--sandbox` behaves in `-p` runs.

- Per-task `base_branch` (defaults to the checked-out branch) and a guard against two write sessions sharing one checkout.

## To watch

- **MCP spec 2026-07-28.** Stateless HTTP, Tasks as an extension polled with `tasks/get`, server-initiated requests replaced. Our servers use stdio, so no change is needed now. Read the official changelog before exposing either server over HTTP, and consider mapping `get_dispatch_result` onto the Tasks extension. Not verified beyond secondary summaries.
- **Agent identity.** No authoritative guidance found on per-agent identities or short-lived credentials. Revisit when it exists.
- **Adding MCP servers.** Add one only for a real external system or for state the servers must enforce. Give read-heavy sources (logs, docs, schemas) to worker sessions, not the orchestrator, to keep its tool list small. See the 2026-11-17 discussion.

## Loose ends

- Nothing from the budget, independent review, edge-case prompt, eval depth and team-sharing work is committed. Suggested commits: budget; review plus evals; edge-case prompt plus team sharing.
- Run the other six eval cases live, including `review-clean`, and `evals run --repeat 3` once to see real flakiness. Only `requirement-retry` and `review-seeded-bug` have run live.
- Re-run `node dist/cli.js install --target <tool>` and reload after pulling, so the orchestrator picks up the new prompt lines (independent review, review prompt).
- `shared_dir` was tested with the fake CLI only. Try it with two real clones before telling a team to rely on it.
