import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const dir = mkdtempSync(join(tmpdir(), "sdlc-os-"));
process.env.SDLC_DATA_DIR = join(dir, "data");
mkdirSync(process.env.SDLC_DATA_DIR);

// Fake CLI: writes the files named in <dir>/plan.json into its working directory and prints the text from <dir>/say.txt.
const fake = join(dir, "fake-coder.mjs");
const plan = join(dir, "plan.json");
const say = join(dir, "say.txt");
writeFileSync(fake, `
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
const files = JSON.parse(readFileSync(${JSON.stringify(plan)}, "utf8"));
for (const [p, body] of Object.entries(files)) { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, body); }
console.log(readFileSync(${JSON.stringify(say)}, "utf8"));
`);
const cfgPath = join(dir, "config.json");
const writeCfg = (o: object = {}) => writeFileSync(cfgPath, JSON.stringify({ default_platform: "fake", platforms: { fake: { command: process.execPath, args: [fake], prompt_via: "file" } }, ...o }));
writeCfg();
process.env.SDLC_CONFIG = cfgPath;

const repo = join(dir, "repo");
mkdirSync(repo);
execFileSync("git", ["init", "-q"], { cwd: repo });
execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"], { cwd: repo });

const { startAgentDispatch, getDispatch } = await import("../dispatch/runner.js");
const { scanFilesForSecrets } = await import("../common/redact.js");

async function code(files: object, text: string, kind: "coding" | "analysis" = "coding") {
  writeFileSync(plan, JSON.stringify(files));
  writeFileSync(say, text);
  const m = await startAgentDispatch({ kind, task_id: "T-os", platformId: "fake", req: { projectRoot: repo, extraReadRoots: [], prompt: "x" } });
  for (let i = 0; i < 100 && getDispatch(m.dispatch_id).status === "in-flight"; i++) await new Promise((r) => setTimeout(r, 100));
  return getDispatch(m.dispatch_id);
}

const AWS = "AKIA" + "ABCDEFGHIJKLMNOP"; // assembled so this file holds no complete key
const ASSIGNED = 'const apiToken = "' + "Zx9" + 'qLm2Pv8RtYw4Hs";';

test("a secret in what the session printed is flagged by kind and count, the value is never stored as a count", async () => {
  const d = await code({}, `done. I used the key ${AWS} for the check`, "analysis");
  assert.deepEqual(d.secrets_in_output, { "aws-access-key": 1 });
  assert.equal(JSON.stringify({ a: d.secrets_in_output }).includes(AWS), false);
  assert.equal(d.status, "completed", "a warning, not a failure");
  assert.ok(d.output!.includes(AWS), "the text is kept as printed: this is a warning, not an edit");
});

test("a secret in a file the coding session wrote is flagged by path and kind; clean files and fake examples are not", async () => {
  const d = await code({ "src/config.js": `export const k = "${AWS}";\n${ASSIGNED}\n`, "src/ok.js": "export const n = 1;\nconst password = process.env.DB_PASSWORD;\n" }, "done");
  assert.deepEqual(Object.keys(d.secrets_in_files ?? {}), ["src/config.js"]);
  assert.deepEqual(d.secrets_in_files!["src/config.js"], { "aws-access-key": 1, "assigned-secret": 1 });
  assert.equal(d.status, "completed");
  assert.equal(d.secrets_in_output, undefined);
});

test("a clean session carries no secret fields, and switching redaction off for the repo switches the scan off", async () => {
  const clean = await code({ "src/a.js": "export const a = 1;\n" }, "all good");
  assert.equal(clean.secrets_in_output, undefined);
  assert.equal(clean.secrets_in_files, undefined);

  writeCfg({ projects: { [repo]: { redact_secrets: false } } });
  const off = await code({ "src/b.js": `export const k = "${AWS}";\n` }, `key ${AWS}`);
  assert.equal(off.secrets_in_output, undefined);
  assert.equal(off.secrets_in_files, undefined);
  writeCfg();
});

test("the file scan skips binary and oversized files, and caps how many it reads", () => {
  writeFileSync(join(repo, "bin.dat"), Buffer.concat([Buffer.from(AWS), Buffer.from([0, 1, 2])]));
  writeFileSync(join(repo, "big.txt"), AWS + "x".repeat(1024 * 1024 + 1));
  writeFileSync(join(repo, "hit.txt"), AWS);
  const r = scanFilesForSecrets(repo, ["bin.dat", "big.txt", "hit.txt", "missing.txt"]);
  assert.deepEqual(Object.keys(r.found), ["hit.txt"]);
  assert.equal(r.scanned, 1);
  assert.equal(r.skipped, 3);
  const many = scanFilesForSecrets(repo, Array.from({ length: 250 }, (_, i) => `nope${i}.txt`));
  assert.equal(many.skipped, 250, "50 beyond the cap plus 200 unreadable");
});
