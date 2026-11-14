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

Output: only this template.

```
Steps:
  1. <file/component> — <concrete change> — <why>
  2. ...
Files touched: [...]
Test Plan: [...]
Rollback/Revert notes: ... (only if reversible = false)
```
