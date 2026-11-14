# AI-Assisted SDLC Orchestrator

Platform-agnostic SDLC control plane. See [ai-sdlc-orchestrator-design.md](ai-sdlc-orchestrator-design.md) for the design.

- `src/workflow-state/`: MCP server. SQLite state, policy, gates, versioned artifacts, FTS5 precedent search.
- `src/dispatch/`: MCP server. Runs analysis/coding/test sessions through pluggable AI platform adapters (Claude Code, Copilot CLI, Cursor Agent CLI, any custom CLI).
- `orchestrator-agent/`: system prompt and skills (platform-neutral Markdown, injected into dispatched sessions).
- `config/`: default policy, example config.
- `clients/README.md`: registering with Copilot, Claude Code, Cursor, Claude Desktop.

Requires Node 22.5+ (uses built-in `node:sqlite`; no native dependencies).

> **Before your first real task, read [Important: set the model for dispatched sessions](#important-set-the-model-for-dispatched-sessions).** Dispatched sessions do not use your chat window's model unless you pin it, and they are billed separately.

## Build

```
npm install
npm run build        # re-run after any code change; MCP servers run from dist/
npm test
```

## Commands

Run from this repo's folder. Every command below is `node dist/cli.js ...`. After `npm link` (optional) you can type `sdlc-orchestrator ...` from anywhere instead.

### Install the agent and MCP servers

```
# GitHub Copilot in VS Code, for all projects (writes the agent file and mcp.json in your VS Code user profile)
node dist/cli.js install --target copilot

# GitHub Copilot CLI, for all projects (writes ~/.copilot/agents and ~/.copilot/mcp-config.json)
node dist/cli.js install --target copilot-cli

# both, and register your repos and the AI platform used for dispatched work
node dist/cli.js install --target copilot --platform copilot --repo D:/work/ProjectA --repo D:/work/ProjectB
node dist/cli.js install --target copilot-cli --platform copilot

# other tools
node dist/cli.js install --target claude
node dist/cli.js install --target cursor
node dist/cli.js install --target all

# preview only, change nothing
node dist/cli.js install --target copilot --dry-run

# also put the agent file inside a repo (.github/agents/); servers stay in your user config
node dist/cli.js install --target copilot --mode repo --repo D:/work/ProjectA
```

Options: `--target copilot|copilot-cli|claude|cursor|all`, `--mode global|repo`, `--repo <path>` (repeatable), `--platform`, `--analysis-platform`, `--coding-platform`, `--test-command`, `--profile`, `--insiders`, `--no-integrations`, `--jira-server`, `--github-server`, `--mcp-in-repo`, `--dry-run`. Run `node dist/cli.js --help` for details.

Existing MCP config files are merged, not overwritten, and backed up as `.bak` (comments in a JSON file are not preserved). Re-run the install after editing `orchestrator-agent/SYSTEM_PROMPT.md` to refresh the agent files, then reload your tool.

### Manage registered repos

```
node dist/cli.js repos list
node dist/cli.js repos add D:/work/ProjectC D:/work/ProjectD
node dist/cli.js repos remove D:/work/ProjectC
```

The agent offers registered repos when you do not name one.

### Inspect tasks and artifacts

```
node dist/cli.js tasks list
node dist/cli.js tasks show <task_id | JIRA-KEY | PR#>
node dist/cli.js tasks show <task_id> --stage plan       # one stage only: requirement | design | plan
node dist/cli.js tasks remove <task_id>                  # preview; add --yes to delete permanently (--with-children for sub-tasks)
```

`tasks show` prints the stage history and each artifact with its version, skill version, platform and the artifacts it was built from.

## Important: set the model for dispatched sessions

**The AI model in your chat window and the model used by dispatched sessions are separate settings.** The orchestrator runs in your chat window (the model you pick there). Each stage it dispatches (requirement, design, plan, coding) runs in a separate session of the platform's CLI, and that session uses the CLI's own default model, which may be larger and more expensive than the one you chose in chat. With the GitHub Copilot CLI the default was `claude-sonnet-5.5` when this was checked.

Pin the model in `~/.ai-sdlc-orchestrator/config.json` (Windows: `C:\Users\<you>\.ai-sdlc-orchestrator\config.json`), then reload your editor so the dispatch server rereads it:

```json
{
  "default_platform": "copilot",
  "platforms": {
    "copilot": { "model": "gpt-6-luna" }
  }
}
```

- Use the same model name as the chat window if you want the same model and cost level. Per-platform: `platforms.claude.model`, `platforms.cursor.model`. A single dispatch can also override it ("use model X for this stage").
- Find valid names for the Copilot CLI by running `copilot` and using `/model`. A wrong name fails immediately with "Model ... is not available" and costs nothing. Names are not shared between tools.
- Check what a dispatch actually used: the newest `process-*.log` in `~/.copilot/logs` contains `Using default model: ...` or the pinned model.
- Dispatched sessions are billed on their own, separately from chat messages. A session that explores a repo costs far more than a one-line reply, so try the pipeline on one small story first.

## Where things live

Everything is in `~/.ai-sdlc-orchestrator/` (override with `SDLC_DATA_DIR`):

| Path | Contents |
|---|---|
| `workflow.db` | Tasks, transitions, artifacts (`stage_artifacts` table), edge cases, approvals |
| `policy.json` | Stage rules, approval gates, retry limits |
| `config.json` | Platform routing, registered repos (`projects`), custom platforms |
| `dispatches/` | One folder per dispatched session: prompt, raw output, status |
| `backups/` | Daily copy of `workflow.db`, newest 14 kept |

## Using it

In your AI tool's chat, select the **orchestrator** agent and talk naturally ("hi", "what's open?", "work on D:/work/ProjectA: ..."). After each step every reply ends with numbered **Options** (confirm, revise, show, check status, run tests, cancel...). Reply with the number or the words.

Dispatched sessions run through the CLI of the configured AI platform (for Copilot, the GitHub Copilot CLI must be installed and signed in). See `config/config.example.json` and `clients/README.md`.
