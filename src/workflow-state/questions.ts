/**
 * Open Questions are read from, and answered into, the Markdown stage document by plain text handling: no model call is needed
 * to show them to the user or to record what they decided.
 */
export interface OpenQuestion {
  id: string; // Q1, Q2... stable once written into the document
  question: string;
  why: string | null;
  suggested: string | null;
}

interface Block {
  start: number; // [start, end) is replaced when the questions change
  end: number;
  legacy: boolean; // old `Open Questions: [ ... ]` template rather than a `## Open Questions` heading
  body: string[];
}

const clean = (s: string) => s.replace(/\*\*/g, "").replace(/,\s*$/, "").trim();
const orNull = (s: string) => (/^(none\.?|n\/a|-)?$/i.test(s.trim()) ? null : s.trim());

function findBlock(lines: string[]): Block | null {
  for (let i = 0; i < lines.length; i++) {
    if (/^##\s+Open Questions\s*$/i.test(lines[i])) {
      let end = i + 1;
      while (end < lines.length && !/^#{1,2}\s/.test(lines[end])) end++;
      return { start: i, end, legacy: false, body: lines.slice(i + 1, end) };
    }
    if (/^Open Questions:\s*\[\s*$/i.test(lines[i])) {
      let close = i + 1;
      while (close < lines.length && !lines[close].trim().startsWith("]")) close++;
      if (close >= lines.length) return null;
      return { start: i, end: close + 1, legacy: true, body: lines.slice(i + 1, close) };
    }
  }
  return null;
}

function parseBody(body: string[], legacy: boolean): OpenQuestion[] {
  const out: OpenQuestion[] = [];
  let cur: OpenQuestion | null = null;
  for (const raw of body) {
    const line = raw.replace(/\s+$/, "");
    if (!line.trim() || /^\(/.test(line.trim()) || /^None\.?$/i.test(line.trim())) continue;
    const why = /^\s+[-*]\s+Why it matters:\s*(.*)$/i.exec(line);
    const sug = /^\s+[-*]\s+Suggested(?: default)?:\s*(.*)$/i.exec(line);
    if (cur && why) { cur.why = orNull(why[1]); continue; }
    if (cur && sug) { cur.suggested = orNull(sug[1]); continue; }
    let id: string | null = null, text: string | null = null, m: RegExpExecArray | null;
    if ((m = /^[-*]\s+\*\*Q(\d+)\.\*\*\s+(.*)$/.exec(line))) { id = `Q${m[1]}`; text = m[2]; }
    else if (legacy) text = line.trim().replace(/^[-*]\s+/, "");
    else if ((m = /^\d+\.\s+(.*)$/.exec(line)) || (m = /^[-*]\s+(.*)$/.exec(line))) text = m[1];
    if (text === null) continue; // an unlabelled continuation line: ignore
    cur = { id: id ?? `Q${out.length + 1}`, question: clean(text), why: null, suggested: null };
    out.push(cur);
  }
  return out;
}

export function parseOpenQuestions(markdown: string): OpenQuestion[] {
  const block = findBlock(markdown.split(/\r?\n/));
  return block ? parseBody(block.body, block.legacy) : [];
}

function renderQuestions(qs: OpenQuestion[]): string {
  if (!qs.length) return "No open questions.";
  return qs.flatMap((q) => [
    `${q.id}. ${q.question}`,
    ...(q.why ? [`    Why it matters: ${q.why}`] : []),
    `    Suggested: ${q.suggested ?? "none"}`,
  ]).join("\n");
}

/**
 * The whole chat reply for an open-questions turn, built by the server so the orchestrating model prints it instead of writing it:
 * state line, the questions, how to answer, and the numbered Options for what to do next.
 */
export function renderGuidance(o: { task_id: string; stage: string; version: number; path: string; qs: OpenQuestion[]; nextStage?: string; recorded?: string }): string {
  const { qs } = o;
  const suggested = qs.filter((q) => q.suggested).map((q) => q.id);
  const needOwn = qs.filter((q) => !q.suggested).map((q) => q.id);
  const first = qs[0]?.id ?? "Q1", second = qs[1]?.id;
  const head = `Task ${o.task_id} · stage: ${o.stage} (v${o.version}) · waiting for: you`;
  const options = qs.length
    ? [
        `1. answer the open questions   reply with the number and your answer, e.g. "${first}: yes${second ? `, ${second}: only the tool panel` : ""}"; answer some now and the rest later`,
        ...(suggested.length
          ? [`2. accept the suggested answers   say "accept ${suggested.join(", ")}"${suggested.length > 1 ? ' or "accept all suggestions"' : ""}${needOwn.length ? `; ${needOwn.join(", ")} need your own answer` : ""}`]
          : []),
        `${suggested.length ? 3 : 2}. show full text   print the whole ${o.stage} document (also at ${o.path})`,
        `${suggested.length ? 4 : 3}. cancel task   stop here, keeping history`,
      ]
    : [
        `1. confirm   accept this ${o.stage} and move to ${o.nextStage ?? "the next stage"}`,
        `2. work the decisions into the document   a revision pass that updates scope and criteria; only worth it if an answer changed them`,
        `3. show full text   print the whole ${o.stage} document (also at ${o.path})`,
        `4. cancel task   stop here, keeping history`,
      ];
  return [
    ...(o.recorded ? [o.recorded, ""] : []),
    head,
    ...(qs.length ? ["", `Open questions (${qs.length}):`, renderQuestions(qs)] : ["", "No open questions remain."]),
    "",
    "Options:",
    ...options,
  ].join("\n");
}

const renderBlock = (qs: OpenQuestion[]) => [
  "## Open Questions",
  ...(qs.length ? qs.flatMap((q) => [`- **${q.id}.** ${q.question}`, ...(q.why ? [`  - Why it matters: ${q.why}`] : []), `  - Suggested default: ${q.suggested ?? "none"}`]) : ["None."]),
  "",
];

export interface Answer { id: string; answer: string }

/**
 * Move answered questions out of Open Questions into a `## Decisions` section. Returns the new document and what remains open.
 * `accept` ids take the question's own suggested default as the answer (only valid when it has one).
 */
export function applyAnswers(markdown: string, answers: Answer[], accept: string[]): { markdown: string; remaining: OpenQuestion[]; decided: Answer[] } {
  const lines = markdown.split(/\r?\n/);
  const block = findBlock(lines);
  if (!block) throw new Error("this document has no Open Questions section");
  const qs = parseBody(block.body, block.legacy);
  const byId = new Map(qs.map((q) => [q.id.toUpperCase(), q]));
  const decided: Answer[] = [];
  for (const a of answers) {
    if (!byId.has(a.id.toUpperCase())) throw new Error(`no open question ${a.id} (open: ${qs.map((q) => q.id).join(", ") || "none"})`);
    if (!a.answer.trim()) throw new Error(`empty answer for ${a.id}`);
    decided.push({ id: byId.get(a.id.toUpperCase())!.id, answer: a.answer.trim() });
  }
  for (const id of accept) {
    const q = byId.get(id.toUpperCase());
    if (!q) throw new Error(`no open question ${id} (open: ${qs.map((x) => x.id).join(", ") || "none"})`);
    if (!q.suggested) throw new Error(`${q.id} has no suggested answer to accept; give an answer`);
    if (!decided.some((d) => d.id === q.id)) decided.push({ id: q.id, answer: q.suggested });
  }
  if (!decided.length) throw new Error("no answers given");
  const done = new Set(decided.map((d) => d.id));
  const remaining = qs.filter((q) => !done.has(q.id));
  const decisionLines = decided.map((d) => `- **${d.id}.** ${byId.get(d.id.toUpperCase())!.question} → ${d.answer} *(decided by the user)*`);

  // existing Decisions section: append to it; otherwise add one just above Open Questions
  const dec = lines.findIndex((l) => /^##\s+Decisions\s*$/i.test(l));
  const edits: { at: number; remove: number; add: string[] }[] = [{ at: block.start, remove: block.end - block.start, add: renderBlock(remaining) }];
  if (dec >= 0) {
    let end = dec + 1;
    while (end < lines.length && !/^#{1,2}\s/.test(lines[end])) end++;
    while (end > dec + 1 && !lines[end - 1].trim()) end--;
    edits.push({ at: end, remove: 0, add: decisionLines });
  } else edits[0].add = ["## Decisions", ...decisionLines, "", ...edits[0].add];
  for (const e of edits.sort((a, b) => b.at - a.at)) lines.splice(e.at, e.remove, ...e.add);
  return { markdown: lines.join("\n").replace(/\n{3,}/g, "\n\n"), remaining, decided };
}
