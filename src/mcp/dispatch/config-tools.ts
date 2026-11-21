/** Read-only settings tools. Project setup and config changes are CLI-only (sdlc-orchestrator repos / config). */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { loadConfig } from "../../config/config.js";
import { describeConfig } from "../../config/config-edit.js";
import { PLATFORMS } from "../../dispatch/platforms.js";
import { run } from "./shared.js";

export function registerConfigTools(server: McpServer): void {
  server.tool(
    "list_projects", "Repos registered in the global config (sdlc-orchestrator repos / install --repo), with per-repo overrides. Use to let the user pick a repo.", {},
    () => run(() => Object.entries(loadConfig().projects ?? {}).map(([root, o]) => ({ project_root: root, name: root.split(/[\/]/).filter(Boolean).pop(), ...o })))
  );
  
  server.tool(
    "get_config", "Everything configured in config.json: global settings, platforms, every registered project with its settings, and the list of settings the user can change with the CLI (`project_settings`). Pass project_root for one project. Read-only: to change a setting, tell the user the `sdlc-orchestrator config set` command.",
    { project_root: z.string().optional() },
    (a) => run(() => describeConfig(a.project_root))
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
