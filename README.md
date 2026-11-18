# AI-Assisted SDLC Orchestrator

Turn a Jira ticket or a plain description into reviewed, tested code, with an AI that **manages the process** and separate AI sessions that **do the work**. You chat with an orchestrator agent in GitHub Copilot CLI, Claude Code or Cursor. It decides how much process a story needs, drives it through **requirement → design → plan → implementation → test → review**, stops for your approval on risky plans, and remembers where everything stands.

## Why use it

One long AI chat that plans, designs and codes runs out of context and forgets the rules. Here the work is split, which gives you:

- **Fresh context every time, so fewer tokens.** Each worker session is a new one-shot CLI process. It never continues an earlier chat. It starts with only the stage skill, the team's learnings, the repo's own instruction files and the instructions for that step. Stage-to-stage hand-off goes through Markdown documents, not chat history, so cost per step does not grow as a story gets longer.
- **A small orchestrator and a chat you can throw away.** The orchestrator only decides what happens next; it never edits code or does deep analysis. All state (tasks, stages, approvals, documents) lives in the `workflow-state` server and its database, so you can open a new chat whenever the old one gets long and say `continue 2` or `resume PROJ-123`. Nothing is lost.
- **Rules that cannot be talked around.** Gates, read-only analysis, frozen tests and the scope check are enforced by the servers, not requested in a prompt. The server checks what each worker did.
- **You stay in control.** You answer open questions, confirm each document, and approve risky plans. Every reply ends with numbered options.
- **Right-sized process.** Small, reversible changes skip straight to coding; only risky or vague stories pay for requirement, design and plan.
- **Documents you can read and edit.** Every stage produces a versioned Markdown file. Your edits are what the next stage reads.
- **One setup, any AI.** The same skills run on Copilot CLI, Claude Code, Cursor or a custom command, and the chat and the workers can use different platforms and models. A cheaper model can do the worker steps.
- **Safe by default.** Nothing is written into your repos, and coding only happens on its own branch, never `main`.

## How it works

```mermaid
flowchart LR
    You([You]) -- chat --> Orch["Orchestrator agent"]
    Orch --> WF["workflow-state server<br/>tasks, stages, gates, documents"]
    Orch --> DP["dispatch server"]
    Orch --> EXT["Jira + GitHub<br/>(optional)"]
    DP -- starts --> W["Worker AI sessions<br/>analysis (read-only) / coding"]
    W --> Repo[("Your repo")]
```

```mermaid
flowchart LR
    S([Story]) --> T["Triage"]
    T -->|small| I
    T -->|risky or vague| R["Requirement"] --> D["Design"] --> P["Plan"] --> G{"Approve?"}
    G --> I["Implementation"] --> Te["Test"] --> Rv["Review"] --> Done([Done])
    T -.->|"big story"| BD["Split into parts<br/>you review"] -.-> R
```

1. **Triage.** The orchestrator rates the story on five flags. Small, reversible changes go straight to implementation; breaking, irreversible or vague ones go through requirement, design and plan.
2. **Analysis stages** run as read-only worker sessions. Each produces a Markdown document you read, correct and confirm. Revisions are new versions.
3. **Big stories are split** into separate tasks that you review before anything is created.
4. **A risky plan stops at an approval gate.** Implementation is refused until you approve.
5. **Implementation** is a coding session on its own `story/<id>` branch, never `main`. Optionally, tests are written first and frozen. The server flags any change outside the plan.
6. **Tests run, failures retry** a limited number of times, then it goes to review for a human decision. The orchestrator finds the PR and CI results; you merge.

