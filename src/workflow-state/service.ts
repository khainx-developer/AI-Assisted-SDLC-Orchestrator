import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dataDir, normRoot } from "../common/paths.js";
import { branchName, teamDir } from "../common/config.js";
import { loadPolicy, policyVersion, type Policy } from "./policy.js";
import { SCHEMA } from "./schema.js";
import { parseOpenQuestions, renderGuidance, applyAnswers, addOpenQuestion, type Answer, type OpenQuestion } from "./questions.js";

export interface Flags {
  files_affected: number;
  reversible: boolean;
  breaking: boolean;
  has_precedent: boolean;
  requirement_clarity: "high" | "low";
}
const now = () => new Date().toISOString();
const j = (v: unknown) => (v === undefined ? null : JSON.stringify(v));
const p = (s: any) => (s ? JSON.parse(s) : null);

export class WorkflowError extends Error {}

/** Stage documents are Markdown files under the data dir; the database keeps only their metadata. */
const ARTIFACTS_DIR = "artifacts";
const artifactRel = (task_id: string, stage: string, version: number) => `${ARTIFACTS_DIR}/${task_id}/${stage}.v${version}.md`;
const artifactAbs = (rel: string) => join(dataDir(), rel);

export { normRoot };

export class Workflow {
  db: DatabaseSync;
  private file: string;
  constructor(file = join(dataDir(), "workflow.db")) {
    this.file = file;
    this.db = new DatabaseSync(file);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;");
    this.db.exec(SCHEMA);
    this.migrateArtifactsToFiles();
    const taskCols = this.db.prepare("PRAGMA table_info(tasks)").all() as { name: string }[];
    if (!taskCols.some((c) => c.name === "base_branch")) this.db.exec("ALTER TABLE tasks ADD COLUMN base_branch TEXT");
    // one-time normalisation of roots stored before normRoot existed
    for (const table of ["tasks", "search_fts"]) {
      const roots = this.db.prepare(`SELECT DISTINCT project_root AS r FROM ${table}`).all() as { r: string }[];
      for (const { r } of roots) if (r !== normRoot(r)) this.db.prepare(`UPDATE ${table} SET project_root=? WHERE project_root=?`).run(normRoot(r), r);
    }
  }
  /** One-time: databases created before artifacts were files get a `file` column, and each stored document is written out and cleared from the row. */
  private migrateArtifactsToFiles() {
    const cols = this.db.prepare("PRAGMA table_info(stage_artifacts)").all() as { name: string }[];
    if (!cols.some((c) => c.name === "file")) this.db.exec("ALTER TABLE stage_artifacts ADD COLUMN file TEXT");
    const legacy = this.db.prepare("SELECT id, task_id, stage, version, content FROM stage_artifacts WHERE file IS NULL").all() as any[];
    for (const r of legacy) {
      const rel = artifactRel(r.task_id, r.stage, r.version);
      mkdirSync(dirname(artifactAbs(rel)), { recursive: true });
      writeFileSync(artifactAbs(rel), r.content); // file first: a crash here leaves the row intact and the next start retries
      this.db.prepare("UPDATE stage_artifacts SET file=?, content='' WHERE id=?").run(rel, r.id);
    }
  }

  policy(): Policy {
    return loadPolicy();
  }

  static isHeavy(f: Flags) {
    return f.breaking || !f.reversible || f.requirement_clarity === "low";
  }
  static isRisky(f: Flags) {
    return f.breaking || !f.reversible;
  }
  static branchFor(t: { task_id: string; project_root: string; linked_refs?: any }) {
    return branchName(t);
  }

