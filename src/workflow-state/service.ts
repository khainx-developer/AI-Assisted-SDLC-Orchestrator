import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { join, dirname } from "node:path";
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dataDir, normRoot } from "../common/paths.js";
import { branchName } from "../common/config.js";
import { loadPolicy, policyVersion, type Policy } from "./policy.js";
import { SCHEMA } from "./schema.js";
import { parseOpenQuestions, renderGuidance, applyAnswers, type Answer, type OpenQuestion } from "./questions.js";

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
  }) {
    const pol = this.policy();
    if (a.parent_task_id) this.row(a.parent_task_id);
    const heavy = Workflow.isHeavy(a.flags);
    const stage = heavy ? pol.heavy_start_stage : pol.light_start_stage;
    const id = `task_${randomUUID().slice(0, 8)}`;
    const t = now();
    this.db
      .prepare(
        `INSERT INTO tasks (task_id,project_root,parent_task_id,title,description,source,stage,stage_entered_at,
      flags_json,linked_refs_json,related_repos_json,coordinated_release,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        id, normRoot(a.project_root), a.parent_task_id ?? null, a.title, a.description ?? null, a.source, stage, t,
        j(a.flags), j(a.linked_refs ?? {}), j(a.related_repos ?? []), a.coordinated_release ? 1 : 0, t, t
      );
    this.db
      .prepare("INSERT INTO transitions (task_id,from_stage,to_stage,reason,policy_version,created_at) VALUES (?,?,?,?,?,?)")
      .run(id, null, stage, `triage: ${heavy ? "heavy" : "light"} pipeline`, policyVersion(pol), t);
    return this.getTask(id);
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
    return { ...t, children, last_edge_case: last ?? null, history, artifacts };
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

  recordArtifact(task_id: string, stage: string, content: string, input_refs?: object[], skill_version?: string, platform?: string) {
    const t = this.shape(this.row(task_id));
    if (!this.policy().stages.includes(stage)) throw new WorkflowError(`unknown stage '${stage}'`);
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

  /** Called on every poll tick (design 6.5b): auto-approves elapsed gates and reports gates still waiting. */
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
      .map((o) => ({ task_id: o.task_id, title: o.title, files: o.target_files.filter((f) => files.includes(f)) }))
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
    // logged so zero-hit queries can be reviewed: the observable signal for ever needing semantic search (design 9.6)
    this.db.prepare("INSERT INTO search_log (query,project_root,hits,created_at) VALUES (?,?,?,?)").run(query, root, rows.length, now());
    return rows;
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
        for (const table of ["transitions", "stage_artifacts", "edge_cases", "approvals", "search_fts"])
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
      const src = join(dataDir(), name);
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
