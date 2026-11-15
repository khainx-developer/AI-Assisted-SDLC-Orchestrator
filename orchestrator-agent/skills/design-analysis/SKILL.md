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

Output: only this template.

```
Chosen Approach: ...
Reason for choice: ... (one line)
Affected Components/Files: [...]
Risks: [...]
Alternatives considered (brief): [...]
Suggested repo-instruction additions: [...]   (optional)
```
