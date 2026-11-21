import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const dir = mkdtempSync(join(tmpdir(), "sdlc-d-"));
process.env.SDLC_DATA_DIR = dir;

// A fake "AI CLI": reads the prompt file, optionally edits a file, prints a result.
const fake = join(dir, "fake-ai.mjs");
writeFileSync(fake, `
import { readFileSync, writeFileSync, appendFileSync, mkdirSync } from "node:fs";
const [,, promptFile, behaviour] = process.argv;
const prompt = readFileSync(promptFile, "utf8");
if (behaviour === "hang") { console.log("working"); setInterval(() => {}, 1000); await new Promise(() => {}); }
if (behaviour === "edit") writeFileSync("changed.txt", "x");
if (prompt.includes("READ-ONLY")) {
  if (behaviour === "sneaky") writeFileSync("oops.txt", "x");
  if (behaviour === "sneaky-child") writeFileSync("api/oops.txt", "x");
  console.log("Problem Statement: fake\\nAssumptions: none");
} else {
  if (behaviour.startsWith("scope:")) { const n = behaviour.slice(6); mkdirSync("src", { recursive: true }); writeFileSync("src/" + n, "1"); writeFileSync("out-" + n, "1"); }
  if (behaviour === "write-tests") { mkdirSync("tests", { recursive: true }); writeFileSync("tests/a.test.js", "t1"); writeFileSync("stub.js", "s"); }
  if (behaviour === "frozen-edit") appendFileSync("tests/a.test.js", "cheat");
  const wrong = behaviour === "specwrong";
  const result = { success: true, summary: "edited", needs_clarification: false, question: null, pr_number: 7, spec_wrong: wrong, spec_issue: wrong ? "step 2 contradicts step 4" : null };
  console.log("done\\n\`\`\`sdlc-result\\n" + JSON.stringify(result) + "\\n\`\`\`");
}
`);
const cfgPath = join(dir, "config.json");
const writeCfg = (behaviour: string) =>
  writeFileSync(cfgPath, JSON.stringify({
    default_platform: "fake",
    platforms: { fake: { command: process.execPath, args: [fake, "{prompt_file}", behaviour], prompt_via: "file" } },
  }));
process.env.SDLC_CONFIG = cfgPath;

const repo = join(dir, "repo");
mkdirSync(repo);
const g = (...a: string[]) => execFileSync("git", a, { cwd: repo, encoding: "utf8" });
g("init", "-q"); g("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init");

const { startAgentDispatch, getDispatch, cancelDispatch, ensureBranch } = await import("../dispatch/runner.js");
const { PLATFORMS, promptAccessRequest, resolvePlatform } = await import("../dispatch/platforms.js");
const { parseCodingResult, loadSkill } = await import("../dispatch/prompt.js");

async function wait(id: string) {
  for (let i = 0; i < 100; i++) { const m = getDispatch(id); if (m.status !== "in-flight") return m; await new Promise((r) => setTimeout(r, 100)); }
  throw new Error("dispatch never finished");
}

test("every built-in platform builds a headless invocation; analysis is restricted, coding is not", () => {
  const base = { prompt: "P", promptFile: "/p.md", projectRoot: "/r", extraReadRoots: ["/other"] };
  for (const id of ["claude", "copilot", "cursor"]) {
    const p = PLATFORMS[id];
    const a = p.build({ ...base, mode: "analysis" }, {}, "P").args.join(" ");
    const c = p.build({ ...base, mode: "coding" }, {}, "P").args.join(" ");
    assert.notEqual(a, c, `${id}: analysis and coding must differ`);
  }
  assert.match(PLATFORMS.claude.build({ ...base, mode: "analysis" }, {}, "P").args.join(" "), /disallowedTools Edit,Write/);
  assert.match(PLATFORMS.cursor.build({ ...base, mode: "coding" }, {}, "P").args.join(" "), /--force/);
  assert.doesNotMatch(PLATFORMS.cursor.build({ ...base, mode: "analysis" }, {}, "P").args.join(" "), /--force/);
  assert.match(PLATFORMS.cursor.build({ ...base, mode: "analysis" }, {}, "P").args.join(" "), /--trust/);
  assert.match(PLATFORMS.cursor.build({ ...base, mode: "coding" }, {}, "P").args.join(" "), /--trust/);
  assert.match(PLATFORMS.copilot.build({ ...base, mode: "analysis" }, {}, "P").args.join(" "), /--add-dir \/other/);
});

