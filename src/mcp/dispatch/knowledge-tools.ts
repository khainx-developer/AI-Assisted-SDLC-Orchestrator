/** Project knowledge tools: the separate knowledge store, freshness and citation checks, Confluence sync bookkeeping. */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  configureKnowledgeSync,
  getKnowledgeSyncState,
  listKnowledgeDocuments,
  reconcileKnowledgeDocument,
  readKnowledgeDocument,
  readKnowledgeDocumentForSync,
  readKnowledgeSyncBaseline,
  readProjectSourceFiles,
  recordKnowledgeSyncBaseline,
  writeKnowledgeDocument,
} from "../../knowledge/storage.js";
import { checkFreshness } from "../../knowledge/freshness.js";
import { checkModule, formatModuleReport } from "../../knowledge/module-check.js";
import { planPublish, writeIndexPage, isGenerated } from "../../knowledge/publish-plan.js";
import { run } from "./shared.js";

export function registerKnowledgeTools(server: McpServer): void {
  server.tool(
    "list_knowledge_documents",
    "List saved Markdown knowledge documents for one project. This reads only the separate knowledge store, never the project repository.",
    { project_root: z.string().min(1) },
    (a) => run(() => listKnowledgeDocuments(a.project_root))
  );
  
  server.tool(
    "check_knowledge_freshness",
    "Check whether saved knowledge pages still match the code they cite. No model call: it reads each page's `Source: <repo>@<commit>` line and asks git which cited files and lines changed since. States: fresh, shifted (cited file changed elsewhere), stale (cited lines changed), broken (cited file gone), unknown (no usable Source commit). Pass relative_path for one page, or omit it to check every page in the project's knowledge store. It reads the repository only through git and the cited paths, and never scans it.",
    { project_root: z.string().min(1), relative_path: z.string().optional() },
    (a) => run(() => {
      const paths = a.relative_path ? [a.relative_path] : listKnowledgeDocuments(a.project_root).documents.map((d) => d.path).filter((p) => !isGenerated(p));
      return paths.map((p) => ({ page: p, ...checkFreshness(a.project_root, readKnowledgeDocument(a.project_root, p).content) }));
    })
  );
  
  server.tool(
    "check_knowledge_citations",
    "Check one saved knowledge page against the code it cites. No model call: every `path:line` must exist in the repo, bullets that state facts must cite, a backticked name must appear in the files its bullet cites, and `Source` must name a commit. Module pages must also have the module headings; other page types are not held to them. Returns ok, the number of citations and a plain-text report you can hand back to the session as repair instructions. It cannot tell whether a sentence is true: use the claim-verification skill for that.",
    { project_root: z.string().min(1), relative_path: z.string().min(1), expected_sha: z.string().optional().describe("commit the page should name in Source; omit to skip that check") },
    (a) => run(() => {
      const r = checkModule(a.project_root, readKnowledgeDocument(a.project_root, a.relative_path).content, a.expected_sha);
      return { page: a.relative_path, ok: r.ok, citations: r.citations, report: formatModuleReport(r) };
    })
  );
  
  server.tool(
    "plan_knowledge_publish",
    "What publishing the project's knowledge pages to Confluence would do, worked out locally (no remote call, nothing written). For each page: the Confluence title to use (`<project> / <page title>`), the labels to set (sdlc-knowledge, sdlc-type-<type>, sdlc-project-<project>), its freshness, the page it is already mapped to, and whether publishing renames it. Show this in the sync preview. A rename or a stale or broken page needs the user's explicit approval like any other write.",
    { project_root: z.string().min(1) },
    (a) => run(() => planPublish(a.project_root))
  );
  
  server.tool(
    "write_knowledge_index",
    "Regenerate `_index.md` in the knowledge store: a generated overview page listing every knowledge page with its type, summary, scope, checked commit and freshness. It is the one page that is overwritten without asking, because it is generated. It is synced to Confluence like any other page, with the same preview and approval.",
    { project_root: z.string().min(1) },
    (a) => run(() => writeIndexPage(a.project_root))
  );
  
  server.tool(
    "read_knowledge_document",
    "Read one Markdown document from the project's separate knowledge store. Rejects absolute paths, traversal, and symlinks.",
    { project_root: z.string().min(1), relative_path: z.string().min(1) },
    (a) => run(() => readKnowledgeDocument(a.project_root, a.relative_path))
  );
  
  server.tool(
    "read_knowledge_document_for_sync",
    "Read one Markdown knowledge document for an external Confluence sync. Refuses the document if secret-looking content is detected; review and remove it before syncing.",
    { project_root: z.string().min(1), relative_path: z.string().min(1) },
    (a) => run(() => readKnowledgeDocumentForSync(a.project_root, a.relative_path))
  );
  
  server.tool(
    "write_knowledge_document",
    "Create or explicitly overwrite one Markdown document in the project's separate knowledge store. Overwriting is disabled by default; only set overwrite=true after the user approves replacement.",
    { project_root: z.string().min(1), relative_path: z.string().min(1), content: z.string(), overwrite: z.boolean().default(false) },
    (a) => run(() => writeKnowledgeDocument(a.project_root, a.relative_path, a.content, a.overwrite))
  );
  
  server.tool(
    "configure_knowledge_sync",
    "Save the user's Confluence site, space key and parent content ID for this project's document sync. This stores identifiers only and makes no remote request or write.",
    {
      project_root: z.string().min(1),
      cloud_id: z.string().trim().min(1),
      space_key: z.string().trim().min(1),
      parent_content_id: z.string().trim().min(1),
    },
    (a) => run(() => configureKnowledgeSync(a.project_root, {
      cloudId: a.cloud_id,
      spaceKey: a.space_key,
      parentContentId: a.parent_content_id,
    }))
  );
  
  server.tool(
    "get_knowledge_sync_state",
    "Read the local Confluence page mappings and last-synced hashes for a project. Baseline document content is not included; use read_knowledge_sync_baseline for one mapped document.",
    { project_root: z.string().min(1) },
    (a) => run(() => getKnowledgeSyncState(a.project_root))
  );
  
  server.tool(
    "read_knowledge_sync_baseline",
    "Read the last-synced Markdown baseline for one mapped knowledge document. Use it to compare local and Confluence edits before a bidirectional sync.",
    { project_root: z.string().min(1), relative_path: z.string().min(1) },
    (a) => run(() => readKnowledgeSyncBaseline(a.project_root, a.relative_path))
  );
  
  server.tool(
    "reconcile_knowledge_document",
    "Compare one mapped local Markdown file and supplied current Confluence Markdown with their last-synced baseline. Returns a deterministic action; it never writes either side.",
    { project_root: z.string().min(1), relative_path: z.string().min(1), remote_content: z.string() },
    (a) => run(() => reconcileKnowledgeDocument(a.project_root, a.relative_path, a.remote_content))
  );
  
  server.tool(
    "record_knowledge_sync_baseline",
    "Record a successful Confluence create, update or user-approved page adoption as a local baseline. Requires confirmed=true after the user approved this sync, and the destination must match the configured one.",
    {
      project_root: z.string().min(1),
      relative_path: z.string().min(1),
      page_id: z.string().trim().min(1),
      title: z.string().trim().min(1),
      content: z.string(),
      remote_version: z.number().int().min(1).optional(),
      cloud_id: z.string().trim().min(1),
      space_key: z.string().trim().min(1),
      parent_content_id: z.string().trim().min(1),
      confirmed: z.boolean(),
    },
    (a) => run(() => recordKnowledgeSyncBaseline(a.project_root, {
      relativePath: a.relative_path,
      pageId: a.page_id,
      title: a.title,
      content: a.content,
      remoteVersion: a.remote_version,
      cloudId: a.cloud_id,
      spaceKey: a.space_key,
      parentContentId: a.parent_content_id,
      confirmed: a.confirmed,
    }))
  );
  
  // Confluence to local pull (apply_remote_knowledge_document in storage.ts) is parked: sync is one way, local to Confluence. See BACKLOG.md.
  server.tool(
    "read_project_source_files",
    "Read only the exact relative source-file paths explicitly supplied by the user. No directory listing, globbing, recursive traversal, or repository scan is performed. Secret-like files are denied, content is size-capped and redacted, and returned lines are numbered.",
    { project_root: z.string().min(1), relative_paths: z.array(z.string().min(1)).min(1).max(12) },
    (a) => run(() => readProjectSourceFiles(a.project_root, a.relative_paths))
  );
}
