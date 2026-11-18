import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const dir = mkdtempSync(join(tmpdir(), "sdlc-kr-"));
process.env.SDLC_DATA_DIR = dir;
const { runKnowledge } = await import("../knowledge/run.js");
type Session = Parameters<typeof runKnowledge>[1];

function mkRepo() {
  const r = join(dir, "shop");
  const put = (p: string, t: string) => { mkdirSync(join(r, p, ".."), { recursive: true }); writeFileSync(join(r, p), t); };
  mkdirSync(r);
  put("Core/Core.csproj", "<Project Sdk=\"Microsoft.NET.Sdk\"><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup></Project>");
  put("Web/Web.csproj", "<Project Sdk=\"Microsoft.NET.Sdk\"><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup><ItemGroup><ProjectReference Include=\"../Core/Core.csproj\" /></ItemGroup></Project>");
  put("Web/Program.cs", "class Program {}\n");
  const g = (...a: string[]) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...a], { cwd: r, stdio: "ignore" });
  g("init", "-q"); g("add", "-A"); g("commit", "-qm", "init");
  return r;
}
const repo = mkRepo();

const survey = (webDeps: string) => `# Survey: shop
## Modules
### M1. Core
- Projects and folders: \`Core/\`
- Depends on: none
### M2. Web
- Projects and folders: \`Web/\`
- Depends on: ${webDeps}
`;
const page = (cite: string, sha: string) => `# Module: Web

Source: shop@${sha}

## Purpose
Hosts the web program. \`${cite}\`

## Responsibilities
- Runs Program. \`${cite}\`

## Public surface
- \`Program\` - entry. \`${cite}\`

## Dependencies
### Uses inside the repo
- Core. \`Web/Web.csproj:1\`

## Data and configuration
- none. \`${cite}\`

## Runtime and deployment
- not found. \`${cite}\`

## Build and test
- none. \`${cite}\`

## Known risks and technical debt
- none. \`${cite}\`

## How to change it safely
- \`Web/Program.cs\`

## Open Questions
None.
`;

function fake(log: string[], script: { survey: string[]; module: string[]; verdicts: string[] }): Session {
  const q = { ...script, survey: [...script.survey], module: [...script.module], verdicts: [...script.verdicts] };
  return async (a) => {
    log.push(a.skill);
    const next = a.skill === "repo-survey" ? q.survey.shift() : a.skill === "module-analysis" ? q.module.shift() : q.verdicts.shift();
    return { artifact: next ?? "", platform: a.skill === "claim-verification" ? "v" : "w", skill_version: "x", input_tokens: 10, output_tokens: 5 };
  };
}

test("survey and a module are repaired until clean; drafts and a manifest are stored, nothing in the repo", async () => {
  const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo }).toString().trim();
  const calls: string[] = [];
  const m = await runKnowledge({ repo, modules: ["M2"] }, fake(calls, {
    survey: [survey("none"), survey("M1")],
    module: [page("Web/Nope.cs:1", sha), page("Web/Program.cs:1", sha)],
    verdicts: [[1, 2, 3, 4, 5, 6, 7, 8].map((n) => `C${n} | supported |`).join("\n")],
  }));
  // survey: missing Web -> Core edge, repaired once. module: bad file (code check, no verifier), repaired, then verifier.
  assert.deepEqual(calls, ["repo-survey", "repo-survey", "module-analysis", "module-analysis", "claim-verification"]);
  assert.equal(m.survey?.status, "clean");
  assert.equal(m.survey?.rounds, 1);
  assert.equal(m.modules[0].status, "clean");
  assert.equal(m.modules[0].rounds, 1);
  assert.equal(m.modules[0].independent_verifier, true);
  assert.equal(m.sessions, 5);
  assert.equal(m.tokens.input, 50);
  assert.ok(existsSync(join(dir, "knowledge", m.slug, ".meta", "manifest.json")));
  assert.match(readFileSync(m.modules[0].file, "utf8"), /Web\/Program\.cs:1/);
  assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: repo }).toString(), "");
});

test("without --modules the run stops after the survey; a module that never settles is needs-review with its problems", async () => {
  const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo }).toString().trim();
  const calls: string[] = [];
  const only = await runKnowledge({ repo }, fake(calls, { survey: [survey("M1")], module: [], verdicts: [] }));
  assert.match(only.stopped ?? "", /survey only/);
  assert.deepEqual(calls, ["repo-survey"]);

  const bad = await runKnowledge({ repo, modules: ["M2"], reuseSurvey: true, maxRepairs: 1 }, fake([], { survey: [], module: [page("Web/Nope.cs:1", sha), page("Web/Nope.cs:2", sha)], verdicts: [] }));
  assert.equal(bad.survey?.status, "reused");
  assert.equal(bad.modules[0].status, "needs-review");
  assert.match(bad.modules[0].remaining.join("\n"), /does not exist/);
});

test("the session limit stops the run and is recorded", async () => {
  const calls: string[] = [];
  const m = await runKnowledge({ repo, modules: "all", maxSessions: 1 }, fake(calls, { survey: [survey("M1")], module: [], verdicts: [] }));
  assert.match(m.stopped ?? "", /session limit/);
  assert.equal(m.sessions, 1);
});

test("a claim flagged once is dropped when a second look supports it, and an unanswered claim is asked again", async () => {
  const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo }).toString().trim();
  const all = (ids: number[], except: Record<number, string> = {}) => ids.map((n) => `C${n} | ${except[n] ?? "supported |"}`).join("\n");
  const calls: string[] = [];
  const m = await runKnowledge({ repo, modules: ["M2"], reuseSurvey: true }, fake(calls, {
    survey: [], module: [page("Web/Program.cs:1", sha)],
    verdicts: [
      all([1, 2, 3, 4, 5, 6], { 2: "partial | too broad" }), // first pass: C7 and C8 left out, C2 flagged
      all([7, 8]),                                           // asked again
      all([2]),                                              // second look at the flagged claim: supported
    ],
  }));
  assert.equal(m.modules[0].status, "clean", m.modules[0].remaining.join("; "));
  assert.deepEqual(calls, ["module-analysis", "claim-verification", "claim-verification", "claim-verification"]);
});
