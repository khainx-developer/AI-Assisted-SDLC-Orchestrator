---
name: requirement-analysis
description: Stage skill (read-only). Turns a ticket or ad-hoc request into a requirement artifact. Answers "what", never "how".
---
# requirement-analysis

Inputs you receive: raw ticket/ad-hoc text and the triage flags. Explore the repo read-only only to understand current behaviour.

Rules
- Answer WHAT and WHY. Never propose a design or implementation.
- If something is ambiguous, list it under Open Questions. Do not silently pick an answer.
- Every assumption you had to make goes under Assumptions.
- Acceptance criteria must be testable statements.
- If you find a durable fact about the codebase (structure, convention, deprecated module, flaky test) that the repo's own instruction files do not mention, list it under "Suggested repo-instruction additions" so a human can commit it to the repo's .github/agents or CLAUDE.md. Omit the field if there is nothing. Never present it as a requirement or step.

Output: only this template, nothing before or after. The output is stored as a Markdown file that a human reviews, so write real Markdown: the `##` headings exactly as below, one bullet per list item (never a bracketed `[a, b, c]` list), no text outside the template.

```
# Requirement: <short title>

## Problem Statement
<one short paragraph>

## Goal
<one or two sentences>

## Scope
### In
- ...
### Out
- ...

## Acceptance Criteria
1. <testable statement>
2. ...

## Assumptions
- ...

## Open Questions
- **Q1.** <the question, one plain sentence>
  - Why it matters: <what changes depending on the answer>
  - Suggested default: <your best proposal, or "none">
- **Q2.** ...
(Write "None." if there are none. Keep the `- **Q1.**` label format exactly: tooling reads it. A reader will answer these in chat, so each must stand on its own without the rest of the document.)

## Suggested repo-instruction additions
- ...   (omit this whole section if there is nothing)
```
