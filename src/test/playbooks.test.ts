import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { listPlaybooks, readPlaybook, bundledPlaybooksDir } from "../common/playbooks.js";

const prompt = readFileSync(join(bundledPlaybooksDir, "..", "SYSTEM_PROMPT.md"), "utf8");

test("every bundled playbook is readable and named in the system prompt", () => {
  const names = listPlaybooks();
  assert.deepEqual(names, ["configuration", "project-knowledge", "remove-task"]);
  for (const n of names) {
    assert.ok(readPlaybook(n).length > 200, `${n} has content`);
    assert.ok(prompt.includes(`\`${n}\``), `the prompt points at ${n}`);
  }
});

test("a playbook name cannot escape the folder or name a missing file", () => {
  assert.throws(() => readPlaybook("../SYSTEM_PROMPT"), /invalid playbook name/);
  assert.throws(() => readPlaybook("nope"), /not found; available: configuration/);
});

test("the moved sections are no longer in the always-loaded prompt", () => {
  assert.ok(!prompt.includes("## Project knowledge"));
  assert.ok(!prompt.includes("## Changing configuration"));
  assert.ok(!prompt.includes("## Removing a task"));
});
