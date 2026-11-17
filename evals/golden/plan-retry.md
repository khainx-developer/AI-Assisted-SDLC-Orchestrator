# Plan: Retry in sendEmail

## Steps
1. `src/mailer.js` — add a `sleep(ms)` helper — needed for the backoff delay
2. `src/mailer.js` — loop the fetch up to 3 times, waiting 100 ms then 200 ms — meets the retry criteria

## Files touched
- `src/mailer.js`
- `test/mailer.test.js`

## Test Plan
- `succeeds after two failures`: given a gateway that fails twice then answers ok, expect `sendEmail` to return true (`test/mailer.test.js`)
- `gives up after three attempts`: given a gateway that always fails, expect false and exactly 3 requests (`test/mailer.test.js`)
