import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dataRoot = mkdtempSync(join(tmpdir(), "sdlc-publish-plan-"));
process.env.SDLC_DATA_DIR = dataRoot;
process.env.SDLC_CONFIG = join(dataRoot, "config.json");

const { writeKnowledgeDocument, configureKnowledgeSync, recordKnowledgeSyncBaseline, readKnowledgeDocument } = await import("../knowledge/storage.js");
const { planPublish, buildIndexPage, writeIndexPage, INDEX_PATH } = await import("../knowledge/publish-plan.js");
const { knowledgeIndex } = await import("../knowledge/index-block.js");

const repo = join(dataRoot, "Shop API");
mkdirSync(repo, { recursive: true });

const page = (title: string, type: string, summary: string, source = "Source: shop@abc1234") =>
  `# ${title}\n\n${source}\nType: ${type}\nSummary: ${summary}\nApplies to: src/\nStatus: draft\n\n## Rules\n- a fact\n`;

test("titles are '<project> / <page title>' and labels name the kind and the project", () => {
  writeKnowledgeDocument(repo, "orders.md", page("Orders", "domain-rules", "Order rules."));
  const plan = planPublish(repo);
  assert.equal(plan.project, "Shop API");
  assert.equal(plan.items[0].title, "Shop API / Orders");
  assert.deepEqual(plan.items[0].labels, ["sdlc-knowledge", "sdlc-type-domain-rules", "sdlc-project-shop-api"]);
  assert.equal(plan.items[0].rename, false);
  assert.equal(plan.summary.create, 1);
});

test("two pages with the same title get their path added, so Confluence titles stay unique", () => {
  writeKnowledgeDocument(repo, "a/rules.md", page("Rules", "domain-rules", "A."));
  writeKnowledgeDocument(repo, "b/rules.md", page("Rules", "domain-rules", "B."));
  const titles = planPublish(repo).items.map((i) => i.title);
  assert.ok(titles.includes("Shop API / Rules (a/rules.md)") && titles.includes("Shop API / Rules (b/rules.md)"));
});

test("a page already synced under its old path-style title is flagged as a rename, not changed", () => {
  configureKnowledgeSync(repo, { cloudId: "c", spaceKey: "S", parentContentId: "1" });
  const content = readKnowledgeDocument(repo, "orders.md").content;
  recordKnowledgeSyncBaseline(repo, { relativePath: "orders.md", pageId: "77", title: "orders.md", content, cloudId: "c", spaceKey: "S", parentContentId: "1", confirmed: true });
  const item = planPublish(repo).items.find((i) => i.path === "orders.md")!;
  assert.deepEqual([item.page_id, item.current_title, item.rename], ["77", "orders.md", true]);
  assert.equal(planPublish(repo).summary.rename, 1);
  // once it is recorded under the new title the plan stops reporting a rename
  recordKnowledgeSyncBaseline(repo, { relativePath: "orders.md", pageId: "77", title: "Shop API / Orders", content, cloudId: "c", spaceKey: "S", parentContentId: "1", confirmed: true });
  assert.equal(planPublish(repo).items.find((i) => i.path === "orders.md")!.rename, false);
});

test("the index page lists every page with its summary, escapes table characters, and never lists itself", () => {
  writeKnowledgeDocument(repo, "pipes.md", page("Pipes", "how-to", "Use a | b | c."));
  const { path, content } = writeIndexPage(repo);
  assert.equal(path, INDEX_PATH);
  assert.ok(content.startsWith("# Knowledge index"));
  assert.ok(content.includes("| Orders | domain-rules | Order rules. |"));
  assert.ok(content.includes("Use a \\| b \\| c."));
  assert.ok(content.includes("Do not edit it"));
  assert.ok(!content.includes("| Knowledge index |"), "does not list itself");
  assert.equal(buildIndexPage(repo), content, "regenerating with the index present gives the same text");
});

test("the generated index is planned as an overview page and is not in the workers' knowledge index", () => {
  const item = planPublish(repo).items.find((i) => i.path === INDEX_PATH)!;
  assert.equal(item.title, "Shop API / Knowledge index");
  assert.ok(item.labels.includes("sdlc-type-overview"));
  assert.ok(!knowledgeIndex(repo)!.text.includes("_index.md"));
});
