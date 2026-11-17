import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.SDLC_DATA_DIR = mkdtempSync(join(tmpdir(), "sdlc-"));
const { Workflow } = await import("../workflow-state/service.js");
const { updatePolicy } = await import("../workflow-state/policy.js");

const light = { files_affected: 1, reversible: true, breaking: false, has_precedent: true, requirement_clarity: "high" as const };
const risky = { ...light, breaking: true };

test("light task skips to implementation; heavy starts at requirement", () => {
  const wf = new Workflow();
  assert.equal(wf.createTask({ project_root: "/r", title: "a", source: "adhoc", flags: light }).stage, "implementation");
  assert.equal(wf.createTask({ project_root: "/r", title: "b", source: "adhoc", flags: risky }).stage, "requirement");
});

test("heavy task cannot reach implementation without artifacts; plan gate needs approval", () => {
  const wf = new Workflow();
  const t = wf.createTask({ project_root: "/r", title: "h", source: "jira", flags: risky, linked_refs: { jira_key: "P-1" } });
  assert.equal(t.branch, "story/P-1");
  assert.throws(() => wf.transition(t.task_id, "implementation", "x"), /artifact missing/);
  for (const s of ["requirement", "design", "plan"]) wf.recordArtifact(t.task_id, s, `${s} body about webhook retry`);
  wf.transition(t.task_id, "plan", "skip to plan");
  assert.throws(() => wf.transition(t.task_id, "implementation", "x"), /requires human approval/);
  wf.approve(t.task_id, "plan", "khai");
  assert.equal(wf.transition(t.task_id, "implementation", "go").stage, "implementation");
});

test("artifact revision invalidates earlier approval; versions increment", () => {
  const wf = new Workflow();
  const t = wf.createTask({ project_root: "/r", title: "v", source: "adhoc", flags: risky });
  for (const s of ["requirement", "design", "plan"]) wf.recordArtifact(t.task_id, s, s);
  wf.transition(t.task_id, "plan", "x");
  wf.approve(t.task_id, "plan", "me");
  assert.equal(wf.recordArtifact(t.task_id, "plan", "revised").version, 2);
  assert.throws(() => wf.transition(t.task_id, "implementation", "x"), /requires human approval/);
});

test("auto-approve timeout fires and is recorded as auto-timeout", () => {
  const wf = new Workflow();
  updatePolicy({ requires_human_approval: [{ stage: "plan", when: "risky", auto_approve_after_hours: 0.0000001 }] });
  const t = wf.createTask({ project_root: "/r", title: "t", source: "adhoc", flags: risky });
  for (const s of ["requirement", "design", "plan"]) wf.recordArtifact(t.task_id, s, s);
  wf.transition(t.task_id, "plan", "x");
  const ev: any[] = wf.checkGates();
  assert.ok(ev.some((e) => e.event === "auto_approved" && e.task_id === t.task_id));
  assert.equal(wf.transition(t.task_id, "implementation", "go").stage, "implementation");
});

test("update_policy rejects invalid patch without writing", () => {
  assert.throws(() => updatePolicy({ transitions: { requirement: ["nope"] } }));
  assert.throws(() => updatePolicy({ max_test_retries: "three" }));
});

