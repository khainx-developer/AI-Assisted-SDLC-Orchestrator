import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { dataDir, normRoot } from "./paths.js";
import { loadConfig, workspaceOf } from "./config.js";

/** Cap on notes per file. The file is injected into every dispatch, so it must stay small. */
export const MAX_NOTES = 20;
const GLOBAL = "_global";

const dir = () => { const d = join(dataDir(), "learnings"); mkdirSync(d, { recursive: true }); return d; };

/**
 * File slug for a repo: `projects.<root>.slug` from config.json when set, else <folder name>-<6-char hash of
 * the normalised path>. Keyed off the path hash rather than the bare folder name so two repos called "api"
 * never share notes.
 */
export function slugFor(projectRoot: string): string {
  const root = normRoot(projectRoot);
  const cfg = loadConfig().projects ?? {};
  const hit = Object.entries(cfg).find(([k]) => normRoot(k) === root)?.[1]?.slug;
  if (hit) {
    if (!/^[A-Za-z0-9._-]+$/.test(hit) || hit === GLOBAL) throw new Error(`invalid learnings slug '${hit}'`);
    return hit;
  }
  const base = (root.split("/").filter(Boolean).pop() ?? "repo").toLowerCase().replace(/[^a-z0-9._-]+/g, "-") || "repo";
  return `${base}-${createHash("sha1").update(root.toLowerCase()).digest("hex").slice(0, 6)}`;
}

export function learningsFile(projectRoot?: string): string {
  return join(dir(), `${projectRoot ? slugFor(projectRoot) : GLOBAL}.md`);
}

const isNote = (l: string) => /^- \[/.test(l);

function lines(file: string): string[] {
  return existsSync(file) ? readFileSync(file, "utf8").split(/\r?\n/) : [];
}

export function listNotes(projectRoot?: string): string[] {
  return lines(learningsFile(projectRoot)).filter(isNote);
}

/** Notes of the workspace a child repo belongs to ([] for any other repo): they apply to every child task. */
function workspaceNotes(projectRoot?: string): string[] {
  const ws = projectRoot ? workspaceOf(projectRoot) : undefined;
  return ws ? listNotes(ws) : [];
}

/** Notes for a repo, its workspace (if it is a child repo) and the global ones, or null when there are none. This is what dispatch injects. */
export function learningsText(projectRoot: string): string | null {
  const sections: [string, string[]][] = [
    ["Notes for this repository", listNotes(projectRoot)],
    ["Notes for the workspace this repository belongs to", workspaceNotes(projectRoot)],
    ["Notes that apply to every repository", listNotes()],
  ];
  const text = sections.filter(([, notes]) => notes.length).map(([title, notes]) => `${title}:\n${notes.join("\n")}`).join("\n\n");
  return text || null;
}

export function readLearnings(projectRoot?: string) {
  return { file: learningsFile(projectRoot), notes: listNotes(projectRoot), workspace_notes: workspaceNotes(projectRoot), global_notes: projectRoot ? listNotes() : [], max_notes: MAX_NOTES };
}

export function writeLearning(note: string, projectRoot?: string, sourceTaskId?: string) {
  const text = note.replace(/\s+/g, " ").trim();
  if (!text) throw new Error("note is empty");
  const file = learningsFile(projectRoot);
  const notes = listNotes(projectRoot);
  if (notes.length >= MAX_NOTES)
    throw new Error(`learnings file is at its ${MAX_NOTES}-note cap (${file}); retire an outdated note first (remove_learning)`);
  if (notes.some((n) => n.endsWith(`] ${text}`))) return { ok: true, duplicate: true, file };
  const line = `- [${new Date().toISOString().slice(0, 10)}${sourceTaskId ? ` · ${sourceTaskId}` : ""}] ${text}`;
  const head = existsSync(file) ? lines(file).join("\n").replace(/\n*$/, "\n") : `# Learnings (${projectRoot ? normRoot(projectRoot) : "all repositories"})\n\n`;
  writeFileSync(file, `${head}${line}\n`);
  return { ok: true, file, count: notes.length + 1 };
}

/** Remove one note by its 1-based position among the notes (as listed by read_learnings). */
export function removeLearning(index: number, projectRoot?: string) {
  const file = learningsFile(projectRoot);
  const all = lines(file);
  const at = all.map((l, i) => (isNote(l) ? i : -1)).filter((i) => i >= 0);
  if (!Number.isInteger(index) || index < 1 || index > at.length) throw new Error(`no note ${index}; there are ${at.length}`);
  const [removed] = all.splice(at[index - 1], 1);
  writeFileSync(file, all.join("\n"));
  return { ok: true, removed, remaining: at.length - 1 };
}