  private row(task_id: string): any {
    const r = this.db.prepare("SELECT * FROM tasks WHERE task_id=?").get(task_id);
    if (!r) throw new WorkflowError(`unknown task_id '${task_id}'`);
    return r;
  }
  private shape(r: any) {
    const t = {
      task_id: r.task_id as string,
      project_root: r.project_root as string,
      parent_task_id: r.parent_task_id as string | null,
      title: r.title as string,
      description: r.description as string | null,
      source: r.source as string,
      stage: r.stage as string,
      stage_entered_at: r.stage_entered_at as string,
      flags: p(r.flags_json) as Flags,
      linked_refs: (p(r.linked_refs_json) ?? {}) as Record<string, any>,
      related_repos: (p(r.related_repos_json) ?? []) as string[],
      coordinated_release: !!r.coordinated_release,
      needs_attention: !!r.needs_attention,
      retry_count: r.retry_count as number,
      dispatch_id: r.dispatch_id as string | null,
      dispatch_status: r.dispatch_status as string | null,
      target_files: (p(r.target_files_json) ?? []) as string[],
      base_branch: (r.base_branch ?? null) as string | null,
      created_at: r.created_at as string,
      updated_at: r.updated_at as string,
    };
    // a bad branch_pattern in config.json must not make every task unreadable: report it on the task instead
    let branch: string | null = null, branch_error: string | undefined;
    try { branch = Workflow.branchFor(t); } catch (e: any) { branch_error = e.message; }
    return { ...t, branch, ...(branch_error ? { branch_error } : {}) };
  }