test("file-delivered prompts grant only add-dir platforms access to the prompt directory", () => {
  const req = { mode: "analysis" as const, prompt: "P", promptFile: "/data/dispatches/d_123/prompt.md", projectRoot: "/r", extraReadRoots: ["/other"] };
  const accessible = promptAccessRequest(req, PLATFORMS.copilot, "file");
  assert.deepEqual(accessible.extraReadRoots, ["/other", "/data/dispatches/d_123"]);
  assert.deepEqual(req.extraReadRoots, ["/other"], "the caller's request is not mutated");
  assert.equal(promptAccessRequest(req, PLATFORMS.copilot, "arg"), req);
  assert.equal(promptAccessRequest(req, PLATFORMS.cursor, "file"), req);
});

test("unknown platform ids need a command; declared ones become generic", () => {
  assert.throws(() => resolvePlatform("windsurf", {}), /unknown platform/);
  assert.equal(resolvePlatform("windsurf", { windsurf: { command: "ws" } }).platform.id, "windsurf");
});

test("claude output envelope is unwrapped", () => {
  assert.equal(PLATFORMS.claude.parseOutput(JSON.stringify({ result: "hello" })), "hello");
});

test("skills load with a content-hash version", () => {
  const s = loadSkill("requirement-analysis");
  assert.match(s.version, /^requirement-analysis@[0-9a-f]{8}$/);
});

test("analysis dispatch on a custom platform returns the artifact", async () => {
  writeCfg("none");
  const m = await startAgentDispatch({ kind: "analysis", task_id: "t", platformId: "fake", req: { projectRoot: repo, extraReadRoots: [], prompt: "READ-ONLY please" } });
  const r = await wait(m.dispatch_id);
  assert.equal(r.status, "completed");
  assert.match(r.output!, /Problem Statement: fake/);
  assert.equal(r.read_only_violation, undefined);
});

test("analysis that writes a file is flagged as a read-only violation", async () => {
  writeCfg("sneaky");
  const m = await startAgentDispatch({ kind: "analysis", task_id: "t", platformId: "fake", req: { projectRoot: repo, extraReadRoots: [], prompt: "READ-ONLY please" } });
  const r = await wait(m.dispatch_id);
  assert.equal(r.status, "failed");
  assert.deepEqual(r.read_only_violation, ["oops.txt"]);
});

test("coding dispatch runs on the task branch and reports files + pr_number", async () => {
  writeCfg("edit");
  await ensureBranch(repo, "task/PROJ-1");
  assert.equal(g("rev-parse", "--abbrev-ref", "HEAD").trim(), "task/PROJ-1");
  const m = await startAgentDispatch({ kind: "coding", task_id: "t", platformId: "fake", branch: "task/PROJ-1", req: { projectRoot: repo, extraReadRoots: [], prompt: "implement it" } });
  const r = await wait(m.dispatch_id);
  assert.equal(r.status, "completed");
  assert.equal(r.pr_number, 7);
  assert.ok(r.files_changed!.includes("changed.txt"));
});

test("parseCodingResult handles clarification and garbage", () => {
  const r = parseCodingResult('x\n```sdlc-result\n{"success":false,"needs_clarification":true,"question":"which UserService?"}\n```');
  assert.equal(r?.needs_clarification, true);
  assert.equal(parseCodingResult("no block"), null);
});

test("extractArtifact: markers, fences and raw text", async () => {
  const { extractArtifact } = await import("../dispatch/prompt.js");
  const F = "`".repeat(3);
  assert.equal(extractArtifact(`noise\n<<<ARTIFACT\nProblem: x\nARTIFACT>>>\ntrailer`), "Problem: x");
  assert.equal(extractArtifact(`/ Search foo\n${F}\nProblem: y\n${F}`), "Problem: y");
  assert.equal(extractArtifact(`<<<ARTIFACT\n${F}\nProblem: z\n${F}\nARTIFACT>>>`), "Problem: z");
  assert.equal(extractArtifact("Problem: plain"), "Problem: plain");
  // closing marker dropped or cut short: the opener must not leak into the document
  assert.equal(extractArtifact("<<<ARTIFACT\n# D: x\n\n## Open Questions\nNone.\nARTIFACT"), "# D: x\n\n## Open Questions\nNone.");
  assert.equal(extractArtifact("<<<ARTIFACT\n# D: x\nARTIFACT>>"), "# D: x");
  assert.equal(extractArtifact("<<<ARTIFACT\n# D: x\n"), "# D: x");
});

