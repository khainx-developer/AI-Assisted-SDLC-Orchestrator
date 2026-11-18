import { execFileSync } from "node:child_process";
import { readFileSync, existsSync, statSync, mkdirSync, writeFileSync } from "node:fs";
import { join, basename } from "node:path";
import { createHash } from "node:crypto";
import { dataDir, normRoot } from "../common/paths.js";
import { loadConfig } from "../common/config.js";
import { restrictionsFor } from "../common/restrictions.js";
import { slugFor } from "../common/learnings.js";

/**
 * Stage 0 of the knowledge pipeline: facts about a repo gathered by code, with no AI. The AI stages read this file instead of
 * walking thousands of files. Hard rules: nothing is written into the repo, config files give key NAMES only (never values),
 * and files that look like secrets are never opened.
 */

export interface ProjectInfo {
  name: string;
  path: string;
  kind: "dotnet" | "node";
  target_frameworks: string[];
  output_type?: string;
  project_references: string[];
  packages: { name: string; version?: string }[];
  package_count: number;
  is_test: boolean;
  files: number;
}

export interface ScanResult {
  schema: 1;
  generated_at: string;
  repo_root: string;
  slug: string;
  head: { branch: string; sha: string; date: string; commits: number; remote: string | null };
  files: { tracked: number; considered: number; excluded_vendored: number; by_ext: Record<string, number> };
  solutions: { path: string; projects: number }[];
  projects: ProjectInfo[];
  frameworks: Record<string, number>;
  top_dirs: { dir: string; files: number }[];
  /** top-level folders holding files that belong to no project (SQL scripts, pipelines, infrastructure, docs): easy to miss in a module map */
  unowned_dirs: { dir: string; files: number }[];
  instruction_files: string[];
  docs: string[];
  adr_files: string[];
  codeowners: string | null;
  hot: { since: string; units: { unit: string; changes: number }[] };
  ticket_ids: { prefix: string; count: number; latest: string[] }[];
  config_keys: { file: string; keys: string[] }[];
  skipped_secret_like: number;
  notes: string[];
}

export interface ScanOptions {
  /** git --since value for the hot-spot and ticket scan */
  since?: string;
  /** extra regexes (source strings) for paths to treat as vendored or third-party */
  exclude?: string[];
  /** extra file name globs never to open, in addition to the restriction defaults */
  denyRead?: string[];
}

const VENDORED = [
  /(^|\/)(node_modules|deps|vendor|bin|obj|dist|\.vs|\.git|\.idea)(\/|$)/i,
  /^packages\//i, // NuGet restore folder; dropped again below when packages/ holds JS workspaces
  /(^|\/)(ckeditor|tinymce|adminlte|datatables|jquery[\w.-]*|bootstrap[\w.-]*|fontawesome[\w.-]*|moment|kendo[\w.-]*)(\/|$)/i,
  /\.min\.(js|css)$/i,
  /\.(png|jpe?g|gif|ico|svg|woff2?|ttf|eot|pdf|zip|dll|exe|snk|pfx)$/i,
];

const MAX_FILE = 2_000_000;

function git(root: string, args: string[], max = 512 * 1024 * 1024): string {
  return execFileSync("git", ["-c", "core.quotepath=off", ...args], { cwd: root, encoding: "utf8", maxBuffer: max, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
}
const gitTry = (root: string, args: string[]): string | null => { try { return git(root, args).trim(); } catch { return null; } };

/** A remote URL with any user:password@ part removed. A remote can carry a token, and the scan is shared with AI sessions. */
export function safeRemote(url: string | null): string | null {
  if (!url) return null;
  return url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/i, "$1");
}

/** git@host:org/repo.git, https://host/org/repo and ssh://git@host/org/repo all become host/org/repo. */
export function normRemote(url: string): string {
  let u = url.trim().replace(/\.git$/i, "");
  const scp = u.match(/^[^@/\s]+@([^:/\s]+):(.+)$/);
  if (scp) u = `${scp[1]}/${scp[2]}`;
  else u = u.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").replace(/^[^/@]+@/, "");
  return u.replace(/\/+$/, "").toLowerCase();
}

/**
 * Knowledge is keyed by repo identity, not by folder: the same repo cloned at two paths must not get two knowledge sets.
 * Order: slug set in config.json, else name + hash of the git remote, else the learnings slug (path based).
 */
export function knowledgeSlug(root: string): string {
  const hit = Object.entries(loadConfig().projects ?? {}).find(([k]) => normRoot(k) === normRoot(root))?.[1]?.slug;
  if (hit) return slugFor(root);
  const remote = gitTry(root, ["remote", "get-url", "origin"]);
  if (!remote) return slugFor(root);
  const n = normRemote(remote);
  const base = (n.split("/").pop() ?? "repo").replace(/[^a-z0-9._-]+/g, "-") || "repo";
  return `${base}-${createHash("sha1").update(n).digest("hex").slice(0, 6)}`;
}

export function knowledgeDir(slug: string): string {
  return join(dataDir(), "knowledge", slug);
}

function globToRegex(g: string): RegExp {
  const esc = g.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]").replace(/\u0000/g, ".*");
  return new RegExp(`^${esc}$`, "i");
}

