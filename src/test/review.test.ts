import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const dir = mkdtempSync(join(tmpdir(), "sdlc-rv-"));
process.env.SDLC_DATA_DIR = dir;
const cfgPath = join(dir, "config.json");
process.env.SDLC_CONFIG = cfgPath;
const writeCfg = (extra: object = {}) => writeFileSync(cfgPath, JSON.stringify({ default_platform: "claude", platforms: { claude: {}, copilot: {} }, ...extra }));
writeCfg();

const repo = join(dir, "repo");
mkdirSync(repo);
const g = (...a: string[]) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...a], { cwd: repo, encoding: "utf8" });
g("init", "-q", "-b", "main");
writeFileSync(join(repo, "mailer.js"), "export const send = () => true;\n");
g("add", "-A"); g("commit", "-q", "-m", "base");
g("checkout", "-q", "-b", "story/x");
writeFileSync(join(repo, "mailer.js"), "export const send = () => { for (let i = 0; i < 2; i++) {} return true; };\n");
writeFileSync(join(repo, "mailer.test.js"), "// test\n");
g("add", "-A"); g("commit", "-q", "-m", "retry");

const { branchDiff, detectBase, reviewInstructions, chooseReviewer, MAX_DIFF_CHARS } = await import("../dispatch/review.js");
const { dispatchDir, metaFile, latestDispatch } = await import("../stores/dispatch-store.js");
const { loadSkill } = await import("../dispatch/prompt.js");

const seedCoding = (id: string, task: string, platform: string, model: string | undefined, finished: string) => {
  mkdirSync(dispatchDir(id), { recursive: true });
  writeFileSync(metaFile(id), JSON.stringify({ dispatch_id: id, kind: "coding", task_id: task, platform, model, project_root: repo, status: "completed", started_at: finished, finished_at: finished }));
};

// ---------- the diff ----------

