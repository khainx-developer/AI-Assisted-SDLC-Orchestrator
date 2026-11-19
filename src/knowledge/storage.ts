import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, writeFileSync, linkSync, unlinkSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { dataDir, normRoot } from "../common/paths.js";
import { loadConfig, redactSettings } from "../common/config.js";
import { DEFAULT_DENY_READ, restrictionsFor } from "../common/restrictions.js";
import { redactSecrets } from "../common/redact.js";
import { slugFor } from "../common/learnings.js";

const MAX_SOURCE_FILES = 12;
const MAX_SOURCE_FILE_BYTES = 256 * 1024;
const MAX_SOURCE_TOTAL_BYTES = 1024 * 1024;
const SECRET_LIKE_NAME = /(password|passwd|secret|credential|private[-_.]?key|token)/i;
const SECRET_FILE_EXTENSIONS = new Set([".pem", ".key", ".pfx", ".p12", ".p7b", ".p7c", ".p8", ".jks", ".keystore"]);

export interface KnowledgeDocument {
  path: string;
  size: number;
  updatedAt: string;
}

export interface KnowledgeSyncDestination {
  cloudId: string;
  spaceKey: string;
  parentContentId: string;
}

export interface KnowledgeSyncMapping {
  path: string;
  pageId: string;
  title: string;
  baselineHash: string;
  remoteVersion?: number;
  lastSyncedAt: string;
}

export interface KnowledgeSyncComparison {
  path: string;
  pageId: string;
  title: string;
  baselineHash: string;
  localHash: string | null;
  remoteHash: string;
  localChanged: boolean;
  remoteChanged: boolean;
  action: "unchanged" | "publish-local" | "pull-confluence" | "same-change" | "conflict" | "local-missing";
}

interface StoredKnowledgeSyncMapping extends KnowledgeSyncMapping {
  baselineContent: string;
}

interface StoredKnowledgeSyncState {
  schema: 1;
  destination?: KnowledgeSyncDestination;
  documents: Record<string, StoredKnowledgeSyncMapping>;
}

const EMPTY_SYNC_STATE: StoredKnowledgeSyncState = { schema: 1, documents: {} };

export function knowledgeSlug(projectRoot: string): string {
  const root = normRoot(projectRoot);
  const configured = Object.entries(loadConfig().projects ?? {}).find(([path]) => normRoot(path) === root)?.[1]?.slug;
  if (configured) return slugFor(root);

  const remote = gitRemote(root);
  if (!remote) return slugFor(root);
  const normalized = normalizeRemote(remote);
  const name = normalized.split("/").pop() ?? "repo";
  const base = name.replace(/[^a-z0-9._-]+/g, "-") || "repo";
  return `${base}-${createHash("sha1").update(normalized).digest("hex").slice(0, 6)}`;
}

export function knowledgeDirectory(projectRoot: string): string {
  return join(dataDir(), "knowledge", knowledgeSlug(projectRoot));
}

