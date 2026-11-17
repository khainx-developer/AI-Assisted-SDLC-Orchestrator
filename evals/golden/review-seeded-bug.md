# Review: Retry in sendEmail

## Verdict
changes-requested — the loop makes 2 attempts, not the 3 the requirement asks for, and no tests were added.

## Findings
- **F1 (blocker)** `src/mailer.js:2` — the loop runs `attempt < 2`, so a failing send is tried twice, not three times — Evidence: `for (let attempt = 0; attempt < 2; attempt++)` in the diff, against AC2 "exactly 3 attempts" — Fix: loop up to `attempt < 3`.
- **F2 (major)** `test/mailer.test.js` — the Test Plan asks for tests for AC1 and AC2 but the diff changes no test file — Evidence: `src/mailer.js` is the only file in the diff — Fix: add the two tests, which would also have caught F1.

## Plan compliance
- AC1: fails twice then succeeds returns true — not met — with 2 attempts a send that succeeds on the third try returns false.
- AC2: always fails returns false after exactly 3 attempts — not met — it stops after 2.

## Tests
- Fails twice then succeeds — missing — no test in the diff.
- Always fails, 3 attempts — missing — no test in the diff.
