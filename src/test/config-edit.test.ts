import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "sdlc-ce-"));
process.env.SDLC_DATA_DIR = join(dir, "data");
mkdirSync(process.env.SDLC_DATA_DIR);
const cfgPath = join(dir, "config.json");
process.env.SDLC_CONFIG = cfgPath;
const repo = join(dir, "app");
mkdirSync(repo);

const { addProject, removeProject, updateSetting, describeConfig } = await import("../common/config-edit.js");
const { worktreeSettings } = await import("../common/config.js");
const saved = () => JSON.parse(readFileSync(cfgPath, "utf8"));

test("add a project, turn worktree on and off, and loadConfig sees it at once", () => {
  assert.equal(addProject(repo).added, true);
  assert.equal(addProject(repo).added, false);
  assert.equal(worktreeSettings(repo).enabled, false, "off by default");
  updateSetting(repo, "worktree", "true");
  updateSetting(repo, "worktree_setup", "npm ci");
  assert.deepEqual(worktreeSettings(repo), { enabled: true, setup: "npm ci" });
  updateSetting(repo, "worktree", null);
  assert.equal(worktreeSettings(repo).enabled, false);
});

test("values are validated and typed", () => {
  updateSetting(repo, "platform", "copilot");
  updateSetting(repo, "scope_check", "fail");
  updateSetting(repo, "scope_allow", "package-lock.json, yarn.lock");
  updateSetting(repo, "tests_first", true);
  const p = Object.values<any>(saved().projects)[0];
  assert.equal(p.platform, "copilot");
  assert.deepEqual(p.scope_allow, ["package-lock.json", "yarn.lock"]);
  assert.equal(p.tests_first, true);
  assert.throws(() => updateSetting(repo, "platform", "nope"), /unknown platform/);
  assert.throws(() => updateSetting(repo, "scope_check", "maybe"), /off, warn or fail/);
  assert.throws(() => updateSetting(repo, "worktree", "perhaps"), /true or false/);
  assert.throws(() => updateSetting(repo, "branch_pattern", "feature/x"), /must contain/);
  assert.throws(() => updateSetting(repo, "branch_pattern", "f/{key}/{oops}"), /no other placeholder/);
  assert.throws(() => updateSetting(repo, "shared_dir", "/x"), /cannot be set per repo/);
  assert.throws(() => updateSetting(join(dir, "other"), "worktree", true), /not registered/);
});

test("global settings and platform models", () => {
  updateSetting(undefined, "default_platform", "claude");
  updateSetting(undefined, "branch_pattern", "feature/{key}");
  updateSetting(undefined, "platforms.copilot.model", "gpt-x");
  assert.equal(saved().platforms.copilot.model, "gpt-x");
  assert.throws(() => updateSetting(undefined, "worktree", true), /cannot be set globally/);
  assert.throws(() => updateSetting(undefined, "default_platform", null), /cannot be unset/);
  updateSetting(undefined, "platforms.copilot.model", null);
  assert.equal(saved().platforms.copilot.model, undefined);
  const d = describeConfig(repo);
  assert.equal(d.global.branch_pattern, "feature/{key}");
  assert.equal(Object.keys(d.projects).length, 1);
});

test("remove a project", () => {
  assert.equal(removeProject(repo).removed, true);
  assert.equal(removeProject(repo).removed, false);
  assert.throws(() => addProject(join(dir, "missing")), /not found/);
});
