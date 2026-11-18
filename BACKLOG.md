# Backlog

Work not done yet, most valuable first. Items come from the community research of 2026-11-18 and from loose ends of earlier work. Move an item to the README's "covered" table when it ships, and delete it here.

## To build

Nothing planned. Add items here as they are found.


## Parked

- **Worktree per task** for running stories in parallel. Built and tested once, then removed on 2026-11-18: the target repo is about 20 GB, so each story would need a full extra working copy. Revisit with a sparse option (`worktree_sparse`: create the worktree without a checkout, then check out only the listed folders) or if a smaller repo needs parallel stories. Notes from the design: one worktree per task and repo (not per dispatch, so retries see earlier changes), config looked up by the repo and files judged in the worktree, `remove_worktree` that refuses on uncommitted work, `worktree_setup` for ignored files such as `node_modules`.

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
