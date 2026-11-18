import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const dir = mkdtempSync(join(tmpdir(), "sdlc-ks-"));
process.env.SDLC_DATA_DIR = dir;
const { scanRepo, writeScan, scanSummary, safeRemote, normRemote, knowledgeSlug } = await import("../knowledge/scan.js");

function mkRepo(name: string, remote?: string) {
  const r = join(dir, name);
  const put = (p: string, t: string) => { mkdirSync(join(r, p, ".."), { recursive: true }); writeFileSync(join(r, p), t); };
  mkdirSync(r);
  const g = (...a: string[]) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...a], { cwd: r, stdio: "ignore" });
  g("init", "-q");
  put("App.sln", 'Project("{1}") = "Core", "Core\\Core.csproj", "{a}"\nProject("{1}") = "Web", "Web\\Web.csproj", "{b}"\n');
  put("Core/Core.csproj", '<Project><PropertyGroup><TargetFrameworkVersion>v4.7.2</TargetFrameworkVersion><OutputType>Library</OutputType></PropertyGroup></Project>');
  put("Core/packages.config", '<packages><package id="EntityFramework" version="6.4.4" targetFramework="net472" /></packages>');
  put("Web/Web.csproj", '<Project Sdk="Microsoft.NET.Sdk.Web"><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup><ItemGroup><ProjectReference Include="..\\Core\\Core.csproj" /><PackageReference Include="Serilog" Version="3.1.1" /></ItemGroup></Project>');
  put("Web/Web.Tests/Web.Tests.csproj", '<Project><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup><ItemGroup><PackageReference Include="xunit"><Version>2.6.0</Version></PackageReference></ItemGroup></Project>');
  put("Web/Program.cs", "class P {}");
  put("Web/appsettings.json", JSON.stringify({ ConnectionStrings: { Default: "Server=x;Password=hunter2-SECRET" }, Feature: { Flag: true } }));
  put("Web/Web.config", '<configuration><appSettings><add key="ApiBase" value="https://x" /><add key="ApiToken" value="tok-9999" /></appSettings><connectionStrings><add name="Db" connectionString="Server=a;Password=SECRETPW" /></connectionStrings></configuration>');
  put("Web/sign-pass.txt", "SUPERSECRETFILE");
  put("Web/appsettings.Production.json", JSON.stringify({ Hidden: 1 }));
  put("Web/secrets.json", JSON.stringify({ Leak: "NOPE" }));
  put("packages/Newtonsoft.Json.13/lib.cs", "vendored");
  put("Web/Scripts/ckeditor/ckeditor.js", "vendored");
  put("docs/architecture.md", "# a");
  put("docs/adr/0001-use-queue.md", "# adr");
  put("AGENTS.md", "# agents");
  put(".github/skills/x/SKILL.md", "# skill");
  g("add", "-A");
  g("commit", "-q", "-m", "PM-101 first");
  put("Web/Program.cs", "class P { int x; }");
  g("commit", "-q", "-am", "PM-102 and ABC-7 change");
  if (remote) g("remote", "add", "origin", remote);
  return r;
}

test("scan reads projects, frameworks, references, packages and test projects", () => {
  const s = scanRepo(mkRepo("a"));
  const by = Object.fromEntries(s.projects.map((p) => [p.name, p]));
  assert.deepEqual(by.Core.target_frameworks, ["net472"]);
  assert.deepEqual(by.Web.target_frameworks, ["net8.0"]);
  assert.deepEqual(by.Web.project_references, ["Core"]);
  assert.ok(by.Web.packages.some((p) => p.name === "Serilog" && p.version === "3.1.1"));
  assert.ok(by.Core.packages.some((p) => p.name === "EntityFramework" && p.version === "6.4.4"), "packages.config is read");
  assert.equal(by["Web.Tests"].is_test, true);
  assert.equal(by.Web.is_test, false);
  assert.equal(s.frameworks["net8.0"], 2);
  assert.equal(s.frameworks["net472"], 1);
  assert.equal(s.solutions[0].projects, 2);
  assert.ok(by.Web.files >= 3, "files are attributed to the nearest project");
});

