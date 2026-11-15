# AI-Assisted SDLC Orchestrator

An **orchestrator agent** you chat with in GitHub Copilot (VS Code or CLI), Claude Code or Cursor. It takes a story (a Jira ticket or a plain description), decides how much process it needs, and drives it through **requirement → design → plan → implementation → test → review**. It keeps the state, stops for your approval on risky plans, and hands the actual analysis and coding to separate AI sessions so its own context stays small.

Documentation index: [docs/README.md](docs/README.md)

| | |
|---|---|
| [Features](docs/features.md) | One-page map of what it does |
| [MCP servers](docs/mcp-servers.md) | Every server and tool |
| [Learnings (memory)](docs/learnings.md) | How durable notes are stored, written and read |
| [Design and rationale](ai-sdlc-orchestrator-design.md) | Full design, decisions, build status |

```
You ── chat ──> Orchestrator agent ──> workflow-state MCP  (tasks, stages, artifacts, approvals; SQLite)
                                   └─> dispatch MCP        (starts worker sessions: Copilot CLI / Claude / Cursor / custom)
                                   └─> Jira + GitHub MCP   (read tickets, find PRs)
```

## Prerequisites

| Need | Why |
|---|---|
| Node 22.5 or newer | Runs the servers (uses built-in `node:sqlite`, no native packages) |
| Git | Coding sessions work on a `task/<id>` branch |
| A chat tool with MCP support: VS Code + GitHub Copilot, Copilot CLI, Claude Code or Cursor | Where you talk to the orchestrator |
| The CLI of the AI that does the dispatched work, installed **and signed in** | Copilot: `npm install -g @github/copilot`, then run `copilot` once. Claude: `claude`. Cursor: `cursor-agent` |
| Optional: Atlassian (Jira) and GitHub MCP access | Lets the agent read tickets and find PRs. You sign in when your tool prompts |

## Install (about 5 minutes)

