# Knowledge base design (local first, Confluence mirror)

Status: the page header, skill updates, playbook rules, the freshness check (section 2), the worker index (section 3) and the Confluence plan (section 4) are built. Nothing in this design calls or changes Jira. Extends [knowledge-pipeline.md](knowledge-pipeline.md) and backlog item 10.

## Goal

One knowledge base per project, written for AI use. You edit it locally with the agent, and ask the agent to sync it to Confluence when you want a copy there. Two readers:

| Reader | Needs | Reads from |
|---|---|---|
| The agent's worker sessions (requirement, design, plan, coding, review) | Facts about the codebase before they act | The local Markdown files |
| Anyone or anything reading Confluence (people, or other tools such as Rovo, outside this project) | The same facts, findable | Confluence pages |

The local Markdown files are the source of truth. Confluence is a one-way mirror that the user syncs on purpose: local to Confluence, never back. Our job ends at publishing good, labelled, fresh pages: no Jira calls, no Rovo. Nothing here scans the repository: pages are written in chat from files the user names, as today.

## What exists, what is missing

| Piece | State |
|---|---|
| Write pages in chat from user-selected files, cite `path:line` | Built |
| Local store outside the repo, Confluence sync with baseline and conflict handling | Built |
| Claim checks (`claims.ts`, `module-check.ts`, `claim-verification` skill) | Built, but only as CLI commands, not in the chat flow |
| Workers receive the knowledge (index in every dispatch prompt) | Built (section 3) |
| Freshness: which pages are stale after the code changed | Built (section 2) |
| Confluence titles, labels, generated index page, rename preview | Built (section 4) |
| Page header (`Source`, `Type`, `Summary`, `Applies to`, `Status`) | Built (section 1) |
| `knowledge-refresh` (re-verify only the changed claims) | Not built |

## 1. Page format

Every page starts with a small header, so a person, a worker and Confluence search all read the same thing first. `Source:` is the line the existing `module-check.ts` already parses, so the freshness check reuses it.

```
# <Title>

Source: <repository>@<git commit sha>
Type: module | domain-rules | conventions | decision | glossary | how-to | overview
Summary: <two or three sentences: what this is and when to read it>
Applies to: <paths or folders, comma separated>
Status: draft | approved

## <body: facts as bullets, each ending with its citation `path:line`>
```

- `Summary` and `Applies to` are the retrieval keys. The worker index (section 3) shows them and orders pages by `Applies to`.
- `Source` is the commit the citations were last checked against. A refresh moves it forward.
- Types reuse what the `conventions`, `domain-rules` and `decision-mining` skills already write. `how-to` ("how to add an endpoint here") and `glossary` (the words the business uses, so tickets and code agree) are new.
- Page text is capped near 1500 words. Longer pages are split, because search and workers both do better with short focused pages.
- Status: done for the three stage skills (`conventions`, `domain-rules`, `decision-mining` write the header, and take the files the user names instead of a survey) and for the `project-knowledge` playbook (the chat flow writes the same header).

## 2. Freshness: `knowledge check`

A deterministic check, no model call.

1. Read the page header. Collect every `path:line` citation (the same pattern `claims.ts` already parses).
2. Ask git which of those files changed since the `Source` commit (`git diff --name-only <sha>..HEAD`), and whether the cited lines still exist.
3. Report per page: `fresh`, `stale` (a cited file changed, with the list), or `broken` (a cited file or line range is gone).

Uses:
- Exposed as a tool `check_knowledge_freshness(project_root)` and a CLI command. The orchestrator offers it at the start of a task and before a Confluence sync.
- A stale or broken page is shown in the sync preview. Publishing it needs the user's explicit "publish anyway".
- To refresh a stale page, the existing claim-verification flow runs on only the claims whose cited files changed. The user approves the edit, and `Source` moves to the new commit.
- Workers report drift. When the code contradicts a page, the worker's summary names the page and the line (the rule is already "code wins"). The orchestrator marks the page stale and tells the user.

