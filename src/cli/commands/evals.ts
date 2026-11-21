/** `evals check | run`: skill eval cases against golden artifacts (offline) or real AI sessions (costs money). */
import { optionOf } from "../args.js";
import { loadCases, checkGoldens, runEvals } from "../../evals/run.js";

export async function evalsCommand(argv: string[]): Promise<void> {
  const sub = argv[1];
  const oi = (n: string) => optionOf(argv, n);
  if (sub !== "check" && sub !== "run") {
    console.error("usage: evals check                                         offline: each golden artifact must pass its checks (free)\n       evals run [--case <name>] [--platform <p>] [--model <m>] [--repeat N]   live: runs the cases through real AI sessions (costs money)");
    process.exit(1);
  }
  let cases = loadCases();
  if (oi("case")) { cases = cases.filter((c) => c.name === oi("case")); if (!cases.length) { console.error(`no eval case named '${oi("case")}'`); process.exit(1); } }
  if (sub === "check") {
    const r = checkGoldens(cases);
    for (const x of r) console.log(`${x.pass ? "PASS" : "FAIL"}  ${x.case}${x.failures.length ? "\n      " + x.failures.join("\n      ") : ""}`);
    process.exit(r.every((x) => x.pass) ? 0 : 1);
  }
  const run = await runEvals(cases, { platform: oi("platform"), model: oi("model"), repeat: oi("repeat") ? Number(oi("repeat")) : 1 });
  for (const x of run.results) {
    const u = x.usage ? `, ${x.usage.input_tokens}/${x.usage.output_tokens} tokens ${x.usage.source}` : "";
    console.log(`${x.pass ? "PASS" : "FAIL"}  ${x.case}  (${x.skill_version}, ${x.platform}, ${Math.round((x.duration_ms ?? 0) / 1000)}s${u})${x.failures.length ? "\n      " + x.failures.join("\n      ") : ""}`);
  }
  for (const f of run.flaky) console.log(`FLAKY  ${f.case}: passed ${f.passed} of ${f.runs} runs`);
  for (const g of run.regressions) console.log(`REGRESSION  ${g.case}: passed with ${g.was}, fails with ${g.now}`);
  console.log(`${run.results.filter((x) => x.pass).length}/${run.results.length} runs passed; run saved under the data folder, evals/results`);
  process.exit(run.results.every((x) => x.pass) ? 0 : 1);
}