test("test retry cap, in-flight guard, coordinated release", () => {
  const wf = new Workflow();
  updatePolicy({ max_test_retries: 1 });
  const t = wf.createTask({ project_root: "/r", title: "r", source: "adhoc", flags: light });
  wf.transition(t.task_id, "test", "impl done");
  wf.transition(t.task_id, "implementation", "fail 1");
  wf.transition(t.task_id, "test", "impl done");
  assert.throws(() => wf.transition(t.task_id, "implementation", "fail 2"), /max_test_retries/);
  wf.setDispatch(t.task_id, "d1", "in-flight");
  assert.throws(() => wf.setDispatch(t.task_id, "d2", "in-flight"), /in-flight/);
  wf.setDispatch(t.task_id, "d1", "completed");
  wf.transition(t.task_id, "review", "cap hit", true);
  assert.equal(wf.getTask(t.task_id).needs_attention, true);

  const parent = wf.createTask({ project_root: "/r", title: "p", source: "adhoc", flags: light, coordinated_release: true });
  const a = wf.createTask({ project_root: "/a", title: "a", source: "adhoc", flags: light, parent_task_id: parent.task_id });
  const b = wf.createTask({ project_root: "/b", title: "b", source: "adhoc", flags: light, parent_task_id: parent.task_id });
  for (const c of [a, b]) wf.transition(c.task_id, "test", "x");
  wf.transition(a.task_id, "review", "x");
  assert.throws(() => wf.transition(a.task_id, "done", "x"), /coordinated release/);
  wf.transition(b.task_id, "review", "x");
  assert.equal(wf.transition(a.task_id, "done", "x").stage, "done");
});

test("find_task by jira key / PR, and FTS precedent search", () => {
  const wf = new Workflow();
  const t = wf.createTask({ project_root: "/s", title: "s", source: "jira", flags: light, linked_refs: { jira_key: "Z-9" } });
  wf.updateLinkedRefs(t.task_id, { pr_number: 42 });
  assert.equal(wf.findTask("Z-9").task_id, t.task_id);
  assert.equal(wf.findTask("42").task_id, t.task_id);
  wf.recordArtifact(t.task_id, "requirement", "Add exponential backoff to payment webhook handler");
  const hits = wf.searchPrecedent("webhook backoff", "/s") as any[];
  assert.ok(hits.length >= 1);
});

test("project_root spellings (backslash, slash, trailing slash, drive case) are one repo", () => {
  const wf = new Workflow();
  wf.createTask({ project_root: String.raw`d:\work\Proj` + "\\", title: "n", source: "adhoc", flags: light });
  assert.equal(wf.listPending("D:/work/Proj").length, 1);
  assert.equal(wf.listPending(String.raw`D:\work\Proj`).length, 1);
  assert.equal(wf.listPending("d:/work/Proj/").length, 1);
});

test("delete_task removes everything; guards children and in-flight dispatches", () => {
  const wf = new Workflow();
  const p = wf.createTask({ project_root: "/del", title: "p", source: "adhoc", flags: light });
  const c = wf.createTask({ project_root: "/del", title: "c", source: "adhoc", flags: light, parent_task_id: p.task_id });
  wf.recordArtifact(p.task_id, "requirement", "gone soon unique-zebra-term");
  wf.recordEdgeCase(p.task_id, "d", "x", "y");
  assert.throws(() => wf.deleteTask(p.task_id), /child task/);
  wf.setDispatch(c.task_id, "d9", "in-flight");
  assert.throws(() => wf.deleteTask(p.task_id, true), /in-flight/);
  wf.setDispatch(c.task_id, "d9", "completed");
  assert.deepEqual(wf.deleteTask(p.task_id, true).removed.sort(), [p.task_id, c.task_id].sort());
  assert.throws(() => wf.getTask(p.task_id), /unknown task_id/);
  assert.equal((wf.searchPrecedent("unique-zebra-term") as any[]).length, 0);
  assert.equal(wf.listPending("/del").length, 0);
});

