/** `dispatches usage | prune`: cost and retention of finished AI sessions. */
import { pruneDispatches } from "../../stores/dispatch-store.js";
import { usageSummary, formatRow } from "../../stores/usage.js";
import { loadConfig } from "../../config/config.js";

export function dispatchesCommand(argv: string[]): void {
  if (argv[1] === "usage") {
    const ti = argv.indexOf("--task"), ui = argv.indexOf("--days");
    const s = usageSummary({ taskId: ti >= 0 ? argv[ti + 1] : undefined, days: ui >= 0 ? Number(argv[ui + 1]) : undefined });
    console.log(`total: ${formatRow(s.total)}`);
    for (const [title, rows] of [["by kind", s.by_kind], ["by platform", s.by_platform], ["by task", s.by_task]] as const)
      if (Object.keys(rows).length) { console.log(`\n${title}`); for (const [k, r] of Object.entries(rows)) console.log(`  ${k}: ${formatRow(r)}`); }
    console.log(`\n${s.note}`);
    return;
  }
  if (argv[1] !== "prune") { console.error("usage: dispatches prune [--days N] [--yes]   (default days from config dispatch_retention_days, else 14; without --yes only lists)\n       dispatches usage [--task <task_id>] [--days N]   (token use and cost of finished dispatches)"); process.exit(1); }
  const di = argv.indexOf("--days");
  const days = di >= 0 ? Number(argv[di + 1]) : loadConfig().dispatch_retention_days ?? 14;
  if (!Number.isFinite(days) || days < 0) { console.error("--days must be a number >= 0"); process.exit(1); }
  const r = pruneDispatches(days, !argv.includes("--yes"));
  console.log(`${argv.includes("--yes") ? "removed" : "would remove"} ${r.removed.length} finished dispatch(es) older than ${days} day(s); kept ${r.kept}${argv.includes("--yes") || !r.removed.length ? "" : "; re-run with --yes to delete"}`);
}
