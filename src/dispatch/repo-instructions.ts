import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative } from "node:path";

/** Default cap, in characters, on what is injected from a repo's own instruction files (override with repo_instructions_max_chars). */
export const MAX_REPO_INSTRUCTION_CHARS = 12_000;
/** Longest index of agent and skill files; the rest is dropped with a note. */
const MAX_INDEX_ENTRIES = 60;

function filesIn(dir: string, pick: (name: string) => boolean, depth = 1): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    let st; try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) { if (depth > 0) out.push(...filesIn(p, pick, depth - 1)); }
    else if (pick(name)) out.push(p);
  }
  return out;
}

/** Instruction files a platform's CLI loads by itself, so repeating them in the prompt only costs tokens. */
const NATIVE: Record<string, RegExp[]> = {
  copilot: [/(^|\/)\.github\/copilot-instructions\.md$/i, /(^|\/)AGENTS\.md$/i],
  claude: [/(^|\/)CLAUDE\.md$/i],
  cursor: [/(^|\/)AGENTS\.md$/i, /(^|\/)\.cursor\/rules\//i],
};
const isNative = (platform: string | undefined, file: string) => !!platform && (NATIVE[platform] ?? []).some((re) => re.test(file.split("\\").join("/")));

/** Files whose full text is injected (general instructions). */
function inlineFiles(root: string): string[] {
  return [
    join(root, "CLAUDE.md"),
    join(root, "AGENTS.md"),
    join(root, ".github", "copilot-instructions.md"),
    ...filesIn(join(root, ".cursor", "rules"), (n) => /\.(md|mdc)$/i.test(n), 0),
  ].filter((f) => existsSync(f));
}

/** Agent and skill files: only listed (name and description), because most are irrelevant to any one task. The session opens the ones it needs. */
function indexedFiles(root: string): string[] {
  return [
    ...filesIn(join(root, ".github", "agents"), (n) => /\.md$/i.test(n), 0),
    ...filesIn(join(root, ".github", "skills"), (n) => /^SKILL\.md$/i.test(n), 1),
  ];
}

/** All the instruction files of a repo, as before (inline ones first). */
export function repoInstructionFiles(root: string): string[] {
  return [...inlineFiles(root), ...indexedFiles(root)];
}

/** A one-line description: the frontmatter `description`, else the first line of prose. */
export function describeFile(body: string): string {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(body);
  const d = fm && /^description:\s*(?:["']?)(.+?)(?:["']?)\s*$/im.exec(fm[1]);
  let text = d && d[1] && !/^[>|]-?$/.test(d[1]) ? d[1] : "";
  if (!text) {
    const rest = fm ? body.slice(fm[0].length) : body;
    const clean = (l: string) => l.trim().replace(/^[-*>]+\s*/, "").replace(/\*\*/g, "").trim();
    text = rest.split(/\r?\n/).map(clean).find((l) => l && !/^(#|---|name:|title:|description:)/i.test(l) && !/^use when:?$/i.test(l)) ?? "";
  }
  return text.replace(/\s+/g, " ").slice(0, 160);
}

/**
 * Labelled instruction text (capped), or null if there is none. `repos` defaults to [root]; for a workspace pass its
 * child repos so they share ONE size budget and are labelled by their path under `root`. With `platform`, files that
 * platform's CLI already reads on its own are left out. Agent and skill files appear as an index, not in full.
 */
export function repoInstructionsText(root: string, max = MAX_REPO_INSTRUCTION_CHARS, repos: string[] = [root], platform?: string): string | null {
  const label = (f: string) => relative(root, f).split("\\").join("/");
  const inline = repos.flatMap(inlineFiles).filter((f) => !isNative(platform, f));
  const indexed = repos.flatMap(indexedFiles);
  let used = 0;
  const parts: string[] = [];
  const skipped: string[] = [];
  for (const f of inline) {
    let body = readFileSync(f, "utf8").trim();
    if (!body) continue;
    if (used + body.length > max) {
      const room = max - used;
      if (room < 500) { skipped.push(label(f)); continue; }
      body = body.slice(0, room) + "\n[truncated]";
    }
    used += body.length;
    parts.push(`--- ${label(f)} ---\n${body}`);
  }
  if (skipped.length) parts.push(`(not included, size cap reached: ${skipped.join(", ")})`);
  const entries: string[] = [];
  for (const f of indexed.slice(0, MAX_INDEX_ENTRIES)) {
    let body = ""; try { body = readFileSync(f, "utf8"); } catch { continue; }
    if (!body.trim()) continue;
    const d = describeFile(body);
    entries.push(`- ${label(f)}${d ? `: ${d}` : ""}`);
  }
  if (indexed.length > MAX_INDEX_ENTRIES) entries.push(`- (${indexed.length - MAX_INDEX_ENTRIES} more files not listed)`);
  if (entries.length) parts.push(`--- agent and skill files in this repo (not included; open one with your read tool when it applies) ---\n${entries.join("\n")}`);
  return parts.length ? parts.join("\n\n") : null;
}
