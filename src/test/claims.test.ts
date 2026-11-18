import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractClaims, formatClaims, parseVerdicts, summariseVerdicts, formatVerdictReport } from "../knowledge/claims.js";

const repo = mkdtempSync(join(tmpdir(), "claims-"));
mkdirSync(join(repo, "Svc"), { recursive: true });
writeFileSync(join(repo, "Svc", "A.cs"), "line1\nline2\nline3\nline4\n");
const md = `# Module: Svc

Source: repo@abc

## Purpose
Runs jobs. \`Svc/A.cs:1-2\`

## Responsibilities
- Sends mail. \`Svc/A.cs:3\`
- Wraps onto
  a second line. \`Svc/A.cs:4\` \`Svc/Gone.cs:1\`
- No evidence here.

## Dependencies
### Uses inside the repo
- Core - helpers. \`Svc/A.cs:1\`

## Open Questions
- **Q1.** Something? \`Svc/A.cs:1\`
`;

test("claims are the cited bullets of the fact sections, with the cited lines attached", () => {
  const c = extractClaims(repo, md);
  assert.deepEqual(c.map((x) => x.id), ["C1", "C2", "C3", "C4"]);
  assert.equal(c[0].section, "Purpose");
  assert.equal(c[2].text, "Wraps onto a second line.");
  assert.equal(c[3].section, "Dependencies");
  assert.match(c[0].cites[0].excerpt, /1: line1\n2: line2/);
  assert.equal(c[2].cites[1].excerpt, "(file not found)");
  assert.match(formatClaims(c), /C2 \[Responsibilities\] Sends mail\.\n {2}evidence Svc\/A\.cs:3\n {4}\| 3: line3/);
});

test("verdict lines are parsed and counted; flagged and unanswered claims make the report not ok", () => {
  const rows = parseVerdicts("C1 | supported |\nC2 | Partial | name not in lines\nnoise\n- C3 | unsupported | wrong\n");
  assert.deepEqual(rows.map((r) => r.verdict), ["supported", "partial", "unsupported"]);
  const r = summariseVerdicts(extractClaims(repo, md), rows);
  assert.equal(r.supported, 1);
  assert.deepEqual(r.unanswered, ["C4"]);
  assert.equal(r.ok, false);
  assert.match(formatVerdictReport(r), /C2 partial: "Sends mail\." - name not in lines/);
  const all = summariseVerdicts(extractClaims(repo, md), parseVerdicts("C1 | supported |\nC2 | supported |\nC3 | supported |\nC4 | supported |"));
  assert.equal(all.ok, true);
});

test("the repair block carries the page and every problem, and is empty work when all is well", async () => {
  const { repairBlock } = await import("../knowledge/claims.js");
  const rows = parseVerdicts("C1 | supported |\nC2 | partial | too broad\nC3 | supported |\nC4 | supported |");
  const v = summariseVerdicts(extractClaims(repo, md), rows);
  const b = repairBlock(md, "Cited file does not exist: Svc/Gone.cs", v);
  assert.match(b, /^REPAIR/);
  assert.match(b, /PAGE\n# Module: Svc/);
  assert.match(b, /Cited file does not exist: Svc\/Gone\.cs/);
  assert.match(b, /partial: "Sends mail\." - too broad/);
});
