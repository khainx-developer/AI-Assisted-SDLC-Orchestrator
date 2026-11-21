import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.SDLC_DATA_DIR = mkdtempSync(join(tmpdir(), "sdlc-auto-"));
const { Workflow } = await import("../workflow/service.js");
const { updatePolicy, loadPolicy, PolicySchema } = await import("../workflow/policy.js");
const { countBreakdownParts, neverAutonomousReason } = await import("../workflow/autonomy.js");
const { autopilotLoop } = await import("../autopilot/loop.js");
const { formatReport } = await import("../autopilot/report.js");
const { buildInvocation, runTurn, tickPrompt } = await import("../autopilot/agent.js");
const { BUILTIN_PLATFORM_IDS } = await import("../config/builtin-platforms.js");
const { PLATFORMS } = await import("../dispatch/platforms.js");

const light = { files_affected: 1, reversible: true, breaking: false, has_precedent: true, requirement_clarity: "high" as const };
const heavy = { ...light, requirement_clarity: "low" as const };
const breaking = { ...light, breaking: true };
const doc = (qs: string) => `# Requirement\n\n## Open Questions\n${qs}\n`;
const withDefault = "- **Q1.** Retry how many times?\n  - Why it matters: load\n  - Suggested: 3 times\n";
const withoutDefault = "- **Q2.** Which queue?\n  - Why it matters: routing\n";

const on = () => updatePolicy({ autonomy: { enabled: true } });
const off = () => updatePolicy({ autonomy: { enabled: false } });
const root = (n: string) => `/repo-${n}`;

test("autonomous mode is available by default, and a policy.json from before it existed still validates", () => {
  assert.equal(loadPolicy().autonomy.enabled, true);
  const old: any = JSON.parse(JSON.stringify(loadPolicy()));
  delete old.autonomy;
  const p = PolicySchema.parse(old);
  assert.equal(p.autonomy.enabled, true);
  assert.equal(p.autonomy.max_children, 6);
  assert.equal(p.autonomy.never_autonomous.breaking, true);
});

test("a run cannot start while the policy switch is off", () => {
  off();
  const wf = new Workflow();
  assert.throws(() => wf.autonomy.startRun({ project_root: root("off") }), /autonomous mode is off/);
});

test("a run enrolls the repo's unfinished tasks (or only the named ones) and children join their parent's run", () => {
  on();
  const wf = new Workflow();
  const a = wf.createTask({ project_root: root("enrol"), title: "a", source: "adhoc", flags: light });
  const b = wf.createTask({ project_root: root("enrol"), title: "b", source: "adhoc", flags: light });
  const other = wf.createTask({ project_root: root("elsewhere"), title: "x", source: "adhoc", flags: light });
  const { run, enrolled } = wf.autonomy.startRun({ project_root: root("enrol"), hours: 1 });
  assert.deepEqual(enrolled.sort(), [a.task_id, b.task_id].sort());
  assert.equal(wf.getTask(a.task_id).autonomous, true);
  assert.equal(wf.getTask(other.task_id).autonomous, false);
  assert.ok(run.deadline);

  const only = wf.autonomy.startRun({ project_root: root("enrol"), task_ids: [a.task_id] });
  assert.deepEqual(only.enrolled, [a.task_id]);

  const parent = wf.createTask({ project_root: root("kids"), title: "parent", source: "adhoc", flags: heavy });
  const r2 = wf.autonomy.startRun({ project_root: root("kids") });
  const child = wf.createTask({ project_root: root("kids"), title: "child", source: "adhoc", flags: light, parent_task_id: parent.task_id });
  assert.equal(wf.getTask(child.task_id).autonomous, true);
  assert.equal(wf.getTask(child.task_id).run_id, r2.run.run_id);
});

