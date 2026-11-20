import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkFreshness, parseHeader, formatFreshness } from "../knowledge/freshness.js";

const repo = mkdtempSync(join(tmpdir(), "fresh-"));
const git = (...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: repo, encoding: "utf8" }).trim();
mkdirSync(join(repo, "src"));
const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
writeFileSync(join(repo, "src", "a.ts"), lines(20));
writeFileSync(join(repo, "src", "b.ts"), lines(10));
git("init", "-q"); git("add", "-A"); git("commit", "-q", "-m", "one");
const sha = git("rev-parse", "--short=7", "HEAD");

const page = (cites: string, source = `Source: shop@${sha}`) => `# Orders\n\n${source}\nType: module\nSummary: How orders work.\nApplies to: src/\nStatus: draft\n\n## Responsibilities\n${cites}\n`;
const check = (md: string) => checkFreshness(repo, md);

test("the header is parsed", () => {
  const h = parseHeader(page("- x `src/a.ts:3`"));
  assert.deepEqual([h.title, h.source_sha, h.type, h.applies_to, h.status], ["Orders", sha, "module", ["src/"], "draft"]);
  assert.equal(parseHeader("# T\n\nno header").source_sha, null);
});

test("nothing changed: fresh", () => assert.equal(check(page("- x `src/a.ts:3-5`")).state, "fresh"));

test("a change outside the cited lines is shifted, not stale; a change inside is stale", () => {
  writeFileSync(join(repo, "src", "a.ts"), lines(20).replace("line 15", "changed 15"));
  assert.equal(check(page("- x `src/a.ts:3-5`")).state, "shifted");
  const r = check(page("- x `src/a.ts:14-16`"));
  assert.equal(r.state, "stale");
  assert.equal(r.stale[0].cited, "src/a.ts:14-16");
  assert.match(formatFreshness("orders.md", r), /cited lines changed: src\/a\.ts:14-16/);
});

test("an insertion inside a cited range is stale; one after it is not", () => {
  writeFileSync(join(repo, "src", "a.ts"), lines(20).replace("line 4\n", "line 4\nnew\n"));
  assert.equal(check(page("- x `src/a.ts:3-5`")).state, "stale");
  assert.equal(check(page("- x `src/a.ts:6-8`")).state, "shifted");
});

test("uncommitted work counts, and a committed change is seen too", () => {
  git("add", "-A"); git("commit", "-q", "-m", "two");
  assert.equal(check(page("- x `src/a.ts:3-5`")).state, "stale");
});

test("a deleted cited file is broken", () => {
  rmSync(join(repo, "src", "b.ts"));
  const r = check(page("- x `src/b.ts:1`"));
  assert.equal(r.state, "broken");
  assert.deepEqual(r.missing, ["src/b.ts"]);
});

test("no Source commit, an unknown commit and a page with no citations are reported plainly", () => {
  assert.equal(check("# T\n\n- x `src/a.ts:1`").state, "unknown");
  assert.match(check(page("- x `src/a.ts:1`", "Source: shop@deadbee")).reason ?? "", /not in this repository/);
  assert.equal(check(page("- no cites")).state, "fresh");
  assert.equal(checkFreshness(tmpdir(), page("- x `src/a.ts:1`")).state, "unknown");
});

test("a citation that points outside the repo is broken, not read", () => {
  assert.equal(check(page("- x `../etc/passwd:1`")).state, "broken");
});
