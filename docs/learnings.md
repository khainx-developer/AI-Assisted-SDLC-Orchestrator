# Learnings: how the orchestrator's memory works

Learnings are short, durable notes that outlive any single task and are fed back into every later task on the same repo. They are the orchestrator's only long-term memory beyond task history.

Part of the [documentation](../README.md#documentation). This page is the practical guide; the reasoning behind it is under Decisions in [architecture.md](architecture.md#decisions-and-when-to-revisit-them).

## What belongs in learnings (and what doesn't)

Only knowledge with **no natural home in the repo**:

| Kind | Example note |
|---|---|
| Ticketing-system quirks | `PROJ tickets never fill Acceptance Criteria` |
| Cross-repo process habits | `This team always squash-merges` |
| How requests get phrased | `"the dashboard" is ambiguous for this team: ask which one` |

Everything else has a better place:

| Knowledge | Goes to | Why |
|---|---|---|
| A routing rule (which stages, gates, retries) | `policy.json` (`update_policy`) | Enforced by code, not by a model reading a note |
| A fact about the codebase (structure, conventions, deprecated modules, flaky tests) | The repo's own `.github/agents`, `.github/skills` or `CLAUDE.md` | Committed, team-visible, read by coding sessions |
| Data about one task (artifacts, edge cases) | SQLite (`workflow.db`) | Searchable per task; see `search_precedent` |

**Calibration bar:** a note earns its place only if it would matter to the next several tasks on that repo. Not every one-off observation.

## Where it lives

In the orchestrator's data dir (`~/.ai-sdlc-orchestrator`, override with `SDLC_DATA_DIR`):

```
learnings/
  projecta-3f9a1c.md    one file per repo
  _global.md            notes that apply to every repo
```

- The repo file name is `projects.<root>.slug` from `config.json` if you set one, otherwise `<folder name>-<6-char hash of the path>`. The hash keeps two repos both named `api` apart. Set a `slug` to keep notes when you move a repo.
- Files are plain markdown. Each note is one line:

```
- [2026-11-15 · task_ab12cd34] PROJ tickets never fill Acceptance Criteria
```

  Date, optional source task, then the note. You can edit the files by hand. Keep the `- [` prefix, because that is how notes are counted.
- **Cap: 20 notes per file.** The file is injected into every dispatch, so it has to stay small. At the cap, writing is refused until you retire a note.
- **Sharing with a team:** set `shared_dir` in `config.json` to a folder the team keeps in git (each person clones it). `learnings/` and `policy.json` then live there; tasks, documents and dispatches stay private. Give every shared repo a `projects.<root>.slug`, because the default slug includes a hash of the local path, which differs on each machine. A relative `shared_dir` is taken from the data dir. Sync is plain git (pull, commit, push); the orchestrator never runs it.
- `learnings/` is included in the daily backup (`backups/learnings-<date>/`, newest 14 kept).

## How notes get written

Two ways only:

1. **You tell the orchestrator to remember something.** "Remember that this team always squash-merges." It calls `write_learning` (without `project_root` if it applies to every repo).
2. **`edge-case-review`.** You run it periodically. It groups logged edge cases, and for each recurring pattern (3 or more) proposes exactly one of: a policy patch, a suggested repo-instruction addition, or a learning. You approve each one.

**Never automatically from a dispatched session, a ticket or a repo file.** Those can contain text planted by someone else, and a note is injected into every future dispatch. If a dispatched session discovers a codebase fact that isn't written down anywhere, it lists it under **Suggested repo-instruction additions** in its artifact. The orchestrator shows you that, and you commit it to the repo yourself.

## How notes get read

| When | Who reads | How |
|---|---|---|
| Intake (`jira-intake`, `triage-task`) | The orchestrator | `read_learnings(project_root)`. Ticketing quirks and phrasing habits change how it reads a ticket and scores `requirement_clarity` |
| Every analysis dispatch (requirement, design, plan, breakdown) | The dispatch server | Injected into the worker prompt as a LEARNINGS block |
| Every coding dispatch | The dispatch server | Same injection |

The dispatch server reads the files itself, so the orchestrator never pastes notes into `instructions` and can't forget to. The repo file and `_global.md` are both included.

Analysis sessions also get the repo's own instruction files (`CLAUDE.md`, `AGENTS.md`, `.github/copilot-instructions.md`, `.github/agents`, `.github/skills`, `.cursor/rules`) injected as context only. Their directives to edit or run things are ignored there. Coding sessions read those files natively.

## Tools

On the `workflow-state` server:

| Tool | Purpose |
|---|---|
| `read_learnings(project_root)` | Repo notes plus global notes, and the file path |
| `write_learning(note, project_root?, source_task_id?)` | Append a dated note. Duplicates are ignored. Refused at the cap |
| `remove_learning(index, project_root?)` | Retire a note by its 1-based position in `read_learnings` |

## Keeping notes healthy

Notes go stale (a team changes its process, a ticket template gets fixed). Each note carries a date and source task so you can judge age. `edge-case-review` also reviews existing notes and proposes `remove_learning` for outdated ones, starting with the oldest when a file is at the cap. A stale note that is wrongly injected is worse than no note.

## Example

1. Over several Jira tasks, the orchestrator records an edge case each time a requirement arrives with no Acceptance Criteria and it has to ask the human.
2. You run `edge-case-review`. It finds 4 matching cases, sees this isn't a routing rule or a codebase fact, and proposes: `PROJ tickets never fill Acceptance Criteria`.
3. You approve. `write_learning` appends the note to the repo's file.
4. Next task: at intake the orchestrator reads the note, scores `requirement_clarity: low` and routes through the full requirement stage. The requirement-analysis worker sees the same note in its prompt and asks for acceptance criteria instead of assuming them.

## What this deliberately does not do

- **No search or embeddings.** The files are small and read whole. Real retrieval is revisited only if keyword search demonstrably misses similar past cases (see `list_zero_hit_searches`).
- **No codemap or code index.** An index goes stale as code changes. Structural overviews belong in the repo's own instruction files. Revisit only if analysis sessions spend most of their time locating code (check `duration_ms` in `dispatches/<id>/meta.json`).
- **Not team-shared.** Learnings live in a per-machine data dir. If several people share one orchestrator setup, revisit this (see [architecture.md](architecture.md#decisions-and-when-to-revisit-them)).