test("a run always has a deadline, never past max_hours_per_run, and agent turns are capped", () => {
  updatePolicy({ autonomy: { enabled: true, max_hours_per_run: 2, max_turns_per_run: 2 } });
  const wf = new Workflow();
  const t = wf.createTask({ project_root: root("limits"), title: "a", source: "adhoc", flags: light });
  const hoursLeft = (r: { deadline: string | null }) => (Date.parse(r.deadline!) - Date.now()) / 3.6e6;
  const none = wf.autonomy.startRun({ project_root: root("limits") }).run;
  assert.ok(none.deadline && hoursLeft(none) <= 2.01, "no hours given: the policy cap applies");
  const more = wf.autonomy.startRun({ project_root: root("limits"), hours: 50 }).run;
  assert.ok(hoursLeft(more) <= 2.01, "asking for more than the cap is cut to the cap");
  const less = wf.autonomy.startRun({ project_root: root("limits"), hours: 1 }).run;
  assert.ok(hoursLeft(less) <= 1.01, "a shorter request is kept");

  assert.equal(wf.autonomy.budget(less).exhausted, false);
  wf.autonomy.logTick(less.run_id, t.task_id, "requirement");
  wf.autonomy.logTick(less.run_id, t.task_id, "requirement");
  const b = wf.autonomy.budget(less);
  assert.deepEqual([b.turns_used, b.turns_max, b.exhausted], [2, 2, true]);
  updatePolicy({ autonomy: { max_hours_per_run: 8, max_turns_per_run: 100 } });
});

test("children of an enrolled parent are capped by max_children", () => {
  updatePolicy({ autonomy: { enabled: true, max_children: 2 } });
  const wf = new Workflow();
  const parent = wf.createTask({ project_root: root("cap"), title: "p", source: "adhoc", flags: heavy });
  wf.autonomy.startRun({ project_root: root("cap") });
  for (let i = 0; i < 2; i++) wf.createTask({ project_root: root("cap"), title: `c${i}`, source: "adhoc", flags: light, parent_task_id: parent.task_id });
  assert.throws(() => wf.createTask({ project_root: root("cap"), title: "c3", source: "adhoc", flags: light, parent_task_id: parent.task_id }), /max_children/);
  updatePolicy({ autonomy: { max_children: 6 } });
});

function gated(wf: InstanceType<typeof Workflow>, name: string, flags = breaking, planText = "plan body") {
  const t = wf.createTask({ project_root: root(name), title: `task ${name}`, description: "add retries", source: "adhoc", flags });
  for (const s of ["requirement", "design", "plan"]) wf.recordArtifact(t.task_id, s, s === "plan" ? planText : `${s} body`);
  wf.transition(t.task_id, "plan", "x");
  return t.task_id;
}

test("an autonomous approval is refused for a task that is not enrolled, and by default for breaking changes", () => {
  on();
  const wf = new Workflow();
  const id = gated(wf, "appr1");
  assert.throws(() => wf.approve(id, "plan", "autonomous:run_x"), /not enrolled/);
  wf.autonomy.startRun({ project_root: root("appr1") });
  assert.throws(() => wf.approve(id, "plan", "autonomous:run_x"), /breaking change/);
  assert.throws(() => wf.transition(id, "implementation", "go"), /requires human approval/, "the refusal approved nothing");
});

test("with breaking changes allowed, a gated plan is approved, logged and moves on; a human name still needs no guard", () => {
  updatePolicy({ autonomy: { enabled: true, never_autonomous: { breaking: false } } });
  const wf = new Workflow();
  const id = gated(wf, "appr2");
  const { run } = wf.autonomy.startRun({ project_root: root("appr2") });
  wf.approve(id, "plan", `autonomous:${run.run_id}`);
  assert.equal(wf.transition(id, "implementation", "go").stage, "implementation");
  const rows = wf.db.prepare("SELECT kind FROM autonomy_log WHERE task_id=? AND kind='approval'").all(id);
  assert.equal(rows.length, 1);
  const human = gated(wf, "appr3");
  wf.approve(human, "plan", "khai");
  updatePolicy({ autonomy: { never_autonomous: { breaking: true } } });
});

test("sensitive keywords in the task or the plan stop an autonomous approval", () => {
  updatePolicy({ autonomy: { enabled: true, never_autonomous: { breaking: false } } });
  const wf = new Workflow();
  const id = gated(wf, "kw", breaking, "Step 1: run the database migration on orders");
  const { run } = wf.autonomy.startRun({ project_root: root("kw") });
  assert.throws(() => wf.approve(id, "plan", `autonomous:${run.run_id}`), /mentions 'migration'/);
  assert.equal(neverAutonomousReason({ flags: light, title: "Fix the author field", description: null }, { breaking: true, irreversible: true, keywords: ["auth"] }), "it mentions 'auth'", "matches at a word start, conservatively");
  assert.equal(neverAutonomousReason({ flags: light, title: "Rename a variable", description: null }, { breaking: true, irreversible: true, keywords: ["auth"] }), null);
  assert.match(String(neverAutonomousReason({ flags: { ...light, reversible: false }, title: "x", description: null }, { breaking: true, irreversible: true, keywords: [] })), /not reversible/);
});