test("projectConfig matches a repo regardless of slash and drive-letter spelling", async () => {
  const { projectConfig } = await import("../config/config.js");
  writeFileSync(cfgPath, JSON.stringify({ default_platform: "fake", platforms: {}, projects: { "D:/work/Spell": { model: "m1" } } }));
  assert.equal(projectConfig("d:/work/Spell/")?.model, "m1");
  assert.equal(projectConfig("D:" + String.fromCharCode(92) + "work" + String.fromCharCode(92) + "Spell")?.model, "m1");
  assert.equal(projectConfig("D:/work/Other"), undefined);
});

function writeCfgWorkspace(ws: string, behaviour: string) {
  writeFileSync(cfgPath, JSON.stringify({
    default_platform: "fake",
    platforms: { fake: { command: process.execPath, args: [fake, "{prompt_file}", behaviour], prompt_via: "file" } },
    projects: { [ws]: { child_repos: ["api", "web", "missing"], test_command: "npm run t", branch_pattern: "wk/{key}", model: "m-ws", slug: "ws-slug" } },
  }));
}

test("workspace: a child repo inherits the workspace's settings; coding/tests are refused at the non-git root", async () => {
  const { projectConfig } = await import("../config/config.js");
  const { projectRepos, requireGitRepo } = await import("../dispatch/target.js");
  const { detectTestCommand } = await import("../dispatch/runner.js");
  const ws = join(dir, "ws");
  const api = join(ws, "api"), web = join(ws, "web");
  mkdirSync(api, { recursive: true }); mkdirSync(web, { recursive: true });
  for (const d of [api, web]) {
    execFileSync("git", ["init", "-q"], { cwd: d });
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"], { cwd: d });
  }
  writeCfgWorkspace(ws, "edit");

  const inherited = projectConfig(api)!;
  assert.equal(inherited.model, "m-ws");
  assert.equal(inherited.branch_pattern, "wk/{key}");
  assert.equal(inherited.test_command, "npm run t");
  assert.equal(inherited.child_repos, undefined, "a child is a plain repo");
  assert.equal(inherited.slug, undefined, "learnings stay per repo");
  assert.equal(projectConfig(join(dir, "elsewhere")), undefined);
  assert.equal(detectTestCommand(api), "npm run t");

  assert.deepEqual(projectRepos(repo), [repo]);
  assert.equal(projectRepos(ws).length, 3);
  assert.throws(() => requireGitRepo(ws), /workspace, not a git repo.*child task/);
  assert.throws(() => requireGitRepo(join(dir, "nope")), /not a git repository/);
  requireGitRepo(api); requireGitRepo(repo);

  // a task rooted at a child is an ordinary single-repo task: branch and coding run there, the root is untouched
  await ensureBranch(api, "wk/W-1");
  const head = (d: string) => execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: d, encoding: "utf8" }).trim();
  assert.equal(head(api), "wk/W-1");
  assert.notEqual(head(web), "wk/W-1");
  const m = await startAgentDispatch({ kind: "coding", task_id: "t", platformId: "fake", branch: "wk/W-1", req: { projectRoot: api, extraReadRoots: [], prompt: "implement it" } });
  const r = await wait(m.dispatch_id);
  assert.equal(r.status, "completed");
  assert.ok(r.files_changed!.includes("changed.txt"));
});

test("workspace analysis at the root: a write inside any child repo is a read-only violation, reported relative to the root", async () => {
  const { projectRepos } = await import("../dispatch/target.js");
  const ws = join(dir, "ws");
  writeCfgWorkspace(ws, "sneaky-child");
  const a = await startAgentDispatch({ kind: "analysis", task_id: "t", platformId: "fake", repos: projectRepos(ws), req: { projectRoot: ws, extraReadRoots: [], prompt: "READ-ONLY please" } });
  const ar = await wait(a.dispatch_id);
  assert.equal(ar.status, "failed");
  assert.deepEqual(ar.read_only_violation, ["api/oops.txt"]);
});

