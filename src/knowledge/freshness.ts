import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { isAbsolute, join, normalize, relative } from "node:path";

/**
 * Freshness of a knowledge page, decided without a model. The page's `Source: <repo>@<sha>` line names the commit its
 * citations were read at. Git says what changed in the cited files since then, and whether a change touched the cited lines.
 *   fresh   no cited file changed
 *   shifted a cited file changed, but not the cited lines (the claims hold, the line numbers have moved)
 *   stale   a change overlaps cited lines: the claim may no longer be true
 *   broken  a cited file is gone
 *   unknown there is no usable Source commit, so nothing can be said
 */
export type Freshness = "fresh" | "shifted" | "stale" | "broken" | "unknown";

export interface PageHeader {
  title: string;
  source_sha: string | null;
  type: string | null;
  summary: string | null;
  applies_to: string[];
  status: string | null;
}

export interface FreshnessReport {
  state: Freshness;
  source_sha: string | null;
  citations: number;
  /** cited files whose cited lines changed since the Source commit, with the first affected cited range */
  stale: { file: string; cited: string }[];
  /** cited files that changed elsewhere */
  shifted: string[];
  /** cited files that no longer exist */
  missing: string[];
  reason?: string;
}

const CITE = /`([^`\s:]+):(\d+)(?:-(\d+))?`/g;
const slash = (p: string) => p.split("\\").join("/");

function field(md: string, name: string): string | null {
  return md.match(new RegExp(`^${name}:[ \\t]*(.+?)\\s*$`, "mi"))?.[1] ?? null;
}

export function parseHeader(md: string): PageHeader {
  const source = field(md, "Source");
  return {
    title: md.match(/^#\s+(.+?)\s*$/m)?.[1] ?? "",
    source_sha: source?.match(/@([0-9a-f]{7,40})\b/i)?.[1] ?? null,
    type: field(md, "Type"),
    summary: field(md, "Summary"),
    applies_to: (field(md, "Applies to") ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    status: field(md, "Status"),
  };
}

export function citedRanges(md: string): Map<string, [number, number][]> {
  const out = new Map<string, [number, number][]>();
  for (const m of md.matchAll(CITE)) {
    const a = Number(m[2]), b = Number(m[3] ?? m[2]);
    const list = out.get(slash(m[1])) ?? [];
    list.push([Math.min(a, b), Math.max(a, b)]);
    out.set(slash(m[1]), list);
  }
  return out;
}

function git(repo: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
}

/** Old-side line ranges changed between `sha` and the working tree, from `git diff -U0`. An insertion after line n is the point between n and n+1. */
function changedOldRanges(repo: string, sha: string, file: string): [number, number][] {
  const out: [number, number][] = [];
  for (const m of git(repo, "diff", "-U0", "--no-color", "--no-renames", sha, "--", file).matchAll(/^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@/gm)) {
    const start = Number(m[1]), len = m[2] === undefined ? 1 : Number(m[2]);
    out.push(len === 0 ? [start, start + 1] : [start, start + len - 1]);
  }
  return out;
}

export function checkFreshness(repoRoot: string, md: string): FreshnessReport {
  const h = parseHeader(md);
  const ranges = citedRanges(md);
  const citations = [...ranges.values()].reduce((n, r) => n + r.length, 0);
  const base: FreshnessReport = { state: "unknown", source_sha: h.source_sha, citations, stale: [], shifted: [], missing: [] };
  if (!h.source_sha) return { ...base, reason: "the page has no `Source: <repo>@<commit>` line" };
  try { git(repoRoot, "cat-file", "-e", `${h.source_sha}^{commit}`); }
  catch { return { ...base, reason: `commit ${h.source_sha} is not in this repository (or it is not a git repository)` }; }
  if (!citations) return { ...base, state: "fresh", reason: "the page cites no files, so nothing can go stale" };

  const stale: FreshnessReport["stale"] = [], shifted: string[] = [], missing: string[] = [];
  for (const [file, cited] of ranges) {
    const full = join(repoRoot, file);
    const inside = !isAbsolute(file) && !relative(repoRoot, normalize(full)).startsWith("..");
    if (!inside || !existsSync(full) || !statSync(full).isFile()) { missing.push(file); continue; }
    let changes: [number, number][];
    try { changes = changedOldRanges(repoRoot, h.source_sha, file); } catch { missing.push(file); continue; }
    if (!changes.length) continue;
    const hit = cited.find(([a, b]) => changes.some(([x, y]) => x <= b && y >= a));
    if (hit) stale.push({ file, cited: `${file}:${hit[0]}${hit[1] !== hit[0] ? `-${hit[1]}` : ""}` });
    else shifted.push(file);
  }
  const state: Freshness = missing.length ? "broken" : stale.length ? "stale" : shifted.length ? "shifted" : "fresh";
  return { ...base, state, stale, shifted, missing };
}

export function formatFreshness(page: string, r: FreshnessReport): string {
  const L = [`${page}: ${r.state}${r.source_sha ? ` (checked against ${r.source_sha.slice(0, 7)})` : ""}`];
  if (r.reason) L.push(`  ${r.reason}`);
  for (const s of r.stale) L.push(`  cited lines changed: ${s.cited}`);
  for (const f of r.missing) L.push(`  cited file is gone: ${f}`);
  for (const f of r.shifted) L.push(`  changed elsewhere (line numbers may have moved): ${f}`);
  return L.join("\n");
}