test("plan_gate 'park', open questions, a parked task and an ended run each refuse an autonomous approval", () => {
  updatePolicy({ autonomy: { enabled: true, plan_gate: "park", never_autonomous: { breaking: false } } });
  const wf = new Workflow();
  const id = gated(wf, "refuse");
  const { run } = wf.autonomy.startRun({ project_root: root("refuse") });
  assert.throws(() => wf.approve(id, "plan", `autonomous:${run.run_id}`), /plan_gate is 'park'/);
  updatePolicy({ autonomy: { plan_gate: "auto_approve" } });

  wf.recordArtifact(id, "plan", `# Plan\n\n## Open Questions\n${withDefault}`);
  assert.throws(() => wf.approve(id, "plan", `autonomous:${run.run_id}`), /open questions/);
  wf.recordArtifact(id, "plan", "# Plan\nclean");

  wf.autonomy.park(id, "waiting");
  assert.throws(() => wf.approve(id, "plan", `autonomous:${run.run_id}`), /is parked/);
  wf.autonomy.unpark(id);

  wf.autonomy.stopRun(run.run_id, "enough");
  assert.throws(() => wf.approve(id, "plan", `autonomous:${run.run_id}`), /no longer active/);
  updatePolicy({ autonomy: { never_autonomous: { breaking: true } } });
});

test("a run past its deadline decides nothing more", () => {
  on();
  const wf = new Workflow();
  const id = gated(wf, "late", light);
  const { run } = wf.autonomy.startRun({ project_root: root("late") });
  wf.db.prepare("UPDATE autonomy_runs SET deadline=? WHERE run_id=?").run(new Date(Date.now() - 1000).toISOString(), run.run_id);
  assert.throws(() => wf.autonomy.answerOpenQuestions(id, "plan"), /no longer active/);
});

test("open questions: suggested answers are taken and logged as edge cases; a question without one parks the task", () => {
  on();
  const wf = new Workflow();
  const t = wf.createTask({ project_root: root("q"), title: "q task", source: "adhoc", flags: heavy });
  wf.recordArtifact(t.task_id, "requirement", doc(withDefault));
  wf.autonomy.startRun({ project_root: root("q") });
  const r = wf.autonomy.answerOpenQuestions(t.task_id, "requirement");
  assert.deepEqual(r, { parked: false, accepted: ["Q1"], unanswered: [] });
  assert.equal(wf.openQuestions(t.task_id, "requirement").count, 0);
  assert.match(wf.getArtifact(t.task_id, "requirement").content, /3 times/);
  const edge = wf.db.prepare("SELECT decision, reasoning FROM edge_cases WHERE task_id=?").all(t.task_id) as any[];
  assert.equal(edge.length, 1);
  assert.match(edge[0].decision, /Accepted the suggested answer: 3 times/);
  assert.match(edge[0].reasoning, /no human to ask/);

  const u = wf.createTask({ project_root: root("q2"), title: "q2", source: "adhoc", flags: heavy });
  wf.recordArtifact(u.task_id, "requirement", doc(withDefault + withoutDefault));
  wf.autonomy.startRun({ project_root: root("q2") });
  const r2 = wf.autonomy.answerOpenQuestions(u.task_id, "requirement");
  assert.deepEqual(r2, { parked: true, accepted: ["Q1"], unanswered: ["Q2"] });
  const parked = wf.getTask(u.task_id);
  assert.match(String(parked.parked_reason), /1 open question\(s\).*no suggested answer/);
  assert.equal(parked.needs_attention, true);
  assert.equal(wf.openQuestions(u.task_id, "requirement").count, 1, "the unanswerable one is left for the human");
});

