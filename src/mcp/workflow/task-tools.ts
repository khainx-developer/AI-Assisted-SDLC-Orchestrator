/** Task lifecycle tools: create, find, list, move between stages, link external refs, track the running dispatch, delete. */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { wf, run, Flags, tid } from "./shared.js";

export function registerTaskTools(server: McpServer): void {
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
  server.tool("update_linked_refs", "Merge external refs (jira_key, pr_number, ...).", { task_id: tid, linked_refs_patch: z.record(z.string(), z.any()) }, (a) => run(() => wf.updateLinkedRefs(a.task_id, a.linked_refs_patch)));
  server.tool(
    "delete_task", "PERMANENTLY remove a task and all its artifacts/history (use transition_stage -> cancelled to keep history instead). Only after the user explicitly confirms. Does not delete git branches.",
    { task_id: tid, include_children: z.boolean().optional() },
    (a) => run(() => wf.deleteTask(a.task_id, a.include_children))
  );
  server.tool(
    "set_dispatch_status", "Mark a dispatch in-flight/completed/failed (null clears). Refuses a second in-flight dispatch.",
    { task_id: tid, dispatch_id: z.string().nullable(), status: z.enum(["in-flight", "completed", "failed"]).nullable(), target_files: z.array(z.string()).optional() },
    (a) => run(() => wf.setDispatch(a.task_id, a.dispatch_id, a.status, a.target_files))
  );
  server.tool("check_file_overlap", "Other pending tasks on the same repo touching any of these files. same_base=false means the two stories branch from different branches, so they only meet if both are merged into one place later.", { task_id: tid, files: z.array(z.string()) }, (a) => run(() => wf.fileOverlaps(a.task_id, a.files)));
}
