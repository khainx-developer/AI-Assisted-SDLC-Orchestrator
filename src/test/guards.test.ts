import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathAllowed, outsideScope, porcelainPath, classifyTestRun, hashFiles, touchedSince, snapshotFrozen, frozenViolations } from "../dispatch/guards.js";

test("pathAllowed: exact files, directories, and globs", () => {
  assert.ok(pathAllowed("src/a.ts", ["src/a.ts"]));
  assert.ok(pathAllowed("src/deep/a.ts", ["src"]), "a directory covers everything below it");
  assert.ok(pathAllowed("src/deep/a.ts", ["src/"]));
  assert.ok(pathAllowed("src/deep/a.ts", ["./src/", "docs/"]), "a leading ./ is ignored");
  assert.ok(pathAllowed("src\\a.ts", ["src/a.ts"]), "backslashes are normalised");
  assert.ok(pathAllowed("src/a.test.ts", ["src/*.test.ts"]));
  assert.ok(!pathAllowed("src/deep/a.test.ts", ["src/*.test.ts"]), "* stays inside one folder");
  assert.ok(pathAllowed("src/deep/a.test.ts", ["src/**/*.test.ts"]));
  assert.ok(pathAllowed("a.test.ts", ["**/*.test.ts"]), "** also matches no folder at all");
  assert.ok(pathAllowed("package-lock.json", ["*.json"]));
  assert.ok(!pathAllowed("srcs/a.ts", ["src"]), "a directory pattern is not a string prefix");
  assert.ok(!pathAllowed("other/a.ts", ["src/"]));
  assert.ok(!pathAllowed("src/a.ts", []));
});

test("pathAllowed escapes regex characters in globs", () => {
  assert.ok(pathAllowed("a+b(1).ts", ["a+b(1).*"]));
  assert.ok(!pathAllowed("aab(1).ts", ["a+b(1).*"]));
});

test("outsideScope: an empty scope means nothing was declared, so nothing is outside", () => {
  assert.deepEqual(outsideScope(["a", "b"], []), []);
  assert.deepEqual(outsideScope(["src/a", "x/b"], ["src/"]), ["x/b"]);
});

test("porcelainPath: renames, quoting and status columns", () => {
  assert.equal(porcelainPath("?? src/new.ts"), "src/new.ts");
  assert.equal(porcelainPath(" M src/a.ts"), "src/a.ts");
  assert.equal(porcelainPath("R  old.ts -> src/new.ts"), "src/new.ts");
  assert.equal(porcelainPath('?? "dir with space/a.ts"'), "dir with space/a.ts");
});

test("classifyTestRun: passed is vacuous, a failure that could not run is broken, an assertion failure is red", () => {
  assert.equal(classifyTestRun(true, "3 passing"), "vacuous");
  assert.equal(classifyTestRun(false, "AssertionError: expected 1 to equal 2"), "red");
  for (const out of [
    "Error: Cannot find module './retry'", "ModuleNotFoundError: No module named 'retry'", "src/a.test.ts(3,10): error TS2307: Cannot find module",
    "error CS0103: The name 'Retry' does not exist", "COMPILATION ERROR : cannot find symbol", "collected 0 items", "No tests found, exiting with code 1",
    "SyntaxError: Unexpected token",
  ]) assert.equal(classifyTestRun(false, out), "broken", out);
});

test("frozen snapshot: edits, deletions and untouched files are told apart; touchedSince ignores unchanged dirty files", () => {
  const root = mkdtempSync(join(tmpdir(), "sdlc-g-"));
  mkdirSync(join(root, "tests"));
  writeFileSync(join(root, "tests", "a.test.js"), "one");
  writeFileSync(join(root, "tests", "b.test.js"), "two");
  const backup = join(root, ".backup");
  const snap = snapshotFrozen(root, ["tests/a.test.js", "tests/b.test.js"], backup);
  assert.deepEqual(frozenViolations(root, snap), []);
  writeFileSync(join(root, "tests", "a.test.js"), "changed");
  rmSync(join(root, "tests", "b.test.js"));
  assert.deepEqual(frozenViolations(root, snap).sort(), ["tests/a.test.js", "tests/b.test.js"]);

  const before = hashFiles(root, ["tests/a.test.js"]);
  assert.deepEqual(touchedSince(root, before, ["tests/a.test.js", "new.ts"]), ["new.ts"], "a.test.js is unchanged since `before`; new.ts was clean then");
  writeFileSync(join(root, "tests", "a.test.js"), "again");
  assert.deepEqual(touchedSince(root, before, ["tests/a.test.js"]), ["tests/a.test.js"]);
});