test("answer_questions 'park' parks without answering; never-autonomous tasks park their questions too", () => {
  updatePolicy({ autonomy: { enabled: true, answer_questions: "park" } });
  const wf = new Workflow();
  const t = wf.createTask({ project_root: root("qp"), title: "qp", source: "adhoc", flags: heavy });
  wf.recordArtifact(t.task_id, "requirement", doc(withDefault));
  wf.autonomy.startRun({ project_root: root("qp") });
  assert.equal(wf.autonomy.answerOpenQuestions(t.task_id, "requirement").parked, true);
  assert.equal(wf.openQuestions(t.task_id, "requirement").count, 1);

  updatePolicy({ autonomy: { answer_questions: "accept_suggested" } });
  const s = wf.createTask({ project_root: root("qs"), title: "Add payment retries", source: "adhoc", flags: heavy });
  wf.recordArtifact(s.task_id, "requirement", doc(withDefault));
  wf.autonomy.startRun({ project_root: root("qs") });
  const r = wf.autonomy.answerOpenQuestions(s.task_id, "requirement");
  assert.equal(r.parked, true);
  assert.match(String(wf.getTask(s.task_id).parked_reason), /mentions 'payment'/);
});

test("parking, unparking and handing over for review", () => {
  on();
  const wf = new Workflow();
  const t = wf.createTask({ project_root: root("park"), title: "p", source: "adhoc", flags: light });
  assert.throws(() => wf.autonomy.park(t.task_id, "x"), /not part of an autonomous run/);
  const { run } = wf.autonomy.startRun({ project_root: root("park") });
  assert.throws(() => wf.autonomy.park(t.task_id, "  "), /say why/);
  wf.autonomy.park(t.task_id, "needs a decision", "Which queue?", "the default one");
  assert.equal(wf.autonomy.runnable(run.run_id).tasks.length, 0, "a parked task is not given turns");
  assert.throws(() => wf.autonomy.unpark("nope"), /unknown task/);
  wf.autonomy.unpark(t.task_id, "answered in chat");
  assert.equal(wf.autonomy.runnable(run.run_id).tasks.length, 1);
  assert.throws(() => wf.autonomy.markReadyForReview(t.task_id, " "), /summary/);
  wf.autonomy.markReadyForReview(t.task_id, "retries added on story/x, PR #12");
  const rep = wf.autonomy.report(run.run_id);
  assert.equal(rep.tasks[0].outcome, "ready");
  assert.equal(rep.counts.ready, 1);
  assert.equal(wf.getTask(t.task_id).needs_attention, false, "ready for review is not a problem");
});

test("a task with no stage change after max_attempts_per_task turns is parked, and a stage change resets the count", () => {
  updatePolicy({ autonomy: { enabled: true, max_attempts_per_task: 2 } });
  const wf = new Workflow();
  const t = wf.createTask({ project_root: root("att"), title: "stuck", source: "adhoc", flags: light });
  const { run } = wf.autonomy.startRun({ project_root: root("att") });
  wf.autonomy.logTick(run.run_id, t.task_id, "implementation");
  assert.equal(wf.autonomy.runnable(run.run_id).tasks.length, 1);
  wf.transition(t.task_id, "test", "coded");
  wf.autonomy.logTick(run.run_id, t.task_id, "test");
  assert.equal(wf.autonomy.runnable(run.run_id).tasks.length, 1, "progress happened, so the earlier turn does not count");
  wf.autonomy.logTick(run.run_id, t.task_id, "test");
  assert.equal(wf.autonomy.runnable(run.run_id).tasks.length, 0);
  assert.match(String(wf.getTask(t.task_id).parked_reason), /no progress after 2 agent turns/);
  updatePolicy({ autonomy: { max_attempts_per_task: 4 } });
});

test("a task whose session is still running is not given a turn; a finished one is", () => {
  on();
  const wf = new Workflow();
  const t = wf.createTask({ project_root: root("fly"), title: "fly", source: "adhoc", flags: light });
  const { run } = wf.autonomy.startRun({ project_root: root("fly") });
  const id = "d_0badf00d";
  const dir = join(process.env.SDLC_DATA_DIR!, "dispatches", id);
  const meta = { dispatch_id: id, kind: "coding", task_id: t.task_id, platform: "x", project_root: root("fly"), status: "in-flight", started_at: new Date().toISOString() };
  mkdirpWrite(dir, meta);
  wf.setDispatch(t.task_id, id, "in-flight");
  assert.equal(wf.autonomy.runnable(run.run_id).tasks.length, 0);
  assert.equal(wf.autonomy.runnable(run.run_id).waiting, 1);
  mkdirpWrite(dir, { ...meta, status: "completed" });
  const r = wf.autonomy.runnable(run.run_id);
  assert.equal(r.tasks.length, 1);
  assert.match(r.tasks[0].why, /has completed/);
  assert.equal(r.budget.used, 1, "the session counts against the run's budget");
});

