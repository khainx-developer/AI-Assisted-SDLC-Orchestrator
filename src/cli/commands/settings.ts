/** `repos`, `model`, `branch` and `config`: edit config.json. */
import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fwd, readRawConfig } from "../args.js";
import { branchName, DEFAULT_BRANCH_PATTERN } from "../../config/config.js";
import * as ce from "../../config/config-edit.js";

export function reposCommand(a: string[]): void {
  const { file, cfg } = readRawConfig();
  cfg.projects = cfg.projects ?? {};
  const [sub, ...paths] = a;
  if (sub === "add") {
    for (const p of paths) {
      const k = fwd(resolve(p));
      if (!existsSync(resolve(p))) { console.error(`not found: ${k}`); continue; }
      cfg.projects[k] = cfg.projects[k] ?? {};
      console.log(`added ${k}`);
    }
  } else if (sub === "remove") {
    for (const p of paths) { delete cfg.projects[fwd(resolve(p))]; console.log(`removed ${fwd(resolve(p))}`); }
  } else if (sub !== "list") { console.error("usage: repos list | add <path>... | remove <path>..."); process.exit(1); }
  if (sub !== "list") writeFileSync(file, JSON.stringify(cfg, null, 2));
  const keys = Object.keys(cfg.projects);
  console.log(keys.length ? keys.join("\n") : "(no repos registered)");
}

export function modelCommand(a: string[]): void {
  const { file, cfg } = readRawConfig();
  const [sub, ...rest] = a;
  const ri = rest.indexOf("--repo");
  const repoArg = ri >= 0 ? rest[ri + 1] : undefined;
  if (ri >= 0 && !repoArg) { console.error("--repo needs a path"); process.exit(1); }
  const key = repoArg ? fwd(resolve(repoArg)) : undefined;
  const platformOf = (v: any) => v?.platform ?? v?.coding_platform ?? v?.analysis_platform ?? cfg.coding_platform ?? cfg.default_platform;
  if (sub === "show") {
    console.log("platform models (platforms.<id>.model):");
    for (const [id, p] of Object.entries<any>(cfg.platforms ?? {})) console.log(`  ${id}: ${p?.model ?? "(CLI default)"}`);
    const rows = Object.entries<any>(cfg.projects ?? {}).filter(([k]) => !key || k === key);
    for (const [k, v] of rows) console.log(`${k}: ${v?.model ?? `(platform default, ${platformOf(v)}: ${cfg.platforms?.[platformOf(v)]?.model ?? "CLI default"})`}`);
    return;
  }
  if (sub === "set") {
    const name = rest.filter((_, i) => ri < 0 || (i !== ri && i !== ri + 1))[0];
    if (!name || !key) { console.error("usage: model set <name> --repo <path>"); process.exit(1); }
    cfg.projects = cfg.projects ?? {};
    cfg.projects[key] = { ...(cfg.projects[key] ?? {}), model: name };
    writeFileSync(file, JSON.stringify(cfg, null, 2));
    console.log(`${key}: model set to ${name}. A wrong name fails instantly at no cost. Reload your tool so the servers reread config.json.`);
    return;
  }
  if (sub === "reset") {
    if (!key) { console.error("usage: model reset --repo <path>"); process.exit(1); }
    if (cfg.projects?.[key]) delete cfg.projects[key].model;
    writeFileSync(file, JSON.stringify(cfg, null, 2));
    console.log(`${key}: model reset to the platform's model.`);
    return;
  }
  console.error("usage: model show | set <name> --repo <path> | reset --repo <path>");
  process.exit(1);
}

