/**
 * Deterministic checks on a stage artifact. They test the SHAPE a skill promises (template headings, testable
 * criteria, labelled open questions, no design talk in a requirement), not whether the content is wise.
 * Cheap, repeatable, and good at catching a prompt change that breaks the contract the rest of the tooling relies on.
 */
export interface EvalChecks {
  /** the artifact's first line must start with this, e.g. "# Requirement:" */
  title_prefix?: string;
  /** `## Heading` lines that must be present (exact text) */
  headings?: string[];
  /** headings that must NOT be present (e.g. a section the skill says to omit) */
  forbidden_headings?: string[];
  /** case-insensitive substrings the artifact must contain */
  must_include?: string[];
  /** regexes (case-insensitive) the artifact must not match, e.g. design words in a requirement */
  must_not_match?: string[];
  /** under this heading there must be at least N list items (bullets or numbered) */
  min_items?: Record<string, number>;
  /** "labelled": Open Questions is either "None." or every item is `- **Qn.**` */
  open_questions?: "labelled";
  /** at least this many `- **Qn.**` questions (a vague ticket must not get "None.") */
  min_questions?: number;
  /** no `- [a, b, c]` bracketed lists: the skills ask for one bullet per item */
  bullets_not_bracketed?: boolean;
  /** the artifact must be exactly this text (task-breakdown's "no split" answer) */
  exact?: string;
  max_chars?: number;
}

export interface EvalCase {
  name: string;
  skill: string;
  /** the TASK INPUT the session receives */
  instructions: string;
  /** files created in the throwaway repo the session reads, path -> content */
  files?: Record<string, string>;
  checks: EvalChecks;
}

export interface CheckResult { pass: boolean; failures: string[] }

const NL = /\r?\n/;

/** The text under `## <heading>` up to the next `## ` heading, or null when the heading is absent. */
export function section(md: string, heading: string): string | null {
  const lines = md.split(NL);
  const start = lines.findIndex((l) => l.trim() === `## ${heading}`);
  if (start < 0) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^## /.test(l));
  return (end < 0 ? rest : rest.slice(0, end)).join("\n");
}

const isItem = (l: string) => /^\s*(?:[-*]|\d+[.)])\s+\S/.test(l);
const isQuestion = (l: string) => /^[-*]\s+\*\*Q\d+\.\*\*\s+\S/.test(l);

export function checkArtifact(artifact: string, c: EvalChecks): CheckResult {
  const f: string[] = [];
  const md = artifact.trim();
  if (!md) return { pass: false, failures: ["artifact is empty"] };

  if (c.exact !== undefined) {
    if (md !== c.exact) f.push(`expected exactly ${JSON.stringify(c.exact)}`);
    return { pass: !f.length, failures: f };
  }
  if (c.title_prefix && !md.split(NL)[0].startsWith(c.title_prefix)) f.push(`first line should start with "${c.title_prefix}"`);
  for (const h of c.headings ?? []) if (section(md, h) === null) f.push(`missing heading "## ${h}"`);
  for (const h of c.forbidden_headings ?? []) if (section(md, h) !== null) f.push(`heading "## ${h}" should have been omitted`);
  for (const s of c.must_include ?? []) if (!md.toLowerCase().includes(s.toLowerCase())) f.push(`should mention "${s}"`);
  for (const r of c.must_not_match ?? []) if (new RegExp(r, "i").test(md)) f.push(`must not match /${r}/`);
  for (const [h, n] of Object.entries(c.min_items ?? {})) {
    const body = section(md, h);
    const count = body === null ? 0 : body.split(NL).filter(isItem).length;
    if (count < n) f.push(`"## ${h}" needs at least ${n} item(s), found ${count}`);
  }
  if (c.open_questions === "labelled") {
    const body = section(md, "Open Questions");
    if (body !== null && !/^\s*None\.?\s*$/m.test(body)) {
      const top = body.split(NL).filter((l) => /^[-*]\s/.test(l));
      if (!top.length) f.push('"## Open Questions" has neither "None." nor any question');
      for (const l of top) if (!isQuestion(l)) f.push(`open question not in "- **Qn.** text" format: ${l.trim().slice(0, 60)}`);
    }
  }
  if (c.min_questions) {
    const n = (section(md, "Open Questions") ?? "").split(NL).filter(isQuestion).length;
    if (n < c.min_questions) f.push(`needs at least ${c.min_questions} open question(s), found ${n}`);
  }
  if (c.bullets_not_bracketed) for (const l of md.split(NL)) if (/^\s*[-*]\s+\[[^\]]*,[^\]]*\]\s*$/.test(l)) f.push(`bracketed list instead of bullets: ${l.trim().slice(0, 60)}`);
  if (c.max_chars && md.length > c.max_chars) f.push(`too long: ${md.length} characters (limit ${c.max_chars})`);
  return { pass: !f.length, failures: f };
}
