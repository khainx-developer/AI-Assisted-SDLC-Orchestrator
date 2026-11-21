import { loadConfig, projectConfig } from "./config.js";

/**
 * What a worker session is not allowed to touch, expressed once and translated by each platform adapter into that CLI's own
 * permission rules. These are tool-level rules of the AI CLI, not an OS boundary: see docs/security.md for what each platform enforces.
 */
export interface RestrictionsConfig {
  /** false turns every restriction off, including the built-in defaults */
  enabled?: boolean;
  /** file name patterns the session may not read or write, in addition to the built-in secret-file defaults */
  deny_read?: string[];
  /** command prefixes a coding session may not run (e.g. "git push", "curl"), in addition to the defaults */
  deny_commands?: string[];
  /** run shell commands in the CLI's OS sandbox where the CLI has one; a dispatch fails rather than run unsandboxed if it cannot */
  sandbox?: boolean;
}

export interface Restrictions {
  enabled: boolean;
  deny_read: string[];
  deny_commands: string[];
  sandbox: boolean;
}

/** Files that normally hold secrets. Examples (.env.example) stay readable. */
export const DEFAULT_DENY_READ = [
  ".env", ".env.local", ".env.*.local", ".env.production", ".env.development", ".env.staging",
  "*.pem", "*.key", "*.pfx", "*.p12", "id_rsa", "id_ed25519",
  "**/secrets/**", "**/.ssh/**", "**/.aws/**",
];
export const DEFAULT_DENY_COMMANDS = ["sudo", "ssh", "scp"];

const uniq = (a: string[]) => [...new Set(a.map((x) => x.trim()).filter(Boolean))];

/** Effective restrictions for a repo: lists add up (global + repo + defaults), switches are overridden by the repo. */
export function restrictionsFor(root: string): Restrictions {
  const g = loadConfig().restrictions ?? {};
  const p = projectConfig(root)?.restrictions ?? {};
  const enabled = p.enabled ?? g.enabled ?? true;
  if (!enabled) return { enabled: false, deny_read: [], deny_commands: [], sandbox: false };
  return {
    enabled: true,
    deny_read: uniq([...DEFAULT_DENY_READ, ...(g.deny_read ?? []), ...(p.deny_read ?? [])]),
    deny_commands: uniq([...DEFAULT_DENY_COMMANDS, ...(g.deny_commands ?? []), ...(p.deny_commands ?? [])]),
    sandbox: p.sandbox ?? g.sandbox ?? false,
  };
}

/** What the adapter did with the restrictions, recorded on the dispatch so the human can see what was and was not enforced. */
export interface RestrictionsReport {
  applied: string[];
  not_enforced: string[];
}
