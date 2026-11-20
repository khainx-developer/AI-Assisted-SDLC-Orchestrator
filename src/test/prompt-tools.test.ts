import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// The orchestrator's own prompt and skills must only name tools that exist. A renamed or removed tool otherwise fails silently in a live chat.
const root = join(import.meta.dirname, "..", "..");
const registered = new Set<string>();
for (const f of ["src/workflow-state/server.ts", "src/dispatch/server.ts"]) {
  const src = readFileSync(join(root, f), "utf8");
  for (const m of src.matchAll(/server\.tool\(\s*"([a-z_]+)"/g)) registered.add(m[1]);
}

const TOOL_LIKE = /`((?:create|get|list|record|set|start|dispatch|run|mark|write|read|remove|search|update|approve|answer|cancel|check|delete|find|report|transition)_[a-z_]+)(?:\(|`)/g;
// words with a tool-like prefix that are fields or flags, not tools
const NOT_TOOLS = new Set(["dispatch_id", "dispatch_status", "dispatch_timeout_minutes", "read_only_violation"]);

function named(file: string): string[] {
  return [...readFileSync(file, "utf8").matchAll(TOOL_LIKE)].map((m) => m[1]).filter((n) => !NOT_TOOLS.has(n));
}

test("the servers register the tools this check reads", () => {
  assert.ok(registered.size >= 30, `only found ${registered.size} registered tools; the registration pattern may have changed`);
  assert.ok(registered.has("transition_stage") && registered.has("dispatch_review_task"));
});

test("SYSTEM_PROMPT.md and every skill name only tools that exist", () => {
  const files = [join(root, "orchestrator-agent", "SYSTEM_PROMPT.md")];
  const skills = join(root, "orchestrator-agent", "skills");
  for (const d of readdirSync(skills)) files.push(join(skills, d, "SKILL.md"));
  for (const f of files) for (const n of named(f)) assert.ok(registered.has(n), `${f} names tool '${n}', which no server registers`);
});

test("project knowledge is chat-led and limited to exact user-selected source files", () => {
  const section = readFileSync(join(root, "orchestrator-agent", "playbooks", "project-knowledge.md"), "utf8");
  assert.match(section, /Never scan, survey, crawl, recursively list, glob, or search the target repository/);
  assert.match(section, /Only call `read_project_source_files` for exact relative file paths the user has named/);
  assert.match(section, /After approval, use `write_knowledge_document`/);
  assert.doesNotMatch(section, /`(?:start_knowledge_run|get_knowledge_run)`/);
});
