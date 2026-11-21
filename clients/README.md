# Registering with an MCP client

The orchestrator is two stdio MCP servers plus a system prompt. Any MCP-capable client can host it. Replace `<REPO>` with the absolute path of this repo (after `npm install && npm run build`).

Server entries (same for every client):

```json
{
  "workflow-state": { "command": "node", "args": ["<REPO>/dist/mcp/workflow/server.js"] },
  "dispatch":       { "command": "node", "args": ["<REPO>/dist/mcp/dispatch/server.js"] }
}
```

| Client | Where the servers go | Where the system prompt goes |
|---|---|---|
| Claude Code | `claude mcp add --scope user workflow-state -- node <REPO>/dist/mcp/workflow/server.js` (and `dispatch`) | copy `orchestrator-agent/SYSTEM_PROMPT.md` to `~/.claude/agents/orchestrator.md` with frontmatter `name: orchestrator`, `description: SDLC orchestrator` |
| GitHub Copilot CLI | `~/.copilot/mcp-config.json` | `~/.copilot/agents/orchestrator.agent.md`. Prefer `node dist/cli/index.js install --target copilot-cli --repo <path>` (registers the repo; does not write into the project) |
| Cursor | `~/.cursor/mcp.json`, under `"mcpServers"` | `~/.cursor/agents/orchestrator-agent.md` (`@orchestrator-agent`). Prefer `node dist/cli/index.js install --target cursor --repo <path>` (registers the repo in orchestrator config; does not write into the project) |
| Claude Desktop | `claude_desktop_config.json`, under `"mcpServers"` | paste into a Project's instructions |

The orchestrator host and the AI platforms used for dispatched work are independent. You can drive from Copilot CLI while analysis runs on Claude and coding on Cursor: set `analysis_platform` / `coding_platform` in `~/.ai-sdlc-orchestrator/config.json` (see `config/config.example.json`).

Each dispatch platform's CLI must be installed and authenticated on the machine: `claude`, `copilot`, `cursor-agent`, or your own command declared under `platforms` in config.json. Run `list_platforms` from the orchestrator to see what is configured.

Environment: `SDLC_DATA_DIR` (default `~/.ai-sdlc-orchestrator`) holds `workflow.db`, `policy.json`, `config.json`, `learnings/`, `dispatches/` and `backups/`. `SDLC_CONFIG` points at a different config file.