test("repo instructions: children share one size budget, labelled by path under the root", async () => {
  const { repoInstructionsText } = await import("../dispatch/repo-instructions.js");
  const ws = join(dir, "ws2");
  for (const k of ["a", "b"]) { mkdirSync(join(ws, k), { recursive: true }); writeFileSync(join(ws, k, "CLAUDE.md"), k.repeat(900)); }
  const text = repoInstructionsText(ws, 1000, [join(ws, "a"), join(ws, "b")])!;
  assert.match(text, /--- a\/CLAUDE\.md ---/);
  assert.ok(text.length < 1400, "one shared cap, not one per repo");
});

test("completedArtifact hands a finished analysis document to the workflow server, and refuses everything else", async () => {
  const { completedArtifact } = await import("../stores/dispatch-store.js");
  writeCfg("none");
  const ok = await wait((await startAgentDispatch({ kind: "analysis", task_id: "t9", platformId: "fake", skill_version: "requirement-analysis@abc12345", req: { projectRoot: repo, extraReadRoots: [], prompt: "READ-ONLY please" } })).dispatch_id);
  const got = completedArtifact("t9", ok.dispatch_id);
  assert.match(got.content, /Problem Statement: fake/);
  assert.equal(got.skill_version, "requirement-analysis@abc12345");
  assert.equal(got.platform, "fake");
  assert.throws(() => completedArtifact("other-task", ok.dispatch_id), /belongs to task t9/);
  assert.throws(() => completedArtifact("t9", "d_00000000"), /unknown dispatch_id/);
  assert.throws(() => completedArtifact("t9", "../x"), /invalid dispatch_id/);
  const bad = await wait((await startAgentDispatch({ kind: "coding", task_id: "t9", platformId: "fake", branch: "b", req: { projectRoot: repo, extraReadRoots: [], prompt: "implement" } })).dispatch_id);
  assert.throws(() => completedArtifact("t9", bad.dispatch_id), /only analysis dispatches/);
  writeCfg("sneaky");
  (await import("node:fs")).rmSync(join(repo, "oops.txt"), { force: true }); // left by the earlier read-only test; only NEW dirty files count
  const viol = await wait((await startAgentDispatch({ kind: "analysis", task_id: "t9", platformId: "fake", req: { projectRoot: repo, extraReadRoots: [], prompt: "READ-ONLY please" } })).dispatch_id);
  assert.throws(() => completedArtifact("t9", viol.dispatch_id), /is failed/);
});

// ---- write-session guards: scope, test-first, frozen tests, spec_wrong ----

const writeGuardCfg = (behaviour: string, extra: Record<string, unknown> = {}) =>
  writeFileSync(cfgPath, JSON.stringify({
    default_platform: "fake",
    platforms: { fake: { command: process.execPath, args: [fake, "{prompt_file}", behaviour], prompt_via: "file" } },
    ...extra,
  }));
const coding = (over: Record<string, unknown> = {}) =>
  startAgentDispatch({ kind: "coding", task_id: "g", platformId: "fake", branch: "task/PROJ-1", req: { projectRoot: repo, extraReadRoots: [], prompt: "implement it" }, ...over } as any);

test("scope: files outside the plan's scope are reported as a warning by default and fail the dispatch with scope_check=fail", async () => {
  writeGuardCfg("scope:one");
  const warn = await wait((await coding({ targetFiles: ["src/"] })).dispatch_id);
  assert.equal(warn.status, "completed", "warn does not fail the dispatch");
  assert.deepEqual(warn.scope_violation, ["out-one"]);
  assert.equal(warn.scope_check, "warn");
  assert.ok(warn.files_touched!.includes("src/one") && warn.files_touched!.includes("out-one"));
  assert.ok(warn.prompt_chars! > 0 && warn.duration_ms! >= 0, "cost signals are recorded");

  writeGuardCfg("scope:two", { scope_check: "fail" });
  const fail = await wait((await coding({ targetFiles: ["src/"] })).dispatch_id);
  assert.equal(fail.status, "failed");
  assert.deepEqual(fail.scope_violation, ["out-two"]);

  writeGuardCfg("scope:three", { scope_check: "off" });
  assert.equal((await wait((await coding({ targetFiles: ["src/"] })).dispatch_id)).scope_violation, undefined);

  writeGuardCfg("scope:four", { scope_allow: ["out-*"] });
  assert.equal((await wait((await coding({ targetFiles: ["src/"] })).dispatch_id)).scope_violation, undefined, "scope_allow globs are always allowed");

  writeGuardCfg("scope:five");
  assert.equal((await wait((await coding()).dispatch_id)).scope_violation, undefined, "no declared scope, nothing to compare");
});

