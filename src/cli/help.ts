/** Text printed by `sdlc-orchestrator --help`. */
export const HELP = `sdlc-orchestrator install [options]

  --target <t>        copilot-cli (~/.copilot) | claude | cursor | all        (required)
  --mode <m>          global (default): agent + servers for all projects; repos named with --repo are
                      registered in the global config
                      repo: for claude only, also put the agent file inside each --repo
                      (copilot-cli, cursor: always user-global; --repo only updates config.json)
  --repo <path>       repository; repeat for several. Registered in ~/.ai-sdlc-orchestrator/config.json
  --platform <p>      default AI platform for dispatched work: claude | copilot | cursor | <custom id>
                      (copilot/copilot-cli/cursor + --repo: defaults each repo's platform unless you pass --platform)
  --analysis-platform <p>   platform for read-only analysis stages
  --coding-platform <p>     platform for coding sessions
  --no-integrations   do not register/allow the Jira (Atlassian) and GitHub MCP servers
  --jira-server <name>    MCP server key for Jira (default com.atlassian/atlassian-mcp-server)
  --github-server <name>  MCP server key for GitHub (default io.github.github/github-mcp-server)
  --test-command <c>  test command to record for the registered repo(s)
  --dry-run           show what would be written, change nothing
  -h, --help

sdlc-orchestrator repos list | add <path>... | remove <path>...   manage registered repos in the global config
sdlc-orchestrator model show [--repo <path>]                        AI model per repo (overrides the platform's model; a one-off model on a dispatch overrides both)
sdlc-orchestrator model set <name> --repo <path>                   model name as the repo's AI CLI expects it
sdlc-orchestrator model reset --repo <path>
sdlc-orchestrator branch show [--repo <path>]                      branch naming pattern in effect (default story/{key})
sdlc-orchestrator branch set <pattern> [--repo <path>]             e.g. feature/{key}; without --repo sets the global pattern
sdlc-orchestrator branch reset [--repo <path>]                     back to the default (or the global pattern, for a repo)
sdlc-orchestrator config show [--repo <path>]                      everything configured, global and per repo
sdlc-orchestrator config add-project <path>                        register a repo
sdlc-orchestrator config remove-project <path>
sdlc-orchestrator config set <key> <value> [--repo <path>]         without --repo: a global setting. Keys: platform, analysis_platform, coding_platform,
                                                                   review_platform, model, branch_pattern, test_command, tests_first, scope_check,
                                                                   scope_allow, redact_secrets, worktree, worktree_setup (repo); default_platform,
                                                                   dispatch_timeout_minutes (global); platforms.<id>.model (global)
sdlc-orchestrator config unset <key> [--repo <path>]               e.g. config set worktree true --repo D:/work/App
sdlc-orchestrator dispatches usage [--task <id>] [--days N]        token use and cost of finished dispatches
sdlc-orchestrator autopilot enable | disable                         turn unattended runs on or off (policy.autonomy.enabled)
sdlc-orchestrator autopilot start --repo <path> [--tasks a,b] [--hours N] [--max-dispatches N] [--platform copilot|claude]
                                                                     work the repo's tasks unattended; decisions allowed by policy.autonomy are logged, the rest park
sdlc-orchestrator autopilot start --resume <run_id>                  carry on a run after a crash or reboot
sdlc-orchestrator autopilot status | stop | report [--run <run_id>]  progress, stop, or the morning report
sdlc-orchestrator evals check                                   offline check of the skill eval cases against their golden artifacts
sdlc-orchestrator evals run [--case <n>] [--platform <p>] [--model <m>] [--repeat N]   run the cases through real AI sessions (costs money)
`;
