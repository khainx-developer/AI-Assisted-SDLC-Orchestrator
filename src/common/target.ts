import { existsSync } from "node:fs";
import { join } from "node:path";
import { childRepos } from "./config.js";

/** Every git repository of a project: its child repos (workspace), or the root itself. */
export function projectRepos(root: string): string[] {
  const kids = childRepos(root);
  return kids.length ? kids : [root];
}

/**
 * Coding, branching and tests need a real git repo. A workspace root (non-git, `child_repos` configured) is refused with the
 * way forward: work is done by a task whose project_root is one of the children, which inherits the workspace's settings.
 */
export function requireGitRepo(root: string): void {
  const kids = childRepos(root);
  if (kids.length) throw new Error(`${root} is a workspace, not a git repo. Create a child task whose project_root is one of: ${kids.join(", ")}`);
  if (!existsSync(join(root, ".git"))) throw new Error(`${root} is not a git repository (no .git); if it is a workspace, list its git children in config.json projects."<root>".child_repos`);
}
