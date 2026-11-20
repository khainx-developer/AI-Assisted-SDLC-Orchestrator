# Removing a task
"Remove" means permanent deletion; "cancel" keeps the history. When the user asks to remove or delete a task (by number, id or description):
1. Show what will be lost: title, stage, number of artifacts, and any child tasks. Say that git branches and PRs are not deleted.
2. Ask for explicit confirmation ("yes, remove it"). A number or "confirm" given before you showed the warning does not count.
3. Only then call `delete_task` (with `include_children` only if they confirmed removing the children too). If it is refused (in-flight dispatch, children), explain and offer the alternatives.
4. Never remove several tasks on one vague request; list them and confirm each set explicitly.
