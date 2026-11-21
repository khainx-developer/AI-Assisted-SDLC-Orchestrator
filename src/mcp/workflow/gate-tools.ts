/** Policy and approvals: reading and changing policy.json, approving gated stages, the poll tick that auto-approves elapsed gates. */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { updatePolicy, policyVersion } from "../../workflow/policy.js";
import { wf, run, tid } from "./shared.js";

export function registerGateTools(server: McpServer): void {
  server.tool(
    "update_policy", "Deep-merge a patch into policy.json. Rejected (nothing written) if the result fails schema validation.",
    { policy_patch: z.record(z.string(), z.any()) },
    (a) => run(() => { const p = updatePolicy(a.policy_patch); return { ok: true, version: policyVersion(p) }; })
  );
  server.tool("get_policy", "Current policy and its version stamp.", {}, () => run(() => { const p = wf.policy(); return { version: policyVersion(p), policy: p }; }));
  server.tool(
    "approve_stage", "Human approval for a gated stage. Never call on the user's behalf without them saying so. Exception: for a task enrolled in a live autonomous run, approved_by may be 'autonomous:<run_id>'; the server then checks policy.autonomy (plan_gate / breakdown, the never_autonomous list, open questions) and refuses with the reason, in which case park the task.",
    { task_id: tid, stage: z.string(), approved_by: z.string() },
    (a) => run(() => wf.approve(a.task_id, a.stage, a.approved_by))
  );
  server.tool("check_gates", "Poll-tick helper: auto-approves gates whose timeout elapsed, returns events to notify the human about.", {}, () => run(() => wf.checkGates()));
}
