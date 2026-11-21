import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dataRoot = mkdtempSync(join(tmpdir(), "sdlc-knowledge-index-"));
process.env.SDLC_DATA_DIR = dataRoot;
process.env.SDLC_CONFIG = join(dataRoot, "config.json");

const { writeKnowledgeDocument } = await import("../knowledge/storage.js");
const { knowledgeIndex } = await import("../knowledge/index-block.js");
const { analysisPrompt, codingPrompt, testAuthoringPrompt } = await import("../dispatch/prompt.js");
const { knowledgeInPrompts } = await import("../config/config.js");

const repo = join(dataRoot, "shop");
mkdirSync(repo, { recursive: true });

const page = (title: string, type: string, applies: string, summary: string, sha = "abc1234") =>
  `# ${title}\n\nSource: shop@${sha}\nType: ${type}\nSummary: ${summary}\nApplies to: ${applies}\nStatus: draft\n\n## Rules\n- a fact \`src/x.ts:1\`\n`;

test("a project with no pages gets no block and no extra read root", () => {
  assert.equal(knowledgeIndex(repo), null);
});

test("the index lists each page with type, scope, checked commit and summary, and names the folder", () => {
  writeKnowledgeDocument(repo, "orders.md", page("Orders", "domain-rules", "src/orders", "Order rules. Read before changing totals."));
  writeKnowledgeDocument(repo, "billing.md", page("Billing", "module", "src/billing", "How invoices are built."));
  const k = knowledgeIndex(repo)!;
  assert.ok(k.text.includes("orders.md (domain-rules; applies to src/orders; checked at abc1234): Order rules. Read before changing totals."));
  assert.ok(k.text.includes(k.dir));
  assert.equal(k.listed, 2);
});

test("pages that cover the task's files come first", () => {
  const k = knowledgeIndex(repo, ["src/orders/total.ts"])!;
  assert.ok(k.text.indexOf("orders.md") < k.text.indexOf("billing.md"));
  const other = knowledgeIndex(repo, ["src/billing/invoice.ts"])!;
  assert.ok(other.text.indexOf("billing.md") < other.text.indexOf("orders.md"));
});

test("a page with no header still appears, marked as having no Source commit", () => {
  writeKnowledgeDocument(repo, "notes.md", "# Loose notes\n\nsome text\n");
  assert.ok(knowledgeIndex(repo)!.text.includes("notes.md (no Source commit): Loose notes"));
});

test("the index is capped and says how many pages were left out", () => {
  for (let i = 0; i < 30; i++) writeKnowledgeDocument(repo, `p${String(i).padStart(2, "0")}.md`, page(`Page ${i}`, "module", `src/m${i}`, "x".repeat(150)));
  const k = knowledgeIndex(repo, [], 1000)!;
  assert.ok(k.text.length <= 1000 + 120, "stays near the cap");
  assert.ok(k.omitted > 0 && k.text.includes(`${k.omitted} more pages not listed`));
});

test("prompts carry the block with the code-wins rule, and are unchanged without it", () => {
  const withK = analysisPrompt({ skill: "s", skillBody: "BODY", instructions: "do", projectRoot: repo, readRoots: [], knowledge: "- orders.md (x)" });
  assert.ok(withK.includes("=== KNOWLEDGE") && withK.includes("- orders.md (x)") && withK.includes("the code is right"));
  const without = analysisPrompt({ skill: "s", skillBody: "BODY", instructions: "do", projectRoot: repo, readRoots: [] });
  assert.ok(!without.includes("KNOWLEDGE"));
  const coding = codingPrompt({ instructions: "do", projectRoot: repo, branch: "story/x", readRoots: [], knowledge: "- orders.md (x)" });
  assert.ok(coding.includes("- orders.md (x)"));
  assert.ok(!codingPrompt({ instructions: "do", projectRoot: repo, branch: "story/x", readRoots: [] }).includes("KNOWLEDGE"));
  assert.ok(testAuthoringPrompt({ instructions: "do", projectRoot: repo, branch: "story/x", readRoots: [], knowledge: "- orders.md (x)" }).includes("- orders.md (x)"));
});

test("it is on by default and can be switched off for one repo or for all", () => {
  assert.equal(knowledgeInPrompts(repo), true);
  writeFileSync(process.env.SDLC_CONFIG!, JSON.stringify({ default_platform: "claude", platforms: {}, knowledge_in_prompts: false }));
  assert.equal(knowledgeInPrompts(repo), false);
  writeFileSync(process.env.SDLC_CONFIG!, JSON.stringify({ default_platform: "claude", platforms: {}, knowledge_in_prompts: false, projects: { [repo]: { knowledge_in_prompts: true } } }));
  assert.equal(knowledgeInPrompts(repo), true);
});
