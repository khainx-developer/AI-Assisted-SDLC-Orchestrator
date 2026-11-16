# AI-Assisted SDLC Orchestrator — Design Document

## 1. Motivation

Modern AI coding models are strong enough to write code directly from a well-scoped task. What they still lack is **reliable control over process**: knowing which SDLC stage a task is in, when to skip steps for trivial work, when to enforce requirement/design/review for risky work, and how to recover from edge cases without burning tokens on every decision.

This project separates two concerns that used to be entangled in a single VS Code extension:

- **Control plane** — deterministic workflow state, stage transitions, policy rules. Cheap, testable, editor-independent.
- **Execution plane** — actual work (analysis *and* coding), done by dispatched sessions rather than inline in the orchestrator's own context.

The orchestrator never writes code itself, and it never does deep requirement/design/plan reasoning inline either — it decides *what happens next* and *dispatches* the work (analysis or coding) to the right place, keeping its own context light.

## 2. Goals

- Decouple the workflow engine from any single editor/tool (VS Code, Claude Code CLI, Claude Desktop should all be able to drive it).
- **Support multiple AI platforms (Copilot CLI, Claude Code, Cursor, and any other CLI-driven agent) on both sides**: as the *host* that runs the orchestrator, and as the *worker* that executes dispatched analysis/coding sessions. Host and worker are chosen independently, and workers can differ per mode or per repo (§5.4).
- Avoid re-litigating "should every task go through full brainstorm → requirement → plan → implementation → test → review" — route by task complexity instead.
- Reuse existing repo-level coding agents/skills (`.github/agents`, `.github/skills`) without duplicating their logic in the orchestrator.
- Accept a task from multiple entry sources (Jira ticket, ad-hoc description, resuming a pending task) through one consistent interface rather than separate one-off flows.
- Standardize the non-coding stages (requirement, design, plan, breakdown) with their own narrow skills and a consistent artifact format, the same way coding is standardized by repo-level skills.
- Keep the parts that age well (state, policy, integrations, artifact schema) in code/config; keep the parts that are model-dependent (judgment calls on ambiguous cases) as prompts that can be swapped out as models improve.
- Install once per machine (user profile level), usable across multiple repos/projects, not re-installed per repo.

## 3. Non-goals

- Not tied to one AI vendor. No platform-specific logic exists outside the adapter layer (§5.4); the state server, policy, skills and artifacts are platform-neutral.
- Not building a new chat UI. Reuse whatever MCP-capable client is already installed (Copilot CLI, Claude Code CLI, Claude Desktop).
- Not replacing `.github/agents` / `.github/skills` in individual repos. Those stay as-is; the orchestrator calls into them.
- Not trying to enumerate every possible edge case up front. The system is designed to start lean and grow rules from observed edge cases over time.
- Not making Jira the source of truth for workflow stage. Jira status sync is one-way and best-effort (see §7.3); `workflow-state` stays authoritative.
- Not having the orchestrator itself read the full codebase to do requirement/design/plan reasoning. That reasoning is dispatched to a scoped, mostly-read-only session (§8.3) so the orchestrator's own context stays small regardless of task complexity.

## 4. High-level architecture

```
┌───────────────────────────────────────────┐
│ MCP Client (Copilot CLI / Claude Code / Cursor │
│ / Claude Desktop) — any MCP-capable host   │
└───────────────────┬─────────────────────────┘
                     │
                     ▼
┌───────────────────────────────────────────┐
│          Orchestrator Agent                │
│  (system prompt + reasoning, no code exec) │
│  - Parses entry mode (jira/adhoc/resume)   │
│  - Reads workflow state                    │
│  - Applies hard rules where possible       │
│  - Falls back to judgment on edge cases    │
│  - Dispatches analysis AND coding work     │
│  - Never edits files directly, never does  │
│    deep requirement/design/plan reasoning  │
│    inline                                  │
└───────────────────┬─────────────────────────┘
                     │ MCP tool calls
     ┌───────────────┼───────────────┬─────────────────┬───────────────┐
     ▼               ▼               ▼                 ▼               ▼
┌───────────┐  ┌─────────────┐ ┌───────────────┐ ┌──────────────┐ ┌───────────┐
│ Workflow   │  │  Dispatch   │ │  GitHub MCP    │ │  CI/Test MCP │ │ Jira v2   │
│ State MCP  │  │  MCP        │ │  (official,    │ │  (reuse repo │ │ MCP       │
│ (custom)   │  │  (custom)   │ │   reused)      │ │  CI if any)  │ │ (reused)  │
└───────────┘  └──────┬──────┘ └───────────────┘ └──────────────┘ └───────────┘
                       │
         ┌─────────────┴──────────────┐
         ▼                             ▼
┌──────────────────────────────────────────────────┐
│  Platform adapter layer (§5.4)                    │
│  claude │ copilot │ cursor │ any custom CLI        │
└───────────────┬──────────────────┬───────────────┘
                ▼                  ▼
┌──────────────────────┐      ┌─────────────────────┐
│  Analysis session     │      │  Coding session      │
│  (read-only; skill    │      │  (read+write) at repo │
│  text injected into   │      │  root, follows that   │
│  the prompt)          │      │  repo's own agent /   │
│                        │      │  skill conventions    │
└──────────────────────┘      └─────────────────────┘
```

## 5. Components to build

### 5.1 `workflow-state` MCP server (custom — highest priority)

The source of truth for task state. Replaces the earlier "agent writes markdown stage files, extension reads them" approach with structured, queryable state.

Responsibilities:
- Store per-task state: current stage, history of transitions, flags computed at triage time, `linked_refs` (external identifiers — see §7.2), optional `parent_task_id` (see §8.2, task breakdown), and `related_repos` for multi-repo context (see §6.7).
- Store and serve the **stage policy** (which stages are required for which task profile) as data, not code, so it can be edited without redeploying the server.
- Store **stage artifacts** as structured, versioned, traceable records (see §9) — not just opaque blobs.
- Record edge cases the orchestrator had to resolve by judgment, with the resolution and reasoning, so recurring patterns can later be promoted into hard rules.

