import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ScanResult, ProjectInfo } from "../knowledge/scan.js";
import { checkSurvey, formatSurveyReport, parseSurvey } from "../knowledge/survey-check.js";

const proj = (name: string, path: string, tf: string, refs: string[] = []): ProjectInfo => ({
  name, path, kind: "dotnet", target_frameworks: [tf], project_references: refs, packages: [], package_count: 0, is_test: false, files: 1,
});
const scan = (projects: ProjectInfo[], unowned: { dir: string; files: number }[] = []) => ({ projects, unowned_dirs: unowned }) as unknown as ScanResult;

const projects = [
  proj("Core", "Core/Core.csproj", "net472", ["Web"]), // a shared library that references an application: the surprising direction
  proj("Web", "Web/Web.csproj", "net472", []),
  proj("Func", "Func/Func.csproj", "net8.0", ["Core"]),
];

const survey = (core: string, func: string, extra = "") => `# Survey: x
## Modules
### M1. Shared core
- Projects and folders: \`Core/\`
- Depends on: ${core}
### M2. Web
- Projects and folders: \`Web/\`
- Depends on: none
### M3. Functions
- Projects and folders: \`Func/\`${extra}
- Depends on: ${func}
`;

test("parseSurvey reads module ids, folders and stated dependencies", () => {
  const m = parseSurvey(survey("none", "M1"));
  assert.deepEqual(m.map((x) => x.id), ["M1", "M2", "M3"]);
  assert.deepEqual(m[2].folders, ["Func/"]);
  assert.deepEqual(m[2].stated_deps, ["M1"]);
  assert.deepEqual(m[0].stated_deps, []);
});

test("a dependency the code has but the survey omits is reported, with the reference that proves it", () => {
  const r = checkSurvey(scan(projects), survey("none", "M1"));
  assert.equal(r.ok, false);
  assert.deepEqual(r.missing_edges, [{ from: "M1", to: "M2", via: "Core -> Web" }]);
  const text = formatSurveyReport(r, { M1: "Shared core", M2: "Web" });
  assert.match(text, /M1 Shared core depends on M2 Web in code \(Core -> Web\)/);
});

test("a correct survey passes; invented and unknown dependencies are reported", () => {
  assert.equal(checkSurvey(scan(projects), survey("M2", "M1")).ok, true);
  const bad = checkSurvey(scan(projects), survey("M2", "M1, M2, M9"));
  assert.deepEqual(bad.unsupported_edges, [{ from: "M3", to: "M2" }]);
  assert.deepEqual(bad.unknown_deps, [{ from: "M3", dep: "M9" }]);
});

test("unplaced and duplicated projects and unmentioned folders are reported", () => {
  const md = survey("M2", "M1").replace("### M2. Web\n- Projects and folders: `Web/`", "### M2. Web\n- Projects and folders: `Web/`, `Core/`");
  assert.deepEqual(checkSurvey(scan(projects), md).duplicated_projects, ["Core"]);
  const noWeb = survey("M2", "M1").replace("`Web/`", "`Other/`");
  assert.deepEqual(checkSurvey(scan(projects), noWeb).unassigned_projects, ["Web"]);
  const dirs = checkSurvey(scan(projects, [{ dir: "DbScripts", files: 3388 }, { dir: "Pipelines", files: 12 }]), survey("M2", "M1") + "\nPipelines are covered by CI.\n");
  assert.deepEqual(dirs.unmentioned_dirs, [{ dir: "DbScripts", files: 3388 }]);
  assert.match(formatSurveyReport(dirs), /Folder "DbScripts" \(3388 files, no project\)/);
  assert.equal(checkSurvey(scan(projects, [{ dir: "DbScripts", files: 1 }]), survey("M2", "M1") + "\nDbScripts: out of scope.\n").ok, true);
});

test("modern .NET projects that reference .NET Framework projects are listed", () => {
  const r = checkSurvey(scan(projects), survey("M2", "M1"));
  assert.deepEqual(r.cross_framework, ["Func (net8.0) -> Core (net472)"]);
});

test("a document with no module headings is not ok", () => {
  const r = checkSurvey(scan(projects), "# Survey: x\n\nnothing here\n");
  assert.equal(r.ok, false);
  assert.match(formatSurveyReport(r), /No modules were found/);
});

test("the golden survey of the eval case agrees with its own scan", () => {
  const golden = readFileSync(join(import.meta.dirname, "..", "..", "evals", "golden", "survey-three-projects.md"), "utf8");
  const s = scan([proj("Shop.Api", "Shop.Api/Shop.Api.csproj", "net8.0", ["Shop.Core"]), proj("Shop.Core", "Shop.Core/Shop.Core.csproj", "net8.0"), proj("Shop.Core.Tests", "Shop.Core.Tests/Shop.Core.Tests.csproj", "net8.0", ["Shop.Core"])]);
  assert.equal(checkSurvey(s, golden).ok, true);
});

test("edges that come only from test projects are not counted as module dependencies", () => {
  const ps = [...projects, { ...proj("Core.Tests", "Core/Core.Tests/Core.Tests.csproj", "net472", ["Func"]), is_test: true }];
  // Core.Tests sits inside Core/ and references Func; the module Core must not be said to depend on Functions because of it
  const r = checkSurvey(scan(ps), survey("M2", "M1"));
  assert.equal(r.ok, true, formatSurveyReport(r));
});

test("a dependency that only a test project supports is accepted when stated, and not required when omitted", () => {
  const ps = [proj("Core", "Core/Core.csproj", "net472"), proj("Web", "Web/Web.csproj", "net472"), { ...proj("Web.Tests", "Web/Web.Tests/Web.Tests.csproj", "net472", ["Core"]), is_test: true }];
  const md = (dep: string) =>
    "## Modules\n### M1. Core\n- Projects and folders: `Core/`\n- Depends on: none\n### M2. Web\n- Projects and folders: `Web/`\n- Depends on: " + dep + "\n";
  assert.equal(checkSurvey(scan(ps), md("M1")).ok, true);
  assert.equal(checkSurvey(scan(ps), md("none")).ok, true);
});
