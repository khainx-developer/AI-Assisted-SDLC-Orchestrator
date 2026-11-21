import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "sdlc-sh-"));
const shared = join(dir, "team-config");
process.env.SDLC_DATA_DIR = join(dir, "private");
process.env.SDLC_CONFIG = join(dir, "config.json");
writeFileSync(process.env.SDLC_CONFIG, JSON.stringify({
  shared_dir: shared,
  projects: { "/work/api": { slug: "api" } },
}));

const { loadPolicy, updatePolicy, policyPath } = await import("../workflow/policy.js");
const { writeLearning, readLearnings } = await import("../stores/learnings.js");

test("with shared_dir set, policy.json and learnings live there and nothing lands in the private data folder", () => {
  assert.equal(policyPath(), join(shared, "policy.json"));
  assert.equal(loadPolicy().max_test_retries, 3, "the default policy is copied in on first use");
  updatePolicy({ max_test_retries: 7 });
  assert.equal(JSON.parse(readFileSync(join(shared, "policy.json"), "utf8")).max_test_retries, 7);
  assert.equal(existsSync(join(process.env.SDLC_DATA_DIR!, "policy.json")), false);

  writeLearning("Jira tickets here put acceptance criteria in a comment", "/work/api");
  assert.ok(existsSync(join(shared, "learnings", "api.md")), "a stable slug keeps the note file the same on every machine");
  assert.match(JSON.stringify(readLearnings("/work/api")), /acceptance criteria/);
  assert.equal(existsSync(join(process.env.SDLC_DATA_DIR!, "learnings")), false);
});
