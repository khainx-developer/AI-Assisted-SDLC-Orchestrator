import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const dir = mkdtempSync(join(tmpdir(), "sdlc-rs-"));
process.env.SDLC_DATA_DIR = join(dir, "data");
mkdirSync(process.env.SDLC_DATA_DIR);
const cfgPath = join(dir, "config.json");
const repo = join(dir, "repo");
mkdirSync(repo);
execFileSync("git", ["init", "-q"], { cwd: repo });
execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"], { cwd: repo });
const writeCfg = (o: object) => writeFileSync(cfgPath, JSON.stringify(o));
process.env.SDLC_CONFIG = cfgPath;
writeCfg({});

const { restrictionsFor, DEFAULT_DENY_READ, DEFAULT_DENY_COMMANDS } = await import("../common/restrictions.js");
const { PLATFORMS } = await import("../dispatch/platforms.js");

const base = { prompt: "p", promptFile: join(dir, "d_00000000", "prompt.md"), projectRoot: repo, extraReadRoots: [] as string[] };
const on = (extra: object = {}) => ({ enabled: true, deny_read: [".env", "*.pem"], deny_commands: ["sudo", "git push"], sandbox: false, ...extra });

test("restrictions default to secret files and a few commands, lists add up across global and repo, switches are overridden by the repo", () => {
  const d = restrictionsFor(repo);
  assert.equal(d.enabled, true);
  assert.deepEqual(d.deny_read, DEFAULT_DENY_READ);
  assert.deepEqual(d.deny_commands, DEFAULT_DENY_COMMANDS);
  assert.ok(!d.deny_read.includes(".env.example") && !d.deny_read.includes(".env.*"), "example files stay readable");
  assert.equal(d.sandbox, false);

  writeCfg({ restrictions: { deny_read: ["secrets.json"], sandbox: true }, projects: { [repo]: { restrictions: { deny_read: ["vault/**"], deny_commands: ["curl"], sandbox: false } } } });
  const r = restrictionsFor(repo);
  assert.ok(["secrets.json", "vault/**", ...DEFAULT_DENY_READ].every((x) => r.deny_read.includes(x)));
  assert.ok(r.deny_commands.includes("curl") && r.deny_commands.includes("sudo"));
  assert.equal(r.sandbox, false, "the repo's switch wins over the global one");

  writeCfg({ projects: { [repo]: { restrictions: { enabled: false } } } });
  assert.deepEqual(restrictionsFor(repo), { enabled: false, deny_read: [], deny_commands: [], sandbox: false });
  writeCfg({});
});

test("Claude gets a settings file with deny rules, passed by path; sandbox only when asked and only for coding", () => {
  const coding = PLATFORMS.claude.build({ ...base, mode: "coding", restrictions: on() }, {}, "p");
  const i = coding.args.indexOf("--settings");
  assert.ok(i >= 0);
  assert.equal(coding.args[i + 1], coding.files![0].path);
  const s = JSON.parse(coding.files![0].content);
  assert.deepEqual(s.permissions.deny, ["Read(.env)", "Edit(.env)", "Read(*.pem)", "Edit(*.pem)", "Bash(sudo *)", "Bash(git push *)"]);
  assert.equal(s.sandbox, undefined);
  assert.ok(coding.restrictions!.applied.length === 2 && coding.restrictions!.not_enforced.length === 0);

  const sandboxed = JSON.parse(PLATFORMS.claude.build({ ...base, mode: "coding", restrictions: on({ sandbox: true }) }, {}, "p").files![0].content);
  assert.deepEqual(sandboxed.sandbox, { enabled: true, allowUnsandboxedCommands: false, failIfUnavailable: true });

  const analysis = JSON.parse(PLATFORMS.claude.build({ ...base, mode: "analysis", restrictions: on({ sandbox: true }) }, {}, "p").files![0].content);
  assert.deepEqual(analysis.permissions.deny, ["Read(.env)", "Edit(.env)", "Read(*.pem)", "Edit(*.pem)"], "analysis has no shell, so only the file rules apply");
  assert.equal(analysis.sandbox, undefined);

  const off = PLATFORMS.claude.build({ ...base, mode: "coding", restrictions: { ...on(), enabled: false } }, {}, "p");
  assert.equal(off.args.includes("--settings"), false);
  assert.equal(off.files, undefined);
  assert.equal(PLATFORMS.claude.build({ ...base, mode: "coding" }, {}, "p").args.includes("--settings"), false);
});

