# duration.js

ESM module `src/duration.js` exporting two functions.

## parseDuration(text) -> number (milliseconds)

- Units: `ms`, `s`, `m`, `h`, `d`, `w` (week = 7 days).
- A duration is one or more `<number><unit>` parts, optionally separated by
  spaces: `"1h30m"`, `"1h 30m"`, `"2d 4h"`, `"500ms"`.
- Numbers may be decimals: `"1.5h"` = 5 400 000. Each unit may appear at most
  once and units must appear from largest to smallest (`"30m1h"` is invalid).
- A leading `-` negates the whole duration: `"-2m"` = -120 000.
- A bare number (no unit) is milliseconds: `"250"` = 250.
- Leading/trailing whitespace is ignored; input is case-insensitive (`"1H"`).
- Anything else throws `TypeError` whose message starts with `Invalid duration`:
  empty string, unknown unit, repeated unit, wrong order, non-string input.

## formatDuration(ms, { long = false } = {}) -> string

- Integer milliseconds in, compact string out using the largest units first,
  skipping zero parts: `5400000` -> `"1h 30m"`, `90061001` -> `"1d 1h 1m 1s 1ms"`.
- Weeks are used: `1209600000` -> `"2w"`.
- `0` -> `"0ms"`. Negative values get a leading `-`: `-60000` -> `"-1m"`.
- `{ long: true }` spells units out with correct plurals:
  `5400000` -> `"1 hour 30 minutes"`, `1000` -> `"1 second"`, `0` -> `"0 milliseconds"`.
- Non-integer or non-finite input throws `TypeError` (`Invalid milliseconds`).
- Round trip: `parseDuration(formatDuration(x)) === x` for every integer `x`.
