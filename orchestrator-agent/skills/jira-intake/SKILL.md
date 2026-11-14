---
name: jira-intake
description: Orchestrator meta-skill. Maps a Jira issue into create_task fields.
---
# jira-intake

1. Fetch the issue with the Jira MCP.
2. title = summary. description = description + the Acceptance Criteria field verbatim, if present.
3. linked_refs = {"jira_key": "<KEY>"}.
4. Pass the text to `triage-task`. A filled Acceptance Criteria field makes requirement_clarity `high`.
5. Do not copy comments or attachments unless they change scope.
