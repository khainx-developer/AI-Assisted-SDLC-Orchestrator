import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.SDLC_DATA_DIR = mkdtempSync(join(tmpdir(), "sdlc-q-"));
const { parseOpenQuestions, applyAnswers, renderGuidance } = await import("../workflow/questions.js");
const { Workflow } = await import("../workflow/service.js");

const NEW_DOC = `# Requirement: demo

## Goal
Do the thing.

## Assumptions
- one

## Open Questions
- **Q1.** Should tool messages be typed in shared/messages.ts?
  - Why it matters: decides what Phase 1 type-checks
  - Suggested default: yes, add a tool message type
- **Q2.** Is jira.operationResult in scope?
  - Why it matters: exhaustiveness
  - Suggested default: none
- **Q3.** Fix BACKLOG.md now?

## Suggested repo-instruction additions
- note
`;

// the shape of the requirement the first real run produced: not Markdown, bracketed list, one question per line
const LEGACY_DOC = `Problem Statement: p

Open Questions: [
  How should tool-panel messages be typed?,
  Is jira.operationResult in scope?
]

Suggested repo-instruction additions: [
  note
]`;

test("parses the Markdown format and the legacy bracketed format", () => {
  const qs = parseOpenQuestions(NEW_DOC);
  assert.deepEqual(qs.map((q) => q.id), ["Q1", "Q2", "Q3"]);
  assert.equal(qs[0].question, "Should tool messages be typed in shared/messages.ts?");
  assert.equal(qs[0].why, "decides what Phase 1 type-checks");
  assert.equal(qs[0].suggested, "yes, add a tool message type");
  assert.equal(qs[1].suggested, null, '"none" is no suggestion');
  assert.equal(qs[2].why, null);
  const old = parseOpenQuestions(LEGACY_DOC);
  assert.deepEqual(old.map((q) => q.question), ["How should tool-panel messages be typed?", "Is jira.operationResult in scope?"]);
  assert.deepEqual(parseOpenQuestions("# x\n\n## Open Questions\nNone.\n"), []);
  assert.deepEqual(parseOpenQuestions("no section at all"), []);
});