test("vendored folders are left out, guidance files and ADRs are found, history is read", () => {
  const s = scanRepo(mkRepo("b"));
  assert.ok(s.files.excluded_vendored >= 2);
  assert.ok(!JSON.stringify(s.top_dirs).includes("packages"));
  assert.deepEqual(s.instruction_files.sort(), [".github/skills/x/SKILL.md", "AGENTS.md"]);
  assert.deepEqual(s.adr_files, ["docs/adr/0001-use-queue.md"]);
  assert.ok(s.docs.includes("docs/architecture.md"));
  assert.equal(s.codeowners, null);
  assert.ok(s.notes.includes("No CODEOWNERS file found."));
  assert.equal(s.ticket_ids.find((t) => t.prefix === "PM")?.count, 2);
  assert.ok(s.ticket_ids.some((t) => t.prefix === "ABC"));
  assert.ok(s.hot.units.some((u) => u.unit === "Web"));
  assert.equal(s.head.commits, 2);
});

test("config files give key names only; secret-like files are never opened and no value reaches the output", () => {
  const s = scanRepo(mkRepo("c"));
  const all = JSON.stringify(s) + scanSummary(s);
  for (const secret of ["hunter2", "SECRETPW", "tok-9999", "SUPERSECRETFILE", "NOPE"]) assert.ok(!all.includes(secret), `leaked ${secret}`);
  const files = s.config_keys.map((c) => c.file);
  assert.ok(files.includes("Web/appsettings.json") && files.includes("Web/Web.config"));
  assert.ok(!files.some((f) => /secrets\.json|sign-pass/.test(f)));
  const json = s.config_keys.find((c) => c.file === "Web/appsettings.json")!.keys;
  assert.ok(json.includes("ConnectionStrings.Default") && json.includes("Feature.Flag"));
  const cfg = s.config_keys.find((c) => c.file === "Web/Web.config")!.keys;
  assert.ok(cfg.includes("appSettings:ApiBase") && cfg.includes("connectionStrings:Db"));
  assert.ok(s.skipped_secret_like >= 2);
});

test("a remote's credentials are removed, and the same repo at two paths shares one knowledge slug", () => {
  assert.equal(safeRemote("https://user:ghp_abc@github.com/Org/Repo.git"), "https://github.com/Org/Repo.git");
  assert.equal(safeRemote("git@github.com:Org/Repo.git"), "git@github.com:Org/Repo.git");
  assert.equal(normRemote("git@github.com:Org/Repo.git"), normRemote("https://tok@github.com/org/repo"));
  const a = mkRepo("d1", "git@github.com:Org/Repo.git");
  const b = mkRepo("d2", "https://x:y@github.com/org/repo.git");
  assert.equal(knowledgeSlug(a), knowledgeSlug(b));
  assert.match(knowledgeSlug(a), /^repo-[0-9a-f]{6}$/);
  assert.ok(!JSON.stringify(scanRepo(b)).includes("x:y"));
});

test("writeScan stores scan.json under the data dir, not in the repo, and summary is compact Markdown", () => {
  const r = mkRepo("e");
  const s = scanRepo(r);
  const f = writeScan(s);
  assert.ok(f.startsWith(dir) && f.includes("knowledge") && f.endsWith(join(".meta", "scan.json")));
  assert.equal(JSON.parse(readFileSync(f, "utf8")).schema, 1);
  assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: r, encoding: "utf8" }).trim(), "");
  const md = scanSummary(s);
  assert.match(md, /\| Web \| Web\/Web\.csproj \| net8\.0 \| Core \|/);
  assert.ok(md.length < 4000);
});

test("scanRepo refuses a folder that is not a git root", () => {
  const p = join(dir, "plain");
  mkdirSync(p);
  assert.throws(() => scanRepo(p), /not a git repository/);
});

test("the min_citations check counts path:line citations and rejects a page without them", async () => {
  const { checkArtifact } = await import("../evals/checks.js");
  const c = { min_citations: 2 };
  assert.equal(checkArtifact("# M\n- does x `src/a.cs:10`\n- does y `src/b/c.cs:3-9`", c).pass, true);
  const none = checkArtifact("# M\n- does x in src/a.cs\n- time 10:30", c);
  assert.equal(none.pass, false);
  assert.match(none.failures[0], /at least 2 code citation/);
  assert.equal(checkArtifact("# M\n- `src/a.cs` only", { min_citations: 1 }).pass, false, "a bare path is not a line citation");
});