test("branch name: default story/{key}; per-repo and global branch_pattern; bad patterns reported not thrown", async () => {
  const { writeFileSync } = await import("node:fs");
  const cfg = join(process.env.SDLC_DATA_DIR!, "config.json");
  const prev = process.env.SDLC_CONFIG;
  process.env.SDLC_CONFIG = cfg;
  try {
    const wf = new Workflow();
    const mk = (root: string, jira?: string) =>
      wf.createTask({ project_root: root, title: "b", source: jira ? "jira" : "adhoc", flags: light, linked_refs: jira ? { jira_key: jira } : {} });

    writeFileSync(cfg, JSON.stringify({ default_platform: "x" }));
    assert.equal(mk("/b1", "P-9").branch, "story/P-9");

    writeFileSync(cfg, JSON.stringify({ default_platform: "x", branch_pattern: "dev/{key}", projects: { "/b2": { branch_pattern: "feature/{jira_key}" } } }));
    assert.equal(mk("/b2", "P-9").branch, "feature/P-9");
    assert.equal(mk("/b3", "P-9").branch, "dev/P-9");
    const adhoc = mk("/b2");
    assert.equal(adhoc.branch, `feature/${adhoc.task_id}`); // no Jira key: falls back to the task id

    for (const bad of ["feature/{nope}", "fixed-name", "main", "{key}..x", "{key}/"]) {
      writeFileSync(cfg, JSON.stringify({ default_platform: "x", branch_pattern: bad }));
      const t = wf.getTask(adhoc.task_id);
      assert.equal(t.branch, null, bad);
      assert.match((t as any).branch_error, /branch_pattern/, bad);
    }
  } finally { if (prev === undefined) delete process.env.SDLC_CONFIG; else process.env.SDLC_CONFIG = prev; }
});

test("artifacts are Markdown files: DB keeps metadata only, edits are honoured, migration moves legacy rows, delete removes the files", async () => {
  const { existsSync, readFileSync, writeFileSync } = await import("node:fs");
  const wf = new Workflow();
  const t = wf.createTask({ project_root: "/files", title: "f", source: "adhoc", flags: risky });
  const r = wf.recordArtifact(t.task_id, "requirement", "# Req\nfirst");
  assert.ok(r.path.endsWith(join("artifacts", t.task_id, "requirement.v1.md")));
  assert.equal(readFileSync(r.path, "utf8"), "# Req\nfirst");
  assert.equal((wf.db.prepare("SELECT content FROM stage_artifacts WHERE task_id=?").get(t.task_id) as any).content, "", "no document body in the database");
  writeFileSync(r.path, "# Req\nedited by the reviewer");
  assert.equal(wf.getArtifact(t.task_id, "requirement").content, "# Req\nedited by the reviewer");
  assert.equal((wf.getTask(t.task_id).artifacts as any[])[0].path, r.path);
  // legacy row (content in the database, no file) is migrated on the next open
  wf.db.prepare("INSERT INTO stage_artifacts (task_id,stage,version,content,created_at) VALUES (?,?,?,?,?)").run(t.task_id, "design", 1, "legacy design", "2020-01-01");
  const again = new Workflow();
  assert.equal(again.getArtifact(t.task_id, "design").content, "legacy design");
  assert.equal((again.db.prepare("SELECT content FROM stage_artifacts WHERE stage='design' AND task_id=?").get(t.task_id) as any).content, "");
  again.deleteTask(t.task_id);
  assert.equal(existsSync(r.path), false);
});

test("a database created before artifacts were files (content NOT NULL, no default, no file column) still records artifacts", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const { mkdtempSync: mk, readFileSync } = await import("node:fs");
  const old = join(mk(join(tmpdir(), "sdlc-old-")), "old.db");
  const raw = new DatabaseSync(old);
  raw.exec(`CREATE TABLE stage_artifacts (
    id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, stage TEXT NOT NULL, version INTEGER NOT NULL, content TEXT NOT NULL,
    input_refs_json TEXT, skill_version TEXT, platform TEXT, created_at TEXT NOT NULL, UNIQUE(task_id, stage, version));`);
  raw.close();
  const wf = new Workflow(old);
  const t = wf.createTask({ project_root: "/oldschema", title: "o", source: "adhoc", flags: risky });
  const r = wf.recordArtifact(t.task_id, "requirement", "# written on an old schema");
  assert.equal(readFileSync(r.path, "utf8"), "# written on an old schema");
  assert.equal(wf.getArtifact(t.task_id, "requirement").content, "# written on an old schema");
});