test("scope: files that were already dirty before the session are not blamed on it", async () => {
  writeGuardCfg("scope:one"); // rewrites the same content to the same files: nothing changes
  const r = await wait((await coding({ targetFiles: ["src/"] })).dispatch_id);
  assert.deepEqual(r.files_touched, []);
  assert.equal(r.scope_violation, undefined);
  assert.ok(r.files_changed!.length > 0, "files_changed still lists everything dirty");
});

test("test-first: test-authoring freezes the tests it wrote; stubs outside test_paths are flagged", async () => {
  writeGuardCfg("write-tests");
  const t = await wait((await startAgentDispatch({ kind: "test-authoring", task_id: "g", platformId: "fake", branch: "task/PROJ-1", testPaths: ["tests/"],
    req: { projectRoot: repo, extraReadRoots: [], prompt: "write the tests" } })).dispatch_id);
  assert.equal(t.status, "completed");
  assert.equal(t.kind, "test-authoring");
  assert.deepEqual(t.frozen_files, ["tests/a.test.js"]);
  assert.deepEqual(t.scope_violation, ["stub.js"]);
  const { frozenFilesFrom } = await import("../stores/dispatch-store.js");
  assert.deepEqual(frozenFilesFrom("g", t.dispatch_id), ["tests/a.test.js"]);
  assert.throws(() => frozenFilesFrom("other", t.dispatch_id), /belongs to task/);
});

test("test-first: a session that writes no tests fails visibly", async () => {
  writeGuardCfg("none");
  const t = await wait((await startAgentDispatch({ kind: "test-authoring", task_id: "g", platformId: "fake", branch: "task/PROJ-1", testPaths: ["tests/"],
    req: { projectRoot: repo, extraReadRoots: [], prompt: "write the tests" } })).dispatch_id);
  assert.equal(t.status, "failed");
  assert.match(t.error!, /wrote no test files/);
  const { frozenFilesFrom } = await import("../stores/dispatch-store.js");
  assert.throws(() => frozenFilesFrom("g", t.dispatch_id), /is failed/);
});

test("frozen tests: editing one fails the coding dispatch and the original is backed up; leaving them alone passes", async () => {
  const { readFileSync, existsSync } = await import("node:fs");
  writeGuardCfg("frozen-edit");
  const bad = await wait((await coding({ frozenFiles: ["tests/a.test.js"] })).dispatch_id);
  assert.equal(bad.status, "failed");
  assert.deepEqual(bad.frozen_test_violation, ["tests/a.test.js"]);
  const backup = join(bad.frozen_backup!, "tests", "a.test.js");
  assert.ok(existsSync(backup));
  assert.equal(readFileSync(backup, "utf8"), "t1", "the backup holds the file as it was before the session");
  writeFileSync(join(repo, "tests", "a.test.js"), "t1"); // put it back by hand, as the human would

  writeGuardCfg("scope:six");
  const ok = await wait((await coding({ frozenFiles: ["tests/a.test.js"], targetFiles: ["src/"] })).dispatch_id);
  assert.equal(ok.status, "completed");
  assert.equal(ok.frozen_test_violation, undefined);
  assert.equal(ok.scope_violation?.includes("tests/a.test.js"), false, "frozen files are never reported as scope violations");
});

test("a coding session that reports a wrong spec is marked unsuccessful with the issue", async () => {
  writeGuardCfg("specwrong");
  const r = await wait((await coding()).dispatch_id);
  assert.equal(r.spec_wrong, true);
  assert.equal(r.spec_issue, "step 2 contradicts step 4");
  assert.equal(r.success, false);
});

test("parseCodingResult reads spec_wrong; older result blocks without it still parse", () => {
  const r = parseCodingResult('```sdlc-result\n{"success":false,"spec_wrong":true,"spec_issue":"plan step 3 needs a table that does not exist"}\n```');
  assert.equal(r?.spec_wrong, true);
  assert.match(r!.spec_issue!, /table/);
  const old = parseCodingResult('```sdlc-result\n{"success":true,"summary":"ok"}\n```');
  assert.equal(old?.spec_wrong, false);
  assert.equal(old?.spec_issue, null);
});

