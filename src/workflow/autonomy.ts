/**
 * Unattended runs ("autonomous mode").
 *
 * A *run* enrolls tasks. While a run is active, an enrolled task may be approved (plan gate, breakdown) or have its open questions
 * answered by the orchestrator itself, but only as far as policy.autonomy allows, and every such decision is logged for the morning
 * report. Anything the policy does not allow, or anything with no safe default, *parks* the task: it is skipped, the run carries on
 * with the other tasks, and a human picks it up later.
 *
 * The rules live here, in the server, not in the prompt: the agent cannot approve or answer for an enrolled task unless this
 * module agrees. Code only ever lands on a task branch; nothing here merges, pushes or deletes.
 */
import { randomUUID } from "node:crypto";
import { normRoot } from "../shared/paths.js";
import { dispatchesSince, readDispatchMeta } from "../stores/dispatch-store.js";
import { WorkflowError } from "./errors.js";
import { parseOpenQuestions } from "./questions.js";
import type { AutonomyPolicy } from "./policy.js";
import type { Workflow } from "./service.js";

/** `approved_by` values that start with this are autonomous approvals and go through guardApproval. */
export const AUTONOMOUS_PREFIX = "autonomous:";

const now = () => new Date().toISOString();

export interface RunRow {
  run_id: string;
  project_root: string;
  started_at: string;
  deadline: string | null;
  max_dispatches: number;
  status: "active" | "stopped" | "finished";
  ended_at: string | null;
  end_reason: string | null;
}

type TaskView = ReturnType<Workflow["getTask"]>;