export function listKnowledgeDocuments(projectRoot: string): { root: string; documents: KnowledgeDocument[] } {
  const root = knowledgeRoot(projectRoot, false);
  if (!root) return { root: knowledgeDirectory(projectRoot), documents: [] };
  const documents: KnowledgeDocument[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Symbolic links are not allowed in project knowledge: ${file}`);
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
        const info = lstatSync(file);
        documents.push({
          path: relative(root, file).split("\\").join("/"),
          size: info.size,
          updatedAt: info.mtime.toISOString(),
        });
      }
    }
  };
  visit(root);
  documents.sort((left, right) => left.path.localeCompare(right.path));
  return { root, documents };
}

export function readKnowledgeDocument(projectRoot: string, relativePath: string): { path: string; content: string } {
  const normalized = normalizeDocumentPath(relativePath);
  const root = knowledgeRoot(projectRoot, false);
  if (!root) throw new Error(`Project knowledge directory does not exist: ${knowledgeDirectory(projectRoot)}`);
  const file = resolveUnderRoot(root, normalized, false);
  if (!lstatSync(file).isFile()) throw new Error(`Project knowledge document is not a file: ${normalized}`);
  return { path: normalized, content: readFileSync(file, "utf8") };
}

export function readKnowledgeDocumentForSync(projectRoot: string, relativePath: string): { path: string; content: string } {
  const document = readKnowledgeDocument(projectRoot, relativePath);
  const { counts } = redactSecrets(document.content, redactSettings(projectRoot).redact_extra);
  if (Object.keys(counts).length) {
    throw new Error(`Refusing to prepare ${document.path} for Confluence: secret-like content was detected (${Object.entries(counts).map(([kind, count]) => `${kind}: ${count}`).join(", ")}). Review and remove it before syncing.`);
  }
  return document;
}

export function writeKnowledgeDocument(
  projectRoot: string,
  relativePath: string,
  content: string,
  overwrite = false,
): KnowledgeDocument {
  if (!content.trim()) throw new Error("Document content must not be empty");
  const normalized = normalizeDocumentPath(relativePath);
  const root = knowledgeRoot(projectRoot, true)!;
  const file = resolveUnderRoot(root, normalized, true);
  if (existsSync(file)) {
    if (lstatSync(file).isSymbolicLink()) throw new Error(`Symbolic links are not allowed in project knowledge: ${file}`);
    if (!lstatSync(file).isFile()) throw new Error(`Project knowledge path is not a file: ${normalized}`);
    if (!overwrite) throw new Error(`Document already exists: ${normalized}; set overwrite=true only after the user approves replacement`);
  }

  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, content, { encoding: "utf8", flag: "wx" });
    if (overwrite) renameSync(temporary, file);
    else {
      linkSync(temporary, file);
      unlinkSync(temporary);
    }
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
  const info = lstatSync(file);
  return { path: normalized, size: info.size, updatedAt: info.mtime.toISOString() };
}

export function getKnowledgeSyncState(projectRoot: string): {
  destination?: KnowledgeSyncDestination;
  documents: KnowledgeSyncMapping[];
} {
  const state = readKnowledgeSyncState(projectRoot);
  return {
    destination: state.destination,
    documents: Object.values(state.documents).map(({ baselineContent: _baselineContent, ...mapping }) => mapping)
      .sort((left, right) => left.path.localeCompare(right.path)),
  };
}

export function configureKnowledgeSync(projectRoot: string, destination: KnowledgeSyncDestination): KnowledgeSyncDestination {
  const normalized = {
    cloudId: destination.cloudId.trim(),
    spaceKey: destination.spaceKey.trim(),
    parentContentId: destination.parentContentId.trim(),
  };
  for (const [name, value] of Object.entries(normalized)) {
    if (!value) throw new Error(`Confluence ${name} must not be empty`);
  }
  const state = readKnowledgeSyncState(projectRoot);
  if (state.destination && Object.values(state.documents).length
    && (state.destination.cloudId !== normalized.cloudId
      || state.destination.spaceKey !== normalized.spaceKey
      || state.destination.parentContentId !== normalized.parentContentId)) {
    throw new Error("Confluence destination cannot change while documents are mapped; resolve or export the existing sync state first");
  }
  state.destination = normalized;
  writeKnowledgeSyncState(projectRoot, state);
  return normalized;
}

export function readKnowledgeSyncBaseline(projectRoot: string, relativePath: string): {
  path: string;
  pageId: string;
  title: string;
  content: string;
  hash: string;
  remoteVersion?: number;
  lastSyncedAt: string;
} {
  const normalized = normalizeDocumentPath(relativePath);
  const mapping = readKnowledgeSyncState(projectRoot).documents[normalized];
  if (!mapping) throw new Error(`No Confluence sync baseline exists for ${normalized}`);
  return {
    path: mapping.path,
    pageId: mapping.pageId,
    title: mapping.title,
    content: mapping.baselineContent,
    hash: mapping.baselineHash,
    remoteVersion: mapping.remoteVersion,
    lastSyncedAt: mapping.lastSyncedAt,
  };
}

export function reconcileKnowledgeDocument(
  projectRoot: string,
  relativePath: string,
  remoteContent: string,
): KnowledgeSyncComparison {
  const normalized = normalizeDocumentPath(relativePath);
  const mapping = readKnowledgeSyncState(projectRoot).documents[normalized];
  if (!mapping) throw new Error(`No Confluence sync mapping exists for ${normalized}`);
  const localExists = listKnowledgeDocuments(projectRoot).documents.some((document) => document.path === normalized);
  const localContent = localExists ? readKnowledgeDocument(projectRoot, normalized).content : null;
  const localHash = localContent === null ? null : createHash("sha256").update(localContent).digest("hex");
  const remoteHash = createHash("sha256").update(remoteContent).digest("hex");
  const localChanged = localHash !== null && localHash !== mapping.baselineHash;
  const remoteChanged = remoteHash !== mapping.baselineHash;
  let action: KnowledgeSyncComparison["action"];
  if (localHash === null) action = "local-missing";
  else if (!localChanged && !remoteChanged) action = "unchanged";
  else if (localChanged && !remoteChanged) action = "publish-local";
  else if (!localChanged && remoteChanged) action = "pull-confluence";
  else if (localHash === remoteHash) action = "same-change";
  else action = "conflict";
  return {
    path: normalized,
    pageId: mapping.pageId,
    title: mapping.title,
    baselineHash: mapping.baselineHash,
    localHash,
    remoteHash,
    localChanged,
    remoteChanged,
    action,
  };
}

export function recordKnowledgeSyncBaseline(
  projectRoot: string,
  input: {
    relativePath: string;
    pageId: string;
    title: string;
    content: string;
    remoteVersion?: number;
    cloudId: string;
    spaceKey: string;
    parentContentId: string;
    confirmed: boolean;
  },
): KnowledgeSyncMapping {
  if (!input.confirmed) throw new Error("Recording a Confluence sync requires confirmed=true after the user approves the sync action");
  const normalized = normalizeDocumentPath(input.relativePath);
  if (!input.content.trim()) throw new Error("Confluence baseline content must not be empty");
  const pageId = input.pageId.trim();
  const title = input.title.trim();
  if (!pageId || !title) throw new Error("Confluence page ID and title must not be empty");
  const state = readKnowledgeSyncState(projectRoot);
  assertDestinationMatches(state, input);
  readKnowledgeDocument(projectRoot, normalized);
  const mapping: StoredKnowledgeSyncMapping = {
    path: normalized,
    pageId,
    title,
    baselineContent: input.content,
    baselineHash: createHash("sha256").update(input.content).digest("hex"),
    remoteVersion: input.remoteVersion,
    lastSyncedAt: new Date().toISOString(),
  };
  state.documents[normalized] = mapping;
  writeKnowledgeSyncState(projectRoot, state);
  return withoutBaseline(mapping);
}

export function applyRemoteKnowledgeDocument(
  projectRoot: string,
  input: {
    relativePath: string;
    pageId: string;
    title: string;
    content: string;
    expectedLocalHash: string;
    remoteVersion?: number;
    confirmed: boolean;
  },
): KnowledgeDocument {
  if (!input.confirmed) throw new Error("Applying a Confluence edit locally requires confirmed=true after the user approves the pull");
  const normalized = normalizeDocumentPath(input.relativePath);
  const state = readKnowledgeSyncState(projectRoot);
  const mapping = state.documents[normalized];
  if (!mapping || mapping.pageId !== input.pageId) throw new Error(`Confluence page is not mapped to ${normalized}`);
  const local = readKnowledgeDocument(projectRoot, normalized);
  const currentHash = createHash("sha256").update(local.content).digest("hex");
  if (currentHash !== input.expectedLocalHash) {
    throw new Error(`Local document changed after it was read; refusing to overwrite ${normalized}`);
  }

  const result = writeKnowledgeDocument(projectRoot, normalized, input.content, true);
  state.documents[normalized] = {
    ...mapping,
    title: input.title.trim() || mapping.title,
    baselineContent: input.content,
    baselineHash: createHash("sha256").update(input.content).digest("hex"),
    remoteVersion: input.remoteVersion,
    lastSyncedAt: new Date().toISOString(),
  };
  writeKnowledgeSyncState(projectRoot, state);
  return result;
}

export function readProjectSourceFiles(projectRoot: string, relativePaths: string[]): {
  files: { path: string; content: string; redacted: Record<string, number> }[];
} {
  if (!relativePaths.length || relativePaths.length > MAX_SOURCE_FILES) {
    throw new Error(`Provide between 1 and ${MAX_SOURCE_FILES} explicitly named source files`);
  }
  const root = realpathSync(resolve(projectRoot));
  const restrictions = [...DEFAULT_DENY_READ, ...restrictionsFor(projectRoot).deny_read, "local.settings.json"];
  const redactExtra = redactSettings(projectRoot).redact_extra;
  const files: { path: string; content: string; redacted: Record<string, number> }[] = [];
  let totalBytes = 0;
  for (const input of [...new Set(relativePaths)]) {
    const normalized = normalizeSourcePath(input);
    if (isDeniedSource(normalized, restrictions)) {
      throw new Error(`Reading this source path is not allowed: ${normalized}`);
    }
    const file = resolveUnderRoot(root, normalized, false);
    const info = lstatSync(file);
    if (!info.isFile()) throw new Error(`Source path is not a file: ${normalized}`);
    if (info.size > MAX_SOURCE_FILE_BYTES) throw new Error(`Source file exceeds the ${MAX_SOURCE_FILE_BYTES} byte limit: ${normalized}`);
    totalBytes += info.size;
    if (totalBytes > MAX_SOURCE_TOTAL_BYTES) throw new Error(`Selected source files exceed the ${MAX_SOURCE_TOTAL_BYTES} byte total limit`);

    const bytes = readFileSync(file);
    if (bytes.includes(0)) throw new Error(`Binary source files cannot be read: ${normalized}`);
    const text = bytes.toString("utf8");
    const fullRedaction = redactSecrets(text, redactExtra);
    if (fullRedaction.counts["private-key"]) throw new Error(`Source file contains private-key material and cannot be read: ${normalized}`);
    const counts: Record<string, number> = {};
    const content = text.split(/\r?\n/).map((line, index) => {
      const redacted = redactSecrets(line, redactExtra);
      for (const [kind, count] of Object.entries(redacted.counts)) counts[kind] = (counts[kind] ?? 0) + count;
      return `${index + 1}: ${redacted.text}`;
    }).join("\n");
    files.push({ path: normalized, content, redacted: counts });
  }
  return { files };
}

function knowledgeRoot(projectRoot: string, create: boolean): string | undefined {
  const dataRoot = realpathSync(resolve(dataDir()));
  const slug = knowledgeSlug(projectRoot);
  let current = dataRoot;
  for (const segment of ["knowledge", slug]) {
    current = join(current, segment);
    if (existsSync(current)) {
      const info = lstatSync(current);
      if (info.isSymbolicLink()) throw new Error(`Symbolic links are not allowed in project knowledge: ${current}`);
      if (!info.isDirectory()) throw new Error(`Project knowledge path is not a directory: ${current}`);
    } else if (create) {
      mkdirSync(current);
    } else {
      return undefined;
    }
  }
  return realpathSync(current);
}

function readKnowledgeSyncState(projectRoot: string): StoredKnowledgeSyncState {
  const root = knowledgeRoot(projectRoot, false);
  if (!root) return { ...EMPTY_SYNC_STATE, documents: {} };
  const metadataDirectory = join(root, ".meta");
  if (!existsSync(metadataDirectory)) return { ...EMPTY_SYNC_STATE, documents: {} };
  const directoryInfo = lstatSync(metadataDirectory);
  if (directoryInfo.isSymbolicLink() || !directoryInfo.isDirectory()) throw new Error("Confluence sync metadata path must be a regular directory");
  const file = join(metadataDirectory, "confluence-sync.json");
  if (!existsSync(file)) return { ...EMPTY_SYNC_STATE, documents: {} };
  const info = lstatSync(file);
  if (info.isSymbolicLink() || !info.isFile()) throw new Error("Confluence sync state must be a regular file");
  const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Confluence sync state has an unsupported or invalid format");
  }
  const value = parsed as Record<string, unknown>;
  if (value.schema !== 1 || !value.documents || typeof value.documents !== "object" || Array.isArray(value.documents)) {
    throw new Error("Confluence sync state has an unsupported or invalid format");
  }
  let destination: KnowledgeSyncDestination | undefined;
  if (value.destination !== undefined) {
    const raw = value.destination;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Confluence sync destination is invalid");
    const dest = raw as Record<string, unknown>;
    if (typeof dest.cloudId !== "string" || !dest.cloudId || typeof dest.spaceKey !== "string" || !dest.spaceKey
      || typeof dest.parentContentId !== "string" || !dest.parentContentId) {
      throw new Error("Confluence sync destination is incomplete");
    }
    destination = { cloudId: dest.cloudId, spaceKey: dest.spaceKey, parentContentId: dest.parentContentId };
  }
  const documents: Record<string, StoredKnowledgeSyncMapping> = {};
  for (const [path, raw] of Object.entries(value.documents as Record<string, unknown>)) {
    const normalized = normalizeDocumentPath(path);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`Confluence sync mapping is invalid for ${path}`);
    const entry = raw as Record<string, unknown>;
    if (entry.path !== normalized || typeof entry.pageId !== "string" || typeof entry.title !== "string"
      || typeof entry.baselineContent !== "string" || typeof entry.baselineHash !== "string"
      || typeof entry.lastSyncedAt !== "string"
      || (entry.remoteVersion !== undefined && (!Number.isSafeInteger(entry.remoteVersion) || Number(entry.remoteVersion) < 1))) {
      throw new Error(`Confluence sync mapping is incomplete for ${path}`);
    }
    const calculatedHash = createHash("sha256").update(entry.baselineContent).digest("hex");
    if (calculatedHash !== entry.baselineHash) throw new Error(`Confluence sync baseline hash is invalid for ${path}`);
    documents[normalized] = {
      path: normalized,
      pageId: entry.pageId,
      title: entry.title,
      baselineContent: entry.baselineContent,
      baselineHash: entry.baselineHash,
      remoteVersion: typeof entry.remoteVersion === "number" ? entry.remoteVersion : undefined,
      lastSyncedAt: entry.lastSyncedAt,
    };
  }
  return {
    schema: 1,
    destination,
    documents,
  };
}

function writeKnowledgeSyncState(projectRoot: string, state: StoredKnowledgeSyncState): void {
  const root = knowledgeRoot(projectRoot, true)!;
  const file = join(root, ".meta", "confluence-sync.json");
  if (!existsSync(dirname(file))) mkdirSync(dirname(file));
  else {
    const info = lstatSync(dirname(file));
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("Confluence sync metadata path must be a regular directory");
  }
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    renameSync(temporary, file);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

function assertDestinationMatches(
  state: StoredKnowledgeSyncState,
  destination: KnowledgeSyncDestination,
): asserts state is StoredKnowledgeSyncState & { destination: KnowledgeSyncDestination } {
  if (!state.destination) throw new Error("Configure a Confluence sync destination before recording document mappings");
  if (state.destination.cloudId !== destination.cloudId
    || state.destination.spaceKey !== destination.spaceKey
    || state.destination.parentContentId !== destination.parentContentId) {
    throw new Error("Confluence destination does not match the configured sync destination");
  }
}

function withoutBaseline(mapping: StoredKnowledgeSyncMapping): KnowledgeSyncMapping {
  const { baselineContent: _baselineContent, ...result } = mapping;
  return result;
}

function resolveUnderRoot(root: string, relativePath: string, createParents: boolean): string {
  const segments = relativePath.split("/");
  const target = resolve(root, ...segments);
  if (isOutsideRoot(relative(root, target))) throw new Error("Path escapes its allowed root");
  let current = root;
  for (const segment of segments.slice(0, -1)) {
    current = join(current, segment);
    if (existsSync(current)) {
      const info = lstatSync(current);
      if (info.isSymbolicLink()) throw new Error(`Symbolic links are not allowed in project knowledge: ${current}`);
      if (!info.isDirectory()) throw new Error(`Path component is not a directory: ${current}`);
    } else if (createParents) {
      mkdirSync(current);
    } else {
      throw new Error(`Document does not exist: ${relativePath}`);
    }
  }
  if (existsSync(target) && lstatSync(target).isSymbolicLink()) {
    throw new Error(`Symbolic links are not allowed in project knowledge: ${target}`);
  }
  const rootReal = realpathSync(root);
  if (existsSync(dirname(target)) && isOutsideRoot(relative(rootReal, realpathSync(dirname(target))))) {
    throw new Error("Path escapes its allowed root");
  }
  return target;
}

function normalizeDocumentPath(path: string): string {
  const normalized = normalizeRelativePath(path);
  if (!normalized.toLowerCase().endsWith(".md")) throw new Error("Only Markdown project-knowledge documents are supported");
  return normalized;
}

function normalizeSourcePath(path: string): string {
  const normalized = normalizeRelativePath(path);
  if (normalized.split("/").some((segment) => segment === ".git")) throw new Error("Git metadata is not a project source");
  if (normalized.includes("*") || normalized.includes("?")) throw new Error("Source paths must name files exactly; globs are not supported");
  if (SECRET_FILE_EXTENSIONS.has(extname(normalized).toLowerCase())) throw new Error(`Secret/key files cannot be read: ${normalized}`);
  return normalized;
}

function normalizeRelativePath(path: string): string {
  if (!path || path.includes("\0")) throw new Error("Path must not be empty");
  const normalized = path.replaceAll("\\", "/");
  if (normalized.startsWith("/") || /^[a-zA-Z]:/.test(normalized)) throw new Error("Path must be relative to its allowed root");
  const segments = normalized.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error("Path must not contain empty, dot, or traversal segments");
  }
  return normalized;
}

function isDeniedSource(path: string, patterns: string[]): boolean {
  const name = basename(path);
  if (SECRET_LIKE_NAME.test(name)) return true;
  return patterns.some((pattern) => {
    const normalized = pattern.replaceAll("\\", "/");
    const candidate = normalized.includes("/") ? path : name;
    return globToRegex(normalized).test(candidate);
  });
}

function globToRegex(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*\//g, "\u0001")
    .replace(/\*\*/g, "\u0000")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    .replace(/\u0001/g, "(?:.*/)?")
    .replace(/\u0000/g, ".*");
  return new RegExp(`^${escaped}$`, "i");
}

function gitRemote(root: string): string | null {
  try {
    return execFileSync("git", ["remote", "get-url", "origin"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    }).trim() || null;
  } catch {
    return null;
  }
}

function normalizeRemote(url: string): string {
  let value = url.trim().replace(/\.git$/i, "");
  const scp = value.match(/^[^@/\s]+@([^:/\s]+):(.+)$/);
  if (scp) value = `${scp[1]}/${scp[2]}`;
  else value = value.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").replace(/^[^/@]+@/, "");
  return value.replace(/\/+$/, "").toLowerCase();
}

function isOutsideRoot(path: string): boolean {
  return isAbsolute(path) || path === ".." || path.startsWith(`..${sep}`);
}
