# North star: websites a stranger understands in five seconds

**Metric:** the share of flisk.si websites that pass GEL's `five-second-test` guard (a plain headline of at most 12 words, a lead of at most 32 words, no jargon, and a link or button right below).

**Baseline:** 18 of 31 websites passed on 2026-11-17, before the plain-words fixes. This was counted by hand in that session's first scoring run, so treat it as approximate.

**Target:** 1.5 times the baseline (about 87% passing).

**How it is measured:** `bun scripts/north-star.mjs` reads the live https://cilytics.flisk.si/sites.json, counts pass and fail rows (pages drawn by script and non-pages are left out), and writes `north-star.json`. The guard fails when that file is older than 30 days, so re-run it and commit the result.

**What this does not measure:** whether a person understands the page. The guard counts words and jargon. A real-phone check by a person is still the final test.
