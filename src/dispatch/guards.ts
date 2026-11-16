import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync, mkdirSync, copyFileSync } from "node:fs";
import { join, dirname } from "node:path";

/**
 * Platform-neutral checks the runner applies after a write session, the same way it applies the git-status
 * check after a read-only one: they do not depend on the AI CLI honouring a rule in the prompt.
 */

const norm = (p: string) => p.trim().replace(/^`|`$/g, "").replace(/\\/g, "/").replace(/^\.\//, "");

/** One entry of `git status --porcelain` -> the path it names (new name for a rename, quotes removed). */
export function porcelainPath(line: string): string {
  let p = line.slice(3);
  const arrow = p.indexOf(" -> ");
  if (arrow >= 0) p = p.slice(arrow + 4);
  if (p.startsWith('"') && p.endsWith('"')) p = p.slice(1, -1);
  return norm(p);
}

function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") { re += ".*"; i++; if (glob[i + 1] === "/") i++; } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

/**
 * Is `file` covered by one of the patterns? A pattern is an exact file, a directory (with or without a
 * trailing slash: everything below it counts) or a glob (`*` within a segment, `**` across segments).
 */
export function pathAllowed(file: string, patterns: string[]): boolean {
  const f = norm(file);
  return patterns.map(norm).filter(Boolean).some((p) => {
    if (/[*?]/.test(p)) return globToRegExp(p).test(f);
    const dir = p.replace(/\/+$/, "");
    return f === dir || f.startsWith(`${dir}/`);
  });
}

/** Files that fall outside every pattern. An empty pattern list means no scope was declared: nothing is outside. */
export function outsideScope(files: string[], allowed: string[]): string[] {
  return allowed.length ? files.filter((f) => !pathAllowed(f, allowed)) : [];
}

const MISSING = "<missing>";
const MAX_HASH_BYTES = 20 * 1024 * 1024;

export function hashFile(root: string, rel: string): string {
  const abs = join(root, rel);
  try {
    if (!existsSync(abs)) return MISSING;
    const st = statSync(abs);
    if (!st.isFile()) return MISSING;
    if (st.size > MAX_HASH_BYTES) return `size:${st.size}:${st.mtimeMs}`;
    return createHash("sha1").update(readFileSync(abs)).digest("hex");
  } catch { return MISSING; }
}

export function hashFiles(root: string, files: string[]): Record<string, string> {
  return Object.fromEntries(files.map((f) => [f, hashFile(root, f)]));
}

/** Files whose content now differs from `before` (a hash map taken earlier); a file not in `before` counts as clean then. */
export function touchedSince(root: string, before: Record<string, string>, nowDirty: string[]): string[] {
  return nowDirty.filter((f) => before[f] !== hashFile(root, f));
}

/** Copy frozen files aside and remember their hashes, so a violation can be reported and undone by hand. */
export function snapshotFrozen(root: string, files: string[], backupDir: string): Record<string, string> {
  const hashes = hashFiles(root, files);
  for (const f of files) {
    if (hashes[f] === MISSING) continue;
    const dest = join(backupDir, f);
    mkdirSync(dirname(dest), { recursive: true });
    try { copyFileSync(join(root, f), dest); } catch { /* best effort: the hash comparison still catches the change */ }
  }
  return hashes;
}

/** Frozen files that were edited, replaced or deleted since the snapshot. */
export function frozenViolations(root: string, snapshot: Record<string, string>): string[] {
  return Object.entries(snapshot).filter(([f, h]) => hashFile(root, f) !== h).map(([f]) => f);
}

export type TestVerdict = "red" | "vacuous" | "broken";

// The suite did not really run: a missing module, a compile error, a missing runner or nothing collected.
const BROKEN = [
  /Cannot find module/i, /MODULE_NOT_FOUND/, /ModuleNotFoundError/, /\bImportError\b/, /\bSyntaxError\b/, /IndentationError/,
  /error TS\d+/, /error CS\d+/, /cannot find symbol/i, /COMPILATION ERROR/i, /compilation failed/i, /undefined reference/i,
  /no tests? (?:found|ran|were run|to run)/i, /collected 0 items/i, /\b0 tests? (?:found|run|executed|passed)\b/i, /no test files found/i,
  /command not found/i, /is not recognized as an internal or external command/i, /\bENOENT\b/,
];

/**
 * Judge a test run that was expected to be red (tests written before the code).
 * `vacuous`: they passed, so they check nothing new. `broken`: they failed because the suite could not run, not because an
 * assertion failed. `red`: they ran and failed, which is what a frozen test should do before the code exists.
 * Heuristic on the output text: advisory, the orchestrator shows it to the human rather than deciding alone.
 */
export function classifyTestRun(passed: boolean, output: string): TestVerdict {
  if (passed) return "vacuous";
  return BROKEN.some((re) => re.test(output)) ? "broken" : "red";
}