export function branchCommand(a: string[]): void {
  const { file, cfg } = readRawConfig();
  const [sub, ...rest] = a;
  const ri = rest.indexOf("--repo");
  const repoArg = ri >= 0 ? rest[ri + 1] : undefined;
  if (ri >= 0 && !repoArg) { console.error("--repo needs a path"); process.exit(1); }
  const positional = rest.filter((_, i) => i !== ri && i !== ri + 1 || ri < 0);
  const repoKey = repoArg ? fwd(resolve(repoArg)) : undefined;
  const sample = (root: string, pattern: string) => {
    const jira = branchName({ task_id: "task_ab12cd34", project_root: root, linked_refs: { jira_key: "PROJ-123" } }, pattern);
    const adhoc = branchName({ task_id: "task_ab12cd34", project_root: root }, pattern);
    return `${jira}   (no Jira key: ${adhoc})`;
  };
  if (sub === "show") {
    const global = cfg.branch_pattern ?? DEFAULT_BRANCH_PATTERN;
    console.log(`global: ${global}${cfg.branch_pattern ? "" : "  (default)"}
  e.g. ${sample("/repo", global)}`);
    const rows = Object.entries<any>(cfg.projects ?? {}).filter(([k, v]) => v?.branch_pattern && (!repoKey || k === repoKey));
    for (const [k, v] of rows) console.log(`${k}: ${v.branch_pattern}
  e.g. ${sample(k, v.branch_pattern)}`);
    if (repoKey && !rows.length) console.log(`${repoKey}: no override, uses the global pattern`);
    return;
  }
  if (sub === "set") {
    const pattern = positional[0];
    if (!pattern) { console.error("usage: branch set <pattern> [--repo <path>]"); process.exit(1); }
    try { console.log(`e.g. ${sample(repoKey ?? "/repo", pattern)}`); } catch (e: any) { console.error(`error: ${e.message}`); process.exit(1); }
    if (repoKey) { cfg.projects = cfg.projects ?? {}; cfg.projects[repoKey] = { ...(cfg.projects[repoKey] ?? {}), branch_pattern: pattern }; }
    else cfg.branch_pattern = pattern;
    writeFileSync(file, JSON.stringify(cfg, null, 2));
    console.log(`${repoKey ?? "global"} branch pattern set to ${pattern}. Reload your tool so the servers reread config.json.`);
    return;
  }
  if (sub === "reset") {
    if (repoKey) { if (cfg.projects?.[repoKey]) delete cfg.projects[repoKey].branch_pattern; } else delete cfg.branch_pattern;
    writeFileSync(file, JSON.stringify(cfg, null, 2));
    console.log(`${repoKey ?? "global"} branch pattern reset.`);
    return;
  }
  console.error("usage: branch show | set <pattern> | reset  [--repo <path>]");
  process.exit(1);
}

export function configCommand(a: string[]): void {
  const [sub, ...rest] = a;
  const ri = rest.indexOf("--repo");
  if (ri >= 0 && !rest[ri + 1]) { console.error("--repo needs a path"); process.exit(1); }
  const repo = ri >= 0 ? rest[ri + 1] : undefined;
  const pos = rest.filter((_, i) => ri < 0 || (i !== ri && i !== ri + 1));
  try {
    if (sub === "show") console.log(JSON.stringify(ce.describeConfig(repo), null, 2));
    else if (sub === "add-project" && pos[0]) { const r = ce.addProject(pos[0]); console.log(r.added ? `added ${r.project_root}` : `${r.project_root} is already registered`); }
    else if (sub === "remove-project" && pos[0]) { const r = ce.removeProject(pos[0]); console.log(r.removed ? `removed ${r.project_root}` : `${r.project_root} was not registered`); }
    else if (sub === "set" && pos.length === 2) { const r = ce.updateSetting(repo, pos[0], pos[1]); console.log(`${r.scope}: ${r.key} = ${JSON.stringify(r.value)}`); }
    else if (sub === "unset" && pos.length === 1) { const r = ce.updateSetting(repo, pos[0], null); console.log(`${r.scope}: ${r.key} unset`); }
    else { console.error("usage: config show [--repo <path>] | add-project <path> | remove-project <path> | set <key> <value> [--repo <path>] | unset <key> [--repo <path>]"); process.exit(1); }
  } catch (e: any) { console.error(`error: ${e.message}`); process.exit(1); }
}