test("Copilot gets --deny-tool rules, which win over --allow-all-tools; shell rules and --sandbox only for coding", () => {
  const coding = PLATFORMS.copilot.build({ ...base, mode: "coding", restrictions: on({ sandbox: true }) }, {}, "p").args;
  assert.ok(coding.includes("--allow-all-tools"));
  const denied = coding.flatMap((a, i) => (coding[i - 1] === "--deny-tool" ? [a] : []));
  assert.deepEqual(denied, ["read(.env)", "write(.env)", "read(*.pem)", "write(*.pem)", "shell(sudo)", "shell(git push)"]);
  assert.ok(coding.includes("--sandbox"));

  const analysis = PLATFORMS.copilot.build({ ...base, mode: "analysis", restrictions: on({ sandbox: true }) }, {}, "p").args;
  assert.equal(analysis.includes("--sandbox"), false);
  assert.equal(analysis.includes("shell(sudo)"), false);
  assert.ok(analysis.includes("read(.env)"));
  assert.ok(analysis.includes("shell"), "the existing read-only denial of shell and write is untouched");
});

test("Cursor and a custom CLI say plainly what they cannot enforce instead of pretending", () => {
  const cursor = PLATFORMS.cursor.build({ ...base, mode: "coding", restrictions: on({ sandbox: true }) }, {}, "p");
  assert.deepEqual(cursor.args.slice(cursor.args.indexOf("--sandbox"), cursor.args.indexOf("--sandbox") + 2), ["--sandbox", "enabled"]);
  assert.equal(cursor.restrictions!.not_enforced.length, 2);
  assert.match(cursor.restrictions!.not_enforced[0], /cli-config\.json/);
  const noSandbox = PLATFORMS.cursor.build({ ...base, mode: "coding", restrictions: on() }, {}, "p");
  assert.equal(noSandbox.args.includes("--sandbox"), false);

  const generic = PLATFORMS.generic.build({ ...base, mode: "coding", restrictions: on() }, { command: "x" }, "p");
  assert.equal(generic.restrictions!.applied.length, 0);
  assert.match(generic.restrictions!.not_enforced[0], /custom CLI/);
  assert.deepEqual(PLATFORMS.generic.build({ ...base, mode: "coding", restrictions: { ...on(), enabled: false } }, { command: "x" }, "p").restrictions, { applied: [], not_enforced: [] });
});

test("a dispatch writes the settings file and records what was enforced on the dispatch", async () => {
  // a Claude-shaped CLI that just exits: the point is the file and the record, not the session
  const fake = join(dir, "fake-claude.mjs");
  writeFileSync(fake, `console.log(JSON.stringify({ result: "ok" }));`);
  writeCfg({ platforms: { claude: { command: process.execPath, extra_args: [fake] } } });
  const { startAgentDispatch, getDispatch } = await import("../dispatch/runner.js");
  const m = await startAgentDispatch({ kind: "coding", task_id: "T-r", platformId: "claude", branch: "story/r", req: { projectRoot: repo, extraReadRoots: [], prompt: "x" } });
  for (let i = 0; i < 100 && getDispatch(m.dispatch_id).status === "in-flight"; i++) await new Promise((r) => setTimeout(r, 100));
  const done = getDispatch(m.dispatch_id);
  assert.ok(done.restrictions!.applied.some((x) => x.startsWith("deny_read")));
  const file = join(process.env.SDLC_DATA_DIR!, "dispatches", m.dispatch_id, "restrictions.settings.json");
  assert.ok(existsSync(file));
  assert.ok(JSON.parse(readFileSync(file, "utf8")).permissions.deny.includes("Read(.env)"));
});