  createTask(a: {
    project_root: string;
    title: string;
    description?: string;
    source: "jira" | "adhoc";
    flags: Flags;
    linked_refs?: object;
    parent_task_id?: string;
    related_repos?: string[];
    coordinated_release?: boolean;
    /** the branch this story's work branches from and is reviewed against; default: what the repo has checked out right now */
    base_branch?: string;
  }) {
    const pol = this.policy();
    if (a.parent_task_id) {
      this.row(a.parent_task_id);
      // a parent that has a breakdown document must have it approved first, so a split is never created behind the human's back.
      // Parents without one (e.g. a workspace plan split per repo) are unaffected.
      const hasBreakdown = this.db.prepare("SELECT 1 FROM stage_artifacts WHERE task_id=? AND stage='breakdown'").get(a.parent_task_id);
      if (hasBreakdown && !this.isApproved(a.parent_task_id, "breakdown"))
        throw new WorkflowError(`the breakdown of ${a.parent_task_id} has not been approved: show the parts to the human and call approve_stage(task_id, "breakdown", <name>) when they agree (a revised breakdown needs approving again)`);
    }
    const heavy = Workflow.isHeavy(a.flags);
    const stage = heavy ? pol.heavy_start_stage : pol.light_start_stage;
    const id = `task_${randomUUID().slice(0, 8)}`;
    const t = now();
    this.db
      .prepare(
        `INSERT INTO tasks (task_id,project_root,parent_task_id,title,description,source,stage,stage_entered_at,
      flags_json,linked_refs_json,related_repos_json,coordinated_release,base_branch,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        id, normRoot(a.project_root), a.parent_task_id ?? null, a.title, a.description ?? null, a.source, stage, t,
        j(a.flags), j(a.linked_refs ?? {}), j(a.related_repos ?? []), a.coordinated_release ? 1 : 0, a.base_branch?.trim() || this.currentBase(a.project_root), t, t
      );
    this.db
      .prepare("INSERT INTO transitions (task_id,from_stage,to_stage,reason,policy_version,created_at) VALUES (?,?,?,?,?,?)")
      .run(id, null, stage, `triage: ${heavy ? "heavy" : "light"} pipeline`, policyVersion(pol), t);
    return this.getTask(id);
  }

  /**
   * The branch a new story should start from when nobody said: what the repo has checked out now. If that is the branch of another
   * unfinished task of the repo (the human left the checkout on a story branch), use that task's own base instead, so a story is
   * never based on another story by accident. Null when there is no branch (detached HEAD, not a git repo).
   */
  private currentBase(project_root: string): string | null {
    let current: string;
    try { current = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: project_root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); }
    catch { return null; }
    if (!current || current === "HEAD") return null;
    const other = this.listPending(project_root).find((t) => t.branch === current);
    return other ? other.base_branch : current;
  }

  /** Change where a story's work branches from. Only affects a branch that does not exist yet. */
  setBase(task_id: string, base_branch: string) {
    this.row(task_id);
    const b = base_branch.trim();
    if (!b || /[\s~^:?*[\]\\]|\.\.|^-/.test(b)) throw new WorkflowError(`'${base_branch}' is not a valid branch name`);
    this.db.prepare("UPDATE tasks SET base_branch=?, updated_at=? WHERE task_id=?").run(b, now(), task_id);
    return this.getTask(task_id);
  }

  getTask(task_id: string) {
    const t = this.shape(this.row(task_id));
    const children = this.listChildren(task_id);
    const last = this.db.prepare("SELECT * FROM edge_cases WHERE task_id=? ORDER BY id DESC LIMIT 1").get(task_id);
    const history = this.db
      .prepare("SELECT from_stage,to_stage,reason,policy_version,created_at FROM transitions WHERE task_id=? ORDER BY id")
      .all(task_id);
    const artifacts = (this.db
      .prepare("SELECT stage, MAX(version) AS latest_version FROM stage_artifacts WHERE task_id=? GROUP BY stage")
      .all(task_id) as { stage: string; latest_version: number }[])
      .map((a) => ({ ...a, path: artifactAbs(artifactRel(task_id, a.stage, a.latest_version)) }));
    const changes = this.listChanges(task_id);
    return { ...t, children, last_edge_case: last ?? null, history, artifacts, changes: changes.length ? changes : undefined,
      changes_note: changes.length ? "These change requests were made after the documents were written and supersede them where they conflict. Pass them to coding and review sessions." : undefined };
  }

  /** resume lookup: accepts a task_id, a jira key, or a PR number */
  findTask(ref: string) {
    const byId = this.db.prepare("SELECT task_id FROM tasks WHERE task_id=?").get(ref) as any;
    if (byId) return this.getTask(byId.task_id);
    const rows = this.db
      .prepare(
        `SELECT task_id FROM tasks WHERE json_extract(linked_refs_json,'$.jira_key')=? OR CAST(json_extract(linked_refs_json,'$.pr_number') AS TEXT)=? ORDER BY created_at DESC`
      )
      .all(ref, ref) as any[];
    if (!rows.length) throw new WorkflowError(`no task matches '${ref}'`);
    return this.getTask(rows[0].task_id);
  }

  listPending(project_root: string) {
    const term = this.policy().terminal_stages;
    const rows = this.db.prepare("SELECT * FROM tasks WHERE project_root=? ORDER BY created_at").all(normRoot(project_root)) as any[];
    return rows.filter((r) => !term.includes(r.stage)).map((r) => this.shape(r));
  }
  listChildren(task_id: string) {
    return (this.db.prepare("SELECT * FROM tasks WHERE parent_task_id=? ORDER BY created_at").all(task_id) as any[]).map((r) => {
      const s = this.shape(r);
      return { task_id: s.task_id, title: s.title, stage: s.stage, needs_attention: s.needs_attention, project_root: s.project_root };
    });
  }

  private requiredGate(t: ReturnType<Workflow["shape"]>, stage: string, pol: Policy) {
    const g = pol.requires_human_approval.find((x) => x.stage === stage);
    if (!g) return null;
    if (g.when === "risky" && !Workflow.isRisky(t.flags)) return null;
    return g;
  }
  private isApproved(task_id: string, stage: string) {
    const a = this.db
      .prepare("SELECT created_at FROM approvals WHERE task_id=? AND stage=? ORDER BY id DESC LIMIT 1")
      .get(task_id, stage) as any;
    if (!a) return false;
    const art = this.db.prepare("SELECT MAX(created_at) AS c FROM stage_artifacts WHERE task_id=? AND stage=?").get(task_id, stage) as any;
    return !art?.c || a.created_at >= art.c; // a revised artifact invalidates an older approval
  }

  /** Every transition the policy lists from the current stage, with the reason for any that are blocked right now. */
  validTransitions(task_id: string) {
    const t = this.shape(this.row(task_id));
    const pol = this.policy();
    return (pol.transitions[t.stage] ?? []).map((to) => {
      const blocked = this.blockReason(t, to, pol);
      return blocked ? { stage: to, allowed: false, blocked_by: blocked } : { stage: to, allowed: true };
    });
  }

  private blockReason(t: ReturnType<Workflow["shape"]>, to: string, pol: Policy): string | null {
    if (!(pol.transitions[t.stage] ?? []).includes(to)) return `policy does not allow ${t.stage} -> ${to}`;
    const idx = (s: string) => pol.stages.indexOf(s);
    const forward = idx(to) > idx(t.stage);
    if (forward && to !== "cancelled" && this.requiredGate(t, t.stage, pol) && !this.isApproved(t.task_id, t.stage))
      return `stage '${t.stage}' requires human approval (approve_stage) before leaving it`;
    if (to === "implementation" && Workflow.isHeavy(t.flags)) {
      for (const s of pol.heavy_pipeline) {
        const has = this.db.prepare("SELECT 1 FROM stage_artifacts WHERE task_id=? AND stage=?").get(t.task_id, s);
        if (!has) return `heavy task: '${s}' artifact missing (heavy pipeline: ${pol.heavy_pipeline.join(" -> ")})`;
      }
    }
    if (t.stage === "test" && to === "implementation" && t.retry_count >= pol.max_test_retries)
      return `max_test_retries (${pol.max_test_retries}) reached; transition to 'review' with needs_attention=true instead`;
    if (t.dispatch_status === "in-flight" && to !== "cancelled") return `dispatch ${t.dispatch_id} is still in-flight`;
    if (t.stage === "review" && to === "done" && t.parent_task_id) {
      const parent = this.shape(this.row(t.parent_task_id));
      if (parent.coordinated_release) {
        const waiting = this.listChildren(parent.task_id).filter(
          (c) => c.task_id !== t.task_id && c.stage !== "review" && c.stage !== "done"
        );
        if (waiting.length) return `coordinated release: waiting on sibling(s) ${waiting.map((c) => c.task_id).join(", ")} to reach review`;
      }
    }
    return null;
  }

  transition(task_id: string, next: string, reason: string, needs_attention = false) {
    const t = this.shape(this.row(task_id));
    const pol = this.policy();
    const blocked = this.blockReason(t, next, pol);
    if (blocked) throw new WorkflowError(blocked);
    const ts = now();
    const retry = t.stage === "test" && next === "implementation" ? t.retry_count + 1 : t.retry_count;
    this.db
      .prepare("UPDATE tasks SET stage=?, stage_entered_at=?, retry_count=?, needs_attention=?, updated_at=? WHERE task_id=?")
      .run(next, ts, retry, needs_attention || t.needs_attention ? 1 : 0, ts, task_id);
    this.db
      .prepare("INSERT INTO transitions (task_id,from_stage,to_stage,reason,policy_version,created_at) VALUES (?,?,?,?,?,?)")
      .run(task_id, t.stage, next, reason, policyVersion(pol), ts);
    return this.getTask(task_id);
  }

  /**
   * Implementation (or its tests) proved an earlier document wrong. Sends the task back to `return_to`, writes the issue into that
   * document's Open Questions as a new version (which also voids any plan approval), and logs an edge case. Not a retry: it does
   * not use max_test_retries. Capped by max_spec_wrong_returns so a task cannot bounce between stages forever.
   */
  reportSpecWrong(task_id: string, issue: string, return_to: string, evidence?: string) {
    const t = this.shape(this.row(task_id));
    const pol = this.policy();
    if (!issue.trim()) throw new WorkflowError("issue is empty: say what is wrong and where");
    if (t.stage !== "implementation" && t.stage !== "test") throw new WorkflowError(`report_spec_wrong applies while implementing or testing; task is in '${t.stage}'`);
    if (!pol.spec_wrong_return_to.includes(return_to)) throw new WorkflowError(`policy does not allow returning to '${return_to}' (allowed: ${pol.spec_wrong_return_to.join(", ")})`);
    if (t.dispatch_status === "in-flight") throw new WorkflowError(`dispatch ${t.dispatch_id} is still in-flight`);
    const prior = (this.db.prepare("SELECT COUNT(*) AS n FROM transitions WHERE task_id=? AND reason LIKE 'spec_wrong:%'").get(task_id) as any).n as number;
    if (prior >= pol.max_spec_wrong_returns)
      throw new WorkflowError(`this task was already sent back ${prior} time(s) (max_spec_wrong_returns=${pol.max_spec_wrong_returns}); stop and ask the human how to proceed (mark needs_attention, revise the spec by hand, or cancel)`);

    const detail = evidence?.trim() ? `${issue.trim()} Evidence: ${evidence.trim()}` : issue.trim();
    this.recordEdgeCase(task_id, `Spec proven wrong during ${t.stage}: ${issue.trim()}`, `Sent back to '${return_to}'`, `A ${t.stage} session reported that the ${return_to} cannot be implemented as written. ${evidence?.trim() ?? ""}`.trim());

    let question: { id: string; version: number; path: string } | null = null;
    const has = this.db.prepare("SELECT 1 FROM stage_artifacts WHERE task_id=? AND stage=?").get(task_id, return_to);
    if (has) {
      const a = this.getArtifact(task_id, return_to);
      const r = addOpenQuestion(a.content, `[Raised during ${t.stage}] ${detail}`, `The ${t.stage} session found this ${return_to} cannot be implemented as written; it needs a decision or a revised ${return_to}.`);
      const rec = this.recordArtifact(task_id, return_to, r.markdown, [{ stage: return_to, version: a.version }], undefined, "spec-wrong-handoff");
      question = { id: r.id, version: rec.version, path: rec.path };
    }

    const ts = now();
    this.db.prepare("UPDATE tasks SET stage=?, stage_entered_at=?, updated_at=? WHERE task_id=?").run(return_to, ts, ts, task_id);
    this.db.prepare("INSERT INTO transitions (task_id,from_stage,to_stage,reason,policy_version,created_at) VALUES (?,?,?,?,?,?)")
      .run(task_id, t.stage, return_to, `spec_wrong: ${issue.trim().slice(0, 300)}`, policyVersion(pol), ts);

    const display = [
      `Task ${task_id} sent back to ${return_to}: the ${t.stage} work found the ${return_to} cannot be implemented as written.`,
      "", `Issue: ${detail}`,
      question ? `Recorded as ${question.id} in ${return_to} v${question.version} (${question.path}).` : `There is no ${return_to} document yet, so pass the issue to the ${return_to} stage as input.`,
      "", "Options:",
      `1. answer ${question?.id ?? "the question"}   tell me the decision, I record it; or revise the ${return_to} if the answer changes the approach`,
      `2. show full text   print the ${return_to} document`,
      `3. check the code so far   the branch keeps the partial work; tell me whether to keep or discard it`,
      `4. cancel task   stop here, keeping history`,
    ].join(String.fromCharCode(10));
    return { task: this.getTask(task_id), returned_to: return_to, question_id: question?.id ?? null, display };
  }

  recordArtifact(task_id: string, stage: string, content: string, input_refs?: object[], skill_version?: string, platform?: string) {
    const t = this.shape(this.row(task_id));
    // 'breakdown' is a document on the parent, not a stage a task moves through
    if (stage !== "breakdown" && !this.policy().stages.includes(stage)) throw new WorkflowError(`unknown stage '${stage}'`);
    const v =
      ((this.db.prepare("SELECT MAX(version) AS v FROM stage_artifacts WHERE task_id=? AND stage=?").get(task_id, stage) as any).v ?? 0) + 1;
    const rel = artifactRel(task_id, stage, v);
    mkdirSync(dirname(artifactAbs(rel)), { recursive: true });
    writeFileSync(artifactAbs(rel), content);
    this.db
      .prepare(
        "INSERT INTO stage_artifacts (task_id,stage,version,content,file,input_refs_json,skill_version,platform,created_at) VALUES (?,?,?,'',?,?,?,?,?)" // content stays '': databases created before artifacts were files still declare it NOT NULL
      )
      .run(task_id, stage, v, rel, j(input_refs), skill_version ?? null, platform ?? null, now());
    this.db.prepare("INSERT INTO search_fts (kind,task_id,project_root,stage,text) VALUES ('artifact',?,?,?,?)").run(task_id, t.project_root, stage, content);
    return { task_id, stage, version: v, path: artifactAbs(rel) };
  }
  getArtifact(task_id: string, stage: string, version?: number) {
    const r = version
      ? this.db.prepare("SELECT * FROM stage_artifacts WHERE task_id=? AND stage=? AND version=?").get(task_id, stage, version)
      : this.db.prepare("SELECT * FROM stage_artifacts WHERE task_id=? AND stage=? ORDER BY version DESC LIMIT 1").get(task_id, stage);
    if (!r) throw new WorkflowError(`no '${stage}' artifact for ${task_id}`);
    const { input_refs_json, file, content: _legacy, ...a } = r as any;
    // read from disk so edits you make while reviewing are what the next stage sees
    return { ...a, content: readFileSync(artifactAbs(file), "utf8"), path: artifactAbs(file), input_refs: p(input_refs_json) };
  }

  /** Open Questions of a stage document (default: the task's current stage), parsed, plus a chat-ready `display` block with how-to-answer and Options. No model call. */
  openQuestions(task_id: string, stage?: string) {
    const s = stage ?? this.shape(this.row(task_id)).stage;
    const a = this.getArtifact(task_id, s);
    const questions = parseOpenQuestions(a.content);
    return { task_id, stage: s, version: a.version, path: a.path, count: questions.length, questions, display: this.guidance(task_id, s, a.version, a.path, questions) };
  }

  /** Record the user's answers as a new document version: answered questions move to a Decisions section. No model call. */
  answerQuestions(task_id: string, stage: string, answers: Answer[], accept_suggested: string[] = []) {
    const a = this.getArtifact(task_id, stage);
    const r = applyAnswers(a.content, answers, accept_suggested);
    const rec = this.recordArtifact(task_id, stage, r.markdown, [{ stage, version: a.version }], undefined, "mcp-answers");
    const recorded = `Recorded ${r.decided.map((d) => d.id).join(", ")} as decisions in ${stage} v${rec.version}.`;
    return { ...rec, decided: r.decided, remaining_count: r.remaining.length, remaining: r.remaining, display: this.guidance(task_id, stage, rec.version, rec.path, r.remaining, recorded) };
  }

  private guidance(task_id: string, stage: string, version: number, path: string, qs: OpenQuestion[], recorded?: string) {
    const stages = this.policy().stages;
    return renderGuidance({ task_id, stage, version, path, qs, nextStage: stages[stages.indexOf(stage) + 1], recorded });
  }

  /**
   * The change log: small change requests made after the documents were approved (a rename, an extra edge case, a tweak).
   * Later sessions follow the log on top of the documents, so the documents need not be regenerated for each one.
   */
  recordChange(task_id: string, request: string, affects?: string) {
    const t = this.shape(this.row(task_id));
    if (!request.trim()) throw new WorkflowError("request must not be empty");
    const r = this.db.prepare("INSERT INTO change_requests (task_id,stage,request,affects,created_at) VALUES (?,?,?,?,?)").run(task_id, t.stage, request.trim(), affects?.trim() || null, now());
    this.db.prepare("INSERT INTO search_fts (kind,task_id,project_root,stage,text) VALUES ('change',?,?,?,?)").run(task_id, t.project_root, t.stage, `${request}\n${affects ?? ""}`);
    return { ok: true, id: Number(r.lastInsertRowid), changes: this.listChanges(task_id) };
  }

  /** Active change requests, oldest first. Folded ones (already merged into a document version) are left out unless all is set. */
  listChanges(task_id: string, all = false) {
    return this.db.prepare(`SELECT id, stage, request, affects, status, folded_into, created_at FROM change_requests WHERE task_id=? ${all ? "" : "AND status='active'"} ORDER BY id`).all(task_id) as any[];
  }

  /** Mark change requests as merged into a new document version, so they stop being listed as pending. */
  foldChanges(task_id: string, folded_into: string, ids?: number[]) {
    this.row(task_id);
    const active = this.listChanges(task_id).filter((c) => !ids || ids.includes(c.id));
    for (const c of active) this.db.prepare("UPDATE change_requests SET status='folded', folded_into=? WHERE id=?").run(folded_into, c.id);
    return { ok: true, folded: active.map((c) => c.id) };
  }

  recordEdgeCase(task_id: string, description: string, decision: string, reasoning: string) {
    const t = this.shape(this.row(task_id));
    this.db
      .prepare("INSERT INTO edge_cases (task_id,description,decision,reasoning,created_at) VALUES (?,?,?,?,?)")
      .run(task_id, description, decision, reasoning, now());
    this.db
      .prepare("INSERT INTO search_fts (kind,task_id,project_root,stage,text) VALUES ('edge_case',?,?,?,?)")
      .run(task_id, t.project_root, t.stage, `${description}\n${decision}\n${reasoning}`);
    return { ok: true };
  }

  updateLinkedRefs(task_id: string, patch: Record<string, unknown>) {
    const t = this.shape(this.row(task_id));
    this.db.prepare("UPDATE tasks SET linked_refs_json=?, updated_at=? WHERE task_id=?").run(j({ ...t.linked_refs, ...patch }), now(), task_id);
    return this.getTask(task_id);
  }

  approve(task_id: string, stage: string, approved_by: string) {
    this.row(task_id);
    this.db.prepare("INSERT INTO approvals (task_id,stage,approved_by,created_at) VALUES (?,?,?,?)").run(task_id, stage, approved_by, now());
    return { ok: true, task_id, stage, approved_by };
  }

  /** Called on every poll tick: auto-approves elapsed gates and reports gates still waiting. */
  checkGates() {
    const pol = this.policy();
    const events: object[] = [];
    const rows = this.db.prepare("SELECT * FROM tasks").all() as any[];
    for (const r of rows) {
      if (pol.terminal_stages.includes(r.stage)) continue;
      const t = this.shape(r);
      const g = this.requiredGate(t, t.stage, pol);
      if (!g || this.isApproved(t.task_id, t.stage)) continue;
      const hasArtifact = this.db.prepare("SELECT 1 FROM stage_artifacts WHERE task_id=? AND stage=?").get(t.task_id, t.stage);
      if (!hasArtifact) continue; // nothing to approve yet
      const hours = (Date.now() - Date.parse(t.stage_entered_at)) / 3.6e6;
      if (g.auto_approve_after_hours != null && hours >= g.auto_approve_after_hours) {
        this.approve(t.task_id, t.stage, "auto-timeout");
        events.push({ event: "auto_approved", task_id: t.task_id, stage: t.stage, title: t.title, waited_hours: +hours.toFixed(1) });
      } else {
        events.push({
          event: "awaiting_approval", task_id: t.task_id, stage: t.stage, title: t.title,
          waiting_hours: +hours.toFixed(1), auto_approve_after_hours: g.auto_approve_after_hours ?? null,
        });
      }
    }
    return events;
  }

  setDispatch(task_id: string, dispatch_id: string | null, status: "in-flight" | "completed" | "failed" | null, target_files?: string[]) {
    const t = this.shape(this.row(task_id));
    if (status === "in-flight" && t.dispatch_status === "in-flight")
      throw new WorkflowError(`task already has in-flight dispatch ${t.dispatch_id}; check it before dispatching again`);
    this.db
      .prepare("UPDATE tasks SET dispatch_id=?, dispatch_status=?, target_files_json=COALESCE(?,target_files_json), updated_at=? WHERE task_id=?")
      .run(dispatch_id, status, target_files ? j(target_files) : null, now(), task_id);
    return this.getTask(task_id);
  }

  /** Other pending tasks on the same repo whose recorded files overlap `files`. */
  fileOverlaps(task_id: string, files: string[]) {
    const t = this.shape(this.row(task_id));
    return this.listPending(t.project_root)
      .filter((o) => o.task_id !== task_id)
      .map((o) => ({ task_id: o.task_id, title: o.title, base_branch: o.base_branch, same_base: o.base_branch === t.base_branch, files: o.target_files.filter((f) => files.includes(f)) }))
      .filter((o) => o.files.length);
  }

  searchPrecedent(query: string, project_root?: string, limit = 10) {
    const q = query
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .split(/\s+/)
      .filter(Boolean)
      .map((w) => `"${w}"`)
      .join(" OR ");
    if (!q) return [];
    const root = project_root ? normRoot(project_root) : null;
    const sql = `SELECT kind, task_id, stage, snippet(search_fts, 4, '[', ']', '...', 24) AS snippet FROM search_fts
      WHERE search_fts MATCH ? ${project_root ? "AND project_root = ?" : ""} ORDER BY rank LIMIT ?`;
    const rows = this.db.prepare(sql).all(...(root ? [q, root, limit] : [q, limit]));
    // logged so zero-hit queries can be reviewed: the observable signal for ever needing semantic search (see docs/architecture.md, Decisions)
    this.db.prepare("INSERT INTO search_log (query,project_root,hits,created_at) VALUES (?,?,?,?)").run(query, root, rows.length, now());
    return rows;
  }

  /**
   * Is it time to offer edge-case-review? Counts problems since the last review of this repo: logged edge cases (spec-wrong
   * returns log one too) plus tasks that used up their test retries. Only a prompt: nothing runs and nothing changes.
   */
  reviewSignal(project_root: string) {
    const root = normRoot(project_root);
    const pol = this.policy();
    const last = (this.db.prepare("SELECT MAX(created_at) AS t FROM review_marks WHERE project_root=?").get(root) as any).t as string | null;
    const since = last ?? "";
    const edge = (this.db
      .prepare("SELECT COUNT(*) AS n FROM edge_cases e JOIN tasks t ON t.task_id=e.task_id WHERE t.project_root=? AND e.created_at>?")
      .get(root, since) as any).n as number;
    const exhausted = pol.max_test_retries > 0
      ? ((this.db
          .prepare("SELECT COUNT(*) AS n FROM tasks WHERE project_root=? AND retry_count>=? AND updated_at>?")
          .get(root, pol.max_test_retries, since) as any).n as number)
      : 0;
    const problems = edge + exhausted;
    const threshold = pol.edge_case_review_after;
    const due = threshold > 0 && problems >= threshold;
    return {
      due, problems, edge_cases: edge, retries_exhausted: exhausted, threshold, last_reviewed_at: last,
      message: due
        ? `${problems} problems logged since ${last ? `the last review (${last})` : "the start"} (${edge} edge cases, ${exhausted} tasks out of test retries). Offer edge-case-review to the human as an option; never run it unasked.`
        : threshold === 0 ? "edge-case review prompt is turned off (edge_case_review_after = 0)" : `${problems} of ${threshold} problems since the last review; nothing to offer yet`,
    };
  }

  /** Call when an edge-case-review ends, whatever the human decided, so the same problems do not prompt again. */
  markReviewed(project_root: string) {
    const ts = now();
    this.db.prepare("INSERT INTO review_marks (project_root,created_at) VALUES (?,?)").run(normRoot(project_root), ts);
    return { ok: true, reviewed_at: ts };
  }

  /** Queries that found nothing, newest first. */
  zeroHitSearches(limit = 50) {
    return this.db.prepare("SELECT query, project_root, created_at FROM search_log WHERE hits=0 ORDER BY id DESC LIMIT ?").all(limit);
  }

  /**
   * Permanently remove a task and everything recorded for it (transitions, artifacts, edge cases,
   * approvals, search index). Unlike a 'cancelled' transition, no history is kept. Children are
   * only removed when include_children is set; a task with an in-flight dispatch is refused.
   */
  deleteTask(task_id: string, include_children = false) {
    const t = this.shape(this.row(task_id));
    const kids = this.listChildren(task_id);
    if (kids.length && !include_children)
      throw new WorkflowError(`task has ${kids.length} child task(s) (${kids.map((k) => k.task_id).join(", ")}); remove them too with include_children=true, or remove them first`);
    const ids = [task_id, ...kids.map((k) => k.task_id)];
    for (const id of ids) {
      const r = this.shape(this.row(id));
      if (r.dispatch_status === "in-flight") throw new WorkflowError(`task ${id} has an in-flight dispatch (${r.dispatch_id}); wait for it or cancel the task first`);
    }
    this.db.exec("BEGIN");
    try {
      for (const id of [...ids].reverse()) {
        for (const table of ["transitions", "stage_artifacts", "edge_cases", "change_requests", "approvals", "search_fts"])
          this.db.prepare(`DELETE FROM ${table} WHERE task_id=?`).run(id);
        this.db.prepare("DELETE FROM tasks WHERE task_id=?").run(id);
      }
      this.db.exec("COMMIT");
    } catch (e) { this.db.exec("ROLLBACK"); throw e; }
    for (const id of ids) rmSync(artifactAbs(`${ARTIFACTS_DIR}/${id}`), { recursive: true, force: true });
    return { removed: ids, title: t.title, note: (t.branch ? `git branch ${t.branch} (if any)` : "its git branch (if any)") + " was NOT deleted" };
  }

  /** One copy per day, newest 14 kept. Cheap to call on every server start. */
  backup(retain = 14) {
    const dir = join(dataDir(), "backups");
    mkdirSync(dir, { recursive: true });
    const day = new Date().toISOString().slice(0, 10);
    const target = join(dir, `workflow-${day}.db`);
    if (existsSync(target)) return target;
    this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    copyFileSync(this.file, target);
    // learnings/ and artifacts/ are hand-editable files: back them up alongside the database
    for (const name of ["learnings", ARTIFACTS_DIR]) {
      const src = join(name === "learnings" ? teamDir() : dataDir(), name);
      if (existsSync(src)) cpSync(src, join(dir, `${name}-${day}`), { recursive: true });
    }
    for (const prefix of ["workflow-", "learnings-", `${ARTIFACTS_DIR}-`]) {
      const files = readdirSync(dir).filter((f) => f.startsWith(prefix)).sort();
      for (const f of files.slice(0, Math.max(0, files.length - retain))) {
        try { rmSync(join(dir, f), { recursive: true, force: true }); } catch { /* best effort */ }
      }
    }
    return target;
  }
}