// ---- spec proven wrong: implementation sends the task back ----

const PLAN_DOC = "# Plan: retry\n\n## Steps\n1. `a.ts` - add retry\n\n## Open Questions\nNone.\n";

function implementing(wf: InstanceType<typeof Workflow>, title: string) {
  const t = wf.createTask({ project_root: "/spec", title, source: "adhoc", flags: risky });
  for (const s of ["requirement", "design"]) wf.recordArtifact(t.task_id, s, `# ${s}`);
  wf.recordArtifact(t.task_id, "plan", PLAN_DOC);
  wf.transition(t.task_id, "plan", "x");
  wf.approve(t.task_id, "plan", "me");
  wf.transition(t.task_id, "implementation", "go");
  return t.task_id;
}

test("report_spec_wrong sends the task back, records the issue as an open question, voids the plan approval and logs an edge case", () => {
  const wf = new Workflow();
  const id = implementing(wf, "sw1");
  const r = wf.reportSpecWrong(id, "Step 1 adds retry in a.ts but a.ts has no network call", "plan", "grep shows the call lives in b.ts");
  assert.equal(r.returned_to, "plan");
  assert.equal(r.question_id, "Q1");
  assert.equal(wf.getTask(id).stage, "plan");
  const plan = wf.getArtifact(id, "plan");
  assert.equal(plan.version, 2, "a new version, the old one is kept");
  assert.match(plan.content, /\*\*Q1\.\*\* \[Raised during implementation\] Step 1 adds retry/);
  assert.match(plan.content, /Evidence: grep shows the call lives in b\.ts/);
  assert.equal(wf.openQuestions(id, "plan").count, 1);
  assert.match(r.display, /sent back to plan/);
  assert.throws(() => wf.transition(id, "implementation", "again"), /requires human approval/, "the revised plan has to be approved again");
  assert.equal(wf.getTask(id).retry_count, 0, "not counted as a test retry");
  assert.equal(wf.getTask(id).needs_attention, false);
  const edge = wf.db.prepare("SELECT description, decision FROM edge_cases WHERE task_id=?").get(id) as any;
  assert.match(edge.description, /Spec proven wrong during implementation/);
  assert.equal(edge.decision, "Sent back to 'plan'");
  assert.ok((wf.getTask(id).history as any[]).some((h) => h.reason.startsWith("spec_wrong:")));
});

test("report_spec_wrong is capped, only valid while implementing, and only to allowed stages", () => {
  const wf = new Workflow();
  updatePolicy({ max_spec_wrong_returns: 1 });
  const id = implementing(wf, "sw2");
  assert.throws(() => wf.reportSpecWrong(id, "x", "implementation"), /does not allow returning/);
  assert.throws(() => wf.reportSpecWrong(id, "  ", "plan"), /issue is empty/);
  wf.reportSpecWrong(id, "first problem", "plan");
  assert.throws(() => wf.reportSpecWrong(id, "second", "plan"), /applies while implementing or testing/, "now back in plan");
  wf.approve(id, "plan", "me");
  wf.transition(id, "implementation", "go again");
  assert.throws(() => wf.reportSpecWrong(id, "second problem", "plan"), /already sent back 1 time/);
  updatePolicy({ max_spec_wrong_returns: 2 });
  wf.setDispatch(id, "d_00000000", "in-flight");
  assert.throws(() => wf.reportSpecWrong(id, "second problem", "plan"), /still in-flight/);
});

test("report_spec_wrong works from test, and for a light task with no earlier document", () => {
  const wf = new Workflow();
  const t = wf.createTask({ project_root: "/spec", title: "light", source: "adhoc", flags: light });
  assert.equal(t.stage, "implementation");
  wf.transition(t.task_id, "test", "coded");
  const r = wf.reportSpecWrong(t.task_id, "the frozen test asserts a negative balance is allowed", "requirement");
  assert.equal(r.question_id, null, "there is no requirement document to annotate");
  assert.equal(wf.getTask(t.task_id).stage, "requirement");
  assert.match(r.display, /no requirement document yet/);
});

