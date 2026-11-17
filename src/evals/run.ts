import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { dataDir } from "../common/paths.js";
import { loadConfig } from "../common/config.js";
import type { DispatchUsage } from "../common/dispatch-store.js";
import { analysisPrompt, loadSkill, bundledSkillsDir } from "../dispatch/prompt.js";
import { startAgentDispatch, getDispatch } from "../dispatch/runner.js";
import { checkArtifact, type EvalCase } from "./checks.js";

const here = dirname(fileURLToPath(import.meta.url));
export const evalsDir = join(here, "..", "..", "evals");

export function loadCases(dir = join(evalsDir, "cases")): EvalCase[] {
  return readdirSync(dir).filter((f) => f.endsWith(".json")).sort().map((f) => {
    const c = JSON.parse(readFileSync(join(dir, f), "utf8")) as EvalCase;
    if (!c.name || !c.skill || !c.instructions || !c.checks) throw new Error(`eval case ${f} needs name, skill, instructions and checks`);
    if (c.name !== f.replace(/\.json$/, "")) throw new Error(`eval case ${f}: name must equal the file name`);
    return c;
  });
}

/** A known-good artifact for the case. It proves the checks accept a correct document, and it is the baseline a live run is read against. */
export function goldenFor(c: EvalCase, dir = join(evalsDir, "golden")): string | null {
  const f = join(dir, `${c.name}.md`);
  return existsSync(f) ? readFileSync(f, "utf8") : null;
}

export interface EvalResult {
  case: string;
  skill: string;
  skill_version: string;
  platform: string;
  model?: string;
  pass: boolean;
  failures: string[];
  dispatch_id?: string;
  duration_ms?: number;
  usage?: DispatchUsage;
}

export interface EvalRun {
  at: string;
  results: EvalResult[];
  /** cases that passed in the previous run and fail now, with the skill versions involved */
  regressions: { case: string; was: string; now: string }[];
}

/** Run one case through the real dispatch path (same prompt builder, same platform adapter, same read-only guard) in a throwaway repo. */
export async function runCase(c: EvalCase, o: { platform?: string; model?: string; skillsDir?: string; pollMs?: number } = {}): Promise<EvalResult> {
  const cfg = loadConfig();
  const platform = o.platform ?? cfg.analysis_platform ?? cfg.default_platform;
  const skill = loadSkill(c.skill, o.skillsDir ?? cfg.skills_dir ?? bundledSkillsDir);
  const work = join(dataDir(), "evals", "work", `${c.name}-${randomUUID().slice(0, 6)}`);
  mkdirSync(work, { recursive: true });
  try {
    for (const [p, body] of Object.entries(c.files ?? {})) {
      if (p.includes("..") || /^([a-zA-Z]:|[\\/])/.test(p)) throw new Error(`eval case ${c.name}: file path '${p}' must be relative and stay inside the repo`);
      mkdirSync(join(work, dirname(p)), { recursive: true });
      writeFileSync(join(work, p), body);
    }
    const git = (...a: string[]) => execFileSync("git", ["-c", "user.email=eval@local", "-c", "user.name=eval", ...a], { cwd: work, stdio: "ignore" });
    git("init", "-q"); git("add", "-A"); git("commit", "-q", "--allow-empty", "-m", "fixture");

    const started = await startAgentDispatch({
      kind: "analysis", task_id: `eval-${c.name}`, platformId: platform, skill_version: skill.version, repos: [work],
      req: { projectRoot: work, extraReadRoots: [], model: o.model, prompt: analysisPrompt({ skill: c.skill, skillBody: skill.body, instructions: c.instructions, projectRoot: work, readRoots: [] }) },
    });
    let m = getDispatch(started.dispatch_id);
    while (m.status === "in-flight") { await new Promise((r) => setTimeout(r, o.pollMs ?? 1000)); m = getDispatch(started.dispatch_id); }

    const base = { case: c.name, skill: c.skill, skill_version: skill.version, platform, model: o.model, dispatch_id: m.dispatch_id, duration_ms: m.duration_ms, usage: m.usage };
    if (m.status !== "completed") return { ...base, pass: false, failures: [`dispatch ${m.status}: ${m.error ?? m.read_only_violation?.join(", ") ?? "no detail"}`] };
    const r = checkArtifact(m.artifact ?? "", c.checks);
    return { ...base, pass: r.pass, failures: r.failures };
  } finally {
    try { rmSync(work, { recursive: true, force: true }); } catch { /* a leftover temp folder is harmless */ }
  }
}

const resultsDir = () => join(dataDir(), "evals", "results");

function previousRun(): EvalRun | null {
  const d = resultsDir();
  if (!existsSync(d)) return null;
  const f = readdirSync(d).filter((x) => x.endsWith(".json")).sort().at(-1);
  return f ? (JSON.parse(readFileSync(join(d, f), "utf8")) as EvalRun) : null;
}

/** Run cases live, save the run, and report what got worse since the previous saved run. Costs real AI sessions. */
export async function runEvals(cases: EvalCase[], o: { platform?: string; model?: string; pollMs?: number } = {}): Promise<EvalRun> {
  const prev = previousRun();
  const results: EvalResult[] = [];
  for (const c of cases) results.push(await runCase(c, o)); // one at a time: keeps cost and CLI load predictable
  const regressions = results.filter((r) => !r.pass).flatMap((r) => {
    const was = prev?.results.find((p) => p.case === r.case && p.pass);
    return was ? [{ case: r.case, was: was.skill_version, now: r.skill_version }] : [];
  });
  const run: EvalRun = { at: new Date().toISOString(), results, regressions };
  mkdirSync(resultsDir(), { recursive: true });
  writeFileSync(join(resultsDir(), `${run.at.replace(/[:.]/g, "-")}.json`), JSON.stringify(run, null, 2));
  return run;
}

/** Offline: every golden artifact must pass its case. Catches a broken check or a case that no longer matches its skill's template. */
export function checkGoldens(cases = loadCases()): { case: string; pass: boolean; failures: string[] }[] {
  return cases.map((c) => {
    const g = goldenFor(c);
    if (g === null) return { case: c.name, pass: false, failures: [`no golden file evals/golden/${c.name}.md`] };
    const r = checkArtifact(g, c.checks);
    return { case: c.name, ...r };
  });
}
