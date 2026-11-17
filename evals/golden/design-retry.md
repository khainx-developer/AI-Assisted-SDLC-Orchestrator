# Design: Retry inside sendEmail

## Chosen Approach
Wrap the existing `fetch` call in `src/mailer.js` in a loop of up to three attempts, waiting 100 ms and then 200 ms between them. Only a non-ok response or a thrown network error triggers another attempt.

## Reason for choice
It is the smallest change that meets both acceptance criteria and keeps the public signature of `sendEmail`.

## Affected Components/Files
- `src/mailer.js` — add the retry loop and the delay helper

## Risks
- A slow gateway makes callers wait up to the sum of the delays plus three request times.

## Alternatives considered
- A queue with a background worker — more moving parts than the requirement asks for.
- Retrying in each caller — duplicates the logic.

## Open Questions
None.
