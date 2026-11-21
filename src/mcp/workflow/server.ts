/**
 * The `workflow-state` MCP server: the single source of truth for tasks, stages, approvals and stage documents.
 * Tool definitions live in the sibling modules; this file only wires them up and connects the transport.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { wf } from "./shared.js";
import { registerTaskTools } from "./task-tools.js";
import { registerDocumentTools } from "./document-tools.js";
import { registerGateTools } from "./gate-tools.js";
import { registerMemoryTools } from "./memory-tools.js";
import { registerAutonomyTools } from "./autonomy-tools.js";

try { wf.backup(); } catch (e) { console.error("backup failed:", e); }

const server = new McpServer({ name: "workflow-state", version: "0.1.0" });
registerTaskTools(server);
registerDocumentTools(server);
registerGateTools(server);
registerMemoryTools(server);
registerAutonomyTools(server);

await server.connect(new StdioServerTransport());
