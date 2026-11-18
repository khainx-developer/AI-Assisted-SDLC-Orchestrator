/**
 * Remove secret-looking strings from the text that is about to be sent to an AI CLI.
 *
 * What this is: a safety net for the prompt this tool builds (task input, learnings, repo instruction files, skill).
 * What it is not: it cannot see what the AI session reads on its own from the repo, and a pattern list will always
 * miss some secrets. Keep secrets out of tickets and repo files; treat this as the last line, not the first.
 * Only counts per kind are ever stored or shown, never the removed values.
 */

import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { redactSettings } from "./config.js";

interface Rule { kind: string; re: RegExp; /** keep this capture group (the key name) and replace the rest */ keep?: number }

const RULES: Rule[] = [
  { kind: "private-key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  { kind: "aws-access-key", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { kind: "github-token", re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{50,})\b/g },
  { kind: "slack-token", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g },
  { kind: "api-key", re: /\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}\b/g },
  { kind: "google-api-key", re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { kind: "jwt", re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
  { kind: "bearer-token", re: /\b(Bearer\s+)[A-Za-z0-9._~+/-]{20,}=*/g, keep: 1 },
  { kind: "url-credentials", re: /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/gi, keep: 1 },
  // name = value / name: value, where the name says it is a secret and the value is a real-looking literal (not a placeholder or a call)
  { kind: "assigned-secret", re: /\b((?:[A-Za-z0-9_.-]*(?:password|passwd|pwd|secret|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key|client[_-]?secret|connection[_-]?string)[A-Za-z0-9_.-]*)["']?\s*[:=]\s*["']?)(?![<{$%(]|\*{3}|\[REDACTED)(?![A-Za-z0-9_.-]*\()(?![A-Za-z_]\w*(?:\.[A-Za-z_]\w*)+(?![\w.]))(?=[^\s"'`,;)}\]]*[A-Za-z])[^\s"'`,;)}\]]{8,}["']?/gi, keep: 1 },
];

export interface RedactResult {
  text: string;
  /** kind -> how many were replaced. Never contains the values. */
  counts: Record<string, number>;
}

/** `extra` are additional regex sources (case-sensitive), for team-specific token formats. An invalid one throws with its text. */
export function redactSecrets(text: string, extra: string[] = []): RedactResult {
  const counts: Record<string, number> = {};
  let out = text;
  const rules: Rule[] = [...RULES, ...extra.map((src, i): Rule => {
    try { return { kind: `custom-${i + 1}`, re: new RegExp(src, "g") }; }
    catch (e: any) { throw new Error(`redact_extra pattern #${i + 1} '${src}' is not a valid regex: ${e.message}`); }
  })];
  for (const r of rules) {
    out = out.replace(r.re, (...m) => {
      counts[r.kind] = (counts[r.kind] ?? 0) + 1;
      const prefix = r.keep ? m[r.keep] : "";
      return `${prefix}[REDACTED:${r.kind}]`;
    });
  }
  return { text: out, counts };
}

const MAX_SCAN_FILES = 200;
const MAX_SCAN_BYTES = 1024 * 1024;

/**
 * Secret-looking strings in files a coding session wrote or changed: path -> kind -> count (never the values).
 * A warning, not a block: test fixtures and docs legitimately contain fake keys. Skips unreadable, binary and very large files.
 */
export function scanFilesForSecrets(root: string, files: string[], extra: string[] = []): { found: Record<string, Record<string, number>>; scanned: number; skipped: number } {
  const found: Record<string, Record<string, number>> = {};
  let scanned = 0, skipped = Math.max(0, files.length - MAX_SCAN_FILES);
  for (const f of files.slice(0, MAX_SCAN_FILES)) {
    try {
      const abs = join(root, f);
      const st = statSync(abs);
      if (!st.isFile() || st.size > MAX_SCAN_BYTES) { skipped++; continue; }
      const buf = readFileSync(abs);
      if (buf.includes(0)) { skipped++; continue; } // binary
      scanned++;
      const { counts } = redactSecrets(buf.toString("utf8"), extra);
      if (Object.keys(counts).length) found[f] = counts;
    } catch { skipped++; } // deleted or unreadable: nothing to scan
  }
  return { found, scanned, skipped };
}

/** Redact a prompt according to the repo's settings. Returns null when redaction is switched off for this repo. */
export function redactForRepo(projectRoot: string, text: string): RedactResult | null {
  const s = redactSettings(projectRoot);
  return s.redact_secrets ? redactSecrets(text, s.redact_extra) : null;
}
