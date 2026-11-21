import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const dir = mkdtempSync(join(tmpdir(), "sdlc-wt-"));
process.env.SDLC_DATA_DIR = join(dir, "data");
mkdirSync(process.env.SDLC_DATA_DIR);

const slow = join(dir, "slow-coder.mjs");
writeFileSync(slow, `import { writeFileSync } from "node:fs"; writeFileSync("made.txt", "x"); await new Promise((r) => setTimeout(r, 1200)); console.log("done");`);
const repo = join(dir, "repo");
mkdirSync(repo);
const cfgPath = join(dir, "config.json");
const setCfg = (project: object) => writeFileSync(cfgPath, JSON.stringify({ default_platform: "slow", platforms: { slow: { command: process.execPath, args: [slow], prompt_via: "file" } }, projects: { [repo]: project } }));
process.env.SDLC_CONFIG = cfgPath;
setCfg({});

const git = (cwd: string, ...a: string[]) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...a], { cwd, encoding: "utf8" }).trim();
git(repo, "init", "-q", "-b", "main");
writeFileSync(join(repo, "a.txt"), "a");
git(repo, "add", "-A");
git(repo, "commit", "-q", "-m", "init");

const { prepareWorkDir, removeWorktree, worktreePath } = await import("../dispatch/checkout.js");
const { startAgentDispatch, getDispatch } = await import("../dispatch/runner.js");

async function wait(id: string) {
  for (let i = 0; i < 100; i++) { const m = getDispatch(id); if (m.status !== "in-flight") return m; await new Promise((r) => setTimeout(r, 100)); }
  throw new Error("dispatch never finished");
}

test("worktree is off by default: the repo checkout is used", async () => {
  assert.equal(await prepareWorkDir(repo, "story/off", "T-off"), repo);
  assert.equal(git(repo, "rev-parse", "--abbrev-ref", "HEAD"), "story/off");
  git(repo, "checkout", "-q", "main");
});

test("with worktree on, two tasks code at the same time, each in its own folder", async () => {
  setCfg({ worktree: true });
  const d1 = await prepareWorkDir(repo, "story/w1", "T-w1");
  const d2 = await prepareWorkDir(repo, "story/w2", "T-w2");
  assert.notEqual(d1, d2);
  assert.equal(d1, worktreePath(repo, "T-w1"));
  assert.equal(git(repo, "rev-parse", "--abbrev-ref", "HEAD"), "main", "the main checkout is untouched");
  assert.equal(await prepareWorkDir(repo, "story/w1", "T-w1"), d1, "a retry reuses the worktree");

  const m1 = await startAgentDispatch({ kind: "coding", task_id: "T-w1", platformId: "slow", branch: "story/w1", workDir: d1, req: { projectRoot: repo, extraReadRoots: [], prompt: "x" } });
  const m2 = await startAgentDispatch({ kind: "coding", task_id: "T-w2", platformId: "slow", branch: "story/w2", workDir: d2, req: { projectRoot: repo, extraReadRoots: [], prompt: "x" } });
  await assert.rejects(prepareWorkDir(repo, "story/w1", "T-w1"), /already has a coding session running/);
  const r1 = await wait(m1.dispatch_id); await wait(m2.dispatch_id);
  assert.equal(r1.status, "completed");
  assert.equal(r1.project_root, repo);
  assert.equal(r1.worktree, d1);
  assert.deepEqual(r1.files_changed, ["made.txt"]);
  assert.ok(existsSync(join(d1, "made.txt")) && existsSync(join(d2, "made.txt")));
  assert.equal(existsSync(join(repo, "made.txt")), false, "nothing leaked into the main checkout");
});

test("remove_worktree refuses uncommitted work unless forced; the branch stays", async () => {
  const d1 = worktreePath(repo, "T-w1");
  await assert.rejects(removeWorktree(repo, "T-w1"), /uncommitted work/);
  assert.equal((await removeWorktree(repo, "T-w1", true)).removed, true);
  assert.equal(existsSync(d1), false);
  git(repo, "rev-parse", "--verify", "refs/heads/story/w1");
  git(d1.replace("T-w1", "T-w2"), "add", "-A"); git(d1.replace("T-w1", "T-w2"), "commit", "-q", "-m", "w2");
  assert.equal((await removeWorktree(repo, "T-w2")).removed, true);
  assert.equal((await removeWorktree(repo, "T-none")).removed, false);
  // the branch can get a fresh worktree again
  assert.ok(existsSync(await prepareWorkDir(repo, "story/w2", "T-w2")));
});

test("remove_worktree with delete_branch removes the folder and the merged branch", async () => {
  const d = await prepareWorkDir(repo, "story/c1", "T-c1");
  const r = await removeWorktree(repo, "T-c1", false, true);
  assert.equal(r.branch_deleted, "story/c1");
  assert.equal(existsSync(d), false);
  assert.throws(() => git(repo, "rev-parse", "--verify", "refs/heads/story/c1"));
});

test("delete_branch refuses an unmerged branch unless forced", async () => {
  const d = await prepareWorkDir(repo, "story/c2", "T-c2");
  writeFileSync(join(d, "x.txt"), "x"); git(d, "add", "-A"); git(d, "commit", "-q", "-m", "x");
  await assert.rejects(removeWorktree(repo, "T-c2", false, true), /not deleted/);
  assert.equal(existsSync(d), false, "the worktree is gone, only the branch is left");
  assert.equal((await removeWorktree(repo, "T-c2", true, true, "story/c2")).branch_deleted, "story/c2");
});

test("worktree_setup runs in a new worktree; a failing one is reported", async () => {
  setCfg({ worktree: true, worktree_setup: `node -e "require('fs').writeFileSync('setup.txt','1')"` });
  const d = await prepareWorkDir(repo, "story/s1", "T-s1");
  assert.ok(existsSync(join(d, "setup.txt")));
  setCfg({ worktree: true, worktree_setup: `node -e "process.exit(3)"` });
  await assert.rejects(prepareWorkDir(repo, "story/s2", "T-s2"), /worktree_setup .* failed/);
});
