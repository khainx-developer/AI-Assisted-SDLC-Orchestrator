import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const dir = mkdtempSync(join(tmpdir(), "sdlc-co-"));
process.env.SDLC_DATA_DIR = join(dir, "data");
mkdirSync(process.env.SDLC_DATA_DIR);

const slow = join(dir, "slow-coder.mjs");
writeFileSync(slow, `await new Promise((r) => setTimeout(r, 1500)); console.log("done");`);
const cfgPath = join(dir, "config.json");
writeFileSync(cfgPath, JSON.stringify({ default_platform: "slow", platforms: { slow: { command: process.execPath, args: [slow], prompt_via: "file" } } }));
process.env.SDLC_CONFIG = cfgPath;

const repo = join(dir, "repo");
mkdirSync(repo);
const git = (...a: string[]) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...a], { cwd: repo, encoding: "utf8" }).trim();
git("init", "-q", "-b", "main");
writeFileSync(join(repo, "a.txt"), "a");
git("add", "-A");
git("commit", "-q", "-m", "init");

const { prepareCheckout } = await import("../dispatch/checkout.js");
const { startAgentDispatch, getDispatch } = await import("../dispatch/runner.js");

async function wait(id: string) {
  for (let i = 0; i < 100; i++) { const m = getDispatch(id); if (m.status !== "in-flight") return m; await new Promise((r) => setTimeout(r, 100)); }
  throw new Error("dispatch never finished");
}

test("a new task branch starts from the task's base branch, not from what is checked out", async () => {
  git("checkout", "-q", "-b", "release");
  writeFileSync(join(repo, "release-only.txt"), "r");
  git("add", "-A"); git("commit", "-q", "-m", "release work");
  git("checkout", "-q", "main");

  await prepareCheckout(repo, "story/from-release", "T-rel", "release");
  assert.equal(git("rev-parse", "--abbrev-ref", "HEAD"), "story/from-release");
  assert.ok(existsSync(join(repo, "release-only.txt")), "branched from release although main was checked out");
  git("checkout", "-q", "main");

  // without a base the old behaviour holds: the branch starts from what is checked out
  await prepareCheckout(repo, "story/no-base", "T-nb");
  assert.equal(existsSync(join(repo, "release-only.txt")), false);
  git("checkout", "-q", "main");
});

test("an existing branch is used as it is; a missing base is a clear error", async () => {
  await prepareCheckout(repo, "story/from-release", "T-rel", "main");
  assert.ok(existsSync(join(repo, "release-only.txt")), "the base is ignored for a branch that already exists");
  git("checkout", "-q", "main");
  await assert.rejects(prepareCheckout(repo, "story/x", "T-x", "nope"), /base branch 'nope' does not exist/);
});

test("a second task cannot start a write session while another task's is running in the same repo", async () => {
  git("checkout", "-q", "main");
  const m = await startAgentDispatch({ kind: "coding", task_id: "T-g1", platformId: "slow", branch: "story/g1", req: { projectRoot: repo, extraReadRoots: [], prompt: "x" } });
  await assert.rejects(prepareCheckout(repo, "story/g2", "T-g2"), /already has a coding session running/);
  await prepareCheckout(repo, "story/g1b", "T-g1"); // the same task is not blocked by itself
  git("checkout", "-q", "main");
  await wait(m.dispatch_id);
  await prepareCheckout(repo, "story/g2", "T-g2"); // free again once it has finished
});
