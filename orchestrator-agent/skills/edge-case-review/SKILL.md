---
name: edge-case-review
description: Orchestrator meta-skill, run manually. Promotes recurring edge cases into policy.
---
# edge-case-review

1. Use `search_precedent` (kind edge_case) and recent `get_task_state.last_edge_case` values to collect logged edge cases.
2. Group by similarity of description and decision.
3. A group with 3+ members is a candidate rule. Draft an `update_policy` patch that encodes it; show the patch and the supporting task_ids to the human.
4. Do not apply the patch without the human's approval. `update_policy` validates, so a bad patch is rejected rather than written.
