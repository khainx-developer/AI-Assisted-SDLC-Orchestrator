import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { knowledgeDir, scanRepo, scanSummary, writeScan, type ScanResult } from "./scan.js";
import { checkSurvey, formatSurveyReport, parseSurvey } from "./survey-check.js";
import { checkModule, formatModuleReport } from "./module-check.js";
import { extractClaims, formatClaims, parseVerdicts, repairBlock, summariseVerdicts, type Claim, type VerdictReport, type VerdictRow } from "./claims.js";

/**
 * Knowledge pipeline runner: scan (code) -> survey -> per module: write, check by code, verify claims with a second
 * session, repair, repeat a bounded number of times. Everything lands in ~/.ai-sdlc-orchestrator/knowledge/<slug>/ as
 * drafts plus a manifest; nothing is written into the repo and nothing is marked approved here (a person does that).
 * The AI sessions are injected so the control flow is testable without spending anything.
 */
export interface SessionArgs { skill: string; instructions: string; platform?: string; readRoots: string[] }
export interface SessionResult { artifact: string; platform: string; skill_version: string; duration_ms?: number; input_tokens?: number; output_tokens?: number; error?: string }
export type Session = (a: SessionArgs) => Promise<SessionResult>;

export interface RunOptions {
  repo: string;
  /** module ids from the survey ("M3"), or "all"; undefined stops after the survey */
  modules?: string[] | "all";
  maxRepairs?: number;
  /** hard stop on AI sessions for one run */
  maxSessions?: number;
  /** platform for the claim verifier; default: review_platform from config, else the writer's */
  verifier?: string;
  /** use the survey.draft.md already stored instead of running the survey again */
  reuseSurvey?: boolean;
  log?: (line: string) => void;
}

export interface ModuleOutcome {
  id: string; name: string; file: string; status: "clean" | "needs-review" | "failed";
  rounds: number; claims: number; supported: number; remaining: string[];
  writer_platform?: string; verifier_platform?: string; independent_verifier?: boolean; skill_version?: string; error?: string;
}
export interface Manifest {
  schema: 1; repo: string; slug: string; commit: string; started: string; finished: string; sessions: number;
  tokens: { input: number; output: number };
  survey: { file: string; status: "clean" | "needs-review" | "reused" | "failed"; rounds: number; remaining: string[]; skill_version?: string; platform?: string } | null;
  modules: ModuleOutcome[]; stopped?: string;
}

