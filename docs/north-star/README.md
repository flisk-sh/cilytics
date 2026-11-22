# North Star: cilytics

Serves the org North Star: [docs/NORTH_STAR.md](https://github.com/flisk-sh/.github/blob/main/docs/NORTH_STAR.md).

- **Metric:** share of CI runs that fail across flisk-sh repositories (the last 100 runs of each)
- **Baseline:** the first hourly snapshot, 2026-11-16, with 11.6% of runs failing (88.4% passing, from `history.json`)
- **Target:** ratio 2, lower is better: halve the failing share, to 5.8% or less
- **Result file:** `docs/north-star/result.json` (`value`, `baseline`, `unit`, `measuredAt`)

- **Measured by:** `node scripts/measure-north-star.mjs`, which reads the live https://cilytics.flisk.si/data.json (the hourly collect run's output) and takes `100 - totals.passRate`. GEL's north-star workflow (`.github/workflows/north-star.yml`) runs it each Monday and pushes the result, with its run link, to the `north-star` branch; `history.jsonl` there keeps every run. Nobody types the number in.
- **Why this metric:** the first version measured the share of green repositories against a 1.2x target. A share cannot go above 1, so over a 0.95 baseline that target could never be met. A failing share can fall, and its baseline is a recorded number.
- **Edge:** the pass rate has one decimal, so a perfect 100% reads as 0.1% failing (GEL needs a positive value).
