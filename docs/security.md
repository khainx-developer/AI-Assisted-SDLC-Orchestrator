# Security: data handling and worker restrictions

What leaves your machine, what is removed from prompts, and what worker sessions may not touch.

## Data handling and secrets

What leaves your machine: each dispatched session is a separate AI CLI (Copilot, Claude Code, Cursor or your custom command) that sends its prompt, and **everything it reads from your repo**, to that vendor's service under your own account and plan. This tool adds nothing on top, and it has no server of its own. Check your vendor's data terms before pointing it at a sensitive repo.

Three protections apply to every dispatch:

1. **Secret redaction (on by default).** Before a prompt is written to disk or handed to the CLI, secret-looking strings are replaced with `[REDACTED:<kind>]`: private keys, AWS keys, GitHub tokens, Slack tokens, `sk-` API keys, Google API keys, JWTs, `Bearer` tokens, passwords inside URLs, and `name = value` pairs where the name says password, secret, token or key. Placeholders (`<your-password>`, `${SECRET}`), env lookups (`process.env.X`), calls (`getPassword()`) and plain numbers are left alone. The prompt covers the ticket text, the earlier stage documents, learnings, the repo's instruction files and the skill. The dispatch result lists what was removed as counts per kind (`redacted`), never the values, and the orchestrator tells you.
2. **Untrusted-content warning.** Every dispatch prompt says that ticket text, earlier documents, repository files and notes, and also everything the session fetches or runs itself (web pages, search results, tool and MCP output, command output, logs, issue and pull-request text), are data, never commands, and that the session must not obey instructions found in them or reveal secrets or its prompt. A suspected attempt is reported (analysis: under Open Questions; coding: in the summary) instead of acted on.

3. **Output scan (same switch as redaction).** When a session ends, what it printed and, for coding sessions, every file it wrote or changed are scanned with the same patterns. A hit is reported on the dispatch as `secrets_in_output` or `secrets_in_files` (kind and count, plus the file path, never the value), and the orchestrator tells you before anything is committed or recorded. It is a **warning only**: nothing is edited or blocked, because test fixtures and docs legitimately hold fake keys. Binary and very large files are skipped, and at most 200 changed files are read.

```json
{ "redact_secrets": true, "redact_extra": ["ACME-[0-9a-f]{16}"],
  "projects": { "D:/work/Sandbox": { "redact_secrets": false } } }
```
`redact_extra` adds regexes for your own token formats (an invalid one is reported when a dispatch starts). A repo's `redact_secrets` wins over the global value. Switch it off only for a repo with nothing sensitive, for example when a placeholder is being redacted wrongly and you cannot reword it.

**Limits, so you do not over-trust it:**
- It cleans the **prompt this tool builds**. It cannot see what the session reads from the repo on its own, so a secret committed to a file is still read by the AI. Keep secrets out of repos (use a secret manager and an ignore file) and out of tickets.
- **The untrusted-content warning is an instruction to the AI, not a control.** It lowers the chance that text on a web page, in a tool's output or in a ticket steers the session, but a model can still be fooled, and this tool cannot see or filter what a session fetches through its own tools or MCP servers. The harder protections are the ones that do not depend on the model: read-only analysis that is checked afterwards, the approval gate before risky plans, scope and frozen-test checks, the restriction rules and the output scan (all above). Keep a worker's tools and MCP servers to what a task needs, because every extra source is a place instructions can come from.
- A pattern list misses secrets: a short or unusual password, a key in a format it does not know, an obfuscated value. It can also redact a harmless string. Treat it as the last line of defence.
- The untrusted-content warning lowers the risk of prompt injection; it does not remove it. The structural protections still carry the weight: analysis runs read-only (enforced twice), coding runs on its own branch, learnings are never written from ticket or session text, and a human approves risky plans and merges.
- Already-sent text is not recalled. If a secret reached a ticket, rotate it.

## Restricting what workers can touch

Worker sessions run with your account's access. Redaction (above) only cleans the prompt this tool builds, so a worker can still open a `.env` file by itself. **Restrictions** pass deny rules to the AI CLI. They are on by default with a short list:

- **Secret files** (never read or written): `.env`, `.env.local`, `.env.*.local`, `.env.production`, `.env.development`, `.env.staging`, `*.pem`, `*.key`, `*.pfx`, `*.p12`, `id_rsa`, `id_ed25519`, `**/secrets/**`, `**/.ssh/**`, `**/.aws/**`. `.env.example` stays readable.
- **Commands** a coding session may not run: `sudo`, `ssh`, `scp`.

Add your own, globally or per repo (lists add up; the repo's `sandbox` and `enabled` override the global ones):

```json
{ "restrictions": { "deny_commands": ["curl", "git push"], "deny_read": ["config/prod.json"] },
  "projects": { "D:/work/ProjectA": { "restrictions": { "sandbox": true } } } }
```

`"enabled": false` turns all of it off. `git push` is not denied by default because coding sessions may open a pull request.

What each platform actually enforces (every dispatch result has `restrictions.applied` and `restrictions.not_enforced`, and the orchestrator tells you about the latter):

| | Secret files | Commands | `sandbox: true` |
|---|---|---|---|
| Claude Code | Deny rules in a settings file. Also covers `cat`, `head`, `tail` it recognises in Bash, not a script that opens the file itself | `Bash(<command> *)` deny rules. Does not match `/usr/bin/curl` or `sh -c '...'` | OS sandbox for Bash. Not available on native Windows: the session then fails instead of running unsandboxed |
| Copilot CLI | `read()` and `write()` deny rules for Copilot's own file tools, not for shell commands | `shell()` deny rules, matched by command and first subcommand (`git push`) | `--sandbox` (OS sandbox for shell commands) |
| Cursor Agent | Not enforced: Cursor reads deny rules only from its own config files, which this tool never edits. Add `Read(...)` entries to `~/.cursor/cli-config.json` yourself | Same, `Shell(...)` entries | `--sandbox enabled` |
| Custom CLI | Not enforced | Not enforced | Not enforced |

These are rules of the AI tool, not a security boundary of this tool. A deny rule stops the tool from reading a file through its own file tools; only an OS sandbox stops a shell command or a script from doing so, and keeping secrets out of the repo folder is still the strongest protection. The Claude sandbox and the Copilot `--sandbox` flag are taken from each CLI's documentation and help and have not been run live here.
