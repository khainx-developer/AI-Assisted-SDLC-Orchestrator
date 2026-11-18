# Decision candidates: shop

Source: shop@0123abc

## Decisions
### D1. Money rules live in Shop.Core and the API only calls them
- Status: proposed
- Basis: stated
- Source: `docs/notes.md:3`; task_1 design.v2 (story implemented and merged)
- Modules: Orders core, Shop API
- Context: Order rules need one owner. The API could have called a payment gateway itself.
- Decision: The API calls OrderService in Shop.Core and never talks to a payment gateway directly.
- Alternatives considered: call the gateway from the API; rejected because the rules would be duplicated.
- Consequences:
  - Payment and order rules are changed in one module.
  - The API stays a thin layer.
### D2. Email sending goes through a queue
- Status: proposed
- Basis: inferred
- Source: commit message "SHOP-12 use queue for email sending"
- Modules: all
- Context: A commit message says a queue is used for email sending. No document gives the reasoning or the alternatives.
- Decision: Email sending is queued instead of sent inline.
- Alternatives considered: none recorded
- Consequences:
  - Sending no longer blocks the caller.
- Possible reason: to keep requests fast and survive mail outages.

## Not recorded as decisions
- Shop.Legacy targets netcoreapp3.1: a fact about the code, not a choice.
- The note about task_9 is work in progress, not a decision.

## Open Questions
- **Q1.** Why was a queue chosen for email sending, and what was considered instead?
  - Why it matters: until a person confirms the reason, D2 stays an inferred draft and is not treated as settled.
  - Suggested default: keep D2 as inferred.
