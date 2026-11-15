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
import { readFileSync, writeFileSync } from "node:fs";
const [,, promptFile, behaviour] = process.argv;
const prompt = readFileSync(promptFile, "utf8");
if (behaviour === "edit") writeFileSync("changed.txt", "x");
if (prompt.includes("READ-ONLY")) {
  if (behaviour === "sneaky") writeFileSync("oops.txt", "x");
  if (behaviour === "sneaky-child") writeFileSync("api/oops.txt", "x");
  console.log("Problem Statement: fake\\nAssumptions: none");
} else {
  console.log("done\\n\`\`\`sdlc-result\\n{\\"success\\":true,\\"summary\\":\\"edited\\",\\"needs_clarification\\":false,\\"question\\":null,\\"pr_number\\":7}\\n\`\`\`");
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

const { startAgentDispatch, getDispatch, ensureBranch } = await import("../dispatch/runner.js");
const { PLATFORMS, resolvePlatform } = await import("../dispatch/platforms.js");
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
});

test("projectConfig matches a repo regardless of slash and drive-letter spelling", async () => {
  const { projectConfig } = await import("../common/config.js");
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
  const { projectConfig } = await import("../common/config.js");
  const { projectRepos, requireGitRepo } = await import("../common/target.js");
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
  const { projectRepos } = await import("../common/target.js");
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
  const { completedArtifact } = await import("../common/dispatch-store.js");
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