function denier(patterns: string[]): (path: string) => boolean {
  const rx = patterns.map((p) => ({ withDir: p.includes("/"), re: globToRegex(p) }));
  return (path) => {
    const name = basename(path);
    return rx.some((r) => (r.withDir ? r.re.test(path) : r.re.test(name)));
  };
}

const SECRET_LIKE_NAME = /(pass(word|wd)?|secret|credential|private[-_.]?key|token)/i;

function read(root: string, rel: string): string | null {
  try {
    const f = join(root, rel);
    if (statSync(f).size > MAX_FILE) return null;
    return readFileSync(f, "utf8").replace(/^﻿/, "");
  } catch { return null; }
}

function attr(s: string, name: string): string | undefined {
  return s.match(new RegExp(`${name}\\s*=\\s*"([^"]*)"`, "i"))?.[1];
}

function legacyTfm(v: string): string {
  const m = v.trim().match(/^v?(\d)\.(\d)(?:\.(\d))?$/);
  return m ? `net${m[1]}${m[2]}${m[3] ?? ""}` : v.trim();
}

function parseDotnet(rel: string, text: string, pkgConfig: string | null): Omit<ProjectInfo, "files"> {
  const tfms = (text.match(/<TargetFrameworks?>([^<]+)</i)?.[1] ?? "").split(";").map((s) => s.trim()).filter(Boolean);
  if (!tfms.length) { const v = text.match(/<TargetFrameworkVersion>([^<]+)</i)?.[1]; if (v) tfms.push(legacyTfm(v)); }
  const refs = [...text.matchAll(/<ProjectReference\s+[^>]*Include\s*=\s*"([^"]+)"/gi)].map((m) => (m[1].split(/[\\/]/).pop() ?? "").replace(/\.(cs|fs|vb)proj$/i, ""));
  const packages: { name: string; version?: string }[] = [];
  for (const m of text.matchAll(/<PackageReference\s+([^>]*?)(\/?)>([\s\S]*?(?=<\/PackageReference>))?/gi)) {
    const name = attr(m[1], "Include") ?? attr(m[1], "Update");
    if (!name) continue;
    packages.push({ name, version: attr(m[1], "Version") ?? m[3]?.match(/<Version>([^<]+)</i)?.[1] });
  }
  if (pkgConfig) for (const m of pkgConfig.matchAll(/<package\s+([^>]*?)\/?>/gi)) { const id = attr(m[1], "id"); if (id) packages.push({ name: id, version: attr(m[1], "version") }); }
  const name = basename(rel).replace(/\.(cs|fs|vb)proj$/i, "");
  const testPkg = packages.some((p) => /^(Microsoft\.NET\.Test\.Sdk|xunit|NUnit|MSTest\.TestFramework|SpecFlow|Reqnroll)/i.test(p.name));
  return {
    name, path: rel, kind: "dotnet", target_frameworks: tfms, output_type: text.match(/<OutputType>([^<]+)</i)?.[1],
    project_references: [...new Set(refs)], packages: packages.slice(0, 80), package_count: packages.length,
    is_test: testPkg || /(^|[._])(tests?|specs?)$/i.test(name) || /\.(tests?|specs?)\d*$/i.test(name),
  };
}

