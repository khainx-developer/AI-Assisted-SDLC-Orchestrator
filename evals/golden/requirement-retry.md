# Requirement: Retry failed email sends

## Problem Statement
When the mail gateway rejects a send, `sendEmail` returns false and the message is lost without any further attempt.

## Goal
A failed send is retried a limited number of times with increasing delays before it is reported as failed.

## Scope
### In
- Retrying a failed send from `sendEmail`
### Out
- A persistent queue for undelivered messages

## Acceptance Criteria
1. A send that fails twice and then succeeds is reported as sent.
2. A send that fails on every attempt is reported as failed after the retry limit, and no further attempts are made.
3. The delay between attempts grows with each retry.

## Assumptions
- Gateway failures are usually temporary.

## Open Questions
- **Q1.** How many retries are acceptable before giving up?
  - Why it matters: it sets how long a caller may wait.
  - Suggested default: 3 attempts in total.
