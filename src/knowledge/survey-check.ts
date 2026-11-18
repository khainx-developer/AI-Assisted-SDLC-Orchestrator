import type { ScanResult } from "./scan.js";

/**
 * Deterministic check of a repo-survey document against the scan. A model writes the module map well but gets facts that
 * are derivable from code wrong by omission (seen live: a shared core said to depend on nothing while it references the
 * legacy web app). Code computes the truth; this reports where the document disagrees so the session can repair it.
 */
export interface SurveyModule { id: string; name: string; folders: string[]; stated_deps: string[] }

export interface SurveyReport {
  modules: number;
  /** scan projects that fall under no module's folders */
  unassigned_projects: string[];
  /** project in more than one module */
  duplicated_projects: string[];
  /** module A references module B in code but the survey does not say A depends on B */
  missing_edges: { from: string; to: string; via: string }[];
  /** survey says A depends on B but no project reference supports it */
  unsupported_edges: { from: string; to: string }[];
  /** survey names a dependency id that is not a module */
  unknown_deps: { from: string; dep: string }[];
  /** top-level folders without a project that the survey never mentions */
  unmentioned_dirs: { dir: string; files: number }[];
  /** modern .NET projects that reference .NET Framework projects, which the survey should surface as a risk */
  cross_framework: string[];
  ok: boolean;
}

export function parseSurvey(md: string): SurveyModule[] {
  const out: SurveyModule[] = [];
  for (const block of md.split(/^### /m).slice(1)) {
    const head = block.match(/^(M\d+)\.\s*(.+)/);
    if (!head) continue;
    const folders = [...(block.match(/^- Projects and folders:\s*(.+)$/m)?.[1] ?? "").matchAll(/`([^`]+)`/g)].map((m) => m[1]);
    const dep = block.match(/^- Depends on:\s*(.+)$/m)?.[1] ?? "";
    out.push({ id: head[1], name: head[2].trim(), folders, stated_deps: [...new Set([...dep.matchAll(/\bM\d+\b/g)].map((m) => m[0]))] });
  }
  return out;
}

const isFramework = (t: string) => /^net4\d+$/.test(t);
const isModern = (t: string) => /^net\d+\.\d+$/.test(t);

export function checkSurvey(scan: ScanResult, md: string): SurveyReport {
  const mods = parseSurvey(md);
  const norm = (f: string) => f.replace(/\\/g, "/").replace(/\/package\.json$/i, "/").replace(/^\.\//, "");
  const owners = (path: string) => mods.filter((m) => m.folders.some((f) => { const n = norm(f); return n.endsWith("/") ? path.startsWith(n) : path === n || path.startsWith(n + "/"); }));
  const modOf = new Map<string, string>();
  const unassigned: string[] = [];
  const dup: string[] = [];
  for (const p of scan.projects) {
    const o = owners(p.path);
    if (!o.length) unassigned.push(p.name);
    else { modOf.set(p.name, o[0].id); if (o.length > 1) dup.push(p.name); }
  }

  const ids = new Set(mods.map((m) => m.id));
  const derived = new Map<string, Map<string, string>>(); // from -> (to -> first project reference that proves it), production projects only
  const withTests = new Map<string, Set<string>>(); // same, test projects included: enough to support a stated dependency, not required
  for (const p of scan.projects) {
    const from = modOf.get(p.name);
    if (!from) continue;
    for (const r of p.project_references) {
      const to = modOf.get(r);
      if (to && to !== from) { if (!withTests.has(from)) withTests.set(from, new Set()); withTests.get(from)!.add(to); }
      if (p.is_test) continue; // a test project may reach into other modules; that is not a dependency of the module itself
      if (to && to !== from) { if (!derived.has(from)) derived.set(from, new Map()); if (!derived.get(from)!.has(to)) derived.get(from)!.set(to, `${p.name} -> ${r}`); }
    }
  }
  const missing: SurveyReport["missing_edges"] = [];
  const unsupported: SurveyReport["unsupported_edges"] = [];
  const unknown: SurveyReport["unknown_deps"] = [];
  for (const m of mods) {
    for (const [to, via] of derived.get(m.id) ?? []) if (!m.stated_deps.includes(to)) missing.push({ from: m.id, to, via });
    for (const d of m.stated_deps) {
      if (!ids.has(d)) unknown.push({ from: m.id, dep: d });
      else if (!withTests.get(m.id)?.has(d)) unsupported.push({ from: m.id, to: d });
    }
  }

  const lower = md.toLowerCase();
  const unmentioned = (scan.unowned_dirs ?? []).filter((d) => !lower.includes(d.dir.toLowerCase()));

  const byName = new Map(scan.projects.map((p) => [p.name, p]));
  const cross: string[] = [];
  for (const p of scan.projects) for (const r of p.project_references) {
    const t = byName.get(r);
    if (t && p.target_frameworks.some(isModern) && t.target_frameworks.some(isFramework)) cross.push(`${p.name} (${p.target_frameworks.join(";")}) -> ${t.name} (${t.target_frameworks.join(";")})`);
  }

  return {
    modules: mods.length, unassigned_projects: unassigned, duplicated_projects: dup, missing_edges: missing, unsupported_edges: unsupported,
    unknown_deps: unknown, unmentioned_dirs: unmentioned, cross_framework: cross,
    ok: !!mods.length && !unassigned.length && !dup.length && !missing.length && !unsupported.length && !unknown.length && !unmentioned.length,
  };
}

/** Plain-text findings, written so they can be handed back to the session as repair instructions. */
export function formatSurveyReport(r: SurveyReport, names: Record<string, string> = {}): string {
  const n = (id: string) => (names[id] ? `${id} ${names[id]}` : id);
  const L: string[] = [];
  if (!r.modules) L.push("No modules were found: each module must start with a heading like `### M1. Name`.");
  if (r.unassigned_projects.length) L.push(`Projects not placed in any module (add them to a module's "Projects and folders"): ${r.unassigned_projects.join(", ")}`);
  if (r.duplicated_projects.length) L.push(`Projects placed in more than one module: ${r.duplicated_projects.join(", ")}`);
  for (const e of r.missing_edges) L.push(`${n(e.from)} depends on ${n(e.to)} in code (${e.via}) but its "Depends on" line does not say so.`);
  for (const e of r.unsupported_edges) L.push(`${n(e.from)} says it depends on ${n(e.to)}, but no project reference supports that. Remove it or explain.`);
  for (const e of r.unknown_deps) L.push(`${n(e.from)} names ${e.dep}, which is not a module.`);
  for (const d of r.unmentioned_dirs) L.push(`Folder "${d.dir}" (${d.files} files, no project) is not mentioned: put it in a module's folders or say under Cross-cutting concerns or Open Questions why it is out of scope.`);
  return L.join("\n");
}
