import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, normalize, relative } from "node:path";

/**
 * Claim verification support. Code splits a module page into claims (one bullet with its citations) and attaches the
 * cited lines, so the verifying model reads excerpts instead of exploring the repo, and cannot be misled by what it
 * did not look at. The model's verdicts are parsed and counted here.
 */
export interface Claim { id: string; section: string; text: string; cites: { ref: string; excerpt: string }[] }
export type Verdict = "supported" | "partial" | "unsupported";
export interface VerdictRow { id: string; verdict: Verdict; reason: string }

const CITE = /`([^`\s:]+):(\d+)(?:-(\d+))?`/g;
const FACT = new Set(["Purpose", "Responsibilities", "Public surface", "Dependencies", "Data and configuration", "Runtime and deployment", "Build and test", "Known risks and technical debt"]);
const MAX_EXCERPT = 40;

function excerpt(repoRoot: string, path: string, a: number, b: number): string {
  const p = path.split("\\").join("/");
  const full = join(repoRoot, p);
  if (isAbsolute(p) || relative(repoRoot, normalize(full)).startsWith("..") || !existsSync(full) || !statSync(full).isFile()) return "(file not found)";
  const lines = readFileSync(full, "utf8").split(/\r?\n/);
  const end = Math.min(b, a + MAX_EXCERPT - 1, lines.length);
  const out = lines.slice(Math.max(a, 1) - 1, end).map((l, i) => `${Math.max(a, 1) + i}: ${l}`);
  return out.join("\n") + (b > end ? "\n(excerpt cut)" : "");
}

export function extractClaims(repoRoot: string, md: string): Claim[] {
  const claims: Claim[] = [];
  let section = "";
  let buf: string[] = [];
  const flush = () => {
    if (!buf.length) return;
    const text = buf.join(" ").trim();
    const cites = [...text.matchAll(CITE)].map((c) => ({ ref: c[0].slice(1, -1), excerpt: excerpt(repoRoot, c[1], Number(c[2]), Number(c[3] ?? c[2])) }));
    if (cites.length) claims.push({ id: `C${claims.length + 1}`, section, text: text.replace(CITE, "").replace(/\s+/g, " ").replace(/(\s*[;,])+\s*$/, "").trim(), cites });
    buf = [];
  };
  for (const line of md.split(/\r?\n/)) {
    const h = line.match(/^(#{1,3})\s+(.+?)\s*$/);
    if (h) { flush(); if (h[1].length <= 2) section = h[2]; continue; } // "###" subsections stay in their "##" section
    if (!FACT.has(section)) continue;
    if (/^\s*[-*]\s/.test(line)) { flush(); buf = [line.replace(/^\s*[-*]\s+/, "")]; }
    else if (/^\S/.test(line) && !buf.length && section === "Purpose") buf = [line];
    else if (buf.length && line.trim()) buf.push(line.trim());
    else flush();
  }
  flush();
  return claims;
}

export function formatClaims(claims: Claim[]): string {
  return claims.map((c) => `${c.id} [${c.section}] ${c.text}\n` + c.cites.map((x) => `  evidence ${x.ref}\n` + x.excerpt.split("\n").map((l) => "    | " + l).join("\n")).join("\n")).join("\n\n");
}

/** Parses lines like `C3 | partial | the code also sends SMS`. Unrecognised lines are ignored. */
export function parseVerdicts(text: string): VerdictRow[] {
  const rows: VerdictRow[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*[-*|]?\s*(C\d+)\s*\|\s*(supported|partial|unsupported)\s*\|?\s*(.*)$/i);
    if (m) rows.push({ id: m[1], verdict: m[2].toLowerCase() as Verdict, reason: m[3].replace(/\|\s*$/, "").trim() });
  }
  return rows;
}

export interface VerdictReport { total: number; supported: number; flagged: (VerdictRow & { text: string })[]; unanswered: string[]; ok: boolean }

export function summariseVerdicts(claims: Claim[], rows: VerdictRow[]): VerdictReport {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const flagged: VerdictReport["flagged"] = [];
  const unanswered: string[] = [];
  let supported = 0;
  for (const c of claims) {
    const r = byId.get(c.id);
    if (!r) unanswered.push(c.id);
    else if (r.verdict === "supported") supported++;
    else flagged.push({ ...r, text: c.text });
  }
  return { total: claims.length, supported, flagged, unanswered, ok: !!claims.length && !flagged.length && !unanswered.length };
}

export function formatVerdictReport(r: VerdictReport): string {
  const L = [`${r.supported} of ${r.total} claims supported by their cited lines.`];
  for (const f of r.flagged) L.push(`${f.id} ${f.verdict}: "${f.text.slice(0, 120)}" - ${f.reason}`);
  if (r.unanswered.length) L.push(`No verdict for: ${r.unanswered.join(", ")}`);
  return L.join("\n");
}

/**
 * The block handed back to the writing skill: the page as written, then the findings of the code check and of the
 * verifier. The writer must fix each by narrowing the statement to what the lines show, citing better evidence, or
 * moving it to Open Questions; it must not add new claims.
 */
export function repairBlock(page: string, codeFindings: string, verdicts: VerdictReport | null): string {
  const L = ["REPAIR", "Below is a page you wrote, then the problems found by checks. Return the whole corrected page in the same template.", "For each problem: narrow the statement to what the cited lines show, cite the lines that do show it (read the file), or remove it and put the question under Open Questions. Do not add new claims. Do not change statements that were not flagged.", "", "PAGE", page.trim(), "", "PROBLEMS"];
  if (codeFindings.trim()) L.push(codeFindings.trim());
  for (const f of verdicts?.flagged ?? []) L.push(`${f.verdict}: "${f.text}" - ${f.reason}`);
  for (const id of verdicts?.unanswered ?? []) L.push(`No verdict for claim ${id}`);
  return L.join("\n");
}