Suggested tools:
| Tool | Purpose |
|---|---|
| `create_task(project_root, title, description, source, linked_refs?, parent_task_id?, related_repos?)` | Register a new task, run initial triage (§6.1). `source` is `"jira"` or `"adhoc"`. `parent_task_id` set when created by a `task-breakdown` skill run. `related_repos` lists other repo paths this task needs read-only context from (§6.7) — not repos it writes to. |
| `get_task_state(task_id)` | Return current stage, flags, history, `linked_refs`, child tasks if any, and the last recorded edge case if the last transition was judgment-based. |
| `list_pending_tasks(project_root)` | Tasks not yet in a terminal stage, for a given repo. |
| `list_child_tasks(task_id)` | Children produced by a `task-breakdown` run, with their own stage/status each. |
| `list_valid_transitions(task_id)` | Allowed next stages given current state + policy. |
| `transition_stage(task_id, next_stage, reason)` | Validate against policy, record transition. |
| `record_stage_artifact(task_id, stage, content, input_refs?, skill_version?, platform?)` | Store a stage's artifact, stamped with the skill version and the AI platform that produced it. `input_refs` lists which prior artifacts/versions this was built from (see §9.2 — traceability). Creates a new version rather than overwriting if one already exists for that stage. |
| `get_stage_artifact(task_id, stage, version?)` | Retrieve an artifact; defaults to latest version. |
| `record_edge_case(task_id, description, decision, reasoning)` | Log a non-rule-based decision for later review. |
| `update_policy(policy_patch)` | Adjust stage/transition rules (admin-ish tool, used rarely). |
| `update_linked_refs(task_id, linked_refs_patch)` | Attach/merge external refs discovered later (e.g. a PR number). |
| `find_task(ref)` | Resume lookup by `task_id`, Jira key or PR number. |
| `approve_stage(task_id, stage, approved_by)` | Record human approval for a gated stage (§6.5). A newer artifact for that stage invalidates an older approval. |
| `check_gates()` | Poll-tick helper (§6.5b): auto-approves gates whose timeout elapsed and returns `awaiting_approval` / `auto_approved` events for the host to notify on. |
| `set_dispatch_status(task_id, dispatch_id, status, target_files?)` | Mark a dispatch `in-flight`/`completed`/`failed`. Refuses a second `in-flight` dispatch on the same task (prevents double-dispatch on resume). |
| `check_file_overlap(task_id, files)` | Other pending tasks on the same repo whose recorded files overlap (§5.2 concurrency check). |
| `search_precedent(query, project_root?)` | FTS5 search over past artifacts and edge cases (§9.6). |
| `get_policy()` | Current policy plus its version stamp. |
| `read_learnings(project_root)` | Return the repo's learnings file plus the global one (§9.7). Used by the orchestrator at intake/triage; dispatch reads the same files directly (§5.2). |
| `write_learning(note, project_root?, source_task_id?)` | Append a dated note to the repo's learnings file (or `_global.md` when `project_root` is omitted). Called only from `edge-case-review` or on a direct human instruction — never from dispatch output (§9.7). Refused at the note cap. |
| `remove_learning(index, project_root?)` | Retire an outdated note by its 1-based position; needed when a file is at the cap. |
| `list_zero_hit_searches(limit?)` | `search_precedent` queries that returned nothing — the observable signal for ever needing semantic search (§9.6). |

**Storage: SQLite** (decided). A single file under the server's data directory — no database server needed at this scale, and SQLite's built-in FTS5 doubles as the artifact search mechanism (§9.6) without standing up anything extra. Minimal schema:

```sql
CREATE TABLE tasks (
  task_id          TEXT PRIMARY KEY,
  project_root     TEXT NOT NULL,
  parent_task_id   TEXT REFERENCES tasks(task_id),
  title            TEXT NOT NULL,
  description      TEXT,
  source           TEXT NOT NULL CHECK (source IN ('jira','adhoc')),
  stage            TEXT NOT NULL,
  flags_json       TEXT NOT NULL,   -- {"files_affected":.., "reversible":.., "breaking":.., "has_precedent":.., "requirement_clarity":..}
  linked_refs_json TEXT,            -- {"jira_key":.., "pr_number":..}
  related_repos_json TEXT,          -- ["<path>", ...] — read-only context repos, §6.7
  needs_attention  INTEGER DEFAULT 0,
  coordinated_release INTEGER DEFAULT 0,
  stage_entered_at TEXT NOT NULL,   -- starts the auto-approve clock
  retry_count      INTEGER DEFAULT 0,
  dispatch_id      TEXT, dispatch_status TEXT,  -- in-flight | completed | failed
  target_files_json TEXT,           -- files touched by the last coding dispatch (overlap check)
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);
CREATE INDEX idx_tasks_repo_stage ON tasks(project_root, stage);

CREATE TABLE transitions (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id        TEXT NOT NULL REFERENCES tasks(task_id),
  from_stage     TEXT, to_stage TEXT,
  reason         TEXT,
  policy_version TEXT,
  created_at     TEXT NOT NULL
);

CREATE TABLE stage_artifacts (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id          TEXT NOT NULL REFERENCES tasks(task_id),
  stage            TEXT NOT NULL,
  version          INTEGER NOT NULL,
  content          TEXT NOT NULL,
  input_refs_json  TEXT,
  skill_version    TEXT,
  platform         TEXT,            -- which AI platform produced it
  created_at       TEXT NOT NULL,
  UNIQUE(task_id, stage, version)
);

CREATE TABLE edge_cases (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id     TEXT NOT NULL REFERENCES tasks(task_id),
  description TEXT, decision TEXT, reasoning TEXT,
  created_at  TEXT NOT NULL
);

CREATE TABLE approvals (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id     TEXT NOT NULL REFERENCES tasks(task_id),
  stage       TEXT NOT NULL,
  approved_by TEXT,
  created_at  TEXT NOT NULL
);
```

Flags, `linked_refs`, and `related_repos` stay as JSON columns rather than normalized tables — they're exactly the fields most likely to grow new keys as the policy evolves (§6.3), and SQLite's `json_extract()` is enough to query them when needed without a migration every time a flag is added. `tasks`, `transitions`, `stage_artifacts`, `edge_cases`, and `approvals` stay normalized columns, since those are the fields queried by `task_id`/`project_root`/`stage` constantly and benefit from real indexes.

**Implementation notes worth getting right from the start, not retrofitted later:**
- **Validate `update_policy` writes.** `policy.json` gets hand-edited a lot early on; a typo or a dropped required field shouldn't just sit there until some unrelated task's `transition_stage` call breaks on it later. Reject the write with a clear error if it fails schema validation — fail loud, at edit time, not quietly, at use time.
- **Back up `workflow.db` and `learnings/` on a schedule.** Once these hold months of task history, artifacts, edge cases and learnings, they're the system's only memory — a disk issue or accidental delete loses all of it. A daily copy to another location is enough; nothing fancy needed.
- **Dispatch calls need an in-flight status, not just a result.** If a session drops mid-`dispatch_coding_task` and the task is later picked up via `resume` (§7.1), the orchestrator needs to know a dispatch was already running before firing another one against the same branch — otherwise `resume` can double-dispatch. Track `dispatch_status` (in-flight / completed / failed) per task and check it before any retry or resume touches a task that was mid-dispatch.

### 5.2 `dispatch` MCP server (custom)

Bridges the orchestrator to actual work (analysis *or* coding) without the orchestrator needing to do that work in its own context.