test("the diff is the change on the branch since it left main, with a file list", async () => {
  const d = await branchDiff(repo, "story/x");
  assert.equal(d.base, "main");
  assert.deepEqual(d.files.sort(), ["mailer.js", "mailer.test.js"]);
  assert.match(d.patch, /\+export const send = \(\) => \{ for/);
  assert.match(d.stat, /mailer\.js/);
  assert.equal(d.truncated, false);
});

test("changes made on main after the branch left it are not counted (three-dot diff)", async () => {
  g("checkout", "-q", "main");
  writeFileSync(join(repo, "other.js"), "// unrelated\n");
  g("add", "-A"); g("commit", "-q", "-m", "unrelated work on main");
  g("checkout", "-q", "story/x");
  const d = await branchDiff(repo, "story/x");
  assert.ok(!d.files.includes("other.js"));
});

test("an unknown base is reported; a branch with no changes is refused; master is found when there is no main", async () => {
  await assert.rejects(branchDiff(repo, "story/x", "nope"), /base branch 'nope' not found/);
  g("branch", "story/empty", "main");
  await assert.rejects(branchDiff(repo, "story/empty"), /nothing to review/);
  g("branch", "-m", "main", "master");
  assert.equal(await detectBase(repo), "master");
  g("branch", "-m", "master", "main");
});

test("a huge diff is cut at whole files and the reviewer is told which files it did not get", async () => {
  g("checkout", "-q", "-b", "story/big", "main");
  writeFileSync(join(repo, "small.js"), "export const a = 1;\n");
  writeFileSync(join(repo, "huge.js"), Array.from({ length: 6000 }, (_, i) => `export const v${i} = "${"x".repeat(20)}";`).join("\n") + "\n");
  g("add", "-A"); g("commit", "-q", "-m", "big");
  const d = await branchDiff(repo, "story/big");
  assert.equal(d.truncated, true);
  assert.ok(d.patch.length <= MAX_DIFF_CHARS);
  assert.deepEqual(d.omitted, ["huge.js"]);
  assert.ok(d.patch.includes("small.js") && !d.patch.includes("huge.js"), "whole files only, never half a hunk");
  const text = reviewInstructions({ context: "ctx", branch: "story/big", diff: d });
  assert.match(text, /THE DIFF IS TRUNCATED[\s\S]*huge\.js/);
  g("checkout", "-q", "story/x");
});

test("the review input carries the requirement and plan, the file list and the diff", async () => {
  const d = await branchDiff(repo, "story/x");
  const text = reviewInstructions({ context: "AC1: retry 3 times", branch: "story/x", diff: d });
  assert.match(text, /story\/x' against 'main'/);
  assert.match(text, /AC1: retry 3 times/);
  assert.match(text, /FILES CHANGED \(2\)/);
  assert.match(text, /THE FULL DIFF:\n```diff\ndiff --git/);
});

// ---------- who reviews ----------

test("the reviewer is another configured platform than the coder, and that is reported as independent", () => {
  seedCoding("d_a0000001", "T1", "claude", "m1", "2026-01-01T00:00:00Z");
  const c = chooseReviewer({ taskId: "T1", projectRoot: repo, fallback: "claude" });
  assert.equal(c.platform, "copilot");
  assert.equal(c.independent, true);
  assert.deepEqual(c.coded_by, { platform: "claude", model: "m1" });
  assert.match(c.reason, /differs from coder claude/);
});

test("the latest coding dispatch decides who the coder was", () => {
  seedCoding("d_a0000002", "T2", "claude", undefined, "2026-01-01T00:00:00Z");
  seedCoding("d_a0000003", "T2", "copilot", undefined, "2026-02-01T00:00:00Z");
  assert.equal(latestDispatch("T2", "coding")?.platform, "copilot");
  assert.equal(chooseReviewer({ taskId: "T2", projectRoot: repo, fallback: "claude" }).platform, "claude");
});

test("naming the coder's own platform is allowed but flagged as not independent, unless the model differs", () => {
  seedCoding("d_a0000004", "T3", "claude", "m1", "2026-01-01T00:00:00Z");
  const same = chooseReviewer({ taskId: "T3", projectRoot: repo, explicit: "claude", model: "m1", fallback: "claude" });
  assert.equal(same.independent, false);
  assert.match(same.reason, /NOT independent/);
  const noModel = chooseReviewer({ taskId: "T3", projectRoot: repo, explicit: "claude", fallback: "claude" });
  assert.equal(noModel.independent, false);
  const otherModel = chooseReviewer({ taskId: "T3", projectRoot: repo, explicit: "claude", model: "m2", fallback: "claude" });
  assert.equal(otherModel.independent, true);
  assert.match(otherModel.reason, /model m2 differs from the coder's m1/);
});

test("review_platform in config wins over the automatic choice; a repo's value wins over the global one", () => {
  seedCoding("d_a0000005", "T4", "claude", undefined, "2026-01-01T00:00:00Z");
  writeCfg({ platforms: { claude: {}, copilot: {}, cursor: {} }, review_platform: "cursor" });
  assert.equal(chooseReviewer({ taskId: "T4", projectRoot: repo, fallback: "claude" }).platform, "cursor");
  writeCfg({ platforms: { claude: {}, copilot: {}, cursor: {} }, review_platform: "cursor", projects: { [repo.split("\\").join("/")]: { review_platform: "copilot" } } });
  assert.equal(chooseReviewer({ taskId: "T4", projectRoot: repo, fallback: "claude" }).platform, "copilot");
  writeCfg();
});

test("with nothing but the coder's platform available, the fallback is used and flagged; with no coding record independence cannot be judged", () => {
  seedCoding("d_a0000006", "T5", "claude", undefined, "2026-01-01T00:00:00Z");
  writeCfg({ default_platform: "claude", platforms: { claude: {} } });
  const only = chooseReviewer({ taskId: "T5", projectRoot: repo, fallback: "claude" });
  assert.equal(only.platform, "claude");
  assert.equal(only.independent, false);
  assert.match(only.reason, /NOT independent/);
  const none = chooseReviewer({ taskId: "T-none", projectRoot: repo, fallback: "claude" });
  assert.equal(none.independent, false);
  assert.match(none.reason, /independence cannot be checked/);
  writeCfg();
});

test("the code-review skill loads and asks for the template the checks expect", () => {
  const s = loadSkill("code-review");
  assert.match(s.version, /^code-review@[0-9a-f]{8}$/);
  for (const h of ["## Verdict", "## Findings", "## Plan compliance", "## Tests"]) assert.ok(s.body.includes(h), `skill lacks ${h}`);
  assert.match(s.body, /did not write this change/);
});
