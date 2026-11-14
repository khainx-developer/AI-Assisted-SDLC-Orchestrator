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

Output: only this template.

```
Chosen Approach: ...
Reason for choice: ... (one line)
Affected Components/Files: [...]
Risks: [...]
Alternatives considered (brief): [...]
```