Suggested tools:
| Tool | Purpose |
|---|---|
| `dispatch_analysis_task(task_id, project_root, stage, skill, instructions, additional_read_roots?, platform?, model?)` | Start a **read-only** session scoped to `project_root` (tools limited to read/search — no Edit/Write) running one of the stage-execution skills (§8.3: `requirement-analysis`, `task-breakdown`, `design-analysis`, `plan-creation`). `additional_read_roots` grants read access to the task's `related_repos` (§6.7) for cross-repo context, e.g. checking a shared API contract repo while designing a change to the consumer. Returns the structured artifact content for that stage; orchestrator then calls `record_stage_artifact`. |
| `dispatch_coding_task(task_id, project_root, stage, branch, instructions, target_files?, additional_read_roots?, platform?, model?)` | Start a **read+write** coding session on the task's `branch` (§6.4; created if missing, `main`/`master` refused) scoped to `project_root` (write access stays confined to `project_root` even when `additional_read_roots` is set), following that repo's own agent/skill conventions (`.github/agents`, `.github/skills`, `CLAUDE.md`, `.cursor/rules`, `AGENTS.md`, whichever the chosen platform reads). Returns a structured result (files changed, summary, success/failure, `pr_number` if opened — feed into `update_linked_refs`). |
| `run_tests(task_id, project_root)` | Run the repo's existing test command, structured pass/fail. |
| `list_platforms()` | Built-in and custom platforms, and which is configured for analysis/coding. |
| `get_dispatch_result(dispatch_id)` | Retrieve the result of a dispatch. Both dispatch tools return immediately with a `dispatch_id`; this is the only way results come back, polled by the orchestrator's runtime loop (§6.5b) rather than awaited synchronously. |

**Context injected into every dispatch.** Like skills (§5.4), the dispatch server assembles this itself rather than relying on the orchestrator to paste it into `instructions` (which would cost orchestrator context and can be forgotten):
- **Learnings** (§9.7): the repo's learnings file plus `_global.md`, read from the shared data dir. Applies to both analysis and coding dispatches.
- **The repo's own instruction files** (`.github/agents`, `.github/skills`, `CLAUDE.md`, `.cursor/rules`, `AGENTS.md`) — for analysis dispatches too, not only coding. The session is already read-only in `project_root`, so nothing prevents it. Dispatch resolves and injects these explicitly, since only some platforms load them natively (`claude -p` reads `CLAUDE.md`; Copilot CLI and Cursor will not reliably load `.github/agents`). In analysis mode they are framed as *context only*: any "edit/write/run" directive inside them is to be ignored, with the git-status check below as the backstop.

Keeping `dispatch_analysis_task` read-only is a deliberate safety/clarity boundary, enforced twice: natively where the platform CLI supports it (§5.4), and platform-neutrally by comparing `git status --porcelain` before and after the session. Any new change marks the dispatch `failed` with `read_only_violation` listing the paths, so a platform that cannot enforce read-only is still caught. The rationale: a requirement or plan session should never be able to accidentally modify code while "just exploring" the repo to inform its artifact.

**Concurrency / file-lock awareness.** `dispatch_coding_task` should record which files it actually touched on its branch. Before dispatching a *new* task, the orchestrator checks `list_pending_tasks(project_root)` for other in-flight tasks on the same repo whose recorded `target_files` overlap with the new task's expected scope (from the plan artifact). An overlap doesn't have to block the dispatch, but it should be surfaced — either as a warning to the caller or, if ambiguous, logged via `record_edge_case` — rather than letting two coding sessions silently race on the same files.

### 5.3 Reused, not built

- **GitHub MCP server** (official) — issues, PRs, code search, review comments, Actions runs.
- **Jira v2 MCP server** (official/community) — fetch issue details for `jira` mode, optionally post comments / move status on sync (§7.3).
- **Repo's own CI** (GitHub Actions or similar), if present — trigger/read via the GitHub MCP server rather than a custom test runner.

### 5.4 Platform adapters (multi-AI-platform support)

Every platform-specific detail lives in one adapter per platform (`src/dispatch/platforms.ts`). An adapter turns a platform-neutral request (mode, prompt, project root, extra read roots, model) into one headless CLI invocation and unwraps that CLI's output.

| Platform | CLI | Prompt delivery | Read-only (analysis) | Write (coding) | Extra read roots |
|---|---|---|---|---|---|
| `claude` | `claude -p --output-format json` | stdin | `--allowedTools Read,Grep,Glob,WebSearch,WebFetch` + `--disallowedTools Edit,Write,Bash,...` | `--permission-mode acceptEdits` | `--add-dir` |
| `copilot` | `copilot -p` | argument | `--deny-tool write --deny-tool shell` | `--allow-all-tools` | `--add-dir` |
| `cursor` | `cursor-agent -p` | argument | omit `--force` (proposes only; verified by the git check); always `--trust` (headless workspace trust) | `--force` + `--trust` | named in prompt only |
| any other | declared in `config.json` | `stdin` / `arg` / `file` | git check only | per config | named in prompt only |

The flags above are defaults, not a guarantee: these CLIs change faster than this document, so each can be overridden or extended per platform with `command` / `extra_args` in `config.json`. They have not yet been exercised against the real CLIs (see §12).

Design points:
- **Skills are injected, not installed.** `dispatch_analysis_task` reads the stage skill's `SKILL.md` and embeds it in the prompt, so the same skill runs identically on every platform and `skill_version` (content hash) is computed in one place.
- **Platform-neutral result contract.** Analysis sessions end with only the artifact. Coding sessions end with a fenced `sdlc-result` JSON block (`success`, `summary`, `needs_clarification`, `question`, `pr_number`) that the runner parses, so no platform needs a bespoke output format. If the block is missing, success is inferred from the exit code. `files_changed` comes from git, not from the model's claim.
- **Prompt delivery degrades safely.** Argument-delivered prompts fall back to a prompt file on Windows `.cmd` shims, where multi-line arguments cannot be quoted safely.
- **Routing.** Precedence: explicit `platform` argument, then `projects.<root>.{analysis,coding}_platform` / `platform`, then global `analysis_platform` / `coding_platform`, then `default_platform`. This allows e.g. orchestrating from Copilot CLI, analysis on Claude, coding on Cursor, or a different tool for one legacy repo.
- **Host side is already neutral.** The orchestrator is MCP servers plus a Markdown system prompt, so any MCP host can run it (registration per client in `clients/README.md`). The platform hosting the orchestrator and the platforms doing the work are independent choices.
- **Recorded.** Each artifact stores the `platform` that produced it, so quality differences between platforms are visible later.
- **Adding a platform** is either a config-only entry (command + arg template with `{prompt}`, `{prompt_file}`, `{mode}`, `{model}`, `{project_root}`) or one adapter object in code.
- **Process tracking.** Each dispatch is a directory under the data dir (`meta.json`, `prompt.md`) holding pid, status and result. If the dispatch server restarts mid-run, `get_dispatch_result` detects the dead pid and reports `failed: process lost` rather than hanging in-flight forever.

