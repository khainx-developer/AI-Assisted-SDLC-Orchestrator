---
name: task-breakdown
description: Stage skill (read-only). Splits work into independently shippable child tasks, only when it genuinely does not fit one pass.
---
# task-breakdown

Input: the requirement artifact.

Rules
- Split by independent deliverable, NOT by SDLC step. Re-labelling requirement/design/plan as subtasks is not a breakdown.
- Each child has exactly one write target (one repo). If a change needs commits in two repos, that is two children.
- If two children must ship together, say so explicitly (the orchestrator will set coordinated_release on the parent).
- If nothing is separable, output "No split — work fits one pass" and zero children.

Output: only this template.

```
Children:
  - <title> — <one-line scope> — <project_root/repo> — <why it is independent>
Coordinated release: yes|no — <reason>
(or exactly: "No split — work fits one pass")
```
