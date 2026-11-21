/** Stage documents and what surrounds them: artifacts, open questions, spec-wrong returns, the change log, edge cases. */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { completedArtifact, readDispatchMeta } from "../../stores/dispatch-store.js";
import { wf, run, tid } from "./shared.js";

export function registerDocumentTools(server: McpServer): void {
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
    "record_change", "Log a small change request made after the documents were written (a rename, an extra edge case, a tweak) in the task's change log. The documents are NOT regenerated: coding and review sessions follow the log on top of them. Use this instead of revising the requirement or plan for anything that does not change scope, acceptance criteria or approach. Quote the user's request, and say in `affects` what it touches (a name, files, which document sections).",
    { task_id: tid, request: z.string().describe("the user's request, close to verbatim"), affects: z.string().optional().describe("what it touches: old and new names, files, document sections") },
    (a) => run(() => wf.recordChange(a.task_id, a.request, a.affects))
  );
  server.tool(
    "list_changes", "The task's change log (get_task_state also includes the active ones). all=true includes changes already folded into a document.",
    { task_id: tid, all: z.boolean().optional() },
    (a) => run(() => wf.listChanges(a.task_id, a.all ?? false))
  );
  server.tool(
    "fold_changes", "After a requirement/plan revision that already contains some change requests, mark them as folded so they stop being passed to sessions. folded_into names the document version, e.g. 'plan v3'. Omit ids to fold every active change.",
    { task_id: tid, folded_into: z.string(), ids: z.array(z.number().int()).optional() },
    (a) => run(() => wf.foldChanges(a.task_id, a.folded_into, a.ids))
  );
  server.tool(
    "record_edge_case", "Log a decision made by judgment because no policy rule matched.",
    { task_id: tid, description: z.string(), decision: z.string(), reasoning: z.string() },
    (a) => run(() => wf.recordEdgeCase(a.task_id, a.description, a.decision, a.reasoning))
  );
}
