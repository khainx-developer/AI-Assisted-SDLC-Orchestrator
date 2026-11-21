import { existsSync, readdirSync, mkdirSync } from "node:fs";
import { join, basename } from "node:path";
import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { dataDir, normRoot } from "../shared/paths.js";
import { worktreeSettings } from "../config/config.js";
import { ensureBranch, getDispatch, git, resolveBase, changedFiles } from "./runner.js";

/** A write session still running in this repo: another task's (the checkout cannot be shared by two of them), or with sameTask this task's own. */
function otherWriteSession(root: string, taskId: string, sameTask = false): { task_id: string; kind: string; dispatch_id: string } | null {
  const dir = join(dataDir(), "dispatches");
  if (!existsSync(dir)) return null;
  const mine = normRoot(root);
  for (const id of readdirSync(dir)) {
    if (!/^d_[0-9a-f]{8}$/.test(id)) continue;
    try {
      const m = getDispatch(id);
      if (m.status === "in-flight" && (sameTask ? m.task_id === taskId : m.task_id !== taskId) && (m.kind === "coding" || m.kind === "test-authoring") && normRoot(m.project_root) === mine)
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

/** Where a task's worktree lives: one folder per repo and task under the data folder, never inside the repo. */
export function worktreePath(root: string, taskId: string): string {
  const n = normRoot(root);
  const repoKey = `${basename(n).replace(/[^A-Za-z0-9._-]/g, "_")}-${createHash("sha1").update(n.toLowerCase()).digest("hex").slice(0, 8)}`;
  return join(dataDir(), "worktrees", repoKey, taskId.replace(/[^A-Za-z0-9._-]/g, "_"));
}

/**
 * Directory a write session for this task runs in. With worktree off for the repo this is the repo itself (the shared
 * checkout, one story at a time). With it on, the task gets its own worktree on the task branch, created on first use and
 * reused by later sessions and retries, so stories do not block each other. Only one session at a time per task.
 */
export async function prepareWorkDir(root: string, branch: string, taskId: string, base?: string | null): Promise<string> {
  if (!worktreeSettings(root).enabled) { await prepareCheckout(root, branch, taskId, base); return root; }
  const same = otherWriteSession(root, taskId, true);
  if (same) throw new Error(`task ${taskId} already has a ${same.kind} session running (dispatch ${same.dispatch_id}); wait for it to finish.`);
  const dir = worktreePath(root, taskId);
  if (existsSync(join(dir, ".git"))) {
    const current = await git(dir, "rev-parse", "--abbrev-ref", "HEAD");
    if (current !== branch) throw new Error(`worktree ${dir} is on '${current}', not '${branch}'. Remove it with remove_worktree or switch it back by hand.`);
    return dir;
  }
  mkdirSync(join(dir, ".."), { recursive: true });
  let exists = true;
  try { await git(root, "rev-parse", "--verify", `refs/heads/${branch}`); } catch { exists = false; }
  try {
    if (exists) await git(root, "worktree", "add", dir, branch);
    else await git(root, "worktree", "add", "-b", branch, dir, base ? await resolveBase(root, base) : "HEAD");
  } catch (e: any) {
    throw new Error(`could not create the worktree for ${branch}: ${e.stderr?.toString().trim() || e.message}. If the branch is checked out in the main repo, switch that checkout to another branch first.`);
  }
  const setup = worktreeSettings(root).setup;
  if (setup) {
    try { execSync(setup, { cwd: dir, stdio: "pipe", timeout: 10 * 60_000 }); }
    catch (e: any) { throw new Error(`worktree_setup '${setup}' failed in ${dir}: ${(e.stderr?.toString() || e.message).slice(-500)}. The worktree exists; fix the command and remove_worktree to start over.`); }
  }
  return dir;
}

/** The task's worktree if one exists (tests should run there), else undefined. */
export function existingWorktree(root: string, taskId: string): string | undefined {
  const dir = worktreePath(root, taskId);
  return worktreeSettings(root).enabled && existsSync(join(dir, ".git")) ? dir : undefined;
}

/** Remove a task's worktree (the branch and its commits stay). Refuses while a session runs in it or while it holds uncommitted work, unless force. */
export async function removeWorktree(root: string, taskId: string, force = false): Promise<{ removed: boolean; path: string }> {
  const dir = worktreePath(root, taskId);
  if (!existsSync(dir)) return { removed: false, path: dir };
  const running = otherWriteSession(root, taskId, true);
  if (running) throw new Error(`a ${running.kind} session is still running in this worktree (dispatch ${running.dispatch_id})`);
  if (!force) {
    const dirty = await changedFiles(dir);
    if (dirty.length) throw new Error(`worktree ${dir} has uncommitted work (${dirty.slice(0, 5).join(", ")}${dirty.length > 5 ? ", ..." : ""}). Commit it, or pass force=true to discard it.`);
  }
  await git(root, "worktree", "remove", ...(force ? ["--force"] : []), dir);
  return { removed: true, path: dir };
}