function parseNode(rel: string, text: string): Omit<ProjectInfo, "files"> | null {
  try {
    const j = JSON.parse(text) as { name?: string; dependencies?: object; devDependencies?: object };
    const deps = { ...(j.dependencies ?? {}), ...(j.devDependencies ?? {}) } as Record<string, string>;
    const names = Object.keys(deps);
    return {
      name: j.name ?? rel.replace(/\/package\.json$/, "") ?? "package", path: rel, kind: "node", target_frameworks: [], project_references: [],
      packages: names.slice(0, 40).map((n) => ({ name: n, version: String(deps[n]) })), package_count: names.length,
      is_test: names.some((n) => /^(jest|mocha|vitest|cypress|playwright|@playwright\/test)$/.test(n)),
    };
  } catch { return null; }
}

function configKeys(rel: string, text: string): string[] {
  const keys = new Set<string>();
  if (/\.config$/i.test(rel)) {
    for (const m of text.matchAll(/<add\s+key\s*=\s*"([^"]+)"/gi)) keys.add(`appSettings:${m[1]}`);
    const cs = text.match(/<connectionStrings[\s\S]*?<\/connectionStrings>/i)?.[0] ?? "";
    for (const m of cs.matchAll(/<add\s+name\s*=\s*"([^"]+)"/gi)) keys.add(`connectionStrings:${m[1]}`);
  } else {
    try {
      const walk = (o: unknown, prefix: string, depth: number) => {
        if (!o || typeof o !== "object" || Array.isArray(o) || depth > 2) return;
        for (const [k, v] of Object.entries(o)) { keys.add(prefix ? `${prefix}.${k}` : k); walk(v, prefix ? `${prefix}.${k}` : k, depth + 1); }
      };
      walk(JSON.parse(text), "", 0);
    } catch { /* comments or invalid JSON: skip the file rather than guess */ }
  }
  return [...keys].sort().slice(0, 200);
}

