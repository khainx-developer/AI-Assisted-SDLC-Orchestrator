import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { dataDir, normRoot } from "../common/paths.js";
import { ensureBranch, getDispatch } from "./runner.js";

/** Another task's write session that is still running in this repo (the checkout cannot be shared by two of them). */
function otherWriteSession(root: string, taskId: string): { task_id: string; kind: string; dispatch_id: string } | null {
  const dir = join(dataDir(), "dispatches");
  if (!existsSync(dir)) return null;
  const mine = normRoot(root);
  for (const id of readdirSync(dir)) {
    if (!/^d_[0-9a-f]{8}$/.test(id)) continue;
    try {
      const m = getDispatch(id);
      if (m.status === "in-flight" && m.task_id !== taskId && (m.kind === "coding" || m.kind === "test-authoring") && normRoot(m.project_root) === mine)
        return { task_id: m.task_id, kind: m.kind, dispatch_id: id };
    } catch { /* an unreadable record is not a running session */ }
  }
  return null;
}

/**
 * Check the task branch out in the repo for a write session. A branch that does not exist yet starts from `base`
 * (the task's base_branch) when given. Refuses while another task's write session is running in the same repo:
 * both would share one checkout, and switching branches under a running session breaks it.
 */
export async function prepareCheckout(root: string, branch: string, taskId: string, base?: string | null): Promise<void> {
  const other = otherWriteSession(root, taskId);
  if (other) throw new Error(`task ${other.task_id} already has a ${other.kind} session running in this repo (dispatch ${other.dispatch_id}). Two stories cannot code in one checkout at the same time: wait for that session to finish.`);
  await ensureBranch(root, branch, base);
}
