import { basename, normalize } from "node:path";
import { listKnowledgeDocuments, readKnowledgeDocument, getKnowledgeSyncState, writeKnowledgeDocument, type KnowledgeDocument } from "./storage.js";
import { parseHeader, checkFreshness, type Freshness } from "./freshness.js";

/** The generated overview page. It sits in the knowledge store like any page so it syncs like one, and its name starts with `_` so tools skip it. */
export const INDEX_PATH = "_index.md";
export const isGenerated = (path: string) => path.split("/").pop()!.startsWith("_");

const label = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
const projectName = (projectRoot: string) => basename(normalize(projectRoot).replace(/[\\/]+$/, "")) || "project";

export interface PublishItem {
  path: string;
  /** the Confluence page title: "<project> / <page title>" */
  title: string;
  /** Confluence labels: sdlc-knowledge, sdlc-type-<type>, sdlc-project-<project> */
  labels: string[];
  type: string | null;
  /** freshness against the code the page cites; the generated index is always "fresh" */
  state: Freshness;
  /** the Confluence page this file is already mapped to, if any */
  page_id: string | null;
  /** the title the page has on Confluence now, from the last sync */
  current_title: string | null;
  /** true when the page exists under a different title, so publishing renames it */
  rename: boolean;
}

export interface PublishPlan {
  project: string;
  items: PublishItem[];
  /** how many pages would be created, updated (content or title) or are not yet worth publishing */
  summary: { create: number; rename: number; stale_or_broken: number };
}

function titleFor(project: string, md: string, path: string): string {
  const t = parseHeader(md).title || path.replace(/\.md$/i, "");
  return `${project} / ${t}`;
}

/** What publishing the knowledge store to Confluence would do, decided locally. Makes no remote call and writes nothing. */
export function planPublish(projectRoot: string): PublishPlan {
  const project = projectName(projectRoot);
  const mappings = new Map(getKnowledgeSyncState(projectRoot).documents.map((m) => [m.path, m]));
  const docs = listKnowledgeDocuments(projectRoot).documents.filter((d: KnowledgeDocument) => !d.path.startsWith(".meta/"));
  const raw = docs.map((d) => {
    const md = readKnowledgeDocument(projectRoot, d.path).content;
    return { path: d.path, md, h: parseHeader(md), title: titleFor(project, md, d.path) };
  });
  const seen = new Map<string, number>();
  for (const r of raw) seen.set(r.title, (seen.get(r.title) ?? 0) + 1);
  const items: PublishItem[] = raw.map((r) => {
    const title = (seen.get(r.title) ?? 0) > 1 ? `${r.title} (${r.path})` : r.title; // titles are unique in a Confluence space
    const m = mappings.get(r.path);
    const type = isGenerated(r.path) ? "overview" : r.h.type;
    return {
      path: r.path, title, type,
      labels: ["sdlc-knowledge", ...(type ? [`sdlc-type-${label(type)}`] : []), `sdlc-project-${label(project)}`],
      state: isGenerated(r.path) ? "fresh" : checkFreshness(projectRoot, r.md).state,
      page_id: m?.pageId ?? null, current_title: m?.title ?? null, rename: !!m && m.title !== title,
    };
  });
  return {
    project, items,
    summary: {
      create: items.filter((i) => !i.page_id).length,
      rename: items.filter((i) => i.rename).length,
      stale_or_broken: items.filter((i) => i.state === "stale" || i.state === "broken").length,
    },
  };
}

const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();

/** The text of the generated overview page: one row per page, so a person or search can find the right one. */
export function buildIndexPage(projectRoot: string): string {
  const plan = planPublish(projectRoot);
  const rows = plan.items.filter((i) => !isGenerated(i.path)).map((i) => {
    const h = parseHeader(readKnowledgeDocument(projectRoot, i.path).content);
    return `| ${cell(i.title.replace(`${plan.project} / `, ""))} | ${cell(h.type ?? "")} | ${cell(h.summary ?? "")} | ${cell(h.applies_to.join(", "))} | ${h.source_sha ? h.source_sha.slice(0, 7) : "none"} | ${i.state} | ${cell(h.status ?? "")} |`;
  });
  return [
    `# Knowledge index`,
    ``,
    `Type: overview`,
    `Summary: The knowledge pages for ${plan.project}, with what each covers and how current it is. Start here.`,
    `Applies to: all`,
    `Status: draft`,
    ``,
    `This page is generated from the pages in the knowledge store. Do not edit it: the next sync overwrites it.`,
    ``,
    `| Page | Type | Summary | Applies to | Checked at | Freshness | Status |`,
    `|---|---|---|---|---|---|---|`,
    ...(rows.length ? rows : ["| (no pages yet) | | | | | | |"]),
    ``,
    `Freshness compares each page with the code it cites since its checked commit: fresh, shifted (the cited file changed elsewhere), stale (cited lines changed), broken (a cited file is gone), unknown (no checked commit).`,
    ``,
  ].join("\n");
}

/** Regenerates the index page in the store (the one page that is overwritten without asking, because it is generated). */
export function writeIndexPage(projectRoot: string): { path: string; content: string } {
  const content = buildIndexPage(projectRoot);
  writeKnowledgeDocument(projectRoot, INDEX_PATH, content, true);
  return { path: INDEX_PATH, content };
}
