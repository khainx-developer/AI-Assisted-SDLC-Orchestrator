# Working with the agent effectively

Every stage is a separate AI session that costs time and tokens, so most of the saving comes from how you phrase requests.

**Say how big the change is**
- "Small tweak: rename X to Y in `file`" goes into the task's change log and one coding session. No document is regenerated.
- "Change the requirement/plan to ..." (scope, acceptance criteria, approach) revises the document and its downstream stages. Use it only when that is what you mean.
- Several small things in one message become one coding session.
- Be specific: name the file, line or value. The session then skips searching.
- For familiar work, say "skip design" or "go straight to coding".

**Let the agent change settings.** You can ask in chat ("set the test command for ProjectA to `dotnet test App.sln`", "turn worktrees on for ProjectA", "use copilot for ProjectA"), or run `config set` yourself. It changes only what you ask and tells you the old and new value.

**Keep the cost down**
- Start a new chat for each task. A long chat carries every earlier artifact and tool result in every turn.
- Set `test_command` for repos with more than one solution or project, otherwise `run_tests` fails at once.
- Put a one-line `description:` in each skill and agent file of the repo. Analysis prompts list these files by description instead of including them, so the description is what lets the session choose.
- Keep the repo's instruction files short. What the AI CLI loads itself is not repeated in the prompt, and the rest is capped (`repo_instructions_max_chars`, default 12000).
- Saved knowledge pages reach worker sessions as a short index (path, type, summary, what each covers), capped near 3000 characters; the session opens a page only when it fits the task, and the code wins when a page disagrees. Nothing is added when a project has no pages. Turn it off with `knowledge_in_prompts: false`, globally or per project.
- Set a budget (`budget.task_tokens`, `action: "warn"`) and ask "what did this task cost?" (`get_usage`). Copilot reports no usage, so its numbers are lower bounds.
- Turn on `worktree` only to run stories in parallel: each one is a full copy of the repo.

**Do by hand (the agent cannot)**
- After pulling an update: `npm run build`, then `node dist/cli/index.js install --target <tool>`, then restart the tool or open a new chat.
- Check that both MCP servers are started and their tool groups enabled in your AI tool. If a tool is missing the agent says so and stops.
- Edit files in the repo itself (for example skill descriptions) as an ordinary coding task.

**If it takes the slow path anyway**: say "small tweak, no analysis". The rules are written into the agent's prompt, which the model follows most of the time, not always.