test("run_tests with expect_fail gives a verdict: red, broken or vacuous", async () => {
  const { startTestDispatch } = await import("../dispatch/runner.js");
  const run = async (cmd: string, expectFail = true) => wait(startTestDispatch("g", repo, cmd, expectFail).dispatch_id);
  assert.equal((await run('node -e "console.error(\'AssertionError: expected 1 to equal 2\'); process.exit(1)"')).verdict, "red");
  assert.equal((await run('node -e "console.error(\'Cannot find module x\'); process.exit(1)"')).verdict, "broken");
  const pass = await run('node -e "process.exit(0)"');
  assert.equal(pass.verdict, "vacuous");
  assert.equal(pass.passed, true);
  const plain = await run('node -e "process.exit(0)"', false);
  assert.equal(plain.verdict, undefined, "no verdict unless expect_fail was asked for");
  assert.ok(plain.duration_ms! >= 0);
});

test("repo settings: tests_first defaults off, scope_check defaults to warn, repo value wins over global", async () => {
  const { repoSettings } = await import("../config/config.js");
  writeGuardCfg("none");
  assert.deepEqual(repoSettings(repo), { tests_first: false, scope_check: "warn", scope_allow: [], test_command: null });
  writeGuardCfg("none", { tests_first: true, scope_check: "fail", scope_allow: ["a"], projects: { [repo]: { tests_first: false, scope_check: "off", scope_allow: ["b"], test_command: "npm t" } } });
  assert.deepEqual(repoSettings(repo), { tests_first: false, scope_check: "off", scope_allow: ["a", "b"], test_command: "npm t" });
  writeGuardCfg("none", { scope_check: "bogus" });
  assert.equal(repoSettings(repo).scope_check, "warn", "an invalid value falls back to warn");
});

test("cancel_dispatch kills a hung session, records why, and the stage can be retried; in-flight results report elapsed time", async () => {
  writeCfg("hang");
  const m = await startAgentDispatch({ kind: "analysis", task_id: "c", platformId: "fake", req: { projectRoot: repo, extraReadRoots: [], prompt: "READ-ONLY please" } });
  await new Promise((r) => setTimeout(r, 500));
  const live = getDispatch(m.dispatch_id) as any;
  assert.equal(live.status, "in-flight");
  assert.ok(live.elapsed_seconds >= 0 && live.quiet_seconds >= 0, "liveness fields are reported while running");
  assert.match(live.progress_tail ?? "", /working/, "what the session printed is surfaced");
  cancelDispatch(m.dispatch_id, "cancelled by test");
  const r = await wait(m.dispatch_id);
  assert.equal(r.status, "failed");
  assert.equal(r.error, "cancelled by test");
  assert.doesNotThrow(() => process.kill(process.pid, 0)); // the server itself is untouched
  assert.equal(cancelDispatch(m.dispatch_id).status, "failed", "cancelling a finished dispatch changes nothing");

  writeCfg("none");
  const again = await wait((await startAgentDispatch({ kind: "analysis", task_id: "c", platformId: "fake", req: { projectRoot: repo, extraReadRoots: [], prompt: "READ-ONLY please" } })).dispatch_id);
  assert.equal(again.status, "completed");
});

test("pruneDispatches removes only old finished dispatches; dry run deletes nothing; in-flight are kept", async () => {
  const { pruneDispatches, dispatchDir, metaFile } = await import("../stores/dispatch-store.js");
  const mk = (id: string, status: string, finishedDaysAgo?: number) => {
    mkdirSync(dispatchDir(id), { recursive: true });
    const finished_at = finishedDaysAgo === undefined ? undefined : new Date(Date.now() - finishedDaysAgo * 86_400_000).toISOString();
    writeFileSync(metaFile(id), JSON.stringify({ dispatch_id: id, status, started_at: new Date().toISOString(), finished_at }));
  };
  mk("d_00000001", "completed", 30);
  mk("d_00000002", "failed", 20);
  mk("d_00000003", "completed", 1);
  mk("d_00000004", "in-flight");
  const dry = pruneDispatches(14, true);
  assert.deepEqual(dry.removed.sort().filter((i) => /^d_0000000/.test(i)), ["d_00000001", "d_00000002"]);
  const { existsSync } = await import("node:fs");
  assert.ok(existsSync(dispatchDir("d_00000001")), "dry run keeps everything");
  pruneDispatches(14);
  assert.ok(!existsSync(dispatchDir("d_00000001")) && !existsSync(dispatchDir("d_00000002")));
  assert.ok(existsSync(dispatchDir("d_00000003")) && existsSync(dispatchDir("d_00000004")));
});