const BATCH = 12;
const slugOf = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "module";
const norm = (f: string) => f.split("\\").join("/").replace(/\/package\.json$/i, "/").replace(/^\.\//, "");

export function moduleBlock(survey: string, id: string): string {
  return survey.split(/^### /m).slice(1).map((b) => "### " + b.trimEnd()).find((b) => b.startsWith(`### ${id}.`)) ?? "";
}

function moduleFacts(scan: ScanResult, folders: string[]): string {
  const fs = folders.map(norm);
  const mine = scan.projects.filter((p) => fs.some((f) => (f.endsWith("/") ? p.path.startsWith(f) : p.path === f || p.path.startsWith(f + "/"))));
  return mine.map((p) => `- ${p.name} (${p.path}): ${p.target_frameworks.join(";") || "?"}; references: ${p.project_references.join(", ") || "none"}${p.is_test ? "; test project" : ""}`).join("\n") || "(no projects in the scan for these folders)";
}

export async function runKnowledge(o: RunOptions, session: Session): Promise<Manifest> {
  const log = o.log ?? (() => {});
  const maxRepairs = o.maxRepairs ?? 2;
  const maxSessions = o.maxSessions ?? 40;
  const started = new Date().toISOString();
  const scan = scanRepo(o.repo);
  writeScan(scan);
  const kdir = knowledgeDir(scan.slug);
  const sha = scan.head.sha;
  const repoName = o.repo.split(/[\\/]/).filter(Boolean).pop() ?? "repo";
  log(`scan: ${scan.projects.length} projects at ${sha.slice(0, 7)} (${scan.slug})`);

  const m: Manifest = { schema: 1, repo: o.repo, slug: scan.slug, commit: sha, started, finished: "", sessions: 0, tokens: { input: 0, output: 0 }, survey: null, modules: [] };
  const run = async (a: SessionArgs): Promise<SessionResult> => {
    if (m.sessions >= maxSessions) throw new Error(`session limit reached (${maxSessions})`);
    m.sessions++;
    const r = await session(a);
    m.tokens.input += r.input_tokens ?? 0;
    m.tokens.output += r.output_tokens ?? 0;
    return r;
  };
  const save = () => { m.finished = new Date().toISOString(); mkdirSync(join(kdir, ".meta"), { recursive: true }); writeFileSync(join(kdir, ".meta", "manifest.json"), JSON.stringify(m, null, 2)); };

  try {
    // survey
    const surveyFile = join(kdir, "survey.draft.md");
    let survey = "";
    if (o.reuseSurvey && existsSync(surveyFile)) {
      survey = readFileSync(surveyFile, "utf8");
      m.survey = { file: surveyFile, status: "reused", rounds: 0, remaining: [] };
      log("survey: reusing the stored draft");
    } else {
      const base = `SCAN\n${scanSummary(scan)}\n\nThe full scan is in ${join(kdir, ".meta", "scan.json")} (readable).\nRepository name: ${repoName}. Commit: ${sha}.`;
      let r = await run({ skill: "repo-survey", instructions: base, readRoots: [kdir] });
      let rounds = 0, problems = "";
      for (;;) {
        if (r.error || !r.artifact.trim()) { m.survey = { file: surveyFile, status: "failed", rounds, remaining: [r.error ?? "empty result"], platform: r.platform, skill_version: r.skill_version }; throw new Error("survey session failed: " + (r.error ?? "empty result")); }
        survey = r.artifact;
        const rep = checkSurvey(scan, survey);
        problems = rep.ok ? "" : formatSurveyReport(rep, Object.fromEntries(parseSurvey(survey).map((x) => [x.id, x.name])));
        log(`survey round ${rounds}: ${problems ? problems.split("\n").length + " problem(s)" : "ok"}`);
        if (!problems || rounds >= maxRepairs) break;
        rounds++;
        r = await run({ skill: "repo-survey", instructions: base + `\n\nREPAIR\nBelow is a survey you wrote and the problems code found when checking it against the scan. Return the whole corrected survey in the same template. Fix each problem; do not change what was not flagged.\n\nPAGE\n${survey.trim()}\n\nPROBLEMS\n${problems}`, readRoots: [kdir] });
      }
      writeFileSync(surveyFile, survey);
      m.survey = { file: surveyFile, status: problems ? "needs-review" : "clean", rounds, remaining: problems ? problems.split("\n") : [], platform: r.platform, skill_version: r.skill_version };
    }

    const all = parseSurvey(survey);
    const wanted = o.modules === "all" ? all : all.filter((x) => (o.modules ?? []).includes(x.id));
    if (!o.modules) { m.stopped = "survey only: choose modules with --modules M1,M2 or all"; log(m.stopped); log("modules: " + all.map((x) => `${x.id} ${x.name}`).join("; ")); save(); return m; }
    const unknown = Array.isArray(o.modules) ? o.modules.filter((id) => !all.some((x) => x.id === id)) : [];
    if (unknown.length) log(`not in the survey: ${unknown.join(", ")}`);

    mkdirSync(join(kdir, "modules"), { recursive: true });
    for (const mod of wanted) {
      const file = join(kdir, "modules", `${mod.id.toLowerCase()}-${slugOf(mod.name)}.draft.md`);
      const out: ModuleOutcome = { id: mod.id, name: mod.name, file, status: "failed", rounds: 0, claims: 0, supported: 0, remaining: [] };
      m.modules.push(out);
      const base = `Document this module.\nModule: ${mod.name}\nFolders: ${mod.folders.join(", ")}\nCommit: ${sha}\nRepository: ${repoName}\nSurvey entry:\n${moduleBlock(survey, mod.id)}\nScan facts:\n${moduleFacts(scan, mod.folders)}`;
      let best: { score: number; page: string; remaining: string[]; supported: number; claims: number; verdicts: string } | null = null;
      try {
        let w = await run({ skill: "module-analysis", instructions: base, readRoots: [kdir] });
        out.writer_platform = w.platform; out.skill_version = w.skill_version;
        for (;;) {
          if (w.error || !w.artifact.trim()) throw new Error(w.error ?? "empty result");
          const page = w.artifact;
          writeFileSync(file, page);
          const code = formatModuleReport(checkModule(o.repo, page, sha));
          let v: VerdictReport | null = null;
          let vtext = "";
          const claims = extractClaims(o.repo, page);
          out.claims = claims.length;
          if (!code && claims.length) {
            // batches keep each answer short enough to arrive whole; claims still unanswered get one more ask
            const rows: VerdictRow[] = [];
            let text = "";
            let into = rows;
            const ask = async (batch: Claim[]) => {
              const vr = await run({ skill: "claim-verification", instructions: "CLAIMS\n" + formatClaims(batch), platform: o.verifier, readRoots: [] });
              out.verifier_platform = vr.platform;
              out.independent_verifier = vr.platform !== w.platform;
              if (vr.error) throw new Error("verifier failed: " + vr.error);
              text += vr.artifact.trim() + "\n";
              into.push(...parseVerdicts(vr.artifact).filter((r) => batch.some((c) => c.id === r.id)));
            };
            for (let i = 0; i < claims.length; i += BATCH) await ask(claims.slice(i, i + BATCH));
            for (let k = 0; k < 2; k++) {
              const missed = claims.filter((c) => !rows.some((r) => r.id === c.id));
              if (!missed.length) break;
              log(`${mod.id}: verifier left ${missed.length} claim(s) unanswered, asking again`);
              await ask(missed);
            }
            // verdicts are noisy (the same page scored 17, 22 and 20 supported in three rounds): a claim stays flagged
            // only when a second look at just the flagged claims agrees
            const flagged = claims.filter((c) => rows.some((r) => r.id === c.id && r.verdict !== "supported"));
            if (flagged.length) {
              const second: VerdictRow[] = [];
              into = second;
              await ask(flagged);
              for (const r of second) {
                const first = rows.find((x) => x.id === r.id);
                if (first && r.verdict === "supported") { log(`${mod.id}: ${r.id} flagged once, supported on the second look`); first.verdict = "supported"; first.reason = ""; }
              }
            }
            writeFileSync(file.replace(/\.draft\.md$/, ".verdicts.md"), text);
            vtext = text;
            v = summariseVerdicts(claims, rows);
            out.supported = v.supported;
          }
          const unsettled = !!code || (v ? !v.ok : false);
          out.remaining = [...(code ? code.split("\n") : []), ...(v?.flagged.map((f) => `${f.id} ${f.verdict}: ${f.reason}`) ?? []), ...(v?.unanswered.map((id) => `no verdict for ${id}`) ?? [])];
          log(`${mod.id} round ${out.rounds}: ${code ? "code check failed: " + code.split("\n").slice(0, 2).join(" | ").slice(0, 240) : `${out.supported}/${out.claims} claims supported`}`);
          const score = out.remaining.length + (code ? 1000 : 0);
          if (!best || score < best.score) best = { score, page, remaining: out.remaining, supported: out.supported, claims: out.claims, verdicts: vtext };
          if (!unsettled) { out.status = "clean"; break; }
          out.status = "needs-review";
          if (out.rounds >= maxRepairs) {
            // a repair can make a page worse; keep the best round, not the last
            if (best && best.page !== page) {
              writeFileSync(file, best.page);
              if (best.verdicts) writeFileSync(file.replace(/\.draft\.md$/, ".verdicts.md"), best.verdicts);
              out.remaining = best.remaining; out.supported = best.supported; out.claims = best.claims;
              log(`${mod.id}: kept the best round (${best.supported}/${best.claims} supported), not the last`);
            }
            break;
          }
          out.rounds++;
          w = await run({ skill: "module-analysis", instructions: base + "\n\n" + repairBlock(page, code, v), readRoots: [kdir] });
        }
      } catch (e) {
        out.status = "failed"; out.error = (e as Error).message;
        log(`${mod.id} failed: ${out.error}`);
        if (/session limit/.test(out.error)) { m.stopped = out.error; break; }
      }
    }
  } catch (e) {
    m.stopped = (e as Error).message;
    log("stopped: " + m.stopped);
  }
  save();
  return m;
}
