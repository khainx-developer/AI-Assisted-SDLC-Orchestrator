import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { trustCopilotFolder } from "../common/copilot-trust.js";

test("trusts a folder once while preserving and backing up Copilot settings", () => {
  const home = mkdtempSync(join(tmpdir(), "sdlc-copilot-trust-"));
  const configFile = join(home, "config.json");
  const original = `// Copilot settings\n{\n  "editor": "vscode",\n  "trustedFolders": [],\n}\n`;
  writeFileSync(configFile, original);

  assert.equal(trustCopilotFolder("project", { copilotHome: home }), true);
  assert.equal(trustCopilotFolder("project", { copilotHome: home }), false);
  assert.equal(readFileSync(`${configFile}.bak`, "utf8"), original);
  assert.deepEqual(JSON.parse(readFileSync(configFile, "utf8")), {
    editor: "vscode",
    trustedFolders: [resolve("project")],
  });
});

test("dry-run does not create or modify Copilot config", () => {
  const home = mkdtempSync(join(tmpdir(), "sdlc-copilot-trust-"));
  assert.equal(trustCopilotFolder("project", { copilotHome: home, dryRun: true }), true);
  assert.equal(existsSync(join(home, "config.json")), false);
});

test("refuses malformed config and invalid trustedFolders without overwriting", () => {
  const home = mkdtempSync(join(tmpdir(), "sdlc-copilot-trust-"));
  const configFile = join(home, "config.json");
  writeFileSync(configFile, "{broken");
  assert.throws(() => trustCopilotFolder("project", { copilotHome: home }), /cannot update Copilot CLI trust/);
  assert.equal(readFileSync(configFile, "utf8"), "{broken");

  writeFileSync(configFile, JSON.stringify({ trustedFolders: "not-an-array" }));
  const invalid = readFileSync(configFile, "utf8");
  assert.throws(() => trustCopilotFolder("project", { copilotHome: home }), /trustedFolders must be an array/);
  assert.equal(readFileSync(configFile, "utf8"), invalid);
});