test("answers move questions into Decisions; unanswered stay with stable ids; a second round appends", () => {
  const r1 = applyAnswers(NEW_DOC, [{ id: "q3", answer: "yes, in Phase 4" }], ["Q1"]);
  assert.deepEqual(r1.decided.map((d) => d.id).sort(), ["Q1", "Q3"]);
  assert.deepEqual(r1.remaining.map((q) => q.id), ["Q2"]);
  assert.match(r1.markdown, /## Decisions\n- \*\*Q3\.\*\* Fix BACKLOG\.md now\? → yes, in Phase 4 \*\(decided by the user\)\*/);
  assert.match(r1.markdown, /\*\*Q1\.\*\* Should tool messages.* → yes, add a tool message type/);
  assert.ok(r1.markdown.indexOf("## Decisions") < r1.markdown.indexOf("## Open Questions"));
  assert.match(r1.markdown, /## Goal\nDo the thing\./, "other sections untouched");
  assert.match(r1.markdown, /## Suggested repo-instruction additions\n- note/);
  const r2 = applyAnswers(r1.markdown, [{ id: "Q2", answer: "out of scope" }], []);
  assert.equal(r2.remaining.length, 0);
  assert.match(r2.markdown, /## Open Questions\nNone\./);
  assert.equal((r2.markdown.match(/## Decisions/g) ?? []).length, 1, "decisions are appended, not duplicated");
});

test("legacy documents are converted when answered; bad input is refused", () => {
  const r = applyAnswers(LEGACY_DOC, [{ id: "Q1", answer: "shared type" }], []);
  assert.match(r.markdown, /## Decisions\n- \*\*Q1\.\*\* How should tool-panel messages be typed\? → shared type/);
  assert.match(r.markdown, /## Open Questions\n- \*\*Q2\.\*\* Is jira\.operationResult in scope\?/);
  assert.match(r.markdown, /Suggested repo-instruction additions: \[/, "rest of the legacy document is kept");
  assert.throws(() => applyAnswers(NEW_DOC, [{ id: "Q9", answer: "x" }], []), /no open question Q9/);
  assert.throws(() => applyAnswers(NEW_DOC, [], ["Q2"]), /no suggested answer/);
  assert.throws(() => applyAnswers(NEW_DOC, [{ id: "Q1", answer: "  " }], []), /empty answer/);
  assert.throws(() => applyAnswers(NEW_DOC, [], []), /no answers given/);
  assert.throws(() => applyAnswers("# no questions", [{ id: "Q1", answer: "x" }], []), /no Open Questions section/);
});

test("guidance tells the user how to answer and what to do next", () => {
  const qs = parseOpenQuestions(NEW_DOC);
  const g = renderGuidance({ task_id: "task_1", stage: "requirement", version: 1, path: "/p/requirement.v1.md", qs, nextStage: "design" });
  assert.match(g, /^Task task_1 · stage: requirement \(v1\) · waiting for: you/);
  assert.match(g, /Q1\. Should tool messages be typed/);
  assert.match(g, /Why it matters: decides what Phase 1/);
  assert.match(g, /Suggested: none/);
  assert.match(g, /1\. answer the open questions .*"Q1: yes, Q2: /);
  assert.match(g, /2\. accept the suggested answers .*"accept Q1".*Q2, Q3 need your own answer/);
  assert.match(g, /show full text .*\/p\/requirement\.v1\.md/);
  const done = renderGuidance({ task_id: "task_1", stage: "requirement", version: 2, path: "/p/x.md", qs: [], nextStage: "design", recorded: "Recorded Q1." });
  assert.match(done, /^Recorded Q1\.\n\nTask task_1/);
  assert.match(done, /No open questions remain\./);
  assert.match(done, /1\. confirm .*move to design/);
  assert.match(done, /2\. work the decisions into the document/);
});

test("service: get_open_questions / answer_open_questions round trip makes a new version and needs no model", () => {
  const wf = new Workflow();
  const t = wf.createTask({ project_root: "/q", title: "q", source: "adhoc", flags: { files_affected: 5, reversible: false, breaking: true, has_precedent: false, requirement_clarity: "low" } });
  wf.recordArtifact(t.task_id, "requirement", NEW_DOC);
  const open = wf.openQuestions(t.task_id);
  assert.equal(open.count, 3);
  assert.equal(open.stage, "requirement");
  assert.match(open.display, /Options:/);
  const res = wf.answerQuestions(t.task_id, "requirement", [{ id: "Q2", answer: "out" }, { id: "Q3", answer: "later" }], ["Q1"]);
  assert.equal(res.version, 2);
  assert.equal(res.remaining_count, 0);
  assert.match(res.display, /Recorded Q2, Q3, Q1 as decisions in requirement v2\./);
  assert.match(res.display, /1\. confirm .*move to design/);
  const v2 = wf.getArtifact(t.task_id, "requirement");
  assert.equal(v2.version, 2);
  assert.equal(v2.platform, "mcp-answers");
  assert.deepEqual(v2.input_refs, [{ stage: "requirement", version: 1 }]);
  assert.equal(wf.openQuestions(t.task_id).count, 0);
  assert.match(wf.getArtifact(t.task_id, "requirement", 1).content, /Q1\.\*\* Should tool messages/, "v1 keeps the original questions");
});

const { addOpenQuestion } = await import("../workflow/questions.js");

test("addOpenQuestion: continues the numbering past decided questions, keeps the existing ones, and creates the section if missing", () => {
  const decided = "# Plan\n\n## Decisions\n- **Q1.** old → yes *(decided by the user)*\n- **Q2.** older → no *(decided by the user)*\n\n## Open Questions\nNone.\n";
  const a = addOpenQuestion(decided, "Does step 2 hold?", "it blocks coding");
  assert.equal(a.id, "Q3");
  assert.deepEqual(parseOpenQuestions(a.markdown).map((q) => [q.id, q.question, q.why]), [["Q3", "Does step 2 hold?", "it blocks coding"]]);
  assert.match(a.markdown, /## Decisions/);

  const withOne = "# Req\n\n## Open Questions\n- **Q1.** first?\n  - Why it matters: w\n  - Suggested default: yes\n";
  const b = addOpenQuestion(withOne, "second?\nacross lines");
  assert.equal(b.id, "Q2");
  const qs = parseOpenQuestions(b.markdown);
  assert.deepEqual(qs.map((q) => q.id), ["Q1", "Q2"]);
  assert.equal(qs[0].suggested, "yes", "the existing question is untouched");
  assert.equal(qs[1].question, "second? across lines", "newlines in the issue are folded so the list stays valid");

  const none = addOpenQuestion("# Plan\n\n## Steps\n1. a\n", "new?");
  assert.equal(none.id, "Q1");
  assert.match(none.markdown, /## Steps[\s\S]*## Open Questions\n- \*\*Q1\.\*\* new\?/);
});
