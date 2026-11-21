import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const dir = mkdtempSync(join(tmpdir(), "sdlc-bu-"));
process.env.SDLC_DATA_DIR = dir;

const fake = join(dir, "fake-ai.mjs");
writeFileSync(fake, `console.log("<<<ARTIFACT\\n# Requirement: x\\nARTIFACT>>>");`);
const cfgPath = join(dir, "config.json");
const repo = join(dir, "repo");
const writeCfg = (extra: object = {}) => writeFileSync(cfgPath, JSON.stringify({ default_platform: "fake", platforms: { fake: { command: process.execPath, args: [fake], prompt_via: "stdin" } }, ...extra }));
process.env.SDLC_CONFIG = cfgPath;
writeCfg();
mkdirSync(repo);
execFileSync("git", ["init", "-q"], { cwd: repo });
execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"], { cwd: repo });

const { startAgentDispatch, getDispatch } = await import("../dispatch/runner.js");
const { budgetStatus, budgetFor } = await import("../stores/budget.js");
const { dispatchDir, metaFile } = await import("../stores/dispatch-store.js");

async function wait(id: string) {
  for (let i = 0; i < 100; i++) { const m = getDispatch(id); if (m.status !== "in-flight") return m; await new Promise((r) => setTimeout(r, 100)); }
  throw new Error("dispatch never finished");
}
// a prompt of N chars is about N/4 input tokens (the fake CLI answers with a few tokens)
const go = (task: string, chars: number, extra: object = {}) => startAgentDispatch({ kind: "analysis", task_id: task, platformId: "fake", req: { projectRoot: repo, extraReadRoots: [], prompt: "p".repeat(chars) }, ...extra });

test("no budget configured: nothing is checked or reported", async () => {
  writeCfg();
  assert.equal(budgetFor(repo), null);
  assert.equal(budgetStatus("T", repo), null);
  const done = await wait((await go("T-none", 4000)).dispatch_id);
  assert.equal(done.budget_warning, undefined);
});

test("warn: a dispatch that takes the task over its budget carries a warning, and later dispatches still run", async () => {
  writeCfg({ budget: { task_tokens: 500 } });
  const first = await wait((await go("T-warn", 800)).dispatch_id); // ~200 tokens
  assert.equal(first.budget_warning, undefined, "still within budget");
  const second = await wait((await go("T-warn", 1600)).dispatch_id); // ~400 more
  assert.match(second.budget_warning ?? "", /over its budget \(warning only\)/);
  assert.match(second.budget_warning ?? "", /estimated, a lower bound/);
  const third = await wait((await go("T-warn", 40)).dispatch_id);
  assert.equal(third.status, "completed", "warn never stops work");
  assert.ok(third.budget_warning);
});

test("block: once over, new dispatches for that task are refused with a way forward; other tasks are unaffected", async () => {
  writeCfg({ budget: { task_tokens: 300, action: "block" } });
  const first = await wait((await go("T-block", 2000)).dispatch_id); // ~500 tokens: crosses the limit, but the running dispatch is not killed
  assert.equal(first.status, "completed");
  assert.ok(first.budget_warning);
  await assert.rejects(go("T-block", 40), /over its budget[\s\S]*override_budget=true/);
  const other = await wait((await go("T-other", 40)).dispatch_id);
  assert.equal(other.status, "completed");
});

test("override_budget lets the human continue past a block", async () => {
  writeCfg({ budget: { task_tokens: 300, action: "block" } });
  await wait((await go("T-ovr", 2000)).dispatch_id);
  const done = await wait((await go("T-ovr", 40, { overrideBudget: true })).dispatch_id);
  assert.equal(done.status, "completed");
});

test("a repo's budget overrides the global one field by field", () => {
  const root = repo.split("\\").join("/");
  writeCfg({ budget: { task_tokens: 1000, task_cost_usd: 5, action: "warn" }, projects: { [root]: { budget: { task_tokens: 50, action: "block" } } } });
  assert.deepEqual(budgetFor(repo), { task_tokens: 50, task_cost_usd: 5, action: "block" });
});

test("a cost limit counts only costs the CLI reported", () => {
  writeCfg({ budget: { task_cost_usd: 1 } });
  const seed = (id: string, cost?: number) => {
    mkdirSync(dispatchDir(id), { recursive: true });
    writeFileSync(metaFile(id), JSON.stringify({
      dispatch_id: id, kind: "analysis", task_id: "T-cost", platform: "claude", project_root: repo, status: "completed", started_at: new Date().toISOString(), finished_at: new Date().toISOString(),
      usage: { source: cost === undefined ? "estimated" : "reported", input_tokens: 10, output_tokens: 10, ...(cost === undefined ? {} : { cost_usd: cost }) },
    }));
  };
  seed("d_c0000001", 0.6);
  let s = budgetStatus("T-cost", repo)!;
  assert.equal(s.exceeded, false);
  assert.equal(s.estimated_only, false);
  seed("d_c0000002", 0.5);
  seed("d_c0000003"); // an estimate adds tokens but no cost
  s = budgetStatus("T-cost", repo)!;
  assert.equal(s.exceeded, true);
  assert.ok(Math.abs(s.used_cost_usd - 1.1) < 1e-9);
  assert.match(s.message, /\$1\.10 of \$1\.00/);
});
