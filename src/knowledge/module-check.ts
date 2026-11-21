import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, normalize, relative } from "node:path";

/**
 * Deterministic check of a module-analysis page against the repo. It cannot tell whether a sentence is true, but it
 * finds the cheap failures: citations that point nowhere, bullets with no citation, names in a bullet that appear in
 * none of the files it cites, and a page about a different commit. Claim verification by a second model comes after it.
 */
export interface ModuleReport {
  citations: number;
  /** cited file does not exist in the repo, or points outside it */
  missing_files: string[];
  /** line number past the end of the file, or a reversed range */
  bad_lines: string[];
  /** fact bullets that cite nothing */
  uncited: string[];
  /** a backticked name in a bullet that occurs in none of that bullet's cited files */
  unsupported_names: { bullet: string; name: string }[];
  /** required headings that are absent */
  missing_sections: string[];
  /** Source line names a commit other than the expected one */
  wrong_source: string | null;
  ok: boolean;
}

const SECTIONS = ["Purpose", "Responsibilities", "Public surface", "Dependencies", "Data and configuration", "Runtime and deployment", "Build and test", "Known risks and technical debt", "How to change it safely", "Open Questions"];
/** sections whose bullets state facts about code and so must cite */
const FACT_SECTIONS = new Set(["Responsibilities", "Public surface", "Dependencies", "Data and configuration", "Runtime and deployment", "Build and test", "Known risks and technical debt"]);
const CITE = /`([^`\s:]+):(\d+)(?:-(\d+))?`/g;
const slash = (p: string) => p.split("\\").join("/");

export function checkModule(repoRoot: string, md: string, expectedSha?: string): ModuleReport {
  const missingFiles = new Set<string>();
  const badLines: string[] = [];
  const cache = new Map<string, string | null>();
  const read = (p: string): string | null => {
    if (cache.has(p)) return cache.get(p)!;
    const full = join(repoRoot, p);
    const rel = relative(repoRoot, normalize(full));
    let text: string | null = null;
    if (!isAbsolute(p) && !rel.startsWith("..") && existsSync(full) && statSync(full).isFile()) text = readFileSync(full, "utf8");
    cache.set(p, text);
    return text;
  };

  let citations = 0;
  const uncited: string[] = [];
  const unsupported: ModuleReport["unsupported_names"] = [];
  let section = "";
  for (const line of md.split(/\r?\n/)) {
    const h = line.match(/^##\s+(.+?)\s*$/);
    if (h) { section = h[1]; continue; }
    const cites = [...line.matchAll(CITE)];
    for (const c of cites) {
      citations++;
      const p = slash(c[1]);
      const text = read(p);
      if (text === null) { missingFiles.add(p); continue; }
      const total = text.split("\n").length;
      const a = Number(c[2]), b = Number(c[3] ?? c[2]);
      if (b < a) badLines.push(`${c[0]} (reversed range)`);
      else if (a < 1 || b > total) badLines.push(`${c[0]} (file has ${total} lines)`);
    }
    if (!/^\s*[-*]\s/.test(line) || !FACT_SECTIONS.has(section)) continue;
    const label = line.replace(/^\s*[-*]\s+/, "").slice(0, 90);
    // a plain path citation (`path` with no line) also counts as evidence, for project files and folders
    const hasPathCite = [...line.matchAll(/`([^`\s]+[\\/][^`\s]*|[^`\s]+\.(?:csproj|json|yml|yaml|md|config))`/g)].length > 0;
    if (!cites.length && !hasPathCite) { if (!/not (?:established|found)/i.test(line)) uncited.push(label); continue; } // a statement that something was not found has nothing to cite
    const bodies = cites.map((c) => read(slash(c[1]))).filter((t): t is string => t !== null);
    if (!bodies.length) continue;
    const all = bodies.join("\n") + "\n" + cites.map((c) => slash(c[1])).join("\n"); // a cited file's own path names it too
    const cited = new Set(cites.map((c) => c[0]));
    for (const m of line.matchAll(/`([^`]+)`/g)) {
      if (cited.has(m[0])) continue;
      const name = m[1];
      if (!/^[A-Za-z_][\w.]*$/.test(name) || name.length < 4) continue;
      const parts = name.split(".");
      if (!all.includes(name) && !all.includes(parts[parts.length - 1])) unsupported.push({ bullet: label, name });
    }
  }

  const headings = new Set([...md.matchAll(/^##\s+(.+?)\s*$/gm)].map((m) => m[1]));
  const type = md.match(/^Type:\s*(\S+)/m)?.[1]; // only module pages follow the module template; other page types have their own headings
  const missingSections = type && type !== "module" ? [] : SECTIONS.filter((s) => !headings.has(s));
  const src = md.match(/^Source:\s*(.+)$/m)?.[1] ?? "";
  const wrong = expectedSha && !src.includes(expectedSha.slice(0, 7)) ? `Source line is "${src}", expected commit ${expectedSha.slice(0, 7)}` : null;

  return {
    citations, missing_files: [...missingFiles], bad_lines: badLines, uncited, unsupported_names: unsupported,
    missing_sections: missingSections, wrong_source: wrong,
    ok: !!citations && !missingFiles.size && !badLines.length && !uncited.length && !unsupported.length && !missingSections.length && !wrong,
  };
}

/** Plain-text findings, written so they can be handed back to the session as repair instructions. */
export function formatModuleReport(r: ModuleReport): string {
  const L: string[] = [];
  if (!r.citations) L.push("The page has no `path:line` citations.");
  for (const f of r.missing_files) L.push(`Cited file does not exist in the repository: ${f}. Fix the path or remove the statement.`);
  for (const b of r.bad_lines) L.push(`Cited line is out of range: ${b}.`);
  for (const u of r.uncited) L.push(`This statement has no citation: "${u}". Add \`path:line\` or move it to Open Questions.`);
  for (const u of r.unsupported_names) L.push(`"${u.name}" does not appear in any file cited by: "${u.bullet}". Cite where it is, or remove it.`);
  for (const s of r.missing_sections) L.push(`Missing section: ## ${s}`);
  if (r.wrong_source) L.push(r.wrong_source);
  return L.join("\n");
}
