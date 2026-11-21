# Configuration

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

## Two stories from different branches

Every task has a `base_branch`: the branch its work starts from and is reviewed against. You normally do not set it. Check out the branch you want, open the chat and say "start story A": the task records what is checked out (`dev`). Later switch to `release` and say "start story B": that one records `release`. To say it in words instead, "start story B based on `release`". If you left the checkout on a story branch, the next story takes that story's base, never the story branch itself. The orchestrator tells you which base it picked, and "base it on X" changes it before work starts.

Stories share the repo checkout, so only one can have a coding session running at a time. The server refuses to start a second story's coding session until the first finishes, because switching branches under a running session would break it. While a session runs, leave the checkout alone. Stories with different bases cannot conflict until you merge both into one branch; the file-overlap check tells you when two stories touch the same files and whether their bases match. To run stories in parallel, turn on a worktree per task for that repo (off by default):

```json
{ "projects": { "D:/work/ProjectA": { "worktree": true, "worktree_setup": "npm ci" } } }
```

Each task then codes in its own git worktree under the data folder (`worktrees/<repo>/<task>`), on the task's branch, so the main checkout is never switched and stories do not block each other. A new task branch starts from the task's base branch (`set_task_base` / `base_branch`), else from the branch currently checked out in the main repo; an existing branch is checked out as it is. A task's retries reuse its worktree; only one session per task runs at a time. `run_tests` runs there too. `worktree_setup` is an optional command run once in a new worktree, because ignored files such as `node_modules` are not part of it. When a story is merged or dropped, `remove_worktree` deletes the folder (the branch stays); it refuses while a session runs or work is uncommitted unless `force=true`. Cost: every worktree is a full working copy, so a very large repo needs that much disk per story. Not available for workspaces with `child_repos`; set it on each child repo's own entry instead.

**Branch names.** Coding work always runs on its own branch, created automatically from whatever is checked out. The default name is `story/<Jira key or task id>` (the installer writes it to `config.json` as `branch_pattern`; it never overwrites one you set). To follow your team's convention, run `node dist/cli/index.js branch set "feature/{key}" --repo <path>` (it validates the pattern and shows an example name), or set `branch_pattern` globally or per repo in `config.json` yourself:
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

**Model per repo.** The model is normally set per platform (`platforms.<id>.model`), so every repo using that platform shares it. To give one repo its own, use `model set` (see the README's command list) or `projects.<root>.model` in `config.json`. Precedence: a model named on a single dispatch, then the repo's `model`, then the platform's `model`, then the CLI's own default. The name must be valid for that repo's AI CLI; a repo whose analysis and coding run on different platforms should keep using the per-platform setting.

**Independent review.** After the tests pass, the orchestrator can offer one extra read-only session that reviews the task branch's diff against `main` (or `base_branch`) and judges it against the requirement and plan: see [workflow.md](workflow.md). It runs on a platform or model other than the coder's where one is configured, and says whether it really was independent. To choose the reviewer yourself:
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

## Tests first, scope and wrong specs

Three checks on the implementation stage. They are enforced by the dispatch server after each session, not by asking the AI nicely.

**Scope.** The plan's "Files touched" is the allowed scope of the coding session. Files it changes outside that list are reported to you. Set what happens in `config.json` (global, or per repo under `projects`):
```json
{ "scope_check": "warn", "projects": { "D:/work/ProjectA": { "scope_check": "fail", "scope_allow": ["package-lock.json", "docs/**"] } } }
```
`warn` (default) lets the work finish and shows you the extra files so you can keep them, revert them or revise the plan; `fail` fails the dispatch; `off` skips the check. `scope_allow` takes files, directories or globs that are always fine.

**Tests first (optional, off by default).** One extra AI session writes the failing tests from the plan's Test Plan before any code exists. The server checks they fail for the right reason, then freezes them: the coding session must make them pass and cannot edit them (a change fails the dispatch, with the original saved aside). It costs roughly one extra session per task, so it is worth it for bug fixes, logic, parsing, validation, API contracts and risky changes, and not for refactors, UI, config, docs or small edits. Turn it on for a repo with `"tests_first": true`; otherwise the orchestrator only offers it as a numbered option when the task looks like a good fit. A smaller model is usually enough for this step (the orchestrator can pass `model` for it).

**Wrong specs.** If a coding session finds that the plan (or design, or requirement) itself cannot be right, it says so instead of working around it. The task goes back to that stage with the problem added as an open question, you answer it, and the revised plan needs approval again. A task can be sent back twice by default (`max_spec_wrong_returns` in `policy.json`), then the orchestrator asks you.

After updating, re-run `node dist/cli/index.js install --target <your tool>` (the system prompt is copied into the agent file) and reload your tool. An existing `policy.json` needs no edit: the new policy fields have defaults.
