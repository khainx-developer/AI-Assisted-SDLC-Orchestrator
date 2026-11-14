# AI-Assisted SDLC Orchestrator

An **orchestrator agent** you chat with in GitHub Copilot (VS Code or CLI), Claude Code or Cursor. It takes a story (a Jira ticket or a plain description), decides how much process it needs, and drives it through **requirement → design → plan → implementation → test → review**. It keeps the state, stops for your approval on risky plans, and hands the actual analysis and coding to separate AI sessions so its own context stays small.

Design and rationale: [ai-sdlc-orchestrator-design.md](ai-sdlc-orchestrator-design.md).

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

**2. Install the agent and register the servers** (pick your tool; `--repo` registers a repo, repeat it for several)
```
# GitHub Copilot in VS Code
node dist/cli.js install --target copilot --platform copilot --repo D:/work/ProjectA

# GitHub Copilot CLI (do this too if you use `copilot` in a terminal)
node dist/cli.js install --target copilot-cli --platform copilot
```
Other tools: `--target claude`, `--target cursor`, `--target all`. Add `--dry-run` first to preview what would be written.

**3. Pin the model for dispatched sessions** (important, see below). Edit `~/.ai-sdlc-orchestrator/config.json`:
```json
{
  "default_platform": "copilot",
  "platforms": { "copilot": { "model": "gpt-6-luna" } }
}
```
Use the same model as your chat window. List valid names with `/model` inside `copilot`.

**4. Reload VS Code** (Command Palette: "Developer: Reload Window"), then in the MCP servers list start `workflow-state`, `dispatch`, Atlassian and GitHub, and sign in to the last two when asked.

**5. Check it works.** Open Copilot Chat, switch to agent mode, pick **orchestrator**, and say `hi`. You should get a list of what it can do. Then ask `which repos and AI platforms are set up?`

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
node dist/cli.js install --target copilot --mode repo --repo D:/work/ProjectA   # also put the agent file inside the repo

# repos the agent can offer when you don't name one
node dist/cli.js repos list
node dist/cli.js repos add D:/work/ProjectB
node dist/cli.js repos remove D:/work/ProjectB

# stories and artifacts
node dist/cli.js tasks list
node dist/cli.js tasks show <task_id | JIRA-KEY | PR#>
node dist/cli.js tasks show <task_id> --stage plan        # requirement | design | plan
node dist/cli.js tasks remove <task_id>                   # preview; add --yes to delete (--with-children for sub-tasks)
```

Install options: `--target`, `--mode global|repo`, `--repo <path>` (repeatable), `--platform`, `--analysis-platform`, `--coding-platform`, `--test-command`, `--profile <name>` and `--insiders` (VS Code only), `--no-integrations`, `--jira-server`, `--github-server`, `--mcp-in-repo`, `--dry-run`. `node dist/cli.js --help` lists them.

Install writes, per target:

| Target | Agent file | MCP servers |
|---|---|---|
| `copilot` | VS Code user `prompts/orchestrator.agent.md` | VS Code user `mcp.json` |
| `copilot-cli` | `~/.copilot/agents/orchestrator.agent.md` | `~/.copilot/mcp-config.json` |
| `claude` | `~/.claude/agents/orchestrator.md` | prints `claude mcp add` commands to run |
| `cursor` | `.cursor/rules/` (repo mode only) | `~/.cursor/mcp.json` |

Existing MCP config files are merged, backed up as `.bak`, and comments inside them are not preserved. The VS Code chat and the Copilot CLI read **different** MCP config files, which is why `copilot` and `copilot-cli` are separate targets.

## Configuration

Everything lives in `~/.ai-sdlc-orchestrator/` (override with `SDLC_DATA_DIR`):

| File | Contents |
|---|---|
| `config.json` | Which AI platform and model do the work, per repo overrides, registered repos, custom platforms (example: `config/config.example.json`) |
| `policy.json` | Stages, approval gates (with optional auto-approve timeout), retry limits. Invalid edits are rejected |
| `workflow.db` | Tasks, history, artifacts, approvals (SQLite) |
| `dispatches/` | One folder per worker session: the prompt sent, raw output, status |
| `backups/` | Daily copy of `workflow.db`, newest 14 kept |

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
- `src/dispatch/`: MCP server, platform adapters (`platforms.ts`), process runner, prompt building.
- `src/cli.ts`: the `install`, `repos` and `tasks` commands.
- `orchestrator-agent/`: system prompt and skills (the skills run by dispatched sessions are injected into their prompt; the three the chat agent runs itself are embedded in its agent file at install time).
- `clients/README.md`: manual registration steps, including Claude Desktop.

The adapters for Claude Code and Cursor follow those tools' documented flags but have not been run against the real CLIs; the Copilot CLI adapter has.
