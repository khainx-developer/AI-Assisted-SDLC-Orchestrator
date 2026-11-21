# Troubleshooting

| Symptom | Cause and fix |
|---|---|
| Agent says it has no tools / can't find the orchestrator | Reload the window, open "MCP: List Servers", start the four servers. Start a **new** chat after changing the prompt (old chats keep the old one) |
| "GitHub Copilot CLI was not found" or `UnsupportedWindowsCommandValue` | The Copilot CLI isn't installed, or only VS Code's `copilot-shim` is on PATH. Install it (`npm install -g @github/copilot`) and run `copilot` once. The dispatcher launches the real binary on Windows |
| Worker session says "Skipped workspace MCP servers ... not trusted" | Harmless warning. Trust the folder in the CLI if the worker needs repo-level MCP servers |
| Cursor Agent: "Workspace Trust Required" / exits 1 on analysis | Headless `cursor-agent` needs `--trust`. The Cursor adapter always passes it; rebuild (`npm run build`) and reload MCP if you still see the old error |
| Agent says "still running" and stops | Say `check status`. A stage takes 1 to 5 minutes. Past that, the agent reports the elapsed time and offers to cancel and retry; `dispatch_timeout_minutes` (default 30, lower it in `config.json` if stages are quick) kills a session that runs too long and marks it failed |
| `spawn ENAMETOOLONG` on Windows | The prompt was too long for a command line. Prompts over 8,000 characters are now passed as a file; rebuild and reload if you still see it |
| A story is missing from "what's open?" | Check `node dist/cli/index.js tasks list`; make sure the repo is registered (`repos list`) |
| `Model "x" is not available` | Fix the name in `config.json` (see `/model` in `copilot`) |
| Dispatch failed for another reason | Read `~/.ai-sdlc-orchestrator/dispatches/<id>/meta.json` (`error`, `stderr_tail`, `output`) |
| Changes to the code have no effect | Run `npm run build`, then reload your tool (the servers run from `dist/`) |
