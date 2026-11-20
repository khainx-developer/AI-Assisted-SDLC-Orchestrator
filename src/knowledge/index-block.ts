import { listKnowledgeDocuments, readKnowledgeDocument, knowledgeDirectory } from "./storage.js";
import { parseHeader } from "./freshness.js";

/** Default cap, in characters, on the knowledge index put in a prompt. About 750 tokens. */
export const MAX_KNOWLEDGE_INDEX_CHARS = 3_000;

const norm = (p: string) => p.split("\\").join("/").replace(/^\.\//, "").replace(/\/+$/, "");
/** true when a page's `Applies to` entry covers a task file: the same path, or a folder that contains it (either way round) */
function overlaps(applies: string[], files: string[]): boolean {
  return applies.some((a) => {
    const x = norm(a);
    return !!x && files.some((f) => { const y = norm(f); return y === x || y.startsWith(x + "/") || x.startsWith(y + "/"); });
  });
}

export interface KnowledgeIndex {
  /** the block for the prompt */
  text: string;
  /** the knowledge folder, to be added to the session's read-only roots */
  dir: string;
  listed: number;
  omitted: number;
}

/**
 * A short index of a project's knowledge pages for a worker prompt: one line per page (path, type, summary, what it
 * applies to). The pages themselves are not pasted in; the session opens the ones that fit its task. Pages whose
 * `Applies to` covers the task's files come first. Null when the project has no pages, so a project without
 * knowledge pays nothing.
 */
export function knowledgeIndex(projectRoot: string, taskFiles: string[] = [], max = MAX_KNOWLEDGE_INDEX_CHARS): KnowledgeIndex | null {
  let docs: { root: string; documents: { path: string }[] };
  try { docs = listKnowledgeDocuments(projectRoot); } catch { return null; }
  const pages: { path: string; line: string; rel: boolean }[] = [];
  for (const d of docs.documents) {
    if (d.path.startsWith(".meta/") || d.path.split("/").pop()!.startsWith("_")) continue; // the generated index page is not a source of facts
    let md = ""; try { md = readKnowledgeDocument(projectRoot, d.path).content; } catch { continue; }
    const h = parseHeader(md);
    const summary = (h.summary ?? "").replace(/\s+/g, " ").slice(0, 200);
    const meta = [h.type, h.applies_to.length ? `applies to ${h.applies_to.join(", ")}` : "", h.source_sha ? `checked at ${h.source_sha.slice(0, 7)}` : "no Source commit"].filter(Boolean).join("; ");
    pages.push({ path: d.path, line: `- ${d.path} (${meta})${summary ? `: ${summary}` : h.title ? `: ${h.title}` : ""}`, rel: overlaps(h.applies_to, taskFiles) });
  }
  if (!pages.length) return null;
  pages.sort((a, b) => Number(b.rel) - Number(a.rel) || a.path.localeCompare(b.path));
  const dir = knowledgeDirectory(projectRoot);
  const head = `Folder: ${dir} (read-only; open a page with your read tool when it fits your task)`;
  const lines: string[] = [];
  let used = head.length;
  for (const p of pages) {
    if (used + p.line.length + 1 > max) break;
    lines.push(p.line); used += p.line.length + 1;
  }
  const omitted = pages.length - lines.length;
  if (!lines.length) return null;
  return { text: [head, ...lines, omitted ? `- (${omitted} more pages not listed; list the folder to see them)` : ""].filter(Boolean).join("\n"), dir, listed: lines.length, omitted };
}
