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

Output: only this template, nothing before or after.

```
Problem Statement: ...
Goal: ...
Scope — In: [...]   Out: [...]
Acceptance Criteria: [...]
Assumptions: [...]
Open Questions: [...]
Suggested repo-instruction additions: [...]   (optional)
```