function mkdirpWrite(dir: string, meta: object) {
  mkdirSyncCompat(dir);
  writeFileSync(join(dir, "meta.json"), JSON.stringify(meta));
}
import { mkdirSync } from "node:fs";
function mkdirSyncCompat(d: string) { mkdirSync(d, { recursive: true }); }

test("a split parent is an overview: it is not given turns, its children are", () => {
  on();
  const wf = new Workflow();
  const parent = wf.createTask({ project_root: root("split"), title: "big", source: "adhoc", flags: heavy });
  const { run } = wf.autonomy.startRun({ project_root: root("split") });
  wf.createTask({ project_root: root("split"), title: "part", source: "adhoc", flags: light, parent_task_id: parent.task_id });
  const r = wf.autonomy.runnable(run.run_id);
  assert.deepEqual(r.tasks.map((x) => x.title), ["part"]);
  assert.equal(r.open, 1);
  assert.equal(wf.autonomy.report(run.run_id).tasks.find((x) => x.task_id === parent.task_id)!.outcome, "split");
});

test("breakdown parts are counted from the Children section", () => {
  const md = "# Breakdown: x\n\n## Children\n- **A** — scope — `/r` — why\n- **B** — scope — `/r` — why\n- **C** — scope — `/r` — why\n\n## Coordinated release\nno — x\n- **not a child**\n";
  assert.equal(countBreakdownParts(md), 3);
  assert.equal(countBreakdownParts("No split — work fits one pass"), 0);
});

test("the breakdown of a big story is refused for a run when it has more parts than max_children", () => {
  updatePolicy({ autonomy: { enabled: true, max_children: 2 } });
  const wf = new Workflow();
  const t = wf.createTask({ project_root: root("bd"), title: "story", source: "adhoc", flags: heavy });
  wf.recordArtifact(t.task_id, "breakdown", "# Breakdown\n\n## Children\n- **A** — s — `/r` — w\n- **B** — s — `/r` — w\n- **C** — s — `/r` — w\n");
  const { run } = wf.autonomy.startRun({ project_root: root("bd") });
  assert.throws(() => wf.approve(t.task_id, "breakdown", `autonomous:${run.run_id}`), /3 parts, more than max_children \(2\)/);
  wf.recordArtifact(t.task_id, "breakdown", "# Breakdown\n\n## Children\n- **A** — s — `/r` — w\n- **B** — s — `/r` — w\n");
  wf.approve(t.task_id, "breakdown", `autonomous:${run.run_id}`);
  updatePolicy({ autonomy: { max_children: 6 } });
});

test("deleting a task removes its run log", () => {
  on();
  const wf = new Workflow();
  const t = wf.createTask({ project_root: root("del"), title: "d", source: "adhoc", flags: light });
  wf.autonomy.startRun({ project_root: root("del") });
  assert.ok((wf.db.prepare("SELECT COUNT(*) AS n FROM autonomy_log WHERE task_id=?").get(t.task_id) as any).n > 0);
  wf.deleteTask(t.task_id);
  assert.equal((wf.db.prepare("SELECT COUNT(*) AS n FROM autonomy_log WHERE task_id=?").get(t.task_id) as any).n, 0);
});

// ---- the runner -------------------------------------------------------------------------------------------------------------

const noWait = async () => {};

