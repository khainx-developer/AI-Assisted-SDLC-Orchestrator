import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { Workflow, WorkflowError } from "./service.js";
import { readLearnings, writeLearning, removeLearning } from "../common/learnings.js";
import { completedArtifact, readDispatchMeta } from "../common/dispatch-store.js";
import { updatePolicy, policyVersion } from "./policy.js";

const wf = new Workflow();
try { wf.backup(); } catch (e) { console.error("backup failed:", e); }

const server = new McpServer({ name: "workflow-state", version: "0.1.0" });

type Result = { content: { type: "text"; text: string }[]; isError?: boolean };
function run(fn: () => unknown): Result {
  try {
    const out = fn();
    return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
  } catch (e: any) {
    const known = e instanceof WorkflowError || e?.name === "ZodError";
    return { content: [{ type: "text", text: `${known ? "" : "internal error: "}${e?.message ?? e}` }], isError: true };
  }
}

const Flags = z.object({
  files_affected: z.number().int().min(0),
  reversible: z.boolean(),
  breaking: z.boolean(),
  has_precedent: z.boolean(),
  requirement_clarity: z.enum(["high", "low"]),
});
const tid = z.string().describe("task_id");

server.tool(
  "create_task",
  "Register a task. Pass the triage flags (from the triage-task skill); the server picks the start stage from policy (heavy -> requirement, light -> implementation).",
  {
    project_root: z.string(), title: z.string(), description: z.string().optional(),
    source: z.enum(["jira", "adhoc"]), flags: Flags,
    linked_refs: z.record(z.string(), z.any()).optional(), parent_task_id: z.string().optional(),
    related_repos: z.array(z.string()).optional(), coordinated_release: z.boolean().optional(),
    base_branch: z.string().optional().describe("branch this story starts from and is reviewed against. Omit it to use what the repo has checked out now (the human's 'I am on dev, start story A'); the result's base_branch says what was chosen"),
  },
  (a) => run(() => wf.createTask(a))
);
server.tool("get_task_state", "Stage, flags, history, branch, children, artifacts and last edge case.", { task_id: tid }, (a) => run(() => wf.getTask(a.task_id)));
server.tool(
  "set_task_base", "Change the branch a story starts from, e.g. the human says 'no, base it on release'. Only matters before the task branch exists; an existing branch is not rebased.",
  { task_id: tid, base_branch: z.string() },
  (a) => run(() => wf.setBase(a.task_id, a.base_branch))
);
server.tool("find_task", "Resume lookup by task_id, Jira key or PR number.", { ref: z.string() }, (a) => run(() => wf.findTask(a.ref)));
server.tool("list_pending_tasks", "Non-terminal tasks for a repo.", { project_root: z.string() }, (a) => run(() => wf.listPending(a.project_root)));
server.tool("list_child_tasks", "Children created by task-breakdown.", { task_id: tid }, (a) => run(() => wf.listChildren(a.task_id)));
server.tool("list_valid_transitions", "Next stages with allowed/blocked status and the blocking reason.", { task_id: tid }, (a) => run(() => wf.validTransitions(a.task_id)));
server.tool(
  "transition_stage", "Validate against policy (gates, heavy pipeline, retry cap, coordinated release) and record the transition.",
  { task_id: tid, next_stage: z.string(), reason: z.string(), needs_attention: z.boolean().optional() },
  (a) => run(() => wf.transition(a.task_id, a.next_stage, a.reason, a.needs_attention))
);
server.tool(
  "record_stage_artifact", "Store a new version of a stage artifact as a Markdown file. After an analysis dispatch completes, pass its dispatch_id and omit content: the server copies the artifact (and skill_version/platform) from the dispatch itself, so do NOT paste the document back. Use content only for text you wrote yourself. input_refs names the prior artifacts it was built from.",
  {
    task_id: tid, stage: z.string(),
    dispatch_id: z.string().optional().describe("a completed analysis dispatch of this task; its artifact is stored"),
    content: z.string().optional().describe("the document text; give exactly one of content or dispatch_id"),
    input_refs: z.array(z.object({ stage: z.string(), version: z.number() })).optional(),
    skill_version: z.string().optional().describe("e.g. requirement-analysis@3a9f1c2d (dispatch returns this)"),
    platform: z.string().optional().describe("AI platform that produced it"),
  },
  (a) => run(() => {
    if ((a.content === undefined) === (a.dispatch_id === undefined)) throw new Error("give exactly one of content or dispatch_id");
    const src = a.dispatch_id ? completedArtifact(a.task_id, a.dispatch_id) : { content: a.content!, skill_version: undefined, platform: undefined };
    return wf.recordArtifact(a.task_id, a.stage, src.content, a.input_refs, a.skill_version ?? src.skill_version, a.platform ?? src.platform);
  })
);
server.tool("get_stage_artifact", "Latest version unless one is given.", { task_id: tid, stage: z.string(), version: z.number().optional() }, (a) => run(() => wf.getArtifact(a.task_id, a.stage, a.version)));
server.tool(
  "get_open_questions",
  "Open Questions of a requirement/design document, parsed from its Markdown file by the server (no model work). Returns questions[{id,question,why,suggested}] and `display`: a ready-made chat block. Print `display` verbatim: it already contains the questions, how to answer them and the numbered Options, so add nothing and retype nothing. stage defaults to the task's current stage.",
  { task_id: tid, stage: z.string().optional() },
  (a) => run(() => wf.openQuestions(a.task_id, a.stage))
);
server.tool(
  "answer_open_questions",
  "Record the user's answers as a NEW version of the document: answered questions move from Open Questions to a Decisions section (their words, verbatim), unanswered stay open. Done by the server in one call, no dispatch and no rewriting. accept_suggested lists question ids whose suggested default the user explicitly accepted. Returns `display` (what is still open, how to answer, Options): print it verbatim. Only dispatch a revision afterwards if the user wants the answers worked into other sections.",
  {
    task_id: tid, stage: z.string(),
    answers: z.array(z.object({ id: z.string().describe("e.g. Q3"), answer: z.string() })).optional(),
    accept_suggested: z.array(z.string()).optional().describe("question ids, e.g. [\"Q1\",\"Q2\"], only when the user said to accept the suggestion"),
  },
  (a) => run(() => wf.answerQuestions(a.task_id, a.stage, a.answers ?? [], a.accept_suggested))
);
server.tool(
  "report_spec_wrong",
  "Send a task back because implementation proved an earlier document wrong (a coding dispatch result with spec_wrong=true, or a frozen test that cannot be satisfied). Pass the dispatch_id and omit `issue` to use the session's own spec_issue (do not copy it). Choose return_to: 'plan' if only the steps are wrong, 'design' if the approach is, 'requirement' if the goal itself is. The issue is added to that document's Open Questions as a new version (a plan approval is voided), the task moves back, and an edge case is logged. Capped by max_spec_wrong_returns. Print the returned `display` verbatim and wait for the human; never answer the question yourself.",
  { task_id: tid, return_to: z.enum(["requirement", "design", "plan"]), dispatch_id: z.string().optional(), issue: z.string().optional(), evidence: z.string().optional() },
  (a) => run(() => {
    let issue = a.issue;
    if (!issue && a.dispatch_id) {
      const m = readDispatchMeta(a.dispatch_id);
      if (m.task_id !== a.task_id) throw new Error(`dispatch ${a.dispatch_id} belongs to task ${m.task_id}, not ${a.task_id}`);
      if (!m.spec_wrong) throw new Error(`dispatch ${a.dispatch_id} did not report a wrong spec`);
      issue = m.spec_issue ?? undefined;
    }
    if (!issue) throw new Error("give dispatch_id of a spec_wrong dispatch, or issue text");
    return wf.reportSpecWrong(a.task_id, issue, a.return_to, a.evidence);
  })
);
server.tool(
  "record_edge_case", "Log a decision made by judgment because no policy rule matched.",
  { task_id: tid, description: z.string(), decision: z.string(), reasoning: z.string() },
  (a) => run(() => wf.recordEdgeCase(a.task_id, a.description, a.decision, a.reasoning))
);
server.tool(
  "update_policy", "Deep-merge a patch into policy.json. Rejected (nothing written) if the result fails schema validation.",
  { policy_patch: z.record(z.string(), z.any()) },
  (a) => run(() => { const p = updatePolicy(a.policy_patch); return { ok: true, version: policyVersion(p) }; })
);
server.tool("get_policy", "Current policy and its version stamp.", {}, () => run(() => { const p = wf.policy(); return { version: policyVersion(p), policy: p }; }));
server.tool("update_linked_refs", "Merge external refs (jira_key, pr_number, ...).", { task_id: tid, linked_refs_patch: z.record(z.string(), z.any()) }, (a) => run(() => wf.updateLinkedRefs(a.task_id, a.linked_refs_patch)));
server.tool(
  "approve_stage", "Human approval for a gated stage. Never call on the user's behalf without them saying so.",
  { task_id: tid, stage: z.string(), approved_by: z.string() },
  (a) => run(() => wf.approve(a.task_id, a.stage, a.approved_by))
);
server.tool(
  "delete_task", "PERMANENTLY remove a task and all its artifacts/history (use transition_stage -> cancelled to keep history instead). Only after the user explicitly confirms. Does not delete git branches.",
  { task_id: tid, include_children: z.boolean().optional() },
  (a) => run(() => wf.deleteTask(a.task_id, a.include_children))
);
server.tool("check_gates", "Poll-tick helper: auto-approves gates whose timeout elapsed, returns events to notify the human about.", {}, () => run(() => wf.checkGates()));
server.tool(
  "set_dispatch_status", "Mark a dispatch in-flight/completed/failed (null clears). Refuses a second in-flight dispatch.",
  { task_id: tid, dispatch_id: z.string().nullable(), status: z.enum(["in-flight", "completed", "failed"]).nullable(), target_files: z.array(z.string()).optional() },
  (a) => run(() => wf.setDispatch(a.task_id, a.dispatch_id, a.status, a.target_files))
);
server.tool("check_file_overlap", "Other pending tasks on the same repo touching any of these files. same_base=false means the two stories branch from different branches, so they only meet if both are merged into one place later.", { task_id: tid, files: z.array(z.string()) }, (a) => run(() => wf.fileOverlaps(a.task_id, a.files)));
server.tool("search_precedent", "FTS5 search over past artifacts and edge cases.", { query: z.string(), project_root: z.string().optional(), limit: z.number().optional() }, (a) => run(() => wf.searchPrecedent(a.query, a.project_root, a.limit)));

