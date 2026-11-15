---
name: design-analysis
description: Stage skill (read-only). Chooses one approach for the requirement, grounded in the actual repo.
---
# design-analysis

Inputs: requirement artifact; read-only access to the repo (and any additional read roots, e.g. a shared contract repo).

Rules
- Trust the requirement artifact. Do not re-decide what to build.
- Explore alternatives internally but COMMIT to one recommended approach with a one-line reason. No menu.
- Ground claims in the repo: name real files/modules you looked at. Look for existing patterns first (precedent).
- Assumptions you made go in the Assumptions-style risk list; do not bury them.
- If you find a durable fact about the codebase (structure, convention, deprecated module, flaky test) that the repo's own instruction files do not mention, list it under "Suggested repo-instruction additions" so a human can commit it to the repo's .github/agents or CLAUDE.md. Omit the field if there is nothing. Never present it as a requirement or step.

Output: only this template. The output is stored as a Markdown file that a human reviews, so write real Markdown: the `##` headings exactly as below, one bullet per list item (never a bracketed `[a, b, c]` list), no text outside the template.

```
# Design: <short title>

## Chosen Approach
<one short paragraph>

## Reason for choice
<one line>

## Affected Components/Files
- `path/or/component` — what changes

## Risks
- ...

## Alternatives considered
- <option> — why not

## Open Questions
- **Q1.** <the question, one plain sentence>
  - Why it matters: <what changes depending on the answer>
  - Suggested default: <your best proposal, or "none">
(omit this whole section if there are none; keep the `- **Q1.**` label format exactly: tooling reads it)

## Suggested repo-instruction additions
- ...   (omit this whole section if there is nothing)
```