export function scanRepo(rootIn: string, opts: ScanOptions = {}): ScanResult {
  const root = normRoot(rootIn);
  if (!existsSync(join(root, ".git"))) throw new Error(`${root} is not a git repository root`);
  const since = opts.since ?? "12 months ago";
  const extra = (opts.exclude ?? []).map((s) => new RegExp(s, "i"));
  const tracked = git(root, ["ls-files", "-z"]).split("\0").filter(Boolean);
  const jsWorkspaces = tracked.some((p) => /^packages\/[^/]+\/package\.json$/.test(p));
  const vendored = (p: string) => (jsWorkspaces && /^packages\//i.test(p) ? false : VENDORED.some((r) => r.test(p))) || extra.some((r) => r.test(p));
  const denied = denier([...restrictionsFor(root).deny_read, "local.settings.json", ...(opts.denyRead ?? [])]);

  const files = tracked.filter((p) => !vendored(p));

  const byExt: Record<string, number> = {};
  const topDirs: Record<string, number> = {};
  for (const p of files) {
    const e = /\.([A-Za-z0-9]+)$/.exec(p)?.[1]?.toLowerCase() ?? "(none)";
    byExt[e] = (byExt[e] ?? 0) + 1;
    const d = p.includes("/") ? p.split("/")[0] : ".";
    topDirs[d] = (topDirs[d] ?? 0) + 1;
  }
  const top = (o: Record<string, number>, n: number) => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, n);

  const fileSet = new Set(files);
  const dirOf = (p: string) => p.slice(0, p.lastIndexOf("/") + 1);
  const projects: ProjectInfo[] = [];
  for (const p of files) {
    let info: Omit<ProjectInfo, "files"> | null = null;
    if (/\.(cs|fs|vb)proj$/i.test(p)) {
      const text = read(root, p);
      const pcRel = `${dirOf(p)}packages.config`;
      info = text ? parseDotnet(p, text, fileSet.has(pcRel) ? read(root, pcRel) : null) : null;
    } else if (/(^|\/)package\.json$/.test(p) && projects.filter((x) => x.kind === "node").length < 30) {
      const text = read(root, p);
      info = text ? parseNode(p, text) : null;
    }
    if (info) projects.push({ ...info, files: 0 });
  }
  // files per project: nearest enclosing project folder
  const projDirs = projects.map((x) => ({ x, dir: dirOf(x.path) })).sort((a, b) => b.dir.length - a.dir.length);
  const owner = (p: string) => projDirs.find((d) => d.dir === "" || p.startsWith(d.dir))?.x;
  const unowned: Record<string, number> = {};
  for (const p of files) {
    const o = owner(p);
    if (o) o.files++;
    else { const d = p.includes("/") ? p.split("/")[0] : "."; unowned[d] = (unowned[d] ?? 0) + 1; }
  }
  projects.sort((a, b) => a.path.localeCompare(b.path));

  const frameworks: Record<string, number> = {};
  for (const x of projects) for (const t of x.target_frameworks) frameworks[t] = (frameworks[t] ?? 0) + 1;

  const solutions = files.filter((p) => /\.(sln|slnx)$/i.test(p)).map((p) => {
    const t = read(root, p) ?? "";
    return { path: p, projects: (t.match(/^Project\(/gm) ?? []).length || (t.match(/<Project\s+Path=/g) ?? []).length };
  });

  const instruction = files.filter((p) =>
    /(^|\/)(CLAUDE|AGENTS|agent|copilot-instructions|CONTRIBUTING)\.md$/i.test(p) || /^\.github\/(agents|skills|instructions)\//.test(p) || /^\.cursor\/rules\//.test(p));
  const docs = files.filter((p) => /\.(md|mdx|rst|adoc)$/i.test(p) && (/^docs?\//i.test(p) || !p.includes("/")) && !instruction.includes(p));
  const adr = files.filter((p) => /\.md$/i.test(p) && /(^|\/)(adrs?|decisions?)(\/|$)|(^|\/)(adr|decision)[-_ ]?\d/i.test(p));
  const codeowners = files.find((p) => /(^|\/)CODEOWNERS$/.test(p)) ?? null;

  // hot spots and ticket ids from recent history
  const unitOf = (p: string) => { const o = owner(p)?.path; return o && o.includes("/") ? o.replace(/\/[^/]+$/, "") : p.includes("/") ? p.split("/")[0] : "."; };
  const hot: Record<string, number> = {};
  for (const line of (gitTry(root, ["log", `--since=${since}`, "--name-only", "--format="]) ?? "").split("\n")) {
    const p = line.trim();
    if (p && fileSet.has(p)) { const u = unitOf(p); hot[u] = (hot[u] ?? 0) + 1; } // only files that still exist and are not vendored
  }
  const tickets: Record<string, { count: number; latest: string[] }> = {};
  for (const subj of (gitTry(root, ["log", `--since=${since}`, "--format=%s"]) ?? "").split("\n")) {
    for (const m of subj.matchAll(/\b([A-Z][A-Z0-9]{1,9})-(\d{1,7})\b/g)) {
      const t = (tickets[m[1]] ??= { count: 0, latest: [] });
      t.count++;
      if (t.latest.length < 5 && !t.latest.includes(m[0])) t.latest.push(m[0]);
    }
  }

  // config key names only; never values, never files that look like secrets
  const cfgKeys: { file: string; keys: string[] }[] = [];
  for (const p of files) {
    if (!/(^|\/)((web|app)(\.[\w.-]+)?\.config|appsettings(\.[\w.-]+)?\.json|host\.json)$/i.test(p)) continue;
    if (denied(p) || SECRET_LIKE_NAME.test(basename(p))) continue;
    if (cfgKeys.length >= 40) break;
    const t = read(root, p);
    const keys = t ? configKeys(p, t) : [];
    if (keys.length) cfgKeys.push({ file: p, keys });
  }
  const skippedSecret = files.filter((p) => denied(p) || SECRET_LIKE_NAME.test(basename(p))).length;

  const [sha, date] = (gitTry(root, ["log", "-1", "--format=%H%n%cs"]) ?? "\n").split("\n");
  const remote = safeRemote(gitTry(root, ["remote", "get-url", "origin"]));
  const notes: string[] = [];
  if (!adr.length) notes.push("No ADR files found.");
  if (!codeowners) notes.push("No CODEOWNERS file found.");
  if (tracked.length - files.length) notes.push(`${tracked.length - files.length} tracked files were ignored as vendored, generated or binary.`);
  if (!projects.length) notes.push("No project files recognised (.csproj/.fsproj/.vbproj/package.json); module boundaries must come from folders.");

  return {
    schema: 1, generated_at: new Date().toISOString(), repo_root: root, slug: knowledgeSlug(root),
    head: { branch: gitTry(root, ["rev-parse", "--abbrev-ref", "HEAD"]) ?? "", sha: sha ?? "", date: date ?? "", commits: Number(gitTry(root, ["rev-list", "--count", "HEAD"]) ?? 0), remote },
    files: { tracked: tracked.length, considered: files.length, excluded_vendored: tracked.length - files.length, by_ext: Object.fromEntries(top(byExt, 20)) },
    solutions, projects, frameworks,
    top_dirs: top(topDirs, 40).map(([dir, n]) => ({ dir, files: n })),
    unowned_dirs: top(unowned, 25).map(([dir, n]) => ({ dir, files: n })),
    instruction_files: instruction, docs, adr_files: adr, codeowners,
    hot: { since, units: top(hot, 25).map(([unit, changes]) => ({ unit, changes })) },
    ticket_ids: Object.entries(tickets).sort((a, b) => b[1].count - a[1].count).slice(0, 8).map(([prefix, t]) => ({ prefix, ...t })),
    config_keys: cfgKeys, skipped_secret_like: skippedSecret, notes,
  };
}

export function writeScan(scan: ScanResult, out?: string): string {
  const file = out ?? join(knowledgeDir(scan.slug), ".meta", "scan.json");
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, JSON.stringify(scan, null, 2));
  return file;
}

/** Compact Markdown view of a scan, small enough to paste into a prompt. */
export function scanSummary(s: ScanResult, maxProjects = 120): string {
  const L: string[] = [];
  L.push(`# Scan: ${s.slug}`, `Repo ${s.repo_root} at ${s.head.sha.slice(0, 10)} (${s.head.branch}, ${s.head.date}), ${s.head.commits} commits.`);
  L.push(`Files: ${s.files.considered} considered of ${s.files.tracked} tracked. Top types: ${Object.entries(s.files.by_ext).slice(0, 8).map(([e, n]) => `${e} ${n}`).join(", ")}.`);
  if (Object.keys(s.frameworks).length) L.push(`Target frameworks: ${Object.entries(s.frameworks).sort((a, b) => b[1] - a[1]).map(([t, n]) => `${t} x${n}`).join(", ")}.`);
  if (s.solutions.length) L.push(`Solutions: ${s.solutions.map((x) => `${x.path} (${x.projects})`).join(", ")}.`);
  L.push("", `## Projects (${s.projects.length})`, "| project | path | framework | refs | files | test |", "|---|---|---|---|---|---|");
  for (const p of s.projects.slice(0, maxProjects)) L.push(`| ${p.name} | ${p.path} | ${p.target_frameworks.join(";") || "-"} | ${p.project_references.join(", ") || "-"} | ${p.files} | ${p.is_test ? "yes" : ""} |`);
  if (s.projects.length > maxProjects) L.push(`(${s.projects.length - maxProjects} more in scan.json)`);
  if (s.unowned_dirs.length) L.push("", "## Folders with files but no project (each must be covered by a module or named as out of scope)", ...s.unowned_dirs.map((d) => `- ${d.dir}: ${d.files} files`));
  L.push("", `## Most changed since ${s.hot.since}`, ...s.hot.units.slice(0, 15).map((u) => `- ${u.unit}: ${u.changes}`));
  if (s.ticket_ids.length) L.push("", "## Ticket ids in commit subjects", ...s.ticket_ids.map((t) => `- ${t.prefix}: ${t.count} (e.g. ${t.latest.join(", ")})`));
  L.push("", "## Existing guidance", `Instruction files: ${s.instruction_files.length}. Docs: ${s.docs.join(", ") || "none"}. ADRs: ${s.adr_files.length}. CODEOWNERS: ${s.codeowners ?? "none"}.`);
  if (s.notes.length) L.push("", "## Notes", ...s.notes.map((n) => `- ${n}`));
  return L.join("\n");
}