Not done: automatic refresh, scanning for changed files nobody cites, a background watcher.

## 3. Local use: workers read the knowledge

Add to every dispatch prompt a short `KNOWLEDGE` block, built the same way as the repo-instruction index:

- One line per page: path, type, summary, `Applies to`. Capped (default 3000 characters, the pages whose `Applies to` overlaps the task's files first).
- The knowledge folder is added to the session's read-only roots, so the worker opens a page only when its line looks relevant. The pages are not pasted in.
- The stated rule: pages are background. When code and page disagree, the code wins, and the worker names the page in its summary as drift.
- Setting `knowledge_in_prompts` (default on when the project has pages, off otherwise), per project and global, like the other prompt options.

This costs about 750 tokens per dispatch and nothing when there are no pages.

Built as `knowledgeIndex` in `src/knowledge/index-block.ts`, used by all four dispatch kinds (analysis, review, test-authoring, coding). Pages ordered first are those whose `Applies to` covers the coding task's `target_files`; the other dispatches list pages alphabetically. The index does not run the freshness check (it would spawn git for every page on every dispatch); it shows the `Source` commit each page was checked at, and the orchestrator runs `check_knowledge_freshness` when it matters. The folder is added to the session's extra read roots, which for a coding session is a prompt rule ("never modify") and not a hard block, the same as other extra roots.

## 4. Confluence mirror

The sync is built. Changes so people and other tools find the right page in Confluence:

- **Titles.** Today the title carries the relative file path. Change to `<Project> / <page title>` and keep the path in the sync mapping (it is already stored by page ID), so titles read well and search well.
- **Labels.** Add `sdlc-knowledge`, the page `Type`, and the project slug on create and update. Confluence search can then be filtered by label.
- **Index page.** One generated page under the parent, listing every page with its summary and `Source`. It is rebuilt before each sync preview and is the page to open first.
- **Summary on top.** The `Summary`, `Applies to`, `Source` and `Status` lines go in the page's first block. `Source` shows a reader how old the page is.
- Built as `plan_knowledge_publish` and `write_knowledge_index` (`src/knowledge/publish-plan.ts`). Both are local: the plan says what publishing would do and the orchestrator performs the remote writes after the user approves the preview. A rename of an already-synced page is listed on its own line in the preview. Whether labels can be set depends on the Atlassian MCP having a label operation; if not, the orchestrator lists them for the user.
- Everything else stays: explicit preview, conflicts preserved, no deletes propagated, page text treated as untrusted.

## Skills
| Skill | State | Role |
|---|---|---|
| `conventions`, `domain-rules`, `decision-mining` | updated | write pages with the header, from the files the user names |
| `claim-verification` | unchanged | re-checks claims in a stale page against the lines they cite |
| `knowledge-refresh` | new, not built | takes the stale list, re-verifies only the changed claims, proposes edits |

The chat-led flow writes pages in the orchestrator's own reply (the `project-knowledge` playbook), with no worker dispatch. The three stage skills run only when a worker is dispatched with them (`dispatch_analysis_task` by skill name). The playbook now allows a dispatched worker for a large page when the user has named the files and agrees. The worker's output is a draft shown in chat and saved only after approval.

## Build order

1. `knowledge check` and the page header (sections 1 and 2). The rest builds on `Applies to` and `Source`.
2. `KNOWLEDGE` block in dispatch prompts (section 3). This is what makes the pages useful to workers.
3. Confluence titles, labels, index page (section 4).

Each step ships on its own and each has a deterministic test: header parsing, the git-diff staleness check, the prompt block size and ordering, the sync metadata.

## Open questions

1. `Source` needs a commit. In a folder that is not a git repository, or when the commit is not in it, the check reports `unknown` and says nothing more. Accept that?
2. Should `Status: approved` mean a human read it, and should workers trust only approved pages? Today saving a draft is not approval.
3. Multi-repo projects: one knowledge folder per repo (as now, by project slug) or one shared. This design assumes per repo.
