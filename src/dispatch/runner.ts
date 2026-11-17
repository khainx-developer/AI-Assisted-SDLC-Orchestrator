import { spawn, execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { join, extname, dirname, relative } from "node:path";
import { dispatchDir, metaFile, readDispatchMeta, type DispatchMeta } from "../common/dispatch-store.js";
import { loadConfig, projectConfig, repoSettings } from "../common/config.js";
import { promptAccessRequest, resolvePlatform, type DispatchRequest } from "./platforms.js";
import { parseCodingResult, extractArtifact } from "./prompt.js";
import { porcelainPath, pathAllowed, outsideScope, hashFiles, touchedSince, snapshotFrozen, frozenViolations, classifyTestRun } from "./guards.js";

const execFileP = promisify(execFile);

export type { DispatchMeta };

function save(m: DispatchMeta) { writeFileSync(metaFile(m.dispatch_id), JSON.stringify(m, null, 2)); }

export async function git(cwd: string, ...args: string[]) {
  const { stdout } = await execFileP("git", args, { cwd });
  return stdout.trim();
}
/** `git status --porcelain` lines, untouched (the git() helper trims, which would eat the leading space of the first entry). */
async function statusLines(cwd: string, ...extra: string[]): Promise<string[]> {
  try {
    const { stdout } = await execFileP("git", ["status", "--porcelain", ...extra], { cwd, maxBuffer: 64 * 1024 * 1024 });
    return stdout.split(String.fromCharCode(10)).map((l) => l.trimEnd()).filter(Boolean);
  } catch { return []; }
}

async function porcelain(cwd: string): Promise<string[]> {
  return (await statusLines(cwd)).map((l) => l.slice(3));
}

/** Every dirty file, untracked ones listed one by one (not collapsed to their folder), as paths relative to `cwd`. */
export async function changedFiles(cwd: string): Promise<string[]> {
  return (await statusLines(cwd, "--untracked-files=all")).map(porcelainPath);
}

/** Dirty files across repos, as paths relative to `root` (unprefixed for the root repo itself). */
async function porcelainAll(root: string, repos: string[]): Promise<string[]> {
  const perRepo = await Promise.all(repos.map(async (k) => {
    const prefix = relative(root, k).split("\\").join("/");
    return (await porcelain(k)).map((f) => (prefix ? `${prefix}/${f}` : f));
  }));
  return perRepo.flat();
}

export async function ensureBranch(cwd: string, branch: string) {
  await git(cwd, "rev-parse", "--is-inside-work-tree");
  const current = await git(cwd, "rev-parse", "--abbrev-ref", "HEAD");
  if (current === branch) return;
  try { await git(cwd, "rev-parse", "--verify", branch); await git(cwd, "checkout", branch); }
  catch { await git(cwd, "checkout", "-b", branch); }
}

/**
 * Windows: pick something we can spawn reliably. VS Code puts a "copilot-shim" on PATH that refuses
 * multi-line arguments and cannot launch npm's copilot.cmd ("UnsupportedWindowsCommandValue"),
 * so for copilot we go straight to the native binary the npm package ships.
 */
function resolveExe(cmd: string): string {
  if (process.platform !== "win32" || extname(cmd)) return cmd;
  let hits: string[] = [];
  try { hits = execFileSync("where", [cmd], { encoding: "utf8" }).split(/\r?\n/).map((l) => l.trim()).filter(Boolean); } catch { return cmd; }
  if (cmd === "copilot") {
    const arch = process.arch === "arm64" ? "arm64" : "x64";
    for (const h of hits.filter((l) => /\.cmd$/i.test(l))) {
      const native = join(dirname(h), "node_modules", "@github", "copilot", "node_modules", "@github", `copilot-win32-${arch}`, "copilot.exe");
      if (existsSync(native)) return native;
    }
  }
  const real = hits.filter((l) => !/copilot-shim/i.test(l));
  return real.find((l) => /\.exe$/i.test(l)) ?? real[0] ?? hits[0] ?? cmd;
}

interface StartArgs {
  kind: "analysis" | "coding" | "test-authoring";
  task_id: string;
  platformId: string;
  req: Omit<DispatchRequest, "promptFile" | "mode">;
  skill_version?: string;
  branch?: string;
  /** repos whose dirty files an analysis session is checked against (a workspace has several); defaults to [req.projectRoot] */
  repos?: string[];
  /** coding: the plan's files/dirs/globs. Files this session touches outside them are reported (see scope_check in config) */
  targetFiles?: string[];
  /** coding: frozen test files this session must not change; a change fails the dispatch */
  frozenFiles?: string[];
  /** test-authoring: where the tests belong; the touched files inside become the frozen set, any others are scope violations */
  testPaths?: string[];
}

export async function startAgentDispatch(a: StartArgs): Promise<DispatchMeta> {
  const cfg = loadConfig();
  const { platform, override } = resolvePlatform(a.platformId, cfg.platforms);
  const id = `d_${randomUUID().slice(0, 8)}`;
  mkdirSync(dispatchDir(id), { recursive: true });
  const promptFile = join(dispatchDir(id), "prompt.md");
  writeFileSync(promptFile, a.req.prompt);

  const exe = resolveExe(override.command ?? platform.command);
  const isShim = process.platform === "win32" && /\.(cmd|bat)$/i.test(exe);
  let via = override.prompt_via ?? platform.promptVia;
  if (via === "arg" && isShim) via = "file"; // shims go through cmd.exe, where multi-line args cannot be quoted safely
  // Windows caps a command line at ~32K chars (spawn ENAMETOOLONG); skill + learnings + repo instructions blow past that
  if (via === "arg" && a.req.prompt.length > 8000) via = "file";
  const promptArg = via === "file" ? `Read the file ${promptFile} and follow the instructions in it exactly.` : a.req.prompt;

  const writes = a.kind !== "analysis";
  const req = promptAccessRequest({ ...a.req, mode: writes ? "coding" : "analysis", promptFile }, platform, via);
  const inv = platform.build(req, override, promptArg);
  const root = a.req.projectRoot;
  const repos = a.repos ?? [root];
  const before = a.kind === "analysis" ? await porcelainAll(root, repos) : [];
  // write sessions: remember what was already dirty (earlier attempts, frozen tests) so only THIS session's changes are judged
  const dirtyBefore = writes ? await changedFiles(root) : [];
  const hashesBefore = writes ? hashFiles(root, dirtyBefore) : {};
  const settings = repoSettings(root);
  const frozenSnapshot = a.frozenFiles?.length ? snapshotFrozen(root, a.frozenFiles, join(dispatchDir(id), "frozen")) : null;

  const meta: DispatchMeta = {
    dispatch_id: id, kind: a.kind, task_id: a.task_id, platform: platform.id, project_root: root,
    status: "in-flight", started_at: new Date().toISOString(), skill_version: a.skill_version, branch: a.branch,
    prompt_chars: a.req.prompt.length,
  };
  if (frozenSnapshot) { meta.frozen_files = a.frozenFiles; meta.frozen_backup = join(dispatchDir(id), "frozen"); }
  const child = spawn(exe, inv.args, { cwd: a.req.projectRoot, shell: isShim, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  meta.pid = child.pid;
  save(meta);

  let out = "", err = "", bytes = 0, lastSave = 0;
  const activity = (d: Buffer | string) => {
    bytes += d.length;
    const now = Date.now();
    if (now - lastSave < 10_000) return;
    lastSave = now;
    meta.last_activity_at = new Date(now).toISOString(); meta.output_bytes = bytes;
    try { save(meta); } catch { /* a heartbeat write must never kill the dispatch */ }
  };
  child.stdout.on("data", (d) => { out += d; activity(d); });
  child.stderr.on("data", (d) => { err += d; activity(d); });
  if (inv.stdin !== undefined) child.stdin.end(inv.stdin); else child.stdin.end();
  running.set(id, { meta, pid: child.pid });

  const timer = setTimeout(() => { meta.error = `timed out after ${cfg.dispatch_timeout_minutes} min`; killTree(child.pid); }, cfg.dispatch_timeout_minutes * 60_000);
  const finish = async (code: number | null, spawnErr?: Error) => {
    clearTimeout(timer);
    running.delete(id);
    meta.output_bytes = bytes;
    const text = platform.parseOutput(out).trim();
    meta.finished_at = new Date().toISOString();
    meta.duration_ms = Date.parse(meta.finished_at) - Date.parse(meta.started_at);
    meta.exit_code = code;
    meta.output = text;
    meta.stderr_tail = err.slice(-2000);
    if (spawnErr) meta.error = `could not start '${exe}': ${spawnErr.message}`;
    if (a.kind === "analysis") {
      const after = await porcelainAll(root, repos);
      meta.artifact = extractArtifact(text);
      const added = after.filter((f) => !before.includes(f));
      if (added.length) meta.read_only_violation = added; // platform could not (or did not) keep the session read-only
    } else {
      const after = await changedFiles(root);
      const touched = touchedSince(root, hashesBefore, after);
      meta.files_changed = after;
      meta.files_touched = touched;
      const r = parseCodingResult(text);
      if (r) {
        Object.assign(meta, { success: r.success, summary: r.summary, needs_clarification: r.needs_clarification, question: r.question, pr_number: r.pr_number });
        if (r.spec_wrong) Object.assign(meta, { spec_wrong: true, spec_issue: r.spec_issue ?? "(the session reported a wrong spec but gave no detail)", success: false });
      } else { meta.success = code === 0; meta.summary = "(no sdlc-result block in output; inferred from exit code)"; }

      const mode = settings.scope_check;
      if (a.kind === "coding") {
        if (frozenSnapshot) {
          const bad = frozenViolations(root, frozenSnapshot);
          if (bad.length) meta.frozen_test_violation = bad;
        }
        const frozen = new Set(a.frozenFiles ?? []);
        const out = mode === "off" ? [] : outsideScope(touched.filter((f) => !frozen.has(f)), a.targetFiles?.length ? [...a.targetFiles, ...settings.scope_allow] : []);
        if (out.length) { meta.scope_violation = out; meta.scope_check = mode === "fail" ? "fail" : "warn"; }
      } else {
        const inScope = a.testPaths?.length ? touched.filter((f) => pathAllowed(f, a.testPaths!)) : touched;
        meta.frozen_files = inScope;
        if (!inScope.length && !meta.spec_wrong && !meta.needs_clarification && !meta.error) meta.error = "test-authoring session wrote no test files";
        const out = mode === "off" || !a.testPaths?.length ? [] : touched.filter((f) => !pathAllowed(f, [...a.testPaths!, ...settings.scope_allow]));
        if (out.length) { meta.scope_violation = out; meta.scope_check = mode === "fail" ? "fail" : "warn"; }
      }
    }
    meta.status = code === 0 && !meta.error && !meta.read_only_violation && !meta.frozen_test_violation && meta.scope_check !== "fail" ? "completed" : "failed";
    save(meta);
  };
  child.on("error", (e) => void finish(null, e));
  child.on("close", (code) => void finish(code));
  return meta;
}

export function detectTestCommand(root: string): string | null {
  const cfg = projectConfig(root)?.test_command;
  if (cfg) return cfg;
  if (existsSync(join(root, "package.json"))) return "npm test";
  if (existsSync(join(root, "pom.xml"))) return "mvn -q test";
  if (existsSync(join(root, "gradlew")) || existsSync(join(root, "build.gradle"))) return "gradle test";
  if (existsSync(join(root, "pyproject.toml")) || existsSync(join(root, "pytest.ini"))) return "pytest -q";
  if (existsSync(join(root, "go.mod"))) return "go test ./...";
  if (readdirHas(root, /\.sln$/)) return "dotnet test";
  return null;
}
function readdirHas(dir: string, re: RegExp) {
  try { return readdirSync(dir).some((f: string) => re.test(f)); } catch { return false; }
}

export function startTestDispatch(task_id: string, root: string, command: string, expectFail = false): DispatchMeta {
  const id = `d_${randomUUID().slice(0, 8)}`;
  mkdirSync(dispatchDir(id), { recursive: true });
  const meta: DispatchMeta = { dispatch_id: id, kind: "test", task_id, platform: "shell", project_root: root, status: "in-flight", started_at: new Date().toISOString() };
  const child = spawn(command, { cwd: root, shell: true, windowsHide: true });
  meta.pid = child.pid;
  save(meta);
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));
  const finish = (code: number | null, e?: Error) => {
    meta.finished_at = new Date().toISOString();
    meta.duration_ms = Date.parse(meta.finished_at) - Date.parse(meta.started_at);
    meta.exit_code = code;
    meta.output = out.slice(-8000);
    meta.passed = code === 0;
    if (e) meta.error = e.message;
    if (expectFail) meta.verdict = e ? "broken" : classifyTestRun(code === 0, out);
    meta.status = code === 0 ? "completed" : "failed";
    save(meta);
  };
  child.on("error", (e) => finish(null, e));
  child.on("close", (c) => finish(c));
  return meta;
}

/** sessions started by this server process; lets cancel set the reason before the close handler records the failure */
const running = new Map<string, { meta: DispatchMeta; pid?: number }>();

/** Kill the CLI and everything it spawned. child.kill() alone leaves grandchildren running on Windows (cmd shims, node wrappers). */
function killTree(pid?: number) {
  if (!pid) return;
  try {
    if (process.platform === "win32") execFileSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
    else process.kill(pid, "SIGKILL");
  } catch { /* already gone */ }
}

/** Stop an in-flight dispatch and record it as failed ("cancelled") so the task can be retried. Works after a server restart too (kills by pid). */
export function cancelDispatch(id: string, reason = "cancelled by user"): DispatchMeta {
  const m = readDispatchMeta(id);
  if (m.status !== "in-flight") return m;
  const live = running.get(id);
  if (live) { live.meta.error = reason; killTree(live.pid); return getDispatch(id); } // the close handler finishes the record
  killTree(m.pid);
  m.status = "failed"; m.error = reason; m.finished_at = new Date().toISOString(); save(m);
  return m;
}

export function getDispatch(id: string): DispatchMeta {
  const m = readDispatchMeta(id);
  if (m.status === "in-flight" && m.pid) {
    try { process.kill(m.pid, 0); }
    catch { // owning process is gone and never wrote a result (e.g. the server restarted mid-run)
      m.status = "failed"; m.error = "process lost: dispatch server restarted or child died before reporting"; m.finished_at = new Date().toISOString(); save(m);
    }
  }
  if (m.status === "in-flight") {
    const now = Date.now();
    const quietFor = Math.round((now - Date.parse(m.last_activity_at ?? m.started_at)) / 1000);
    (m as any).elapsed_seconds = Math.round((now - Date.parse(m.started_at)) / 1000);
    (m as any).quiet_seconds = quietFor; // 0 output is normal for some CLIs (they print once at the end), so this is a hint, not proof of a hang
  }
  return m;
}