## 6. Workflow policy design

### 6.1 Task triage (replaces "always run all 8 stages")

At `create_task`, compute a small set of flags instead of subjectively guessing complexity:

- `files_affected`: estimated number of files/modules touched
- `reversible`: can this change be trivially reverted vs hard to revert (migration, schema change, deletion)
- `breaking`: does this affect a public API / other consumers / shared library
- `has_precedent`: does a similar pattern already exist in the repo
- `requirement_clarity`: explicit input/output/acceptance criteria given, or vague — a Jira ticket with a filled-in "Acceptance Criteria" field scores `high` automatically; an ad-hoc one-liner defaults to `low` until the requirement stage fills it in

Routing rule of thumb:
- All flags "light" → skip brainstorm/requirement, go straight to implementation → test → review.
- Any flag "heavy" (`breaking = true`, `reversible = false`, or `requirement_clarity = low`) → require full pipeline: requirement → design → plan → implementation → test → review.

### 6.2 Stage set

1. **Requirement** — clarify intent, scope, acceptance criteria (skippable for simple tasks)
2. **Analyze / Design** — approach, affected components, risks (skippable for simple tasks)
3. **Task package / Plan** — concrete steps, files to touch, test plan
4. **Implementation** — dispatched to repo-level coding agent
5. **Unit test** — run via `run_tests`, structured pass/fail
6. **Review** — human or a review-focused coding agent pass, especially for `breaking`/`not reversible` tasks

### 6.3 Edge case handling

When no policy rule matches the current state cleanly:
1. Orchestrator reasons about it directly.
2. Calls `record_edge_case` with the decision and reasoning before transitioning.
3. Periodically, review `record_edge_case` logs: if a pattern recurs 3+ times, promote it into `update_policy` as a hard rule via the `edge-case-review` skill.

### 6.4 Branching convention

Every task gets its own branch, created automatically when coding starts. The name comes from `branch_pattern` in `config.json` (global, overridden per repo), default `task/{key}`, where `{key}` is `linked_refs.jira_key` when present and the `task_id` otherwise (e.g. `task/PROJ-123`, or `feature/PROJ-123` with `feature/{key}`). Placeholders: `{key}`, `{jira_key}`, `{task_id}`. A pattern with no placeholder, an unknown placeholder, or a result of `main`/`master` is rejected and reported as `branch_error` on the task instead of being used. The branch is created from whatever is checked out; a configurable base branch is not built. `dispatch_coding_task` always works on that branch, never directly on `main`/`master`. This gives two things for free:
- **Rollback by default.** Before merge, "undo" is just discarding the branch — `reversible: false` in the triage flags is really about *post-merge* reversibility (can you cleanly revert after it ships), not about whether the work-in-progress itself is safe to throw away.
- **A natural 1:1 mapping** task → branch → PR, which is what makes `linked_refs.pr_number` meaningful (§7.2) and what `run_tests`/CI should actually run against.

### 6.5 Approval gates

A stage existing in the pipeline doesn't by itself stop the orchestrator from moving past it unattended. For risky tasks, add an explicit gate: `policy.json` carries `requires_human_approval: [stage names]`, defaulting to `["plan"]` whenever `breaking = true` or `reversible = false`. `transition_stage` out of a gated stage is refused by `workflow-state` until a separate `approve_stage(task_id, stage)` call has been made — i.e. the artifact existing is not itself approval. This is what actually enforces "a human looks at the plan before risky code gets written," rather than relying on the orchestrator to remember to pause.

**Auto-approve timeout, for running as a long-lived unattended process.** A gate that blocks forever defeats the point of letting the orchestrator run on its own (§6.5b). Each gated stage carries an optional `auto_approve_after_hours` (e.g. `requires_human_approval: [{"stage": "plan", "auto_approve_after_hours": 24}]`) — the gate still blocks and still notifies (§6.5a) the moment it's hit, but if no explicit `approve_stage` call comes in before the window elapses, `workflow-state` approves it itself and records `approved_by: "auto-timeout"` in the `approvals` table (distinct from a human's name/id), plus a fresh notification that it was auto-approved so it's never silent. This keeps the review window real — a human who's watching still approves or blocks it manually within the window — while a long-running process doesn't stall indefinitely on a task nobody got to in time. Leave `auto_approve_after_hours` unset (blocks forever, as before) for the gates you genuinely never want to pass unattended; set it per-stage rather than globally, since "plan" on a `breaking` task deserves a much longer or absent timeout than something you're comfortable auto-approving after a day.

### 6.5a Human-in-the-loop: notifications and escape hatches

Two gaps that only show up once this runs unattended:

