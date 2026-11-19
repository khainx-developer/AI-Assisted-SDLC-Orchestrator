import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const dir = mkdtempSync(join(tmpdir(), "sdlc-ue-"));
process.env.SDLC_DATA_DIR = dir;

// Fake AI CLI: prints whatever artifact is in <dir>/answer.md between the markers.
const fake = join(dir, "fake-ai.mjs");
writeFileSync(fake, `
import { readFileSync } from "node:fs";
const answer = readFileSync(process.argv[2], "utf8");
console.log("<<<ARTIFACT\\n" + answer + "\\nARTIFACT>>>");
`);
const answerFile = join(dir, "answer.md");
const cfgPath = join(dir, "config.json");
writeFileSync(cfgPath, JSON.stringify({ default_platform: "fake", platforms: { fake: { command: process.execPath, args: [fake, answerFile], prompt_via: "file" } } }));
process.env.SDLC_CONFIG = cfgPath;

const repo = join(dir, "repo");
mkdirSync(repo);
execFileSync("git", ["init", "-q"], { cwd: repo });
execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"], { cwd: repo });

const { PLATFORMS } = await import("../dispatch/platforms.js");
const { startAgentDispatch, getDispatch } = await import("../dispatch/runner.js");
const { usageSummary, estimateTokens, formatRow } = await import("../common/usage.js");
const { checkArtifact } = await import("../evals/checks.js");
const { loadCases, goldenFor, checkGoldens, runCase, runEvals } = await import("../evals/run.js");

async function wait(id: string) {
  for (let i = 0; i < 100; i++) { const m = getDispatch(id); if (m.status !== "in-flight") return m; await new Promise((r) => setTimeout(r, 100)); }
  throw new Error("dispatch never finished");
}

// ---------- usage ----------

test("Claude's JSON envelope gives exact tokens (cache counted as input) and cost; other shapes give null", () => {
  const out = JSON.stringify({ type: "result", result: "hi", total_cost_usd: 0.0123, usage: { input_tokens: 10, cache_creation_input_tokens: 5, cache_read_input_tokens: 100, output_tokens: 7 } });
  assert.deepEqual(PLATFORMS.claude.parseUsage!(out), { input_tokens: 115, output_tokens: 7, cost_usd: 0.0123 });
  assert.equal(PLATFORMS.claude.parseUsage!("plain text"), null);
  assert.equal(PLATFORMS.claude.parseUsage!(JSON.stringify({ result: "x" })), null);
  assert.deepEqual(PLATFORMS.claude.parseUsage!(JSON.stringify({ usage: { input_tokens: 1, output_tokens: 2 } })), { input_tokens: 1, output_tokens: 2 });
  assert.equal(PLATFORMS.copilot.parseUsage, undefined, "CLIs that print no usage fall back to the estimate");
});

test("a dispatch records an estimated usage when the CLI reports none, and usageSummary adds it up by task", async () => {
  writeFileSync(answerFile, "x".repeat(400));
  const m = await startAgentDispatch({ kind: "analysis", task_id: "T-use", platformId: "fake", req: { projectRoot: repo, extraReadRoots: [], prompt: "p".repeat(800) } });
  const done = await wait(m.dispatch_id);
  assert.equal(done.usage?.source, "estimated");
  assert.equal(done.usage?.input_tokens, estimateTokens(800));
  assert.ok(done.usage!.output_tokens >= estimateTokens(400), "counts the text the session printed");
  assert.equal(done.usage?.cost_usd, undefined, "no cost is invented for a CLI that does not report one");

  const one = usageSummary({ taskId: "T-use" });
  assert.equal(one.total.dispatches, 1);
  assert.equal(one.by_task["T-use"].input_tokens, estimateTokens(800));
  assert.equal(one.total.reported, 0);
  assert.match(formatRow(one.total), /estimated, lower bound/);
  assert.equal(usageSummary({ taskId: "nobody" }).total.dispatches, 0);
});

// ---------- eval checks ----------

const REQ = loadCases().find((c) => c.name === "requirement-retry")!;
const good = goldenFor(REQ)!;

test("every golden artifact passes its case, and every case has one", () => {
  const r = checkGoldens();
  assert.ok(r.length >= 8);
  for (const x of r) assert.ok(x.pass, `${x.case}: ${x.failures.join("; ")}`);
});

test("every analysis stage skill has at least one eval case", () => {
  const covered = new Set(loadCases().map((c) => c.skill));
  for (const s of ["requirement-analysis", "design-analysis", "plan-creation", "task-breakdown", "code-review", "decision-mining", "claim-verification", "conventions", "domain-rules"]) assert.ok(covered.has(s), `no eval case for ${s}`);
});