/** Why a task may not be decided on by a run (breaking or irreversible change, or a sensitive keyword), or null when it may. */
export function neverAutonomousReason(
  t: { flags: { breaking: boolean; reversible: boolean }; title: string; description: string | null },
  rules: AutonomyPolicy["never_autonomous"],
  documentText = ""
): string | null {
  if (rules.breaking && t.flags.breaking) return "it is a breaking change";
  if (rules.irreversible && !t.flags.reversible) return "it is not reversible";
  const hay = `${t.title}\n${t.description ?? ""}\n${documentText}`;
  for (const k of rules.keywords) {
    const kw = k.trim();
    if (!kw) continue;
    const re = new RegExp(`(^|[^\\p{L}\\p{N}])${kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "iu");
    if (re.test(hay)) return `it mentions '${kw}'`;
  }
  return null;
}

/** Number of child tasks a task-breakdown document proposes: the bullets under its `## Children` heading. */
export function countBreakdownParts(markdown: string): number {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((l) => /^##\s+Children\s*$/i.test(l));
  if (start < 0) return 0;
  let n = 0;
  for (const l of lines.slice(start + 1)) {
    if (/^#{1,2}\s/.test(l)) break;
    if (/^[-*]\s+\*\*/.test(l)) n++;
  }
  return n;
}

export class Autonomy {
  constructor(private wf: Workflow) {}

  private get rules(): AutonomyPolicy {
    return this.wf.policy().autonomy;
  }
  private get db() {
    return this.wf.db;
  }

  log(run_id: string | null, task_id: string | null, kind: string, summary: string, detail?: unknown) {
    this.db
      .prepare("INSERT INTO autonomy_log (run_id,task_id,kind,summary,detail,created_at) VALUES (?,?,?,?,?,?)")
      .run(run_id, task_id, kind, summary, detail === undefined ? null : JSON.stringify(detail), now());
  }

  // ---- runs --------------------------------------------------------------------------------------------------------------------

  getRun(run_id: string): RunRow {
    const r = this.db.prepare("SELECT * FROM autonomy_runs WHERE run_id=?").get(run_id) as RunRow | undefined;
    if (!r) throw new WorkflowError(`unknown run '${run_id}'`);
    return r;
  }

  /** The run is active and its deadline has not passed. */
  isLive(r: RunRow): boolean {
    return r.status === "active" && (!r.deadline || Date.parse(r.deadline) > Date.now());
  }

  /**
   * Begin an unattended run over a repo. `task_ids` limits it to those tasks; otherwise every unfinished task of the repo is
   * enrolled. Children created later by an enrolled parent join the run themselves.
   */
  startRun(a: { project_root: string; task_ids?: string[]; hours?: number; max_dispatches?: number }) {
    const rules = this.rules;
    if (!rules.enabled) throw new WorkflowError("autonomous mode is off: set policy.autonomy.enabled to true first (update_policy), and tell the human you did");
    const root = normRoot(a.project_root);
    const run_id = `run_${randomUUID().slice(0, 8)}`;
    const started = now();
    // every run has a deadline: never longer than policy.autonomy.max_hours_per_run, so an unattended run cannot go on forever
    const hours = Math.min(a.hours ?? rules.max_hours_per_run, rules.max_hours_per_run);
    const deadline = new Date(Date.now() + hours * 3.6e6).toISOString();
    this.db
      .prepare("INSERT INTO autonomy_runs (run_id,project_root,started_at,deadline,max_dispatches,status) VALUES (?,?,?,?,?,'active')")
      .run(run_id, root, started, deadline, a.max_dispatches ?? rules.max_dispatches_per_run);
    const candidates = a.task_ids?.length ? a.task_ids.map((id) => this.wf.getTask(id)) : this.wf.listPending(root).map((t) => this.wf.getTask(t.task_id));
    const enrolled: string[] = [];
    for (const t of candidates) {
      if (this.wf.policy().terminal_stages.includes(t.stage)) continue;
      this.enroll(t.task_id, run_id);
      enrolled.push(t.task_id);
    }
    this.log(run_id, null, "run_started", `run started over ${root}: ${enrolled.length} task(s), until ${deadline}`, { enrolled });
    return { run: this.getRun(run_id), enrolled };
  }

  stopRun(run_id: string, reason = "stopped") {
    const r = this.getRun(run_id);
    if (r.status !== "active") return { run: r };
    this.db.prepare("UPDATE autonomy_runs SET status='stopped', ended_at=?, end_reason=? WHERE run_id=?").run(now(), reason, run_id);
    this.log(run_id, null, "run_stopped", reason);
    return { run: this.getRun(run_id) };
  }

  /** Mark a run finished (nothing left to do, deadline or session budget reached). */
  finishRun(run_id: string, reason: string) {
    const r = this.getRun(run_id);
    if (r.status !== "active") return { run: r };
    this.db.prepare("UPDATE autonomy_runs SET status='finished', ended_at=?, end_reason=? WHERE run_id=?").run(now(), reason, run_id);
    this.log(run_id, null, "run_finished", reason);
    return { run: this.getRun(run_id) };
  }

  enroll(task_id: string, run_id: string) {
    const t = this.wf.getTask(task_id);
    this.getRun(run_id);
    this.db.prepare("UPDATE tasks SET autonomous=1, run_id=?, parked_reason=NULL, parked_at=NULL, updated_at=? WHERE task_id=?").run(run_id, now(), task_id);
    this.log(run_id, task_id, "enrolled", `enrolled in ${run_id} at stage ${t.stage}`);
  }

  /** What this run has spent against its limits: worker sessions (dispatches) and orchestrator agent turns. */
  budget(run: RunRow) {
    const ids = (this.db.prepare("SELECT task_id FROM tasks WHERE run_id=?").all(run.run_id) as { task_id: string }[]).map((r) => r.task_id);
    const used = dispatchesSince(run.started_at, ids).length;
    const turns = (this.db.prepare("SELECT COUNT(*) AS n FROM autonomy_log WHERE run_id=? AND kind='tick'").get(run.run_id) as { n: number }).n;
    const turns_max = this.rules.max_turns_per_run;
    return { used, max: run.max_dispatches, turns_used: turns, turns_max, exhausted: used >= run.max_dispatches || turns >= turns_max };
  }

  /** Runs, newest first. */
  listRuns(limit = 10): RunRow[] {
    return this.db.prepare("SELECT * FROM autonomy_runs ORDER BY started_at DESC LIMIT ?").all(limit) as unknown as RunRow[];
  }

  /** One screen of progress for a run: state, limits spent, what is open. */
  status(run_id: string) {
    const r = this.runnable(run_id);
    return { run: r.run, live: r.live, budget: r.budget, open_tasks: r.open, ready_now: r.tasks, waiting_on_sessions: r.waiting };
  }

  // ---- parking -----------------------------------------------------------------------------------------------------------------

  /**
   * Set a task aside for a human and let the run continue with the others. `question` is what the human needs to decide;
   * `suggested_answer` is what the run would have done, shown in the morning report so a yes is one word.
   */
  park(task_id: string, reason: string, question?: string, suggested_answer?: string, kind: "park" | "ready" = "park") {
    const t = this.wf.getTask(task_id);
    if (!t.autonomous) throw new WorkflowError(`task ${task_id} is not part of an autonomous run, so there is nothing to park (ask the human instead)`);
    if (!reason.trim()) throw new WorkflowError("say why the task is parked");
    this.db.prepare("UPDATE tasks SET parked_reason=?, parked_at=?, needs_attention=?, updated_at=? WHERE task_id=?").run(reason.trim(), now(), kind === "park" ? 1 : 0, now(), task_id);
    this.log(t.run_id, task_id, kind, reason.trim(), { stage: t.stage, question: question ?? null, suggested_answer: suggested_answer ?? null });
    return this.wf.getTask(task_id);
  }

  /**
   * The run has done all it may do for this task (code on its branch, tests passing, or an investigation answered): hand it to the
   * human for review. The run never moves a task to done, never merges and never pushes.
   */
  markReadyForReview(task_id: string, summary: string) {
    if (!summary.trim()) throw new WorkflowError("give a one-paragraph summary of what was done and where to look");
    return this.park(task_id, `ready for review: ${summary.trim()}`, undefined, undefined, "ready");
  }

  /** A human has dealt with a parked task: put it back in the run. */
  unpark(task_id: string, note?: string) {
    const t = this.wf.getTask(task_id);
    if (!t.parked_reason) throw new WorkflowError(`task ${task_id} is not parked`);
    this.db.prepare("UPDATE tasks SET parked_reason=NULL, parked_at=NULL, updated_at=? WHERE task_id=?").run(now(), task_id);
    this.log(t.run_id, task_id, "unpark", note?.trim() || "put back in the run by a human");
    return this.wf.getTask(task_id);
  }

  // ---- decisions ---------------------------------------------------------------------------------------------------------------

  /** The task is enrolled, not parked, and its run is live. */
  private requireLive(task_id: string): { t: TaskView; run: RunRow } {
    const t = this.wf.getTask(task_id);
    if (!this.rules.enabled) throw new WorkflowError("autonomous mode is off (policy.autonomy.enabled is false)");
    if (!t.autonomous || !t.run_id) throw new WorkflowError(`task ${task_id} is not enrolled in an autonomous run; only the human decides for it`);
    if (t.parked_reason) throw new WorkflowError(`task ${task_id} is parked (${t.parked_reason}); a human must unpark it before anything is decided for it`);
    const run = this.getRun(t.run_id);
    if (!this.isLive(run)) throw new WorkflowError(`run ${run.run_id} is no longer active (${run.status}${run.end_reason ? `: ${run.end_reason}` : ""})`);
    return { t, run };
  }

  /**
   * Called by approve() for an `autonomous:` approver. Throws unless policy lets this run approve this stage of this task.
   * The caller should then park the task with the thrown reason.
   */
  guardApproval(task_id: string, stage: string) {
    const { t, run } = this.requireLive(task_id);
    const rules = this.rules;
    const mode = stage === "breakdown" ? rules.breakdown : rules.plan_gate;
    if (mode !== "auto_approve") throw new WorkflowError(`policy.autonomy.${stage === "breakdown" ? "breakdown" : "plan_gate"} is 'park': a human approves the ${stage}`);
    let doc = "";
    try { doc = this.wf.getArtifact(task_id, stage).content; } catch { /* no document: nothing more to check */ }
    if (doc && parseOpenQuestions(doc).length)
      throw new WorkflowError(`the ${stage} still has open questions; they must be answered (autonomous_answer_open_questions) before it can be approved`);
    const why = neverAutonomousReason(t, rules.never_autonomous, doc);
    if (why) throw new WorkflowError(`a run may not approve the ${stage} of this task: ${why} (policy.autonomy.never_autonomous)`);
    if (stage === "breakdown") {
      const parts = countBreakdownParts(doc);
      if (parts > rules.max_children) throw new WorkflowError(`the breakdown has ${parts} parts, more than max_children (${rules.max_children})`);
    }
    this.log(run.run_id, task_id, "approval", `approved the ${stage} for the human (policy allows it)`, { stage });
  }

  /**
   * Answer a stage document's open questions by taking each question's suggested answer, and log every one as an edge case. Questions
   * with no suggestion cannot be decided safely: the task is parked with them listed, and nothing is invented.
   */
  answerOpenQuestions(task_id: string, stage: string) {
    const { t, run } = this.requireLive(task_id);
    if (this.rules.answer_questions !== "accept_suggested") {
      const qs = this.wf.openQuestions(task_id, stage).questions;
      this.park(task_id, `policy.autonomy.answer_questions is 'park': ${qs.length} open question(s) in the ${stage} wait for a human`, qs.map((q) => `${q.id}: ${q.question}`).join("\n"));
      return { parked: true, accepted: [], unanswered: qs.map((q) => q.id) };
    }
    const doc = this.wf.getArtifact(task_id, stage);
    const qs = parseOpenQuestions(doc.content);
    const withDefault = qs.filter((q) => q.suggested);
    const without = qs.filter((q) => !q.suggested);
    const neverWhy = neverAutonomousReason(t, this.rules.never_autonomous, doc.content);
    if (qs.length && neverWhy) {
      this.park(task_id, `open questions in the ${stage} need a human: ${neverWhy}`, qs.map((q) => `${q.id}: ${q.question}${q.suggested ? ` (suggested: ${q.suggested})` : ""}`).join("\n"));
      return { parked: true, accepted: [], unanswered: qs.map((q) => q.id) };
    }
    if (withDefault.length) {
      this.wf.answerQuestions(task_id, stage, [], withDefault.map((q) => q.id));
      for (const q of withDefault) {
        const decision = `Accepted the suggested answer: ${q.suggested}`;
        this.wf.recordEdgeCase(task_id, `${stage} ${q.id}: ${q.question}`, decision, `Run ${run.run_id} had no human to ask; the ${stage} document itself suggested this answer.`);
        this.log(run.run_id, task_id, "decision", `${stage} ${q.id} -> ${q.suggested}`, { question: q.question, answer: q.suggested });
      }
    }
    if (without.length) {
      this.park(
        task_id,
        `${without.length} open question(s) in the ${stage} have no suggested answer`,
        without.map((q) => `${q.id}: ${q.question}`).join("\n")
      );
      return { parked: true, accepted: withDefault.map((q) => q.id), unanswered: without.map((q) => q.id) };
    }
    return { parked: false, accepted: withDefault.map((q) => q.id), unanswered: [] as string[] };
  }

  // ---- what to work on next ----------------------------------------------------------------------------------------------------

  /** Record that the runner is about to give a task one turn of the agent. Counted against max_attempts_per_task. */
  logTick(run_id: string, task_id: string, stage: string) {
    this.log(run_id, task_id, "tick", `agent turn at stage ${stage}`, { stage });
  }

  /** Ticks on this task since it last changed stage (or was last unparked). */
  private ticksWithoutProgress(task_id: string): number {
    const lastMove = (this.db.prepare("SELECT MAX(created_at) AS t FROM transitions WHERE task_id=?").get(task_id) as any).t as string | null;
    const lastUnpark = (this.db.prepare("SELECT MAX(created_at) AS t FROM autonomy_log WHERE task_id=? AND kind IN ('unpark','enrolled')").get(task_id) as any).t as string | null;
    const since = [lastMove, lastUnpark].filter(Boolean).sort().pop() ?? "";
    return (this.db.prepare("SELECT COUNT(*) AS n FROM autonomy_log WHERE task_id=? AND kind='tick' AND created_at>?").get(task_id, since) as any).n as number;
  }

  /**
   * Tasks of a run that can be given an agent turn now, oldest first. Skips parked and finished tasks and tasks whose session is
   * still running. A task that has used up max_attempts_per_task turns without changing stage is parked here and not returned.
   */
  runnable(run_id: string) {
    const run = this.getRun(run_id);
    const pol = this.wf.policy();
    const ready: { task_id: string; title: string; stage: string; why: string }[] = [];
    const rows = this.db.prepare("SELECT task_id FROM tasks WHERE run_id=? AND autonomous=1 AND parked_at IS NULL ORDER BY created_at").all(run_id) as { task_id: string }[];
    for (const { task_id } of rows) {
      const t = this.wf.getTask(task_id);
      if (pol.terminal_stages.includes(t.stage) || t.children.length) continue; // a split parent is an overview: its children are worked
      let why = "ready for its next step";
      if (t.dispatch_status === "in-flight") {
        let status = "in-flight";
        try { status = readDispatchMeta(t.dispatch_id!).status; } catch { status = "failed"; }
        if (status === "in-flight") continue; // still running: the runner checks again later
        why = `dispatch ${t.dispatch_id} has ${status}`;
      }
      const used = this.ticksWithoutProgress(task_id);
      if (used >= pol.autonomy.max_attempts_per_task) {
        this.park(task_id, `no progress after ${used} agent turns at stage '${t.stage}' (max_attempts_per_task=${pol.autonomy.max_attempts_per_task})`);
        continue;
      }
      ready.push({ task_id, title: t.title, stage: t.stage, why });
    }
    // enrolled, not parked, not finished: includes tasks whose session is still running
    const open = rows.filter(({ task_id }) => {
      const t = this.wf.getTask(task_id);
      return !pol.terminal_stages.includes(t.stage) && !t.parked_reason && !t.children.length;
    }).length;
    return { run, budget: this.budget(run), live: this.isLive(run), open, waiting: Math.max(0, open - ready.length), tasks: ready };
  }

  // ---- the morning report ------------------------------------------------------------------------------------------------------

  report(run_id: string) {
    const run = this.getRun(run_id);
    const pol = this.wf.policy();
    const rows = this.db.prepare("SELECT task_id FROM tasks WHERE run_id=? ORDER BY created_at").all(run_id) as { task_id: string }[];
    const tasks = rows.map(({ task_id }) => {
      const t = this.wf.getTask(task_id);
      const parkLog = this.db.prepare("SELECT kind, detail FROM autonomy_log WHERE task_id=? AND kind IN ('park','ready') ORDER BY id DESC LIMIT 1").get(task_id) as any;
      const park = t.parked_reason && parkLog?.detail ? JSON.parse(parkLog.detail) : null;
      const outcome = pol.terminal_stages.includes(t.stage) ? (t.stage === "done" ? "done" : t.stage)
        : t.children.length ? "split"
        : t.parked_reason ? (parkLog?.kind === "ready" ? "ready" : "parked")
        : "unfinished";
      return {
        task_id, title: t.title, stage: t.stage, outcome, needs_attention: t.needs_attention,
        branch: t.branch, pr_number: t.linked_refs?.pr_number ?? null, jira_key: t.linked_refs?.jira_key ?? null,
        parked: t.parked_reason ? { reason: t.parked_reason, question: park?.question ?? null, suggested_answer: park?.suggested_answer ?? null } : null,
        decisions: (this.db.prepare("SELECT kind, summary, created_at FROM autonomy_log WHERE task_id=? AND run_id=? AND kind IN ('decision','approval') ORDER BY id").all(task_id, run_id) as any[]),
      };
    });
    const counts = { done: 0, ready: 0, parked: 0, unfinished: 0, split: 0, other: 0 };
    for (const t of tasks) (counts as any)[t.outcome in counts ? t.outcome : "other"]++;
    return { run, budget: this.budget(run), counts, tasks };
  }
}
