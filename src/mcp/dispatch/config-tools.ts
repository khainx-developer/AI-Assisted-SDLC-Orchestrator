/** Settings tools: which repos and AI platforms are configured, and changing config.json. */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { loadConfig } from "../../config/config.js";
import { addProject, removeProject, updateSetting, describeConfig } from "../../config/config-edit.js";
import { PLATFORMS } from "../../dispatch/platforms.js";
import { run } from "./shared.js";

export function registerConfigTools(server: McpServer): void {
  server.tool(
    "list_projects", "Repos registered in the global config (sdlc-orchestrator repos / install --repo), with per-repo overrides. Use to let the user pick a repo.", {},
    () => run(() => Object.entries(loadConfig().projects ?? {}).map(([root, o]) => ({ project_root: root, name: root.split(/[\/]/).filter(Boolean).pop(), ...o })))
  );
  
  server.tool(
    "get_config", "Everything configured in config.json: global settings, platforms, every registered project with its settings, and the list of settings that can be changed (`project_settings`). Pass project_root for one project. Read it before suggesting a change.",
    { project_root: z.string().optional() },
    (a) => run(() => describeConfig(a.project_root))
  );
  
  server.tool(
    "add_project", "Register a repo (project_root, an existing folder) so tasks can use it. Ask the human first. Changes config.json.",
    { project_root: z.string().min(1) },
    (a) => run(() => addProject(a.project_root))
  );
  
  server.tool(
    "remove_project", "Unregister a repo: its settings are deleted from config.json (the repo itself and its tasks are untouched). Ask the human first.",
    { project_root: z.string().min(1) },
    (a) => run(() => removeProject(a.project_root))
  );
  
  server.tool(
    "update_config", "Change or unset one setting in config.json. With project_root it is that project's setting: platform, analysis_platform, coding_platform, review_platform, model, branch_pattern, test_command, tests_first, scope_check (off|warn|fail), scope_allow (list), redact_secrets, worktree (true: each task codes in its own git worktree so stories run in parallel; default false), worktree_setup (command run once in a new worktree, e.g. npm ci). Without project_root it is global: default_platform, analysis_platform, coding_platform, review_platform, branch_pattern, tests_first, scope_check, scope_allow, redact_secrets, dispatch_timeout_minutes, dispatch_retention_days, or platforms.<id>.model. value null unsets it. Only change what the human asked for, and say what you changed. Takes effect on the next dispatch; no restart needed.",
    { project_root: z.string().optional(), key: z.string().min(1), value: z.union([z.string(), z.boolean(), z.number(), z.array(z.string()), z.null()]) },
    (a) => run(() => updateSetting(a.project_root, a.key, a.value))
  );
  
  server.tool(
    "list_platforms", "AI platforms available for dispatch and which is configured for analysis/coding.", {},
    () => run(() => {
      const cfg = loadConfig();
      return {
        default_platform: cfg.default_platform, analysis_platform: cfg.analysis_platform ?? null, coding_platform: cfg.coding_platform ?? null,
        built_in: Object.values(PLATFORMS).filter((p) => p.id !== "generic").map((p) => ({ id: p.id, label: p.label, command: p.command, enforces_read_only: p.enforcesReadOnly })),
        custom: Object.keys(cfg.platforms).filter((k) => !PLATFORMS[k]),
      };
    })
  );
}
