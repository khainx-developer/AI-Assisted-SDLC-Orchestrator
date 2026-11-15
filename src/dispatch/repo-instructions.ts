import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative } from "node:path";

/** Total characters injected from a repo's own instruction files; the rest is dropped with a note. */
export const MAX_REPO_INSTRUCTION_CHARS = 40_000;

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

/** The instruction files the supported platforms read natively, resolved explicitly so every platform sees them. */
export function repoInstructionFiles(root: string): string[] {
  return [
    join(root, "CLAUDE.md"),
    join(root, "AGENTS.md"),
    join(root, ".github", "copilot-instructions.md"),
    ...filesIn(join(root, ".github", "agents"), (n) => /\.md$/i.test(n), 0),
    ...filesIn(join(root, ".github", "skills"), (n) => /^SKILL\.md$/i.test(n), 1),
    ...filesIn(join(root, ".cursor", "rules"), (n) => /\.(md|mdc)$/i.test(n), 0),
  ].filter((f) => existsSync(f));
}

/** Concatenated, labelled contents (capped), or null if the repo has none. */
export function repoInstructionsText(root: string, max = MAX_REPO_INSTRUCTION_CHARS): string | null {
  const files = repoInstructionFiles(root);
  if (!files.length) return null;
  let used = 0;
  const parts: string[] = [];
  const skipped: string[] = [];
  for (const f of files) {
    const name = relative(root, f).split("\\").join("/");
    let body = readFileSync(f, "utf8").trim();
    if (!body) continue;
    if (used + body.length > max) {
      const room = max - used;
      if (room < 500) { skipped.push(name); continue; }
      body = body.slice(0, room) + "\n[truncated]";
    }
    used += body.length;
    parts.push(`--- ${name} ---\n${body}`);
  }
  if (skipped.length) parts.push(`(not included, size cap reached: ${skipped.join(", ")})`);
  return parts.length ? parts.join("\n\n") : null;
}
