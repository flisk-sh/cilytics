# Cilytics north star

**Visits that bounce on the first screen** (lower is better), from Flisk analytics (`site_stats`, `cilytics.flisk.si`, 30 days).

- Baseline, 2026-11-17: 38% bounce over 13 visits and 6 visitors, taken before the clearer first screen (#21, #25) was live. The sample is tiny and includes the team's own visits, so treat it as a starting line, not a finding.
- Target: 1.5x lower, so 25% or under.
- Re-measure: read `bounceRate` from `site_stats` for `cilytics.flisk.si` over 30 days and write it to `bench/north-star.json` as `value`, with `measuredAt`. The `north-star` guard fails when it is older than 30 days or the target is not met.
- Better metric once there is an event: visitors who start a scan. The page does not send that event yet.

The first-screen wording is gated separately by GEL's `five-second-test` (headline 12 words or fewer, lead 32 or fewer, no jargon, a button under the headline).
