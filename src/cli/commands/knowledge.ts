/** `knowledge claims | repair | check-module | freshness`: deterministic checks of knowledge pages against the code they cite. */
import { readFileSync } from "node:fs";
import { optionOf } from "../args.js";
import { extractClaims, formatClaims, parseVerdicts, summariseVerdicts, formatVerdictReport, repairBlock } from "../../knowledge/claims.js";
import { checkModule, formatModuleReport } from "../../knowledge/module-check.js";
import { checkFreshness, formatFreshness } from "../../knowledge/freshness.js";
import { listKnowledgeDocuments, readKnowledgeDocument } from "../../knowledge/storage.js";

export function knowledgeCommand(argv: string[]): void {
  const oi = (n: string) => optionOf(argv, n);
  if (argv[1] === "claims") {
    if (!oi("repo") || !oi("module")) { console.error("usage: knowledge claims --repo <path> --module <module.md> [--verdicts <file>]\n       without --verdicts: prints the claim pack (each claim with its cited lines) for the claim-verification skill.\n       with --verdicts: counts the verifier's answers; exit 1 when any claim is partial, unsupported or unanswered."); process.exit(1); }
    const claims = extractClaims(oi("repo")!, readFileSync(oi("module")!, "utf8"));
    if (!oi("verdicts")) { console.log(formatClaims(claims)); return; }
    const r = summariseVerdicts(claims, parseVerdicts(readFileSync(oi("verdicts")!, "utf8")));
    console.log(formatVerdictReport(r));
    process.exit(r.ok ? 0 : 1);
  }
  if (argv[1] === "repair") {
    if (!oi("repo") || !oi("module")) { console.error("usage: knowledge repair --repo <path> --module <module.md> [--verdicts <file>]\n       prints the REPAIR block (the page plus citation and verdict findings) for a user-directed revision. Prints nothing and exits 0 when there is nothing to repair."); process.exit(1); }
    const page = readFileSync(oi("module")!, "utf8");
    const code = formatModuleReport(checkModule(oi("repo")!, page));
    const v = oi("verdicts") ? summariseVerdicts(extractClaims(oi("repo")!, page), parseVerdicts(readFileSync(oi("verdicts")!, "utf8"))) : null;
    if (!code && (!v || v.ok)) return;
    console.log(repairBlock(page, code, v));
    return;
  }
  if (argv[1] === "check-module") {
    if (!oi("repo") || !oi("module")) { console.error("usage: knowledge check-module --repo <path> --module <module.md> [--sha <commit>]\n       checks citations in one selected Markdown document against their source files. It does not scan the repository. Exit 1 when it finds problems."); process.exit(1); }
    const r = checkModule(oi("repo")!, readFileSync(oi("module")!, "utf8"), oi("sha"));
    console.log(formatModuleReport(r) || `module page agrees with the repo (${r.citations} citations)`);
    process.exit(r.ok ? 0 : 1);
  }
  if (argv[1] === "freshness") {
    if (!oi("repo")) { console.error("usage: knowledge freshness --repo <path> [--page <file.md>]\n       checks whether knowledge pages still match the code they cite (all pages in the project's knowledge store, or one file); exits 1 if any page is stale, broken or unknown"); process.exit(1); }
    const pages = oi("page") ? [{ name: oi("page")!, md: readFileSync(oi("page")!, "utf8") }] : listKnowledgeDocuments(oi("repo")!).documents.map((d) => ({ name: d.path, md: readKnowledgeDocument(oi("repo")!, d.path).content }));
    if (!pages.length) { console.log("no knowledge pages"); return; }
    const reports = pages.map((p) => ({ name: p.name, r: checkFreshness(oi("repo")!, p.md) }));
    for (const x of reports) console.log(formatFreshness(x.name, x.r));
    process.exit(reports.every((x) => x.r.state === "fresh" || x.r.state === "shifted") ? 0 : 1);
  }
  console.error("usage: knowledge claims|repair|check-module|freshness (project knowledge is drafted in chat from user-selected context; no project scan is available)");
  process.exit(1);
}