- **Approval gates need to actually reach a human, not just block silently.** When `transition_stage` hits a stage listed in `requires_human_approval`, fire a notification (push/alert — the orchestrator's host environment likely has a notification or scheduled-task mechanism already available; reuse that rather than building one) saying which task is waiting and on what. Otherwise an overnight or unattended run just looks like nothing happened, and a gate that nobody knows fired is no better than no gate.
- **Coding sessions need a third outcome besides success/failure.** `dispatch_coding_task` (§5.2) can hit genuine ambiguity the plan didn't catch (e.g. "two classes named `UserService` — which one?"). Add `needs_clarification: true` + a question as a possible result, which the orchestrator turns into a pause, a `record_edge_case` entry, and the same notification as above — instead of either failing outright or silently guessing an interpretation.

### 6.5b Long-lived orchestrator runtime (polling)

Resolves the earlier "on-demand vs long-lived" and "synchronous vs polling" open decisions in favor of **one long-lived process using polling** — the two choices support each other: a process that's only invoked on-demand can't catch an auto-approve timeout elapsing or a dispatch finishing on its own, and polling only makes sense if something is actually alive to do the polling.

The orchestrator runs as a continuous loop, ticking on an interval (e.g. every few minutes — frequent enough that gate timeouts and dispatch completion feel responsive, infrequent enough not to waste cycles on an MCP round-trip for nothing to report). Each tick:
1. **Poll in-flight dispatches.** For every task with a `dispatch_status` of "in-flight" (§5.1's implementation notes), call `get_dispatch_result`. On completion, advance the task's stage and clear the in-flight status; on failure, apply the retry policy (§6.6).
2. **Check gates for elapsed timeouts.** For every task sitting at a gated stage, compare elapsed time against `auto_approve_after_hours`; if elapsed, auto-approve and notify (§6.5).
3. **Accept new entry-point calls** (`jira`/`adhoc`/`resume`, §7.1) as they come in — the loop doesn't block on any one task while waiting for the others.

This also simplifies `dispatch_coding_task`/`dispatch_analysis_task` (§5.2): they always return immediately with a `dispatch_id` rather than blocking the caller, and `get_dispatch_result` (polled by the loop above, step 1) is the only way results come back — there's no separate "synchronous mode" to maintain.

### 6.6 Retry / failure policy

Formalize what happens when `run_tests` or `dispatch_coding_task` fails repeatedly, instead of leaving it to be improvised differently each time:
- `max_test_retries` in `policy.json` (e.g. `3`) — each failure re-dispatches `implementation` with the failure output appended to the instructions.
- On hitting the limit: transition to `review` anyway, but with a flag (e.g. `needs_attention: true`) so it's visibly different from a clean pass, rather than silently looking the same as a task that succeeded on the first try.
- Same pattern applies if `dispatch_coding_task` itself errors out (not a test failure, a dispatch failure) — cap retries, then surface rather than loop silently.

### 6.7 Multi-repo coordination

Two distinct multi-repo needs, handled differently — don't conflate them:

**Need A: this task needs to *look at* another repo, but only writes to one.** E.g. implementing a frontend change that must match a backend API contract defined in a separate repo. Handled by `related_repos` on the task (a list of other repo paths) and `additional_read_roots` on `dispatch_analysis_task`/`dispatch_coding_task` (§5.2) — read access only, never write. This is the common case and needs no schema beyond what's already there.

**Need B: a change genuinely spans two repos and both need commits.** E.g. an API contract change requiring commits in both the backend and frontend repos. Don't make `project_root` a list to handle this — instead, run `task-breakdown` (§8.3) to split into one child task per repo, each with its own `project_root` and `parent_task_id` pointing at the shared parent. This keeps every task's schema simple (always exactly one write target) while the parent/child graph (`list_child_tasks`) captures the coordination.

For Need B, coordinated release matters: you don't want the backend child merged days before the frontend child if they must ship together. Add a `coordinated_release: true` flag on the parent task (set by `task-breakdown` when it detects this case) — policy then requires *all* children to reach `review`/approved before *any* child is allowed to transition past review. The orchestrator checks `list_child_tasks(parent_task_id)` at that gate rather than treating each child as fully independent.

### 6.8 Write-session guards: scope, tests first, wrong specs

Three controls on the implementation stage. All are enforced by the dispatch server after the session, not by trusting the prompt, in the same way the read-only check (§5.2) does not trust an analysis session.

**Scope.** `dispatch_coding_task(target_files)` is the plan's "Files touched" (files, directories or globs). The runner records the dirty files and their content hashes before the session, and after it compares: only files whose content changed during *this* session are judged, so earlier attempts and frozen tests are not blamed on it. Files outside the scope come back as `scope_violation`. `scope_check` in `config.json` (global, per repo) is `warn` (default: the dispatch succeeds, the orchestrator shows the list and offers keep / revert / revise the plan), `fail` (the dispatch fails) or `off`. `scope_allow` lists paths always allowed, e.g. lockfiles. `warn` is the default because the plan's file list is an estimate made before the code exists, and a hard failure over one extra helper file would burn a retry for nothing.

**Tests first (optional).** Writing tests and code in one session lets the model fit the tests to its code. With `tests_first` (per repo, default off) or when the human accepts the orchestrator's offer, implementation becomes: `dispatch_test_authoring_task` (writes only tests, from the plan's Test Plan; files outside `test_paths` are flagged, e.g. stubs) → `run_tests(expect_fail)` → `dispatch_coding_task(frozen_from_dispatch)`. The tests are frozen: their content is hashed and copied aside when the coding session starts, and a change, rename or deletion fails the dispatch with `frozen_test_violation`, with the original kept in `frozen_backup`. A test that cannot be right is reported as `spec_wrong`, not edited. The red check classifies the run from its output: `red` (ran and failed), `vacuous` (passed: checks nothing new), `broken` (import / compile / nothing collected). It is a heuristic, so the human can overrule it. The cost is one extra session; it is offered for bug fixes with a reproducible failure, logic, parsing, validation, contracts and risky changes, and not for refactors, UI, config, docs or small changes. `duration_ms` and `prompt_chars` are recorded on every dispatch so the real cost can be read from `dispatches/*/meta.json` after a few stories.

**Spec proven wrong.** The `sdlc-result` block has `spec_wrong` and `spec_issue`. The runner marks such a dispatch unsuccessful, and the orchestrator calls `report_spec_wrong(task_id, dispatch_id, return_to)`. The workflow server logs an edge case, appends the issue to the target document's Open Questions as a new version (which also voids a plan approval, §6.5), and moves the task back. This is not a retry: it does not use `max_test_retries`, and `implementation -> plan` is not needed in `transitions` because `spec_wrong_return_to` in `policy.json` lists the allowed targets (default requirement, design, plan). `max_spec_wrong_returns` (default 2) stops a task bouncing forever; past it the orchestrator must ask the human.

## 7. Agent entry points (invocation modes)

The orchestrator is invoked one way, with a mode discriminator — not as three separate agents.

### 7.1 Modes

| Mode | Input | Orchestrator action |
|---|---|---|
| `jira` | Jira ticket key, e.g. `PROJ-123` | Jira MCP "get issue" → `jira-intake` skill maps fields → `create_task(source: "jira", linked_refs: {jira_key})` |
| `adhoc` | Free-text description | `create_task(source: "adhoc")` directly from the text |
| `resume` | `task_id`, or a Jira key / PR number in some task's `linked_refs` | `get_task_state` (look up by `linked_refs` if not given a raw `task_id`) → report current stage, last artifact, last edge case if any → continue from where it stopped. **Does not create a new task.** |

```
@orchestrator start jira PROJ-123
@orchestrator start adhoc "Add retry logic to the payment webhook handler"
@orchestrator resume PROJ-123
@orchestrator resume task_017f...
@orchestrator list ProjectA         # -> list_pending_tasks
```

### 7.2 `linked_refs`

```json
"linked_refs": { "jira_key": "PROJ-123", "pr_number": 42 }
```

`resume` accepts any of these as a lookup key, falling back to `task_id`. Updated via `update_linked_refs` right after `dispatch_coding_task` returns a `pr_number`.

### 7.3 Jira sync policy

One-way, best-effort, config-gated:
- `sync_jira_status: true|false` in `policy.json` (default `false` until trusted).
- When enabled, on reaching `review`/terminal, orchestrator posts a short status note via Jira MCP. Failures here never block `transition_stage`.
- Map only 2–3 meaningful checkpoints to Jira status (e.g. "In Progress" / "In Review" / "Done") rather than mirroring every one of the 6 internal stages.

## 8. Skills needed

Three different kinds of "skill" are in play, and they should stay cleanly separated by **where they run** and **what access they get**:

### 8.1 Repo-level coding skills (already exist, unchanged)

Each repo's own agent/skill conventions (`ProjectA`'s `.github/agents` and `.github/skills`, `CLAUDE.md`, `.cursor/rules`, `AGENTS.md`) — for the read+write coding session invoked via `dispatch_coding_task`. Which of these a session honours depends on the platform chosen for it. The orchestrator itself never reads their contents; the dispatch server injects them into both coding and analysis sessions (§5.2), the latter as read-only context. Nothing to build in the repos.