Read next: [workflow.md](docs/workflow.md) (the journey in detail) and [architecture.md](docs/architecture.md) (how the pieces fit).

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
| Memory | Learnings, injected repo instruction files, full-text search over past decisions |
| Control | Approval gates, read-only analysis (enforced twice), a branch per task, never `main` |
| Checks done by code | Scope check, frozen tests, double-dispatch guard, tests with capped retries |
| Process | Triage by risk, requirement → design → plan, big-story split, wrong-spec return |
| Independent review | Optional read-only review of the branch diff on a different platform or model than the coder, with a verdict and findings; see [workflow.md](docs/workflow.md) |
| Traceability | Versioned documents stamped with skill version and platform, task history, PR lookup |
| Operations | Model pinning, timeout, cancel, lost-process detection, daily backups, pruning |
| Portability | Copilot CLI, Claude Code, Cursor or a custom command, chosen separately for chat and workers |
| Feedback loop | `edge-case-review` turns recurring problems into rules, repo-instruction suggestions or learnings. The server counts logged edge cases and tasks out of test retries since the last review; at `edge_case_review_after` (policy, default 5, 0 = off) the orchestrator offers the review as one option, never runs it unasked |
| Evals | `evals check` (free, offline) and `evals run` (live) test the five stage skills (four analysis skills and `code-review`) against fixed sample stories (8 cases), with `--repeat N` to measure flakiness. A free offline test also checks that the orchestrator prompt and skills only name tools that exist; see [Evals](#evals-for-skills-and-prompts) |
| Data handling | Secret redaction on every prompt (on by default) and an untrusted-content warning in every dispatch; see [Data handling](#data-handling-and-secrets) |
| Team sharing | `shared_dir` in `config.json` moves `policy.json` and `learnings/` into a folder the team keeps in git; tasks and documents stay private. Sync is plain git; see [learnings.md](docs/learnings.md) |
| Cost visibility | Every dispatch records token use; `dispatches usage` and the `get_usage` tool add it up per task, kind and platform; see [Cost](#cost-per-dispatch). A per-task budget can warn or block further dispatches |

**Roadmap:** nothing planned. New gaps get listed here as they are found.

## Documentation

| Read this | When |
|---|---|
| This README | What it is, install, daily use, commands, configuration, troubleshooting |
| [docs/workflow.md](docs/workflow.md) | What happens to a story, step by step, and who does what |
| [docs/architecture.md](docs/architecture.md) | Components, data, how a dispatch works, what the server checks, design decisions and open questions |
| [docs/mcp-servers.md](docs/mcp-servers.md) | Every MCP server and tool |
| [docs/learnings.md](docs/learnings.md) | How durable team notes are stored and used |
| [clients/README.md](clients/README.md) | Registering the servers by hand (including Claude Desktop) |

Agent behaviour lives in [orchestrator-agent/SYSTEM_PROMPT.md](orchestrator-agent/SYSTEM_PROMPT.md) and [orchestrator-agent/skills/](orchestrator-agent/skills/).

## Prerequisites

| Need | Why |
|---|---|
| Node 22.5 or newer | Runs the servers (uses built-in `node:sqlite`, no native packages) |
| Git | Coding sessions work on a `story/<id>` branch |
| A chat tool with MCP support: Copilot CLI, Claude Code or Cursor | Where you talk to the orchestrator |
| The CLI of the AI that does the dispatched work, installed **and signed in** | Copilot: `npm install -g @github/copilot`, then run `copilot` once. Claude: `claude`. Cursor: `cursor-agent` |
| Optional: Atlassian (Jira) and GitHub MCP access | Lets the agent read tickets and find PRs. You sign in when your tool prompts |

## Install (about 5 minutes)

You install **two things**: the orchestrator (this repo, built once) and the registration of its two servers plus the agent prompt in your chat tool. Nothing is written into your project repos.

**1. Build** (from this repo's folder; keep the folder where it is, because the tools point at it)
```
npm install
npm run build
```

**2. Install the agent and register the servers** (pick your tool; `--repo` registers a repo, repeat it for several — nothing is written into the repo for copilot-cli/cursor)
```
# GitHub Copilot CLI (user agent + MCP; register repo for copilot dispatch)
node dist/cli.js install --target copilot-cli --repo D:/work/ProjectA

# Cursor IDE (~/.cursor agent + MCP; register repo for cursor-agent dispatch)
node dist/cli.js install --target cursor --repo D:/work/ProjectA
```
Other tools: `--target claude`, `--target all`. Add `--dry-run` first to preview what would be written.

**3. Pin the model for dispatched sessions** (important, see below). Edit `~/.ai-sdlc-orchestrator/config.json`:
```json
{
  "default_platform": "copilot",
  "platforms": { "copilot": { "model": "gpt-6-luna" } }
}
```
Use the same model as your chat window. List valid names with `/model` inside `copilot`.

**4. Start a new Copilot CLI session** so it loads the agent and MCP configuration.

**5. Check it works.** Start a Copilot CLI or Cursor session, invoke the orchestrator (Copilot CLI: select **orchestrator**; Cursor: `@orchestrator-agent`), and say `hi`. You should get a list of what it can do. Then ask `which repos and AI platforms are set up?`

### Important: the dispatched model is a separate setting

The orchestrator runs in your chat window, using the model you picked there. Every stage it dispatches runs in a **separate CLI session with its own model and its own billing**. If you don't pin a model, the CLI uses its own default (for Copilot CLI this was `claude-sonnet-5.5`), which may be bigger and more expensive than your chat model. Set it in step 3, then reload so the dispatch server rereads the config. A single dispatch can also override it ("use model X for this stage"). To see what a run used, check the newest `process-*.log` in `~/.copilot/logs`. A wrong model name fails instantly at no cost. Sessions that explore a repo cost far more than a one-line reply, so try the pipeline on one small story first.

## Use it

Talk naturally. You never need to remember commands: **every reply ends with numbered Options** (confirm, revise, show, check status, run tests, cancel, remove...). Answer with the number or the words.

**Start a story**
```
Work on D:/work/ProjectA: add retry with backoff to the email sender (needs a schema change)
start jira PROJ-123
```
**See and continue stories**
```
what's open?            lists unfinished stories across your registered repos, numbered
continue 2              resumes number 2
resume PROJ-123         also works with a task id or PR number
```
**What happens to a story**
1. The orchestrator triages it. A small, reversible change skips straight to implementation. A risky, breaking or vague one goes through **requirement → design → plan**.
   A **big story** (many acceptance criteria, several independent deliverables, more than one PR, or several repos) is first run through **task-breakdown**. You get a numbered list of parts to review and edit, and nothing is created until you agree. The server enforces this: it refuses to create the parts until the breakdown is approved, and revising the breakdown voids the approval. Each part then becomes its own task with its own design, plan, approval and PR. The parent shows a progress table ("2 of 5 parts done") whenever you ask about it, and is never reported complete while a part is unfinished.
2. Each analysis stage runs in a read-only worker session and produces an **artifact**. You read it, answer its open questions, and **confirm** or **revise** it (revisions are stored as new versions).
3. A risky **plan** stops at an approval gate. Implementation is refused until you say "approve the plan".
4. Implementation runs on a `story/<id>` branch (never `main`), then tests, then review. Optionally the tests are written first and frozen, and changes outside the plan are flagged ([details](#tests-first-scope-and-wrong-specs)).
5. While a worker session runs, the agent waits for it (up to about 10 minutes per reply) and tells you how long it has been running. If it may be stalled (over about 10 minutes running, or 5 minutes without output) it offers: keep waiting, **cancel and retry**, or retry on another platform. It never cancels on its own. If it stops waiting, say `check status`.

**See artifacts**: ask in chat ("show the plan"), or from a terminal (see Commands). **Remove a story**: say `remove 2` (it asks you to confirm; `cancel` keeps the history, `remove` deletes it permanently).

## Commands

Run from this repo's folder. After `npm link` you can type `sdlc-orchestrator ...` instead of `node dist/cli.js ...` from anywhere.

```
# install / refresh (re-run after editing orchestrator-agent/SYSTEM_PROMPT.md, then reload your tool)
node dist/cli.js install --target copilot-cli|claude|cursor|all [options]
node dist/cli.js install --target cursor --repo D:/work/ProjectA               # Cursor: ~/.cursor agent+MCP; register repo (platform cursor)
node dist/cli.js install --target copilot-cli --repo D:/work/ProjectA          # Copilot CLI: ~/.copilot agent+MCP; register repo (platform copilot)

# repos the agent can offer when you don't name one
node dist/cli.js repos list
node dist/cli.js repos add D:/work/ProjectB
node dist/cli.js repos remove D:/work/ProjectB

# AI model per repo (overrides platforms.<id>.model; a model named on one dispatch overrides both)
node dist/cli.js model show [--repo D:/work/ProjectA]
node dist/cli.js model set <model-name> --repo D:/work/ProjectA
node dist/cli.js model reset --repo D:/work/ProjectA

# branch naming for coding work (default story/{key}; {key} = Jira key, else task id)
node dist/cli.js branch show [--repo D:/work/ProjectA]
node dist/cli.js branch set "feature/{key}" --repo D:/work/ProjectA   # omit --repo for the global pattern
node dist/cli.js branch reset [--repo D:/work/ProjectA]

# stories and artifacts
node dist/cli.js tasks list
node dist/cli.js tasks show <task_id | JIRA-KEY | PR#>
node dist/cli.js tasks show <task_id> --stage plan        # requirement | design | plan
node dist/cli.js tasks remove <task_id>                   # preview; add --yes to delete (--with-children for sub-tasks)

# old worker-session folders (also pruned automatically, see Configuration)
node dist/cli.js dispatches prune                         # preview; add --yes to delete, --days N to override the retention

# what the AI sessions used
node dist/cli.js dispatches usage                         # all finished dispatches; --task <task_id> for one story, --days N for recent ones

# skill evals
node dist/cli.js evals check                              # free and offline: the golden documents must pass their checks
node dist/cli.js evals run [--case <name>] [--platform <p>] [--model <m>] [--repeat N]   # live: real AI sessions, costs money
```

Install options: `--target`, `--mode global|repo` (claude only writes into the repo), `--repo <path>` (repeatable), `--platform`, `--analysis-platform`, `--coding-platform`, `--test-command`, `--no-integrations`, `--jira-server`, `--github-server`, `--dry-run`. `node dist/cli.js --help` lists them.

Install writes, per target (copilot-cli / cursor never modify the repo; `--repo` only updates orchestrator config):

| Target | Agent file | MCP servers |
|---|---|---|
| `copilot-cli` | `~/.copilot/agents/orchestrator.agent.md`; `--repo` sets `platform: copilot` | `~/.copilot/mcp-config.json` |
| `claude` | `~/.claude/agents/orchestrator.md` | prints `claude mcp add` commands to run |
| `cursor` | `~/.cursor/agents/orchestrator-agent.md` (`@orchestrator-agent`); `--repo` sets `platform: cursor` | `~/.cursor/mcp.json` |

Existing MCP config files are merged, backed up as `.bak`, and comments inside them are not preserved. `copilot-cli` is the supported Copilot installer target; `copilot` remains the dispatch platform identifier for Copilot CLI worker sessions.

## Configuration

Everything lives in `~/.ai-sdlc-orchestrator/` (override with `SDLC_DATA_DIR`):

| File | Contents |
|---|---|
| `config.json` | Which AI platform and model do the work, per repo overrides, registered repos, custom platforms (example: `config/config.example.json`) |
| `policy.json` | Stages, approval gates (with optional auto-approve timeout), retry limits. Invalid edits are rejected |
| `workflow.db` | Tasks, history, approvals, and each stage document's metadata and search index (SQLite). The documents themselves are not stored here |
| `artifacts/<task_id>/<stage>.v<N>.md` | The stage documents (requirement, design, plan...) as Markdown, one file per revision. Open and review them in any editor; the next stage reads the file, so your edits count. Databases from older versions are migrated to files automatically on first start |
| `learnings/` | One markdown file per repo plus `_global.md`: durable notes about ticketing quirks, team habits and how requests are phrased. Injected into every dispatch. Hand-editable; max 20 notes per file. Name a repo's file with `projects.<root>.slug` in `config.json`, else `<folder>-<hash>` |
| `dispatches/` | One folder per worker session: the prompt sent, raw output, status. Finished ones older than `dispatch_retention_days` (default 14, `0` keeps all) are deleted when the dispatch server starts; running ones never are. Stage documents are not affected (they live in `artifacts/`) |
| `backups/` | Daily copy of `workflow.db`, `learnings/` and `artifacts/`, newest 14 kept |

### Two stories from different branches

Every task has a `base_branch`: the branch its work starts from and is reviewed against. You normally do not set it. Check out the branch you want, open the chat and say "start story A": the task records what is checked out (`dev`). Later switch to `release` and say "start story B": that one records `release`. To say it in words instead, "start story B based on `release`". If you left the checkout on a story branch, the next story takes that story's base, never the story branch itself. The orchestrator tells you which base it picked, and "base it on X" changes it before work starts.

Stories share the repo checkout, so only one can have a coding session running at a time. The server refuses to start a second story's coding session until the first finishes, because switching branches under a running session would break it. While a session runs, leave the checkout alone. Stories with different bases cannot conflict until you merge both into one branch; the file-overlap check tells you when two stories touch the same files and whether their bases match. Running two stories truly in parallel needs a separate folder per story (a git worktree). That is not built, mainly because a very large repo would need a full extra working copy each; see BACKLOG.md.

**Branch names.** Coding work always runs on its own branch, created automatically from whatever is checked out. The default name is `story/<Jira key or task id>` (the installer writes it to `config.json` as `branch_pattern`; it never overwrites one you set). To follow your team's convention, run `node dist/cli.js branch set "feature/{key}" --repo <path>` (see Commands; it validates the pattern and shows an example name), or set `branch_pattern` globally or per repo in `config.json` yourself:
```json
{
  "branch_pattern": "story/{key}",
  "projects": { "D:/work/ProjectA": { "branch_pattern": "feature/{key}" } }
}
```
Placeholders: `{key}` (Jira key, or the task id when there is none), `{jira_key}` (same fallback), `{task_id}`. The per-repo value wins. A pattern must contain a placeholder and may not produce `main`/`master`; an invalid one is reported on the task and blocks coding dispatch rather than creating a wrong branch.

**Workspace root that is not a git repo.** If the folder you register is a plain directory whose children are the git repos, list them in `config.json`:
```json
{ "projects": { "D:/work/Platform": { "child_repos": ["api", "web"], "test_command": "npm test" } } }
```
Branches are created in the child repos, never in the root, by giving each repo its own task: the orchestrator runs analysis at the workspace root (read-only, covering every child and their instruction files), then splits implementation into one child task per repo, each with `project_root` set to that child's path. A child task is an ordinary single-repo task with its own branch, dispatch, tests and PR, and it inherits the workspace's `platform`, `model`, `branch_pattern` and `test_command` unless the child has its own `projects` entry. `dispatch_coding_task` and `run_tests` on the workspace root itself are refused with a message listing the children. Without `child_repos` nothing changes.

**Model per repo.** The model is normally set per platform (`platforms.<id>.model`), so every repo using that platform shares it. To give one repo its own, use `model set` (Commands) or `projects.<root>.model` in `config.json`. Precedence: a model named on a single dispatch, then the repo's `model`, then the platform's `model`, then the CLI's own default. The name must be valid for that repo's AI CLI; a repo whose analysis and coding run on different platforms should keep using the per-platform setting.

**Independent review.** After the tests pass, the orchestrator can offer one extra read-only session that reviews the task branch's diff against `main` (or `base_branch`) and judges it against the requirement and plan: see [workflow.md](docs/workflow.md). It runs on a platform or model other than the coder's where one is configured, and says whether it really was independent. To choose the reviewer yourself:
```json
{ "review_platform": "claude", "projects": { "D:/work/ProjectA": { "review_platform": "cursor" } } }
```
The default is any configured platform other than the one that wrote the code, so list at least two under `platforms` (or `default_platform` plus one) to get a real second opinion. A repo-wide `model` is not passed to a reviewer on another platform, because that model name may not exist there; pass `model` on the call to set one. The review is advice, a document with a verdict and findings, and it never changes the task.

Routing example: orchestrate from Copilot CLI, analysis on Claude, coding on Copilot, and a different tool for one repo:
```json
{
  "default_platform": "copilot",
  "analysis_platform": "claude",
  "projects": { "D:/work/Legacy": { "coding_platform": "cursor", "test_command": "npm test" } }
}
```

### Tests first, scope and wrong specs

Three checks on the implementation stage. They are enforced by the dispatch server after each session, not by asking the AI nicely.

**Scope.** The plan's "Files touched" is the allowed scope of the coding session. Files it changes outside that list are reported to you. Set what happens in `config.json` (global, or per repo under `projects`):
```json
{ "scope_check": "warn", "projects": { "D:/work/ProjectA": { "scope_check": "fail", "scope_allow": ["package-lock.json", "docs/**"] } } }
```
`warn` (default) lets the work finish and shows you the extra files so you can keep them, revert them or revise the plan; `fail` fails the dispatch; `off` skips the check. `scope_allow` takes files, directories or globs that are always fine.

**Tests first (optional, off by default).** One extra AI session writes the failing tests from the plan's Test Plan before any code exists. The server checks they fail for the right reason, then freezes them: the coding session must make them pass and cannot edit them (a change fails the dispatch, with the original saved aside). It costs roughly one extra session per task, so it is worth it for bug fixes, logic, parsing, validation, API contracts and risky changes, and not for refactors, UI, config, docs or small edits. Turn it on for a repo with `"tests_first": true`; otherwise the orchestrator only offers it as a numbered option when the task looks like a good fit. A smaller model is usually enough for this step (the orchestrator can pass `model` for it).

**Wrong specs.** If a coding session finds that the plan (or design, or requirement) itself cannot be right, it says so instead of working around it. The task goes back to that stage with the problem added as an open question, you answer it, and the revised plan needs approval again. A task can be sent back twice by default (`max_spec_wrong_returns` in `policy.json`), then the orchestrator asks you.

After updating, re-run `node dist/cli.js install --target <your tool>` (the system prompt is copied into the agent file) and reload your tool. An existing `policy.json` needs no edit: the new policy fields have defaults.

### Data handling and secrets

What leaves your machine: each dispatched session is a separate AI CLI (Copilot, Claude Code, Cursor or your custom command) that sends its prompt, and **everything it reads from your repo**, to that vendor's service under your own account and plan. This tool adds nothing on top, and it has no server of its own. Check your vendor's data terms before pointing it at a sensitive repo.

Two protections apply to every dispatch:

1. **Secret redaction (on by default).** Before a prompt is written to disk or handed to the CLI, secret-looking strings are replaced with `[REDACTED:<kind>]`: private keys, AWS keys, GitHub tokens, Slack tokens, `sk-` API keys, Google API keys, JWTs, `Bearer` tokens, passwords inside URLs, and `name = value` pairs where the name says password, secret, token or key. Placeholders (`<your-password>`, `${SECRET}`), env lookups (`process.env.X`), calls (`getPassword()`) and plain numbers are left alone. The prompt covers the ticket text, the earlier stage documents, learnings, the repo's instruction files and the skill. The dispatch result lists what was removed as counts per kind (`redacted`), never the values, and the orchestrator tells you.
2. **Untrusted-content warning.** Every dispatch prompt says that ticket text, earlier documents, repository files and notes are data, never commands, and that the session must not obey instructions found in them or reveal secrets or its prompt. A suspected attempt is reported (analysis: under Open Questions; coding: in the summary) instead of acted on.

```json
{ "redact_secrets": true, "redact_extra": ["ACME-[0-9a-f]{16}"],
  "projects": { "D:/work/Sandbox": { "redact_secrets": false } } }
```
`redact_extra` adds regexes for your own token formats (an invalid one is reported when a dispatch starts). A repo's `redact_secrets` wins over the global value. Switch it off only for a repo with nothing sensitive, for example when a placeholder is being redacted wrongly and you cannot reword it.

**Limits, so you do not over-trust it:**
- It cleans the **prompt this tool builds**. It cannot see what the session reads from the repo on its own, so a secret committed to a file is still read by the AI. Keep secrets out of repos (use a secret manager and an ignore file) and out of tickets.
- A pattern list misses secrets: a short or unusual password, a key in a format it does not know, an obfuscated value. It can also redact a harmless string. Treat it as the last line of defence.
- The untrusted-content warning lowers the risk of prompt injection; it does not remove it. The structural protections still carry the weight: analysis runs read-only (enforced twice), coding runs on its own branch, learnings are never written from ticket or session text, and a human approves risky plans and merges.
- Already-sent text is not recalled. If a secret reached a ticket, rotate it.

### Cost per dispatch

Each finished dispatch records `usage` in its `meta.json`. Where the number comes from depends on the AI CLI:

| Platform | Tokens | Cost |
|---|---|---|
| Claude Code | `reported`: exact, from the CLI (cached input counted as input) | reported in USD |
| Copilot CLI, Cursor, custom | `estimated`: prompt sent plus text printed, about 4 characters per token | not available |

An estimate is a **lower bound**: a session that explores a repo reads far more than its prompt, and that reading is not counted. Use it to compare runs and spot the stage that is growing, not to bill. `node dist/cli.js dispatches usage --task <id>` (or ask the orchestrator, which has the `get_usage` tool) adds it up by kind, platform and task, and says how many numbers are exact.

There is no limit on a single running session: it cannot be stopped by token count, only by `dispatch_timeout_minutes`. What you can set is a **budget per task**, checked between dispatches:

```json
{ "budget": { "task_tokens": 400000, "task_cost_usd": 5, "action": "warn" },
  "projects": { "D:/work/ProjectA": { "budget": { "task_tokens": 150000, "action": "block" } } } }
```
- `task_tokens` counts input plus output of the task's finished dispatches; `task_cost_usd` counts only costs the CLI reported (Claude Code). Set either or both. A repo's `budget` overrides the global one field by field.
- `warn` (default): a dispatch that leaves the task at or over budget carries a `budget_warning`, and the orchestrator tells you and asks before dispatching more. Work is never stopped.
- `block`: once the task is over, new dispatches for it are refused with a message. You can ask the orchestrator to continue anyway (it passes `override_budget`), or raise the budget.
- Because estimated tokens are a lower bound, a task can be over budget before the numbers say so. For a Claude Code repo the numbers are exact. `get_usage` with `task_id` and `project_root` shows a task against its budget.

### Evals for skills and prompts

`evals/cases/*.json` are fixed sample stories, one or two per stage skill (`requirement-analysis`, `design-analysis`, `plan-creation`, `task-breakdown`, `code-review`). Each has a small fixture repo and **shape checks** on the document the skill produces: the template headings, numbered acceptance criteria, open questions in the `- **Q1.**` format the tooling reads, no design talk in a requirement, a Test Plan with at least two behaviours, "No split" answered exactly. `evals/golden/*.md` holds a known-good document for each case.

- `evals check` is free and runs inside `npm test`. It proves the checks accept the golden documents and reject broken ones, and that every analysis skill has a case.
- `evals run` sends each case through the real dispatch path (same prompt builder, same platform adapter, same read-only guard) in a throwaway repo, judges the document, saves the run under `~/.ai-sdlc-orchestrator/evals/results/`, and reports a **REGRESSION** when a case that passed last time fails now, with both skill versions (content hashes). Run it after editing a skill, and when you change the model. `--repeat N` runs each case N times and lists a case that passed some runs and failed others as **FLAKY** (not a regression, since some runs passed). It costs one real session per case per repeat, so try `--case requirement-retry` first.

What it does not do: judge whether the content is *good* (a wrong but well-formed requirement passes), run the orchestrator's own system prompt, or repeat a case to measure how often a flaky skill fails. Add a case when a real story goes wrong in a way the checks could have caught (`evals/cases/<name>.json` plus `evals/golden/<name>.md`; the name must match the file name).

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| Agent says it has no tools / can't find the orchestrator | Reload the window, open "MCP: List Servers", start the four servers. Start a **new** chat after changing the prompt (old chats keep the old one) |
| "GitHub Copilot CLI was not found" or `UnsupportedWindowsCommandValue` | The Copilot CLI isn't installed, or only VS Code's `copilot-shim` is on PATH. Install it (`npm install -g @github/copilot`) and run `copilot` once. The dispatcher launches the real binary on Windows |
| Worker session says "Skipped workspace MCP servers ... not trusted" | Harmless warning. Trust the folder in the CLI if the worker needs repo-level MCP servers |
| Cursor Agent: "Workspace Trust Required" / exits 1 on analysis | Headless `cursor-agent` needs `--trust`. The Cursor adapter always passes it; rebuild (`npm run build`) and reload MCP if you still see the old error |
| Agent says "still running" and stops | Say `check status`. A stage takes 1 to 5 minutes. Past that, the agent reports the elapsed time and offers to cancel and retry; `dispatch_timeout_minutes` (default 30, lower it in `config.json` if stages are quick) kills a session that runs too long and marks it failed |
| `spawn ENAMETOOLONG` on Windows | The prompt was too long for a command line. Prompts over 8,000 characters are now passed as a file; rebuild and reload if you still see it |
| A story is missing from "what's open?" | Check `node dist/cli.js tasks list`; make sure the repo is registered (`repos list`) |
| `Model "x" is not available` | Fix the name in `config.json` (see `/model` in `copilot`) |
| Dispatch failed for another reason | Read `~/.ai-sdlc-orchestrator/dispatches/<id>/meta.json` (`error`, `stderr_tail`, `output`) |
| Changes to the code have no effect | Run `npm run build`, then reload your tool (the servers run from `dist/`) |

## Development

```
npm run build     # compile to dist/
npm test          # build + run the test suite
```

- `src/workflow-state/`: MCP server, policy, SQLite schema and all workflow rules.
- `src/dispatch/`: MCP server, platform adapters (`platforms.ts`), process runner (`runner.ts`: start, watch, cancel), post-session checks (`guards.ts`), prompt building, and `repo-instructions.ts` (the repo's own `CLAUDE.md` / `.github/agents` / skills, injected into read-only analysis sessions as context).
- `src/common/`: config loading, the dispatch record store (`dispatch-store.ts`) and the per-repo learnings store.
- `src/cli.ts`: the `install`, `repos`, `model`, `branch`, `tasks` and `dispatches` commands.
- `orchestrator-agent/`: system prompt and skills (the skills run by dispatched sessions are injected into their prompt; the three the chat agent runs itself are embedded in its agent file at install time).
- `clients/README.md`: manual registration steps, including Claude Desktop.
- `docs/`: this documentation. [architecture.md](docs/architecture.md) is the best starting point for a new contributor.

The Copilot CLI and Cursor adapters have been run against the real CLIs. The Claude Code adapter follows that tool's documented flags but has not been verified against it.
