# North Star: cilytics

Serves the org North Star: [docs/NORTH_STAR.md](https://github.com/flisk-sh/.github/blob/main/docs/NORTH_STAR.md).

- **Metric:** share of flisk-sh repositories whose default branch is green
- **Baseline:** first hourly run, 2026-11-17
- **Target:** ratio 1.2, higher is better
- **Result file:** `docs/north-star/result.json` (`value`, `baseline`, `unit`, `measuredAt`)

- **Measured by:** `node scripts/measure-north-star.mjs`, which reads the live https://cilytics.flisk.si/data.json (the hourly collect run's output) and takes `1 - redRepos / repos`. GEL's north-star workflow (`.github/workflows/north-star.yml`) runs it each Monday and pushes the result, with its run link, to the `north-star` branch; `history.jsonl` there keeps every run. Nobody types the number in.
- **Baseline value:** 0.9518. The 2026-11-17 run had 4 red repos but did not record how many it scanned, so the baseline uses 83, the count when the measure was written.

The share cannot go above 1, so a 1.2x target over a 0.95 baseline cannot be met. The target needs a new baseline or a different metric, and a person has to decide which.