**Where durable knowledge lives.** Anything about the codebase itself (structure, conventions, deprecated modules, flaky tests) belongs in these repo files — committed, team-visible, naturally read by `dispatch_coding_task`. The orchestrator's own learnings (§9.7) are reserved for things with no natural home in the repo. When a dispatched session discovers a durable codebase fact that isn't written down anywhere, it flags it as a **suggested addition to the repo's instruction files** (artifact field, §9.1) rather than quietly stashing it in the orchestrator's private store.

### 8.2 Orchestrator-side meta-skills (control the pipeline itself)

Live in `ai-sdlc-orchestrator`, run by the orchestrator inline (cheap, no repo access needed):

| Skill | When used | Standardizes |
|---|---|---|
| `triage-task` | Every `create_task` | The fixed checklist for computing the 5 triage flags (§6.1) consistently. |
| `jira-intake` | Every `jira` mode invocation | Field mapping from the Jira ticket into title/description/initial flags. |
| `edge-case-review` | Periodic, run manually | Reading `record_edge_case` logs, spotting 3+ recurring patterns, and routing each to one of three outputs: a hard routing rule → `update_policy` patch; a fact about the codebase → suggested addition to the repo's own instruction files; contextual knowledge with no repo home → `write_learning` (§9.7). Also prunes stale learnings. |

Reading learnings (§9.7) is part of `jira-intake` and `triage-task`: ticketing-system quirks and request-phrasing patterns matter before any dispatch happens.

> **Open gap — triage vs. repo access.** `triage-task` runs inline with no repo access, yet §6.1 asks for `files_affected` and `has_precedent`, which need the codebase. As built, they are rough estimates from the ticket text (the skill says so) that `requirement-analysis` later refines; the alternative is a small read-only analysis dispatch at `create_task`. Not settled (§13).

### 8.3 Stage-execution skills (produce the actual stage artifacts)

These are the ones for requirement analysis, breakdown, and planning. They are **not** run inline by the orchestrator — they're dispatched via `dispatch_analysis_task` (§5.2) into a read-only session, because design/plan reasoning genuinely needs to look at the repo (existing patterns, affected files) and that context shouldn't live in the orchestrator's own window.

| Skill | Stage | Input | Output (artifact) | Principle |
|---|---|---|---|---|
| `requirement-analysis` | Requirement | Raw ticket/ad-hoc text + triage flags | Problem statement, scope in/out, acceptance criteria, explicit open questions | **Answers "what", never "how".** If something is genuinely ambiguous, the artifact says so in "open questions" rather than the skill silently assuming an answer — ambiguity should surface, not get resolved by guessing. |
| `task-breakdown` | Requirement (or right after, before Design) | Requirement artifact | A list of child tasks (each becomes its own task via `create_task(parent_task_id: ...)`), only when the work genuinely doesn't fit one pass | **Split by independent deliverable, not by SDLC step.** A "breakdown" that just re-labels requirement/design/plan as three "subtasks" is not a breakdown — only split when there are genuinely separable units of work (e.g. "backend endpoint" and "frontend form" that could ship independently). If nothing is separable, this skill should say so and produce zero children rather than forcing a split. |
| `design-analysis` | Analyze/Design | Requirement artifact + read-only repo exploration | Chosen approach, affected components/files, risks, brief alternatives considered | **One recommended approach, not a menu.** Explore alternatives internally, but commit to one in the artifact with a one-line reason for the choice — leave the full trade-off debate out, that belongs in `record_edge_case` if it was a genuinely hard call. |
| `plan-creation` | Plan | Requirement + Design artifacts + read-only repo exploration | Ordered step list, files touched per step, test plan, rollback/revert notes if `reversible: false` | **Concrete enough to dispatch, not an essay.** Every step should be specific enough that `dispatch_coding_task`'s instructions can be built directly from it (§8.2 of the earlier draft — now folded into `dispatch_analysis_task`'s sibling). If a step can't be stated as "touch file X to do Y", the plan isn't done yet. |

General principles across all four:
1. **Narrow, bounded output.** Each skill fills a fixed template (see §9.1), never free-form essay. This is what makes artifacts machine-consumable by the next stage, not just human-readable.
2. **Don't re-decide the previous stage's answer.** `plan-creation` doesn't re-litigate *what* to build (that's `requirement-analysis`'s job) or *which approach* (that's `design-analysis`'s job) — it only works out *how to execute* the approach already chosen. Each skill trusts its input artifacts as given.
3. **Surface uncertainty instead of resolving it silently.** Any assumption a skill had to make to produce output goes in an explicit "Assumptions" field in the artifact — never buried invisibly in the reasoning.
4. **Read-only means read-only.** None of these four skills should need write access; if a skill run genuinely needs to modify something to "find out", that's a sign it belongs in `dispatch_coding_task`'s spike/exploration step instead, not here.

## 9. Stage artifacts — format and principles

### 9.1 Fixed templates per stage

Each stage artifact is a small structured document, not free text — same spirit as the repo-level coding skills having a fixed shape. Suggested minimal fields:

**Requirement artifact**
```
Problem Statement: ...
Goal: ...
Scope — In: [...]   Out: [...]
Acceptance Criteria: [...]
Assumptions: [...]
Open Questions: [...]
```

**Design artifact**
```
Chosen Approach: ...
Reason for choice: ... (one line)
Affected Components/Files: [...]
Risks: [...]
Alternatives considered (brief): [...]
```

**Plan artifact**
```
Steps:
  1. <file/component> — <concrete change> — <why>
  2. ...
Test Plan: [...]
Rollback/Revert notes: ... (only if reversible = false)
```

**Breakdown artifact** (when `task-breakdown` actually splits work)
```
Children:
  - <title> — <one-line scope> — <why it's independent>
  - ...
(or explicitly: "No split — work fits one pass")
```

**Common optional field on every analysis artifact**
```
Suggested repo-instruction additions: [...]   # durable codebase facts found but not written down in the repo's .github/agents / skills / CLAUDE.md
```
Analysis sessions are read-only and return only an artifact, so this field is the mechanism for surfacing such facts: visible, stored with the artifact, and committed to the repo by a human. The orchestrator never edits repo files.

### 9.2 Traceability

`record_stage_artifact(task_id, stage, content, input_refs?)` — `input_refs` names exactly which prior artifact(s)/version(s) this one was built from (e.g. `plan` v2 built from `requirement` v1 + `design` v1). This makes it possible to answer "if the requirement changes, which downstream artifacts are now stale?" later, without guessing.

