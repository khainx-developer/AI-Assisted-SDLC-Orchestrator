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
- List all files touched across steps. The orchestrator uses this list twice: for overlap checks with other tasks, and as the ALLOWED SCOPE of the coding session, which is checked afterwards (anything changed outside it is reported to the human). So list every file the work will really need, including test files, and prefer a directory or glob (`src/retry/`, `tests/retry/**`) over guessing exact names that are not settled yet.
- Shape. When the change adds or alters a data structure, a stored format, or a function, API or module boundary, write the Shape section first: the core data shape (types, fields, table columns, states) and the signatures at each boundary the change crosses, with no bodies. Name the structure that replaces scattered conditionals if there is one (a state machine, a lookup table, a typed model). The steps must follow this shape and the coder keeps to it, so settle it here, not in the code. Omit the section for a change that adds none of these (config, copy, a one-line fix).
- In the Test Plan, name the behaviours to test (input, expected output or error), and say where the tests go. When the tests are written first by a separate session, this section is its whole brief, so it must be specific enough to write tests from without reading the steps.
- If you find a durable fact about the codebase (structure, convention, deprecated module, flaky test) that the repo's own instruction files do not mention, list it under "Suggested repo-instruction additions" so a human can commit it to the repo's .github/agents or CLAUDE.md. Omit the field if there is nothing. Never present it as a requirement or step.

Output: only this template. The output is stored as a Markdown file that a human reviews, so write real Markdown: the `##` headings exactly as below, one bullet per list item (never a bracketed `[a, b, c]` list), no text outside the template.

```
# Plan: <short title>

## Shape
<types, fields, states, and signatures at each boundary, bodies omitted; put code in an indented block>   (omit this whole section if the change adds no data shape or boundary)

## Steps
1. `<file/component>` — <concrete change> — <why>
2. ...

## Files touched
- `path`   (or a directory / glob; include test files)

## Test Plan
- `<behaviour>`: given <input>, expect <output or error>   (where the test goes: `tests/...`)

## Rollback/Revert notes
<only if reversible = false; otherwise omit this whole section>

## Suggested repo-instruction additions
- ...   (omit this whole section if there is nothing)
```