test("the loop gives each runnable task a turn, ends when every task is done or handed over, and reports", async () => {
  on();
  const wf = new Workflow();
  const a = wf.createTask({ project_root: root("loop"), title: "a", source: "adhoc", flags: light });
  const b = wf.createTask({ project_root: root("loop"), title: "b", source: "adhoc", flags: light });
  const { run } = wf.autonomy.startRun({ project_root: root("loop") });
  const seen: string[] = [];
  const res = await autopilotLoop({
    wf, run_id: run.run_id, intervalMs: 0, sleep: noWait,
    turn: async (t) => {
      seen.push(`${t.task_id}@${t.stage}`);
      if (t.task_id === a.task_id) { wf.transition(t.task_id, "test", "coded"); wf.transition(t.task_id, "review", "green"); wf.autonomy.markReadyForReview(t.task_id, "done on its branch"); }
      else wf.autonomy.park(t.task_id, "needs a decision", "Which queue?", "default");
      return { ok: true, output: "line one\nreached review", exit_code: 0, timed_out: false };
    },
  });
  assert.equal(res.reason, "done");
  assert.equal(res.turns, 2);
  assert.deepEqual(seen.sort(), [`${a.task_id}@implementation`, `${b.task_id}@implementation`].sort());
  assert.equal(wf.autonomy.getRun(run.run_id).status, "finished");
  const text = formatReport(wf.autonomy.report(run.run_id));
  assert.match(text, /READY FOR YOUR REVIEW/);
  assert.match(text, /NEEDS YOU \(parked\)/);
  assert.match(text, /\? Which queue\?/);
  assert.match(text, /the run would have chosen: default/);
});

test("the loop stops when the run is stopped, when the session budget is spent, and when nothing can move", async () => {
  on();
  const wf = new Workflow();
  const t = wf.createTask({ project_root: root("loop2"), title: "x", source: "adhoc", flags: light });
  const { run } = wf.autonomy.startRun({ project_root: root("loop2") });
  const turn = async () => { wf.autonomy.stopRun(run.run_id, "by hand"); return { ok: true, output: "", exit_code: 0, timed_out: false }; };
  assert.equal((await autopilotLoop({ wf, run_id: run.run_id, intervalMs: 0, sleep: noWait, turn })).reason, "stopped");

  const wf2 = new Workflow();
  wf2.createTask({ project_root: root("loop3"), title: "y", source: "adhoc", flags: light });
  const r3 = wf2.autonomy.startRun({ project_root: root("loop3"), max_dispatches: 1 });
  const id = wf2.db.prepare("SELECT task_id FROM tasks WHERE run_id=?").get(r3.run.run_id) as any;
  mkdirpWrite(join(process.env.SDLC_DATA_DIR!, "dispatches", "d_0000beef"), { dispatch_id: "d_0000beef", kind: "analysis", task_id: id.task_id, platform: "x", project_root: "/r", status: "completed", started_at: new Date().toISOString() });
  assert.equal((await autopilotLoop({ wf: wf2, run_id: r3.run.run_id, intervalMs: 0, sleep: noWait, turn })).reason, "budget");

  const wf3 = new Workflow();
  const s = wf3.createTask({ project_root: root("loop4"), title: "z", source: "adhoc", flags: light });
  const r4 = wf3.autonomy.startRun({ project_root: root("loop4") });
  mkdirpWrite(join(process.env.SDLC_DATA_DIR!, "dispatches", "d_0000cafe"), { dispatch_id: "d_0000cafe", kind: "coding", task_id: s.task_id, platform: "x", project_root: "/r", status: "in-flight", started_at: new Date().toISOString() });
  wf3.setDispatch(s.task_id, "d_0000cafe", "in-flight");
  const stalled = await autopilotLoop({ wf: wf3, run_id: r4.run.run_id, intervalMs: 0, idleLimitMs: -1, sleep: noWait, turn });
  assert.equal(stalled.reason, "stalled");
  assert.match(wf3.autonomy.getRun(r4.run.run_id).end_reason ?? "", /never finished/);
});

test("when the agent CLI cannot be started the run stops at once instead of burning every task's attempts", async () => {
  on();
  const wf = new Workflow();
  for (const n of ["a", "b", "c"]) wf.createTask({ project_root: root("nostart"), title: n, source: "adhoc", flags: light });
  const { run } = wf.autonomy.startRun({ project_root: root("nostart") });
  let turns = 0;
  const res = await autopilotLoop({ wf, run_id: run.run_id, intervalMs: 0, sleep: noWait, turn: async () => { turns++; return { ok: false, output: "", exit_code: null, timed_out: false, error: "could not start 'copilot': spawn copilot ENOENT" }; } });
  assert.equal(res.reason, "agent_unavailable");
  assert.equal(turns, 2);
  const r = wf.autonomy.getRun(run.run_id);
  assert.equal(r.status, "stopped");
  assert.match(String(r.end_reason), /could not be started.*copilot/);
  const missing = await runTurn({ command: process.execPath, args: [] }, { cwd: join(tmpdir(), "no-such-folder-xyz"), timeoutMs: 1000 });
  assert.match(String(missing.error), /could not start.*does not exist/);
});

