import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkModule, formatModuleReport } from "../knowledge/module-check.js";

const repo = mkdtempSync(join(tmpdir(), "modchk-"));
mkdirSync(join(repo, "Svc"), { recursive: true });
writeFileSync(join(repo, "Svc", "Worker.cs"), "class Worker {\n  [Trigger(\"%QueueName%\")]\n  void Run() {}\n}\n");

const page = (body: string, source = "Source: repo@abc1234def") => `# Module: Svc

${source}

## Purpose
Runs jobs. \`Svc/Worker.cs:1-3\`

## Responsibilities
${body}

## Public surface
- \`Worker\` - runs. \`Svc/Worker.cs:1\`

## Dependencies
### Uses inside the repo
- none. \`Svc/Worker.cs:1\`

## Data and configuration
- \`QueueName\` - queue. \`Svc/Worker.cs:2\`

## Runtime and deployment
- not found. \`Svc/Worker.cs:1\`

## Build and test
- none. \`Svc/Worker.cs:1\`

## Known risks and technical debt
- none. \`Svc/Worker.cs:1\`

## How to change it safely
- \`Svc/Worker.cs\`

## Open Questions
None.
`;
const ok = "- Runs the worker. `Svc/Worker.cs:1-3`";

test("a page whose citations resolve passes", () => {
  const r = checkModule(repo, page(ok), "abc1234def");
  assert.equal(r.ok, true, formatModuleReport(r));
  assert.ok(r.citations >= 7);
});

test("missing files, out-of-range and reversed lines are reported", () => {
  const r = checkModule(repo, page("- a. `Svc/Nope.cs:1`\n- b. `Svc/Worker.cs:2-99`\n- c. `Svc/Worker.cs:3-1`"));
  assert.deepEqual(r.missing_files, ["Svc/Nope.cs"]);
  assert.equal(r.bad_lines.length, 2);
  assert.match(formatModuleReport(r), /does not exist/);
});

test("a path that leaves the repo is treated as missing", () => {
  assert.deepEqual(checkModule(repo, page("- a. `../outside.cs:1`")).missing_files, ["../outside.cs"]);
});

test("a fact bullet with no citation is reported", () => {
  const r = checkModule(repo, page("- Runs the worker with no evidence."));
  assert.equal(r.uncited.length, 1);
  assert.equal(r.ok, false);
});

test("a name that is in none of the cited files is reported; one in the cited file or its path passes", () => {
  const r = checkModule(repo, page("- Uses `InvoiceService` and `Worker` and `Svc`. `Svc/Worker.cs:1-3`"));
  assert.deepEqual(r.unsupported_names.map((u) => u.name), ["InvoiceService"]);
});

test("missing sections and a source commit that differs are reported", () => {
  const r = checkModule(repo, page(ok, "Source: repo@fff0000").replace("## Build and test\n- none. `Svc/Worker.cs:1`\n\n", ""), "abc1234def");
  assert.deepEqual(r.missing_sections, ["Build and test"]);
  assert.match(r.wrong_source ?? "", /expected commit abc1234/);
});

test("a page with no citations at all is not ok", () => {
  assert.equal(checkModule(repo, "# Module: x\n\nnothing\n").ok, false);
});
