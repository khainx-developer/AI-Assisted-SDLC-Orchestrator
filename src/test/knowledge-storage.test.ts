import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyRemoteKnowledgeDocument,
  configureKnowledgeSync,
  getKnowledgeSyncState,
  listKnowledgeDocuments,
  reconcileKnowledgeDocument,
  readKnowledgeDocument,
  readKnowledgeDocumentForSync,
  readKnowledgeSyncBaseline,
  readProjectSourceFiles,
  recordKnowledgeSyncBaseline,
  writeKnowledgeDocument,
} from "../knowledge/storage.js";
import { createHash } from "node:crypto";

const dataRoot = mkdtempSync(join(tmpdir(), "sdlc-knowledge-storage-"));
process.env.SDLC_DATA_DIR = dataRoot;

const repo = join(dataRoot, "manual-doc-repo");
mkdirSync(join(repo, "docs"), { recursive: true });
mkdirSync(join(repo, "src"), { recursive: true });
writeFileSync(join(repo, "docs", "overview.md"), "# Project overview\nSafe context.\n");
writeFileSync(join(repo, "src", "feature.ts"), "export const feature = true;\n// password = \"sensitive-value-123\";\n");
writeFileSync(join(repo, ".env"), "SECRET=not-for-reading\n");
const git = (...args: string[]) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd: repo, stdio: "ignore" });
git("init", "-q");
git("add", "-A");
git("commit", "-qm", "initial");

test("knowledge docs are scoped, Markdown-only, and require approval to overwrite", () => {
  const first = writeKnowledgeDocument(repo, "architecture/overview.md", "# Architecture\nThe API uses the core module.\n");
  assert.equal(first.path, "architecture/overview.md");
  assert.match(readKnowledgeDocument(repo, first.path).content, /The API uses the core module/);
  assert.deepEqual(listKnowledgeDocuments(repo).documents.map((document) => document.path), ["architecture/overview.md"]);
  assert.throws(() => writeKnowledgeDocument(repo, first.path, "# Replacement"), /overwrite=true/);
  writeKnowledgeDocument(repo, first.path, "# Replacement", true);
  assert.match(readKnowledgeDocument(repo, first.path).content, /# Replacement/);
  const secretDoc = writeKnowledgeDocument(repo, "architecture/publish-check.md", "password = \"sensitive-value-123\"");
  assert.throws(() => readKnowledgeDocumentForSync(repo, secretDoc.path), /secret-like content was detected/);
  assert.match(readKnowledgeDocumentForSync(repo, first.path).content, /# Replacement/);
  assert.throws(() => readKnowledgeDocument(repo, "../outside.md"), /traversal/);
  assert.throws(() => writeKnowledgeDocument(repo, "notes.txt", "text"), /Markdown/);
  assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: repo }).toString(), "");
});

test("source reads are limited to exact named files and redact secret-like values", () => {
  const result = readProjectSourceFiles(repo, ["src/feature.ts"]);
  assert.equal(result.files.length, 1);
  assert.match(result.files[0]!.content, /^1: export const feature/m);
  assert.doesNotMatch(result.files[0]!.content, /sensitive-value-123/);
  assert.match(result.files[0]!.content, /\[REDACTED:assigned-secret\]/);
  assert.throws(() => readProjectSourceFiles(repo, ["src"]), /not a file/);
  assert.throws(() => readProjectSourceFiles(repo, ["../outside.ts"]), /traversal/);
  assert.throws(() => readProjectSourceFiles(repo, ["src/*.ts"]), /exactly/);
  assert.throws(() => readProjectSourceFiles(repo, [".env"]), /not allowed/);
});

test("bidirectional sync stores baselines and protects local edits from stale remote pulls", () => {
  const documentPath = "sync/overview.md";
  const localContent = "# Architecture\nLocal baseline.\n";
  writeKnowledgeDocument(repo, documentPath, localContent);
  const destination = { cloudId: "example.atlassian.net", spaceKey: "ENG", parentContentId: "12345" };
  configureKnowledgeSync(repo, destination);
  const remoteBaseline = "# Architecture\nShared baseline.\n";
  const mapping = recordKnowledgeSyncBaseline(repo, {
    relativePath: documentPath,
    pageId: "67890",
    title: "Architecture overview",
    content: remoteBaseline,
    remoteVersion: 4,
    ...destination,
    confirmed: true,
  });
  assert.equal(mapping.baselineHash, createHash("sha256").update(remoteBaseline).digest("hex"));
  assert.equal(getKnowledgeSyncState(repo).documents[0]!.pageId, "67890");
  assert.equal(readKnowledgeSyncBaseline(repo, documentPath).content, remoteBaseline);
  assert.equal(reconcileKnowledgeDocument(repo, documentPath, remoteBaseline).action, "publish-local");
  assert.throws(() => configureKnowledgeSync(repo, { ...destination, spaceKey: "OTHER" }), /cannot change/);
  assert.throws(() => recordKnowledgeSyncBaseline(repo, {
    relativePath: documentPath,
    pageId: "67890",
    title: "Architecture overview",
    content: remoteBaseline,
    ...destination,
    confirmed: false,
  }), /confirmed=true/);

  const currentLocal = readKnowledgeDocument(repo, documentPath).content;
  const expectedLocalHash = createHash("sha256").update(currentLocal).digest("hex");
  const nextRemote = "# Architecture\nPulled from Confluence.\n";
  applyRemoteKnowledgeDocument(repo, {
    relativePath: documentPath,
    pageId: "67890",
    title: "Architecture overview",
    content: nextRemote,
    expectedLocalHash,
    remoteVersion: 5,
    confirmed: true,
  });
  assert.equal(readKnowledgeDocument(repo, documentPath).content, nextRemote);
  assert.equal(readKnowledgeSyncBaseline(repo, documentPath).content, nextRemote);
  assert.equal(reconcileKnowledgeDocument(repo, documentPath, nextRemote).action, "unchanged");

  writeKnowledgeDocument(repo, documentPath, "# Local edit after fetch\n", true);
  assert.equal(reconcileKnowledgeDocument(repo, documentPath, "# Remote concurrent edit\n").action, "conflict");
  assert.throws(() => applyRemoteKnowledgeDocument(repo, {
    relativePath: documentPath,
    pageId: "67890",
    title: "Architecture overview",
    content: "# Stale remote edit\n",
    expectedLocalHash,
    remoteVersion: 6,
    confirmed: true,
  }), /changed after it was read/);
  assert.equal(readKnowledgeDocument(repo, documentPath).content, "# Local edit after fetch\n");
});
