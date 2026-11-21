import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { listPlaybooks, readPlaybook, bundledPlaybooksDir } from "../stores/playbooks.js";

const prompt = readFileSync(join(bundledPlaybooksDir, "..", "SYSTEM_PROMPT.md"), "utf8");

test("every bundled playbook is readable and named in the system prompt", () => {
  const names = listPlaybooks();
  assert.deepEqual(names, ["autonomous", "configuration", "project-knowledge", "remove-task"]);
  for (const n of names) {
    assert.ok(readPlaybook(n).length > 200, `${n} has content`);
    assert.ok(prompt.includes(`\`${n}\``), `the prompt points at ${n}`);
  }
});

test("a playbook name cannot escape the folder or name a missing file", () => {
  assert.throws(() => readPlaybook("../SYSTEM_PROMPT"), /invalid playbook name/);
  assert.throws(() => readPlaybook("nope"), /not found; available: autonomous/);
});

test("the moved sections are no longer in the always-loaded prompt", () => {
  assert.ok(!prompt.includes("## Project knowledge"));
  assert.ok(!prompt.includes("## Changing configuration"));
  assert.ok(!prompt.includes("## Removing a task"));
});

test("knowledge sync is one way: the playbook never pulls from Confluence, and no tool can", async () => {
  const text = readPlaybook("project-knowledge");
  assert.match(text, /ONE WAY: local to Confluence/);
  assert.ok(!text.includes("apply_remote_knowledge_document"));
  const server = readFileSync(join(bundledPlaybooksDir, "..", "..", "src", "mcp", "dispatch", "knowledge-tools.ts"), "utf8");
  assert.ok(!/server\.tool\(\s*"apply_remote_knowledge_document"/.test(server));
});
