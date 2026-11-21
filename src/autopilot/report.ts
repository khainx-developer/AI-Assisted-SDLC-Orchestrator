/** The morning report of an unattended run, as text. The data comes from Autonomy.report; nothing is computed here. */
import type { Autonomy } from "../workflow/autonomy.js";

type Report = ReturnType<Autonomy["report"]>;

export function formatReport(r: Report): string {
  const out: string[] = [];
  const { run, budget, counts } = r;
  out.push(`Run ${run.run_id} · ${run.status}${run.end_reason ? ` (${run.end_reason})` : ""} · started ${run.started_at}${run.ended_at ? ` · ended ${run.ended_at}` : ""}`);
  out.push(`Sessions: ${budget.used} of ${budget.max} · Tasks: ${r.tasks.length} (${counts.ready} ready for review, ${counts.parked} need you, ${counts.done} done, ${counts.unfinished} unfinished${counts.split ? `, ${counts.split} split into parts` : ""}${counts.other ? `, ${counts.other} cancelled` : ""})`);
  for (const [title, outcome] of [["READY FOR YOUR REVIEW", "ready"], ["NEEDS YOU (parked)", "parked"], ["DONE", "done"], ["UNFINISHED", "unfinished"], ["SPLIT INTO PARTS (the parts are listed separately)", "split"], ["CANCELLED", "cancelled"]] as const) {
    const rows = r.tasks.filter((t) => t.outcome === outcome);
    if (!rows.length) continue;
    out.push("", `${title}`);
    for (const t of rows) {
      const where = [t.jira_key, t.branch ? `branch ${t.branch}` : null, t.pr_number ? `PR #${t.pr_number}` : null].filter(Boolean).join(", ");
      out.push(`- ${t.task_id} · ${t.title} · stage ${t.stage}${where ? ` · ${where}` : ""}`);
      if (t.parked && outcome === "ready") out.push(`    ${t.parked.reason}`);
      else if (t.parked) {
        out.push(`    waiting on you: ${t.parked.reason}`);
        if (t.parked.question) out.push(...String(t.parked.question).split("\n").map((l) => `      ? ${l}`));
        if (t.parked.suggested_answer) out.push(`    the run would have chosen: ${t.parked.suggested_answer}`);
      }
      for (const d of t.decisions) out.push(`    decided for you (${d.kind}): ${d.summary}`);
    }
  }
  const decided = r.tasks.reduce((n, t) => n + t.decisions.length, 0);
  out.push("", decided ? `${decided} decision(s) were made on your behalf (listed above, also logged as edge cases). Disagree with one? Say so and the task goes back to that stage.` : "No decisions were made on your behalf.");
  return out.join("\n");
}