### 9.3 Versioning, not overwriting

If a stage is redone (e.g. `plan` revised after review feedback), store it as a new version rather than overwriting — `get_stage_artifact` defaults to latest but can fetch a specific version. History stays inspectable, and `record_edge_case` entries that reference "why we changed the plan" remain meaningful after the fact.

### 9.4 Consumption contract

Each stage-execution skill's input section (§8.3 table) *is* the contract for what it reads from prior artifacts — nothing implicit. If `plan-creation` ever needs a field that `design-analysis`'s template doesn't produce, that's a sign to add the field to the Design template, not to have `plan-creation` re-derive it independently.

### 9.5 Skill/policy versioning on artifacts

`record_stage_artifact` also stamps which skill produced it — a version string or content hash of the `SKILL.md` used (e.g. `requirement-analysis@v3`). Skills and policy will change over time; without this, there's no way to tell later whether an odd-looking old plan artifact reflects a since-fixed bug in `plan-creation` or was just a hard case. Worth the same stamp on `transition_stage` for which `policy.json` version was in effect at the time.

### 9.6 Do we need RAG?

Two different "find something similar" needs come up in this system, and they call for different answers — worth separating rather than reaching for embeddings/vector search by default.

**Finding precedent in the current codebase** (the `has_precedent` triage flag, and what `design-analysis`/`plan-creation` lean on when exploring the repo). **No RAG needed.** A single repo at the scale being discussed here is well within what `Grep`/`Read` can cover directly in a `dispatch_analysis_task` session — exact and structural search is both more precise and cheaper than semantic retrieval for "does this pattern already exist in this codebase." Reach for semantic code search only if a repo becomes large enough that keyword search genuinely stops surfacing the right files — not before.

**Finding precedent in past decisions** (stage artifacts and `record_edge_case` entries accumulated across tasks, growing over time and now across multiple repos via §6.7). This is the one place a retrieval need will plausibly grow: "has something like this requirement/design/edge-case come up before" is exactly the kind of query where exact keyword match degrades as the corpus grows and phrasing varies. Still, don't start with full RAG (embeddings + vector store) — start with **SQLite FTS5** over `stage_artifacts.content` and `edge_cases.description`/`reasoning` (free, already part of the SQLite decision in §5.1, no new infrastructure). Add a `search_precedent(query, project_root?)` tool on `workflow-state` backed by FTS5.

**Learnings files** (§9.7) are a small per-repo corpus: plain file read, no search infrastructure at all.

**Common revisit trigger across all three places** (codebase precedent, past artifacts/edge cases, learnings): keyword search demonstrably misses conceptually-similar-but-differently-worded matches often enough to matter. To make this observable rather than a guess, `search_precedent` logs each query and its hit count, so zero-hit queries can be reviewed.

**When to actually revisit real RAG:** only if, after real usage, FTS5 keyword search demonstrably misses conceptually-similar-but-differently-worded past cases often enough to matter (a concrete, observable trigger — not a guess made now). At that point, the upgrade path is adding embeddings for `stage_artifacts`/`edge_cases` rows and a vector similarity query, layered on top of the same SQLite tables rather than a separate system. Until that trigger shows up, building it now would be solving a retrieval problem the corpus isn't big enough yet to have.

### 9.7 Learnings (durable cross-task memory)

**What it is.** Knowledge that outlives any single task. It is *not* task-specific data (that stays in SQLite `stage_artifacts`/`edge_cases`), *not* a routing rule (those go to `policy.json`), and *not* codebase knowledge (that goes in the repo's own instruction files, §8.1). What remains is only what has no natural home in the repo:
- ticketing-system quirks ("PROJ tickets never fill Acceptance Criteria"),
- cross-repo process habits ("this team always squash-merges"),
- patterns in how requests get phrased ("'the dashboard' is ambiguous for this team").

**Storage.** One markdown file per repo (`learnings/<slug>.md`) plus one global file (`learnings/_global.md`) in the orchestrator's data dir. `<slug>` is `projects.<root>.slug` from `config.json` when set (so moving a repo doesn't orphan its notes), otherwise `<folder-name>-<6-char hash of the normalised path>`, so two repos both called `api` never share a file. Two small tools on `workflow-state` (`read_learnings`, `write_learning`, §5.1) — not a separate MCP server. The files are plain markdown and can be hand-edited; the tools are a convenience. Included in the daily backup (§5.1).

**Written by:** `edge-case-review` promoting a recurring pattern that is contextual knowledge rather than a hard rule, or a human directly telling the orchestrator to remember something. **Never auto-written from dispatch output**: a hostile ticket or file could otherwise plant text that is injected into every later dispatch.

**Read by:** `jira-intake` / `triage-task` at intake, and the dispatch server before every analysis *and* coding dispatch for that repo (§5.2).

**Hygiene.**
- Each note carries a date and its source `task_id`. Learnings go stale like any index (a team changes its process); `edge-case-review` reviews and prunes them.
- The file is always injected, so it has a size cap (about 20 notes); at the cap, a new note means retiring an old one.
- Calibration bar: a note earns its place only if it would matter to the next several tasks on that repo — not every one-off observation.

### 9.8 Code index / codemap — decided not to build

A real index (symbols, call graph, embeddings) has the same staleness problem as RAG: it needs continuous invalidation as code changes or it actively misleads. Structural overview content ("API layer lives here, services call that, no ORM") is codebase knowledge and belongs in the repo's own instruction files (§8.1), not in learnings and not in an index.

**Trigger to revisit:** `dispatch_analysis_task` sessions keep burning disproportionate time just *locating* things rather than reasoning, even with decent repo instructions in place. To observe this, `duration_ms` is recorded in each dispatch's `meta.json` (tool-call counts aren't reported uniformly across platforms, so they aren't recorded).

## 10. Installation / distribution model

- Separate repository, e.g. `ai-sdlc-orchestrator`, independent of any project repo.
- MCP servers (`workflow-state`, `dispatch`) registered at the **user/global level** (Copilot CLI, Claude Code, Cursor, Claude Desktop), not per-workspace. See `clients/README.md`.
- Runtime: Node 22.5+ with built-in `node:sqlite` (no native modules). Data dir `~/.ai-sdlc-orchestrator` (`SDLC_DATA_DIR`) holds `workflow.db`, `policy.json`, `config.json`, `learnings/`, `dispatches/`, `backups/`.
- Each platform CLI used for dispatch (`claude`, `copilot`, `cursor-agent`, ...) must be installed and authenticated on the machine.
- Jira v2 MCP and GitHub MCP registered the same way, credentials configured once.
- Every project-specific tool call takes `project_root` explicitly, so one running server instance serves multiple repos.
- The orchestrator's system prompt lives in `ai-sdlc-orchestrator`, loaded by whichever client invokes it.
- **Secrets.** Jira/GitHub tokens are never stored in `policy.json`, `config.json`, or anywhere inside the repo. The MCP servers read them from the OS credential store or environment variables at startup only — this matters even more once `ai-sdlc-orchestrator` is a repo shared across machines or with teammates.

