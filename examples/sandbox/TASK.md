# Task: parseDuration

`src/duration.ts` exports `parseDuration(text)`, which turns strings like `"1h30m"` into milliseconds. It is a stub.

Make every test in `test/duration.test.ts` pass:

1. Hours and minutes: `"2h"`, `"45m"`, `"1h30m"`.
2. Seconds and milliseconds: `"90s"`, `"250ms"`, `"1m30s"`.
3. Errors: empty strings, unknown units and repeated units throw a `RangeError` whose message names the bad input.

Run tests with `baton test -- bun test`.
