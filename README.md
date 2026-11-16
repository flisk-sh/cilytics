# Cilytics

Hourly CI health for any GitHub org or user: which workflows are red, flaky or slow, per-repo pass rate, [GEL](https://github.com/flisk-sh/gel) guard results and AI-SDLC flags. It reads the GitHub API only. No model, no account, no server: a GitHub Action writes a snapshot to a branch of your own repository and GitHub Pages serves it.

Live example, for the flisk-sh org: https://cilytics.flisk.si/

## Run it on your org

Add this workflow to any repo you own (a `ci-dashboard` repo works well):

```yaml
# .github/workflows/cilytics.yml
name: Cilytics
on:
  schedule:
    - cron: "17 * * * *"
  workflow_dispatch:

permissions:
  contents: write # lets the action update the cilytics-data branch of this repo

jobs:
  cilytics:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - uses: flisk-sh/cilytics@<full commit SHA of the version you trust>
        with:
          org: your-org-or-username # optional, defaults to this repo's owner
```

Each run replaces `data.json`, `history.json` and `index.html` on the `cilytics-data` branch with one new commit. Turn on GitHub Pages for that branch (Settings, Pages, Deploy from a branch) and the page is at `https://<owner>.github.io/<repo>/`. Any hosted copy of the page can also show your data with `?src=owner/repo[@branch]`, for example `https://cilytics.flisk.si/?src=your-org/ci-dashboard`.

Pin the action to a commit SHA. The default token reads public repos only; pass a token with `repo` read access to include private repos.

### Inputs

| Input | Default | Meaning |
| --- | --- | --- |
| `org` | owner of the running repo | GitHub org or user to read |
| `token` | `github.token` | token that reads the repos and pushes the data branch |
| `branch` | `cilytics-data` | branch that receives the snapshot |
| `max-repos` | all | read at most this many repos, most recently pushed first |
| `scores-file` | none | JSON array of scorer rows to show as a Scoreboard |
| `scores-repo` | none | `owner/repo` the scores come from, shown beside the board |
| `scores-url` | none | https link template for a row, `{id}` is replaced by the row id |
| `cname` | none | custom Pages domain, written as a `CNAME` file on the data branch |
| `publish` | `true` | `false` writes `./cilytics-out` only (dry run) |

Run the collector by hand with `GITHUB_TOKEN=... CILYTICS_ORG=name bun scripts/collect.mjs --out data.json` (set `CILYTICS_MAX_REPOS` to cap it). Preview a local snapshot with `site/index.html?data=./data.json&history=./history.json`.

## What it measures

A repo is active when it is public, not archived, not a fork and was pushed in the last 90 days. For each, the last 100 workflow runs on the default branch (pull-request runs excluded) are read. A workflow is red when its newest completed run failed or timed out. Pass rate counts passed against failed runs; cancelled and skipped runs are left out. A workflow is flaky when it flipped between pass and fail at least three times in its window. The same API answers give the same file.

Delivery, over the last 30 days, for the whole account and per repo (`delivery` in data.json):

- **Merged PRs a day**: pull requests merged in the window, divided by 30.
- **Lead time p50 / p95**: hours from a pull request opening to its merge.
- **CI run p50 / p95**: minutes of a completed run on the default branch.
- **First-pass rate**: share of passed or failed runs that passed on their first attempt. A run that went green only after a re-run does not count.
- **Change failure rate**: share of default-branch commits with at least one red run.

These come from the same last 100 runs and the last 100 closed pull requests of each repo, so a very busy repo shows only its most recent days. A number with nothing behind it is shown as a dash, never as zero.

## GEL

[GEL](https://github.com/flisk-sh/gel) (guards, evals, loops) runs as a workflow named `GEL` (or a file called `gel.yml`) in each repo and uploads a `gel-record` artifact. Cilytics finds the newest completed GEL run per repo, reads `gel-record.jsonl` from its artifact, and shows which repos run GEL, the guard findings and what is blocked. Repos without GEL are marked as not installed; a record Cilytics cannot read still counts as installed, never as an error. The collector never edits a repo and GEL never reads Cilytics.

## Scan one repo

Open the page with `?repo=owner/name` (or a GitHub link), or type one into the box under the title. Cilytics then scans that repo live in your browser from the GitHub API, with no token by default, so GitHub's anonymous limit of 60 requests an hour per address applies; a scan takes four to forty. When the limit is used up the page offers a field for your own GitHub token (no scopes needed): it lifts the limit to 5000 an hour, stays in your browser and goes only to api.github.com. The box suggests the repos listed on [Ranker](https://ranker.flisk.si/). Only public repos can be scanned, and nothing is stored.

A live scan also runs two GEL guards, `pinned-actions` and `workflow-permissions`, on the repo's workflow files. They are the real modules from flisk-sh/gel, imported from a commit pinned in `site/index.html` (`GEL_BASE`). The other three guards need a checkout or a pull request, so the page says so and points to `npx github:flisk-sh/gel run`.

## Develop

```sh
bun test scripts/   # or: node --test scripts/
```

This repo's own workflow (`.github/workflows/cilytics.yml`) runs the action for the flisk-sh org, with the Flisk scoreboard as a worked `scores-file` example.

MIT licensed.
