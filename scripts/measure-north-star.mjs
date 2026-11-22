#!/usr/bin/env node
// Cilytics' north star, measured: the share of flisk-sh repositories whose default branch is green, read from the data the
// hourly collect run publishes (https://cilytics.flisk.si/data.json). GEL's north-star workflow runs this each week and
// publishes the printed result to the north-star branch. The last stdout line is the result GEL reads.
//
// Baseline: the first hourly run on 2026-11-17 had 4 red repositories. That run did not record how many repositories it
// scanned, so the baseline takes today's count when the script was written (83): 1 - 4/83.
export const BASELINE = 0.9518;
export const DATA_URL = "https://cilytics.flisk.si/data.json";

// Pure: data.json -> { value, baseline, unit, green, repos }, or null when it holds no repositories.
export function greenShare(data) {
	const t = data?.totals;
	const repos = Number(t?.repos), red = Number(t?.redRepos);
	if (!Number.isInteger(repos) || repos <= 0 || !Number.isInteger(red) || red < 0 || red > repos) return null;
	return { value: Math.round(((repos - red) / repos) * 10000) / 10000, baseline: BASELINE, unit: "share of repos green", green: repos - red, repos, generatedAt: data.generatedAt ?? null };
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const res = await fetch(DATA_URL, { headers: { "cache-control": "no-cache" } });
	if (!res.ok) throw new Error(`${DATA_URL}: HTTP ${res.status}`);
	const r = greenShare(await res.json());
	if (!r) throw new Error("data.json has no repository totals");
	console.log(JSON.stringify(r));
}
