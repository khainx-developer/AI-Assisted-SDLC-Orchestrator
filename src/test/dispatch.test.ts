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