**1. Build** (from this repo's folder; keep the folder where it is, because the tools point at it)
```
npm install
npm run build
```

**2. Install the agent and register the servers** (pick your tool; `--repo` registers a repo, repeat it for several — nothing is written into the repo for copilot/cursor)
```
# GitHub Copilot in VS Code (user agent + MCP; register repo for copilot dispatch)
node dist/cli.js install --target copilot --repo D:/work/ProjectA

# GitHub Copilot CLI (terminal; do this too if you use `copilot` in a terminal)
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

**4. Reload VS Code** (Command Palette: "Developer: Reload Window"), then in the MCP servers list start `workflow-state`, `dispatch`, Atlassian and GitHub, and sign in to the last two when asked.

**5. Check it works.** Open chat, invoke the orchestrator (Copilot: pick **orchestrator**; Cursor: `@orchestrator-agent`), and say `hi`. You should get a list of what it can do. Then ask `which repos and AI platforms are set up?`

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
2. Each analysis stage runs in a read-only worker session and produces an **artifact**. You read it, answer its open questions, and **confirm** or **revise** it (revisions are stored as new versions).
3. A risky **plan** stops at an approval gate. Implementation is refused until you say "approve the plan".
4. Implementation runs on a `task/<id>` branch (never `main`), then tests, then review.
5. If it says work is still running, say `check status`.

**See artifacts**: ask in chat ("show the plan"), or from a terminal (see Commands). **Remove a story**: say `remove 2` (it asks you to confirm; `cancel` keeps the history, `remove` deletes it permanently).

## Commands

Run from this repo's folder. After `npm link` you can type `sdlc-orchestrator ...` instead of `node dist/cli.js ...` from anywhere.

```
# install / refresh (re-run after editing orchestrator-agent/SYSTEM_PROMPT.md, then reload your tool)
node dist/cli.js install --target copilot|copilot-cli|claude|cursor|all [options]
node dist/cli.js install --target cursor --repo D:/work/ProjectA               # Cursor: ~/.cursor agent+MCP; register repo (platform cursor)
node dist/cli.js install --target copilot --repo D:/work/ProjectA              # GitHub Copilot: VS Code user agent+MCP; register repo (platform copilot)
node dist/cli.js install --target copilot-cli --repo D:/work/ProjectA          # Copilot CLI: ~/.copilot agent+MCP; register repo (platform copilot)

# repos the agent can offer when you don't name one
node dist/cli.js repos list
node dist/cli.js repos add D:/work/ProjectB
node dist/cli.js repos remove D:/work/ProjectB

# AI model per repo (overrides platforms.<id>.model; a model named on one dispatch overrides both)
node dist/cli.js model show [--repo D:/work/ProjectA]
node dist/cli.js model set <model-name> --repo D:/work/ProjectA
node dist/cli.js model reset --repo D:/work/ProjectA

# branch naming for coding work (default task/{key}; {key} = Jira key, else task id)
node dist/cli.js branch show [--repo D:/work/ProjectA]
node dist/cli.js branch set "feature/{key}" --repo D:/work/ProjectA   # omit --repo for the global pattern
node dist/cli.js branch reset [--repo D:/work/ProjectA]

# stories and artifacts
node dist/cli.js tasks list
node dist/cli.js tasks show <task_id | JIRA-KEY | PR#>
node dist/cli.js tasks show <task_id> --stage plan        # requirement | design | plan
node dist/cli.js tasks remove <task_id>                   # preview; add --yes to delete (--with-children for sub-tasks)
```

Install options: `--target`, `--mode global|repo` (claude only writes into the repo), `--repo <path>` (repeatable), `--platform`, `--analysis-platform`, `--coding-platform`, `--test-command`, `--profile <name>` and `--insiders` (VS Code only), `--no-integrations`, `--jira-server`, `--github-server`, `--dry-run`. `node dist/cli.js --help` lists them.

Install writes, per target (copilot / copilot-cli / cursor never modify the repo; `--repo` only updates orchestrator config):

| Target | Agent file | MCP servers |
|---|---|---|
| `copilot` | VS Code user `prompts/orchestrator.agent.md`; `--repo` sets that project's `platform: copilot` | VS Code user `mcp.json` |
| `copilot-cli` | `~/.copilot/agents/orchestrator.agent.md`; `--repo` sets `platform: copilot` | `~/.copilot/mcp-config.json` |
| `claude` | `~/.claude/agents/orchestrator.md` | prints `claude mcp add` commands to run |
| `cursor` | `~/.cursor/agents/orchestrator-agent.md` (`@orchestrator-agent`); `--repo` sets `platform: cursor` | `~/.cursor/mcp.json` |

Existing MCP config files are merged, backed up as `.bak`, and comments inside them are not preserved. The VS Code chat and the Copilot CLI read **different** MCP config files, which is why `copilot` and `copilot-cli` are separate targets.

## Configuration

Everything lives in `~/.ai-sdlc-orchestrator/` (override with `SDLC_DATA_DIR`):

| File | Contents |
|---|---|
| `config.json` | Which AI platform and model do the work, per repo overrides, registered repos, custom platforms (example: `config/config.example.json`) |
| `policy.json` | Stages, approval gates (with optional auto-approve timeout), retry limits. Invalid edits are rejected |
| `workflow.db` | Tasks, history, artifacts, approvals (SQLite) |
| `learnings/` | One markdown file per repo plus `_global.md`: durable notes about ticketing quirks, team habits and how requests are phrased. Injected into every dispatch. Hand-editable; max 20 notes per file. Name a repo's file with `projects.<root>.slug` in `config.json`, else `<folder>-<hash>` |
| `dispatches/` | One folder per worker session: the prompt sent, raw output, status |
| `backups/` | Daily copy of `workflow.db` and `learnings/`, newest 14 kept |

**Branch names.** Coding work always runs on its own branch, created automatically from whatever is checked out. The default name is `task/<Jira key or task id>`. To follow your team's convention, run `node dist/cli.js branch set "feature/{key}" --repo <path>` (see Commands; it validates the pattern and shows an example name), or set `branch_pattern` globally or per repo in `config.json` yourself:
```json
{
  "branch_pattern": "task/{key}",
  "projects": { "D:/work/ProjectA": { "branch_pattern": "feature/{key}" } }
}
```
Placeholders: `{key}` (Jira key, or the task id when there is none), `{jira_key}` (same fallback), `{task_id}`. The per-repo value wins. A pattern must contain a placeholder and may not produce `main`/`master`; an invalid one is reported on the task and blocks coding dispatch rather than creating a wrong branch.

**Model per repo.** The model is normally set per platform (`platforms.<id>.model`), so every repo using that platform shares it. To give one repo its own, use `model set` (Commands) or `projects.<root>.model` in `config.json`. Precedence: a model named on a single dispatch, then the repo's `model`, then the platform's `model`, then the CLI's own default. The name must be valid for that repo's AI CLI; a repo whose analysis and coding run on different platforms should keep using the per-platform setting.

Routing example: orchestrate from Copilot Chat, analysis on Claude, coding on Copilot, and a different tool for one repo:
```json
{
  "default_platform": "copilot",
  "analysis_platform": "claude",
  "projects": { "D:/work/Legacy": { "coding_platform": "cursor", "test_command": "npm test" } }
}
```

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| Agent says it has no tools / can't find the orchestrator | Reload the window, open "MCP: List Servers", start the four servers. Start a **new** chat after changing the prompt (old chats keep the old one) |
| "GitHub Copilot CLI was not found" or `UnsupportedWindowsCommandValue` | The Copilot CLI isn't installed, or only VS Code's `copilot-shim` is on PATH. Install it (`npm install -g @github/copilot`) and run `copilot` once. The dispatcher launches the real binary on Windows |
| Worker session says "Skipped workspace MCP servers ... not trusted" | Harmless warning. Trust the folder in the CLI if the worker needs repo-level MCP servers |
| Cursor Agent: "Workspace Trust Required" / exits 1 on analysis | Headless `cursor-agent` needs `--trust`. The Cursor adapter always passes it; rebuild (`npm run build`) and reload MCP if you still see the old error |
| Agent says "still running" and stops | Say `check status`. A stage takes 1 to 5 minutes |
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
- `src/dispatch/`: MCP server, platform adapters (`platforms.ts`), process runner, prompt building, and `repo-instructions.ts` (the repo's own `CLAUDE.md` / `.github/agents` / skills, injected into read-only analysis sessions as context).
- `src/common/learnings.ts`: the per-repo learnings store.
- `src/cli.ts`: the `install`, `repos` and `tasks` commands.
- `orchestrator-agent/`: system prompt and skills (the skills run by dispatched sessions are injected into their prompt; the three the chat agent runs itself are embedded in its agent file at install time).
- `clients/README.md`: manual registration steps, including Claude Desktop.

The adapters for Claude Code and Cursor follow those tools' documented flags but have not been run against the real CLIs; the Copilot CLI adapter has.
