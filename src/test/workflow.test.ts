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
  assert.equal(t.branch, "task/P-1");
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
