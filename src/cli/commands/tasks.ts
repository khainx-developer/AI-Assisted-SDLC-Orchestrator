/** `tasks list | show | remove`: inspect and delete workflow tasks. */
import { Workflow } from "../../workflow/service.js";

export function tasksCommand(a: string[]): void {
  const wf = new Workflow();
  const [sub, ref, ...rest] = a;
  if (sub === "list") {
    const rows = wf.db.prepare("SELECT task_id, stage, title, project_root, needs_attention, dispatch_status FROM tasks ORDER BY created_at DESC LIMIT 30").all() as any[];
    for (const r of rows) console.log(`${r.task_id}  ${r.stage.padEnd(15)} ${r.needs_attention ? "[attention] " : ""}${r.dispatch_status === "in-flight" ? "[running] " : ""}${r.title}  (${r.project_root})`);
    if (!rows.length) console.log("(no tasks)");
  } else if (sub === "show" && ref) {
    const t = wf.findTask(ref);
    console.log(`${t.task_id}  ${t.title}\nstage: ${t.stage}  branch: ${t.branch}  flags: ${JSON.stringify(t.flags)}\nrefs: ${JSON.stringify(t.linked_refs)}  dispatch: ${t.dispatch_status ?? "-"}`);
    console.log("\nhistory:");
    for (const h of t.history as any[]) console.log(`  ${h.created_at}  ${h.from_stage ?? "-"} -> ${h.to_stage}  (${h.reason})`);
    const si = rest.indexOf("--stage");
    const want = si >= 0 ? rest[si + 1] : undefined;
    for (const art of t.artifacts as any[]) {
      if (want && art.stage !== want) continue;
      const x: any = wf.getArtifact(t.task_id, art.stage);
      console.log(`\n=== ${art.stage} v${x.version}  skill=${x.skill_version ?? "-"}  platform=${x.platform ?? "-"}  built from=${JSON.stringify(x.input_refs)} ===\n${x.content}`);
    }
    const ec = wf.db.prepare("SELECT description, decision FROM edge_cases WHERE task_id=?").all(t.task_id) as any[];
    if (ec.length) console.log("\nedge cases:\n" + ec.map((e) => `  - ${e.description} -> ${e.decision}`).join("\n"));
  } else if (sub === "remove" && ref) {
    const t = wf.findTask(ref);
    if (!rest.includes("--yes")) { console.log(`would permanently remove ${t.task_id} "${t.title}" and its artifacts; re-run with --yes to confirm`); return; }
    console.log(JSON.stringify(wf.deleteTask(t.task_id, rest.includes("--with-children")), null, 2));
  } else console.error("usage: tasks list | tasks show <task_id|jira-key|pr#> [--stage requirement|design|plan] | tasks remove <ref> --yes [--with-children]");
}