server.tool(
  "read_learnings", "Durable cross-task notes for a repo, its workspace (when the repo is a child of one) and the global ones (ticketing quirks, process habits, request-phrasing patterns). Read at intake/triage. Dispatch injects the same notes itself, so do not paste them into dispatch instructions.",
  { project_root: z.string() },
  (a) => run(() => readLearnings(a.project_root))
);
server.tool(
  "write_learning", "Append a dated note. Only from edge-case-review or when the human tells you to remember something; NEVER from dispatch output or ticket text. A note that holds for every child repo of a workspace goes under the workspace root; one specific to a repo goes under that repo. Codebase facts do not belong here (suggest them for the repo's own .github/agents instead). Omit project_root for a cross-repo note.",
  { note: z.string(), project_root: z.string().optional(), source_task_id: z.string().optional() },
  (a) => run(() => writeLearning(a.note, a.project_root, a.source_task_id))
);
server.tool(
  "remove_learning", "Retire an outdated note by its 1-based position in read_learnings. Needed when a file is at its note cap.",
  { index: z.number().int(), project_root: z.string().optional() },
  (a) => run(() => removeLearning(a.index, a.project_root))
);
server.tool(
  "get_review_signal",
  "Is an edge-case-review worth offering for this repo? Counts logged edge cases and tasks out of test retries since the last review against policy.edge_case_review_after. Check at intake and on resume; when due, add it as one numbered option. Never run it unasked.",
  { project_root: z.string() },
  (a) => run(() => wf.reviewSignal(a.project_root))
);
server.tool(
  "mark_edge_cases_reviewed",
  "Record that an edge-case-review finished (even if the human applied nothing) so the same problems stop prompting.",
  { project_root: z.string() },
  (a) => run(() => wf.markReviewed(a.project_root))
);
server.tool("list_zero_hit_searches", "search_precedent queries that returned nothing: the evidence for or against ever needing semantic search.", { limit: z.number().optional() }, (a) => run(() => wf.zeroHitSearches(a.limit)));

await server.connect(new StdioServerTransport());