test("the checks reject documents that break the skill's contract", () => {
  const fails = (md: string, re: RegExp, checks = REQ.checks) => {
    const r = checkArtifact(md, checks);
    assert.equal(r.pass, false);
    assert.ok(r.failures.some((x) => re.test(x)), `expected a failure matching ${re}, got: ${r.failures.join(" | ")}`);
  };
  fails(good.replace("## Goal", "## Aim"), /missing heading "## Goal"/);
  fails(good.replace("# Requirement:", "# Spec:"), /first line/);
  fails(good.replace("- **Q1.**", "- Q1:"), /open question not in/);
  fails(good.replace("## Acceptance Criteria\n1.", "## Acceptance Criteria\n").replace(/\n2\. .*\n3\. .*/, ""), /at least 2 item/);
  fails(good + "\nUse a new class RetryPolicy.\n", /must not match/);
  fails(good.replace("- Gateway failures are usually temporary.", "- [a, b, c]"), /bracketed/);
  fails("", /empty/);
  fails("Here is your document:\n\n" + good, /first line/);

  const vague = loadCases().find((c) => c.name === "requirement-vague")!;
  fails(goldenFor(vague)!.replace(/## Open Questions[\s\S]*$/, "## Open Questions\nNone.\n"), /at least 1 open question/, vague.checks);

  const plan = loadCases().find((c) => c.name === "plan-retry")!;
  fails(goldenFor(plan)! + "\n## Rollback/Revert notes\nRevert the commit.\n", /should have been omitted/, plan.checks);

  const split = loadCases().find((c) => c.name === "breakdown-no-split")!;
  fails("No split. Work fits one pass.", /expected exactly/, split.checks);
});

test("an Open Questions section of 'None.' is fine when questions are not required", () => {
  assert.ok(checkArtifact(good.replace(/## Open Questions[\s\S]*$/, "## Open Questions\nNone.\n"), REQ.checks).pass);
});

// ---------- live runner plumbing (through the fake CLI) ----------

test("runCase runs a case through dispatch in a throwaway repo and judges the artifact", async () => {
  writeFileSync(answerFile, good);
  const ok = await runCase(REQ, { platform: "fake", pollMs: 50 });
  assert.equal(ok.pass, true, ok.failures.join("; "));
  assert.match(ok.skill_version, /^requirement-analysis@[0-9a-f]{8}$/);
  assert.equal(ok.usage?.source, "estimated");

  writeFileSync(answerFile, good.replace("## Goal", "## Aim"));
  const bad = await runCase(REQ, { platform: "fake", pollMs: 50 });
  assert.equal(bad.pass, false);
  assert.match(bad.failures[0], /missing heading/);
});

test("runEvals saves the run and flags a case that passed before and fails now", async () => {
  writeFileSync(answerFile, good);
  const first = await runEvals([REQ], { platform: "fake", pollMs: 50 });
  assert.equal(first.results[0].pass, true);
  assert.deepEqual(first.regressions, []);

  writeFileSync(answerFile, "# Requirement: x\n");
  const second = await runEvals([REQ], { platform: "fake", pollMs: 50 });
  assert.equal(second.results[0].pass, false);
  assert.equal(second.regressions.length, 1);
  assert.equal(second.regressions[0].case, "requirement-retry");

  const saved = readFileSync(join(dir, "evals", "results", readdirLatest(join(dir, "evals", "results"))), "utf8");
  assert.equal(JSON.parse(saved).results.length, 1);
});

function readdirLatest(d: string): string {
  return execFileSync(process.execPath, ["-e", `console.log(require("fs").readdirSync(${JSON.stringify(d)}).sort().at(-1))`], { encoding: "utf8" }).trim();
}

test("a case file path that escapes the throwaway repo is refused", async () => {
  await assert.rejects(runCase({ ...REQ, name: "evil", files: { "../x.txt": "no" } }, { platform: "fake" }), /must be relative/);
  await assert.rejects(runCase({ ...REQ, name: "evil", files: { "C:/x.txt": "no" } }, { platform: "fake" }), /must be relative/);
});

// ---------- repeated runs ----------

test("runEvals with repeat reports a case that passes only sometimes as flaky, not as a regression", async () => {
  writeFileSync(answerFile, good);
  await runEvals([REQ], { platform: "fake", pollMs: 50 }); // a previous passing run
  let n = 0;
  const flip = join(dir, "flip.mjs");
  writeFileSync(flip, `
import { readFileSync, writeFileSync, existsSync } from "node:fs";
const marker = ${JSON.stringify(join(dir, "flip-count"))};
const n = existsSync(marker) ? Number(readFileSync(marker, "utf8")) : 0;
writeFileSync(marker, String(n + 1));
const answer = readFileSync(n % 2 === 0 ? ${JSON.stringify(join(dir, "good.md"))} : ${JSON.stringify(join(dir, "bad.md"))}, "utf8");
console.log("<<<ARTIFACT\\n" + answer + "\\nARTIFACT>>>");
`);
  writeFileSync(join(dir, "good.md"), good);
  writeFileSync(join(dir, "bad.md"), "# Requirement: x\n");
  writeFileSync(cfgPath, JSON.stringify({ default_platform: "fake", platforms: { fake: { command: process.execPath, args: [flip], prompt_via: "file" } } }));
  const run = await runEvals([REQ], { platform: "fake", pollMs: 50, repeat: 4 });
  assert.equal(run.results.length, 4);
  assert.deepEqual(run.flaky, [{ case: "requirement-retry", passed: 2, runs: 4 }]);
  assert.deepEqual(run.regressions, [], "some runs passed, so it is not a regression");
  void n;
});
