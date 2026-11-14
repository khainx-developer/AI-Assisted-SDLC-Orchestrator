import { spawn, execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { join, extname, dirname } from "node:path";
import { dataDir } from "../common/paths.js";
import { loadConfig } from "../common/config.js";
import { resolvePlatform, type DispatchRequest } from "./platforms.js";
import { parseCodingResult, extractArtifact } from "./prompt.js";

const execFileP = promisify(execFile);
const dispatchDir = (id: string) => join(dataDir(), "dispatches", id);
const metaFile = (id: string) => join(dispatchDir(id), "meta.json");

export interface DispatchMeta {
  dispatch_id: string;
  kind: "analysis" | "coding" | "test";
  task_id: string;
  platform: string;
  project_root: string;
  status: "in-flight" | "completed" | "failed";
  pid?: number;
  started_at: string;
  finished_at?: string;
  skill_version?: string;
  branch?: string;
  // outcome
  output?: string;
  /** analysis only: the cleaned stage artifact (use this, not output) */
  artifact?: string;
  exit_code?: number | null;
  error?: string;
  stderr_tail?: string;
  files_changed?: string[];
  read_only_violation?: string[];
  success?: boolean;
  needs_clarification?: boolean;
  question?: string | null;
  pr_number?: number | null;
  summary?: string;
  passed?: boolean;
}

function save(m: DispatchMeta) { writeFileSync(metaFile(m.dispatch_id), JSON.stringify(m, null, 2)); }

export async function git(cwd: string, ...args: string[]) {
  const { stdout } = await execFileP("git", args, { cwd });
  return stdout.trim();
}
async function porcelain(cwd: string): Promise<string[]> {
  try { return (await git(cwd, "status", "--porcelain")).split("\n").filter(Boolean).map((l) => l.slice(3)); } catch { return []; }
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
  kind: "analysis" | "coding";
  task_id: string;
  platformId: string;
  req: Omit<DispatchRequest, "promptFile" | "mode">;
  skill_version?: string;
  branch?: string;
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
  const promptArg = via === "file" ? `Read the file ${promptFile} and follow the instructions in it exactly.` : a.req.prompt;

  const req: DispatchRequest = { ...a.req, mode: a.kind, promptFile };
  const inv = platform.build(req, override, promptArg);
  const before = a.kind === "analysis" ? await porcelain(a.req.projectRoot) : [];

  const meta: DispatchMeta = {
    dispatch_id: id, kind: a.kind, task_id: a.task_id, platform: platform.id, project_root: a.req.projectRoot,
    status: "in-flight", started_at: new Date().toISOString(), skill_version: a.skill_version, branch: a.branch,
  };
  const child = spawn(exe, inv.args, { cwd: a.req.projectRoot, shell: isShim, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  meta.pid = child.pid;
  save(meta);

  let out = "", err = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (err += d));
  if (inv.stdin !== undefined) child.stdin.end(inv.stdin); else child.stdin.end();

  const timer = setTimeout(() => { meta.error = `timed out after ${cfg.dispatch_timeout_minutes} min`; child.kill(); }, cfg.dispatch_timeout_minutes * 60_000);
  const finish = async (code: number | null, spawnErr?: Error) => {
    clearTimeout(timer);
    const text = platform.parseOutput(out).trim();
    meta.finished_at = new Date().toISOString();
    meta.exit_code = code;
    meta.output = text;
    meta.stderr_tail = err.slice(-2000);
    if (spawnErr) meta.error = `could not start '${exe}': ${spawnErr.message}`;
    const after = await porcelain(a.req.projectRoot);
    if (a.kind === "analysis") {
      meta.artifact = extractArtifact(text);
      const added = after.filter((f) => !before.includes(f));
      if (added.length) meta.read_only_violation = added; // platform could not (or did not) keep the session read-only
    } else {
      meta.files_changed = after;
      const r = parseCodingResult(text);
      if (r) { Object.assign(meta, { success: r.success, summary: r.summary, needs_clarification: r.needs_clarification, question: r.question, pr_number: r.pr_number }); }
      else { meta.success = code === 0; meta.summary = "(no sdlc-result block in output; inferred from exit code)"; }
    }
    meta.status = code === 0 && !meta.error && !meta.read_only_violation ? "completed" : "failed";
    save(meta);
  };
  child.on("error", (e) => void finish(null, e));
  child.on("close", (code) => void finish(code));
  return meta;
}

export function detectTestCommand(root: string): string | null {
  const cfg = loadConfig().projects?.[root]?.test_command;
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

export function startTestDispatch(task_id: string, root: string, command: string): DispatchMeta {
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
    meta.exit_code = code;
    meta.output = out.slice(-8000);
    meta.passed = code === 0;
    if (e) meta.error = e.message;
    meta.status = code === 0 ? "completed" : "failed";
    save(meta);
  };
  child.on("error", (e) => finish(null, e));
  child.on("close", (c) => finish(c));
  return meta;
}

export function getDispatch(id: string): DispatchMeta {
  if (!/^d_[0-9a-f]{8}$/.test(id)) throw new Error("invalid dispatch_id");
  if (!existsSync(metaFile(id))) throw new Error(`unknown dispatch_id '${id}'`);
  const m: DispatchMeta = JSON.parse(readFileSync(metaFile(id), "utf8"));
  if (m.status === "in-flight" && m.pid) {
    try { process.kill(m.pid, 0); }
    catch { // owning process is gone and never wrote a result (e.g. the server restarted mid-run)
      m.status = "failed"; m.error = "process lost: dispatch server restarted or child died before reporting"; m.finished_at = new Date().toISOString(); save(m);
    }
  }
  return m;
}