test("a turn that changes nothing is retried, then the task is parked, so a stuck task cannot loop all night", async () => {
  updatePolicy({ autonomy: { enabled: true, max_attempts_per_task: 3 } });
  const wf = new Workflow();
  const t = wf.createTask({ project_root: root("stuck"), title: "stuck", source: "adhoc", flags: light });
  const { run } = wf.autonomy.startRun({ project_root: root("stuck") });
  let turns = 0;
  const res = await autopilotLoop({ wf, run_id: run.run_id, intervalMs: 0, sleep: noWait, turn: async () => { turns++; return { ok: false, output: "", exit_code: 1, timed_out: false, error: "boom" }; } });
  assert.equal(turns, 3);
  assert.equal(res.reason, "done");
  assert.match(String(wf.getTask(t.task_id).parked_reason), /no progress after 3 agent turns/);
  updatePolicy({ autonomy: { max_attempts_per_task: 4 } });
});

// ---- the agent invocation ---------------------------------------------------------------------------------------------------

test("built-in agent invocations: copilot passes the prompt as an argument, claude on stdin; neither can write files or run a shell", () => {
  const p = "one line";
  const cp = buildInvocation(p, undefined, "copilot");
  assert.equal(cp.command, "copilot");
  assert.deepEqual(cp.args.slice(0, 4), ["--agent", "sdlc-orchestrator", "-p", p]);
  assert.ok(cp.args.includes("--no-ask-user") && cp.args.join(" ").includes("--deny-tool write --deny-tool shell"));
  assert.equal(cp.stdin, undefined);
  const cl = buildInvocation(p, { agent: "boss" }, "claude");
  assert.equal(cl.command, "claude");
  assert.equal(cl.stdin, p);
  assert.ok(cl.args.includes("boss") && cl.args.join(" ").includes("--disallowedTools Edit,Write,MultiEdit,NotebookEdit,Bash"));
  assert.equal(buildInvocation(p, { platform: "copilot" }, "claude").command, "copilot", "autopilot.platform wins over default_platform");
  assert.throws(() => buildInvocation(p, undefined, "cursor"), /no built-in way/);
  const custom = buildInvocation(p, { command: "mytool", args: ["run", "{prompt}"] }, "cursor");
  assert.deepEqual(custom, { command: "mytool", args: ["run", p], stdin: undefined });
  assert.equal(buildInvocation(p, { command: "mytool", args: ["run"] }, "cursor").stdin, p);
});

test("the turn instruction is one line and names the run, task and playbook", () => {
  const s = tickPrompt({ run_id: "run_1", task_id: "task_2", stage: "plan", project_root: "/r" });
  assert.ok(!s.includes("\n"));
  assert.match(s, /^AUTONOMOUS TURN\. Run run_1, task task_2/);
  assert.match(s, /get_playbook with name "autonomous"/);
});

test("runTurn runs a process, returns the tail of its output, and kills one that overruns", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sdlc-turn-"));
  const ok = join(dir, "ok.mjs");
  writeFileSync(ok, `let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>console.log("got:"+s.trim()));`);
  const r = await runTurn({ command: process.execPath, args: [ok], stdin: "hello" }, { cwd: dir, timeoutMs: 20_000 });
  assert.equal(r.ok, true);
  assert.equal(r.output, "got:hello");
  const slow = join(dir, "slow.mjs");
  writeFileSync(slow, "setInterval(()=>{},1000);");
  const t = await runTurn({ command: process.execPath, args: [slow] }, { cwd: dir, timeoutMs: 300 });
  assert.equal(t.timed_out, true);
  assert.equal(t.ok, false);
  const missing = await runTurn({ command: "definitely-not-a-real-command-xyz", args: [] }, { cwd: dir, timeoutMs: 5000 });
  assert.equal(missing.ok, false);
});

test("the built-in platform ids that settings code knows match the dispatch adapters", () => {
  assert.deepEqual([...BUILTIN_PLATFORM_IDS].sort(), Object.keys(PLATFORMS).filter((p) => p !== "generic").sort());
});