## 11. Repository layout (as built)

```
ai-sdlc-orchestrator/
├── src/
│   ├── workflow-state/   # server.ts (MCP tools), service.ts (all logic), policy.ts (zod-validated), schema.ts (SQLite + FTS5)
│   ├── dispatch/         # server.ts, platforms.ts (adapters, §5.4), runner.ts (spawn/track/git checks), prompt.ts (skill/learnings/repo-instruction injection, result parsing), repo-instructions.ts (§5.2)
│   ├── common/           # config.ts, paths.ts, learnings.ts (§9.7)
│   └── test/             # node:test suites for both servers
├── config/
│   ├── policy.default.json   # copied to <data dir>/policy.json on first run
│   └── config.example.json   # platform routing, per-project overrides, custom platforms
├── orchestrator-agent/
│   ├── SYSTEM_PROMPT.md
│   └── skills/           # triage-task, jira-intake, edge-case-review (8.2); requirement-analysis, task-breakdown, design-analysis, plan-creation (8.3)
├── clients/README.md     # registering with Copilot CLI, Claude Code, Cursor, Claude Desktop
└── ai-sdlc-orchestrator-design.md
```

## 12. Build order (suggested) and status

**Added later (tested with the fake CLI):** write-session guards §6.8: scope check, optional tests-first with frozen tests and the red check, `report_spec_wrong`.

**Built and unit-tested (steps 1, 3-7 in code, 11 and 12 in the server, plus learnings §9.7, repo-instruction/learnings injection §5.2, zero-hit search log §9.6, `duration_ms` and learnings backup):** workflow-state server (policy validation, gates incl. auto-approve, heavy-pipeline enforcement, retry cap, in-flight guard, coordinated release, FTS5 search, daily backup), dispatch server with claude/copilot/cursor/custom adapters, read-only verification, branch handling, skills and system prompt. Tests use a fake CLI; **the real `claude`, `copilot` and `cursor-agent` flag sets in §5.4 have not been run against the actual tools yet.** Do that first on a throwaway repo (step 2) and adjust `extra_args` as needed. Not built: GitHub/Jira wiring (reused MCP servers, configured in the client), the polling loop itself (the host calls `check_gates` and `get_dispatch_result` per the system prompt), Jira status sync.

0. **Validate the artifact templates by hand, before writing any code.** Manually walk 2–3 real `ProjectA` tickets through the requirement → design → plan templates (§9.1) yourself, in a plain doc. This is the cheapest way to discover a template is missing a field, or that a principle like "one recommended approach, not a menu" (§8.3) doesn't actually fit how your tickets look — far cheaper to fix on paper than after the skills and schema are built around the wrong shape.
1. `workflow-state` MCP server with minimal policy + artifact storage (versioned, with `input_refs`) — highest-value, most durable piece.
2. Register at user level; sanity-test via `adhoc` mode on a throwaway task before touching `ProjectA`.
3. Write `SYSTEM_PROMPT.md`: entry-mode parsing, policy application, when to escalate to judgment.
4. Write `triage-task` skill — every task passes through it immediately.
5. Write `requirement-analysis` skill + `dispatch_analysis_task` (read-only mode) — get one real artifact flowing end to end before adding the rest.
6. Add `design-analysis` and `plan-creation` skills once requirement is proven out.
7. Build `dispatch_coding_task` and connect to a real coding session scoped to `ProjectA`.
8. Wire in GitHub MCP (PR/review integration, `pr_number` capture into `linked_refs`).
9. Wire in Jira v2 MCP for `jira` mode + `jira-intake` skill; leave `sync_jira_status` off until stable.
10. Add `task-breakdown` once you've seen a few real tasks that were genuinely too large for one pass — don't build it speculatively before that.
11. Add the branching convention (§6.4) and approval gates (§6.5) before running anything against `ProjectA` for real — these are cheap to build and far more costly to retrofit after a task has already merged without review.
12. Add the retry/failure policy (§6.6) and the concurrency check (§5.2) once more than one task is routinely in flight on the same repo.
13. Run real tasks from `ProjectA` through the full loop across all entry modes; capture edge cases; refine policy.
14. After a month of real usage, run `edge-case-review` once and fold recurring patterns into `policy.json`.

## 13. Open decisions to revisit

- Whether `sync_jira_status` should eventually be two-way — deliberately deferred.
- Whether `task-breakdown` should run automatically as part of triage, or only on request — leaning toward "only on request" initially, since over-splitting is as costly as never splitting; revisit once `edge-case-review` shows a pattern either way.
- **Cost/token budget per stage.** Not built yet — worth a `max_tokens_per_stage` or similar guardrail once real usage shows which stage (likely `design-analysis` or `plan-creation`, since those explore the repo) is prone to running long, rather than guessing a limit up front.
- **Real RAG (embeddings/vector search) over past artifacts** — deferred until FTS5 (§9.6) demonstrably falls short; not a decision to make speculatively now.
- **Code index / codemap** — not built (§9.8); revisit only if analysis sessions spend disproportionate time locating code.
- **Triage vs. repo access** (§8.2) — whether `files_affected` / `has_precedent` are ticket-text estimates refined later, or come from a small analysis dispatch at `create_task`.
- **Learnings visibility** (§9.7) — they live in a per-machine data dir, so they are not team-visible. Fine for a personal install; revisit if the orchestrator is shared across teammates.
- **Polling interval and `auto_approve_after_hours` defaults** (§6.5, §6.5b) — pick an actual number once you see how long a `plan-creation` or `dispatch_coding_task` run typically takes in practice; guessing a tick interval or timeout now risks being either too chatty or too slow to feel responsive.

**Decided, no longer open:** multi-platform support through an adapter layer with injected skills and a platform-neutral result contract (§5.4); runtime is Node 22.5+ with built-in `node:sqlite`; state storage is SQLite (§5.1, schema included); multi-repo support is handled via `related_repos`/`additional_read_roots` for read-only cross-repo context and `task-breakdown` + `coordinated_release` for genuinely multi-write changes (§6.7); artifact search starts with SQLite FTS5, not a vector store (§9.6); learnings are plain per-repo markdown files, narrowed to non-codebase knowledge, with codebase facts routed to the repo's own instruction files (§8.1, §9.7); no codemap (§9.8); the orchestrator runs as **one long-lived process using polling** rather than on-demand/synchronous (§6.5b), with approval gates supporting an **auto-approve timeout** so that long-lived run never stalls indefinitely on an unattended task (§6.5).
