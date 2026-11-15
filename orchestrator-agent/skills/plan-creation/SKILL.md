---
name: plan-creation
description: Stage skill (read-only). Turns the chosen design into ordered, dispatchable steps.
---
# plan-creation

Inputs: requirement + design artifacts; read-only repo access.

Rules
- Do not re-litigate what to build or which approach. Only work out HOW to execute the chosen approach.
- Every step must be statable as "touch file X to do Y". If it cannot be, the plan is not done.
- Include a test plan. Include rollback/revert notes only if the task is not reversible.
- List all files touched across steps (the orchestrator uses this for overlap checks).
- If you find a durable fact about the codebase (structure, convention, deprecated module, flaky test) that the repo's own instruction files do not mention, list it under "Suggested repo-instruction additions" so a human can commit it to the repo's .github/agents or CLAUDE.md. Omit the field if there is nothing. Never present it as a requirement or step.

Output: only this template. The output is stored as a Markdown file that a human reviews, so write real Markdown: the `##` headings exactly as below, one bullet per list item (never a bracketed `[a, b, c]` list), no text outside the template.

```
# Plan: <short title>

## Steps
1. `<file/component>` — <concrete change> — <why>
2. ...

## Files touched
- `path`

## Test Plan
- ...

## Rollback/Revert notes
<only if reversible = false; otherwise omit this whole section>

## Suggested repo-instruction additions
- ...   (omit this whole section if there is nothing)
```
