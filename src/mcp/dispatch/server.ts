/**
 * The `dispatch` MCP server: starts AI worker sessions and manages settings and project knowledge.
 * Tool definitions live in the sibling modules; this file only wires them up and connects the transport.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "../../config/config.js";
import { pruneDispatches } from "../../stores/dispatch-store.js";
import { registerConfigTools } from "./config-tools.js";
import { registerKnowledgeTools } from "./knowledge-tools.js";
import { registerSessionTools } from "./session-tools.js";

const server = new McpServer({ name: "dispatch", version: "0.1.0" });
registerConfigTools(server);
registerKnowledgeTools(server);
registerSessionTools(server);

// housekeeping: drop old finished dispatch folders at startup (never in-flight ones)
try { const d = loadConfig().dispatch_retention_days ?? 14; if (d > 0) pruneDispatches(d); } catch { /* housekeeping must not block startup */ }

await server.connect(new StdioServerTransport());
