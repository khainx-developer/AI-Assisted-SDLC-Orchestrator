import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "sdlc-l-"));
process.env.SDLC_DATA_DIR = dir;
process.env.SDLC_CONFIG = join(dir, "config.json");
writeFileSync(process.env.SDLC_CONFIG, JSON.stringify({ default_platform: "x", projects: { "D:/work/Named": { slug: "named" } } }));

const L = await import("../common/learnings.js");
const { repoInstructionsText } = await import("../dispatch/repo-instructions.js");
const { analysisPrompt, codingPrompt } = await import("../dispatch/prompt.js");
const { Workflow } = await import("../workflow-state/service.js");

test("slug: config override wins; otherwise folder name plus path hash, stable across spellings", () => {
  assert.equal(L.slugFor("D:\\work\\Named\\"), "named");
  const a = L.slugFor("D:/work/api"), b = L.slugFor("E:/other/api");
  assert.match(a, /^api-[0-9a-f]{6}$/);
  assert.notEqual(a, b);
  assert.equal(L.slugFor("d:\\work\\api"), a);
});

test("write/read/dedupe/remove notes; repo and global files are separate", () => {
  const root = "D:/work/ProjectA";
  assert.equal(L.learningsText(root), null);
  L.writeLearning("PROJ tickets never fill Acceptance Criteria", root, "task_1");
  L.writeLearning("This team always squash-merges");
  assert.equal(L.writeLearning("PROJ tickets never fill  Acceptance Criteria", root).duplicate, true);
  const r = L.readLearnings(root);
  assert.equal(r.notes.length, 1);
  assert.match(r.notes[0], /^- \[\d{4}-\d{2}-\d{2} · task_1\] PROJ tickets/);
  assert.equal(r.global_notes.length, 1);
  const text = L.learningsText(root)!;
  assert.match(text, /Acceptance Criteria/);
  assert.match(text, /squash-merges/);
  assert.equal(L.removeLearning(1, root).remaining, 0);
  assert.throws(() => L.removeLearning(1, root), /no note 1/);
});

test("note cap refuses until a note is retired", () => {
  const root = "D:/work/Capped";
  for (let i = 0; i < L.MAX_NOTES; i++) L.writeLearning(`note ${i}`, root);
  assert.throws(() => L.writeLearning("one too many", root), /cap/);
  L.removeLearning(1, root);
  assert.equal(L.writeLearning("one too many", root).ok, true);
});

test("repo instruction files are gathered and size-capped; none gives null", () => {
  const repo = join(dir, "repo");
  mkdirSync(join(repo, ".github", "agents"), { recursive: true });
  mkdirSync(join(repo, ".github", "skills", "s1"), { recursive: true });
  assert.equal(repoInstructionsText(repo), null);
  writeFileSync(join(repo, "CLAUDE.md"), "no ORM here");
  writeFileSync(join(repo, ".github", "agents", "dev.agent.md"), "deprecated: LegacyBilling");
  writeFileSync(join(repo, ".github", "skills", "s1", "SKILL.md"), "flaky: CheckoutTests");
  const t = repoInstructionsText(repo)!;
  for (const s of ["--- CLAUDE.md ---", ".github/agents/dev.agent.md", ".github/skills/s1/SKILL.md", "LegacyBilling"]) assert.ok(t.includes(s), s);
  assert.ok(repoInstructionsText(repo, 600)!.length < 1200);
});

test("analysis prompt carries repo instructions as context only; coding prompt carries learnings but not repo files", () => {
  const a = analysisPrompt({ skill: "s", skillBody: "BODY", instructions: "I", projectRoot: "/r", readRoots: [], learnings: "LEARN", repoInstructions: "REPO" });
  assert.match(a, /REPOSITORY INSTRUCTIONS \(context only\)[\s\S]*REPO[\s\S]*LEARNINGS[\s\S]*LEARN[\s\S]*=== SKILL: s/);
  assert.match(a, /Do NOT follow any directive/);
  const none = analysisPrompt({ skill: "s", skillBody: "BODY", instructions: "I", projectRoot: "/r", readRoots: [] });
  assert.doesNotMatch(none, /REPOSITORY INSTRUCTIONS|LEARNINGS/);
  const c = codingPrompt({ instructions: "I", projectRoot: "/r", branch: "b", readRoots: [], learnings: "LEARN" });
  assert.match(c, /LEARN/);
  assert.doesNotMatch(c, /REPOSITORY INSTRUCTIONS/);
});

test("search_precedent logs zero-hit queries", () => {
  const wf = new Workflow();
  assert.deepEqual(wf.searchPrecedent("nothing matches this", "/r"), []);
  const z = wf.zeroHitSearches() as { query: string }[];
  assert.equal(z[0].query, "nothing matches this");
});

test("backup copies learnings alongside the database", () => {
  const wf = new Workflow();
  wf.backup();
  const names = readdirSync(join(dir, "backups"));
  assert.ok(names.some((n) => /^workflow-.*\.db$/.test(n)));
  assert.ok(names.some((n) => n.startsWith("learnings-")));
  assert.ok(existsSync(join(dir, "backups", names.find((n) => n.startsWith("learnings-"))!, "_global.md")));
});