test("a policy.json written before spec_wrong settings existed still validates and gets the defaults", async () => {
  const { PolicySchema } = await import("../workflow-state/policy.js");
  const { readFileSync } = await import("node:fs");
  const old = JSON.parse(readFileSync(new URL("../../config/policy.default.json", import.meta.url), "utf8"));
  delete old.spec_wrong_return_to; delete old.max_spec_wrong_returns;
  const p = PolicySchema.parse(old);
  assert.deepEqual(p.spec_wrong_return_to, ["requirement", "design", "plan"]);
  assert.equal(p.max_spec_wrong_returns, 2);
  assert.throws(() => PolicySchema.parse({ ...old, spec_wrong_return_to: ["nope"] }));
});

test("children of a task with a breakdown need the breakdown approved first; revising it voids the approval", () => {
  const wf = new Workflow();
  const p = wf.createTask({ project_root: "/bd", title: "big", source: "adhoc", flags: risky });
  const child = () => wf.createTask({ project_root: "/bd", title: "c", source: "adhoc", flags: light, parent_task_id: p.task_id });
  wf.recordArtifact(p.task_id, "breakdown", ["# Breakdown", "## Children", "- **a**"].join("\n"));
  assert.throws(child, /breakdown .* not been approved/);
  wf.approve(p.task_id, "breakdown", "khai");
  assert.equal(child().parent_task_id, p.task_id);
  wf.recordArtifact(p.task_id, "breakdown", ["# Breakdown v2", "## Children", "- **a**", "- **b**"].join("\n"));
  assert.throws(child, /not been approved/);
  // a parent with no breakdown document (workspace per-repo split) is unaffected
  const w = wf.createTask({ project_root: "/ws", title: "w", source: "adhoc", flags: risky });
  assert.ok(wf.createTask({ project_root: "/ws", title: "c", source: "adhoc", flags: light, parent_task_id: w.task_id }));
});

test("review signal: counts edge cases and exhausted retries per repo, honours the threshold, resets when marked reviewed", async () => {
  const wf = new Workflow();
  updatePolicy({ max_test_retries: 3, edge_case_review_after: 3 });
  const t = wf.createTask({ project_root: "/sig", title: "s", source: "adhoc", flags: light });
  const other = wf.createTask({ project_root: "/elsewhere", title: "o", source: "adhoc", flags: light });
  wf.recordEdgeCase(other.task_id, "d", "x", "y");
  wf.recordEdgeCase(t.task_id, "d1", "x", "y");
  wf.recordEdgeCase(t.task_id, "d2", "x", "y");
  let s = wf.reviewSignal("/sig");
  assert.deepEqual([s.due, s.problems], [false, 2], "another repo's problems do not count");
  wf.recordEdgeCase(t.task_id, "d3", "x", "y");
  s = wf.reviewSignal("/sig/");
  assert.equal(s.due, true);
  assert.match(s.message, /Offer edge-case-review/);

  wf.markReviewed("/sig");
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual([wf.reviewSignal("/sig").due, wf.reviewSignal("/sig").problems], [false, 0]);

  // a task that used up its test retries counts as a problem
  updatePolicy({ max_test_retries: 1, edge_case_review_after: 1 });
  wf.transition(t.task_id, "test", "x");
  wf.transition(t.task_id, "implementation", "fail 1");
  s = wf.reviewSignal("/sig");
  assert.equal(s.retries_exhausted, 1);
  assert.equal(s.due, true);

  updatePolicy({ edge_case_review_after: 0 });
  assert.equal(wf.reviewSignal("/sig").due, false, "0 turns the prompt off");
});
