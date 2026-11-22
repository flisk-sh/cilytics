#!/usr/bin/env node
// Cilytics' north star, measured: the share of CI runs that fail across the flisk-sh repositories (the last 100 runs of
// each), read from the data the hourly collect run publishes (https://cilytics.flisk.si/data.json). GEL's north-star
// workflow runs this each week and publishes the printed result to the north-star branch. The last stdout line is the
// result GEL reads.
//
// Baseline: the first hourly snapshot (2026-11-16 11:47 UTC, history.json) had 88.4% of runs passing, so 11.6% failing.
// It is a recorded number, not an estimate. Lower is better; the target is to halve it.
export const BASELINE = 11.6;
export const DATA_URL = "https://cilytics.flisk.si/data.json";

// Pure: data.json -> { value, baseline, unit, runs }, or null when the data holds no usable pass rate.
// The pass rate has one decimal, so 100% passing is "under 0.1% failing": the value is floored at 0.1 because GEL
// needs a positive number and a perfect org must not read as a broken measurement.
export function failShare(data) {
	const t = data?.totals;
	const pass = Number(t?.passRate), runs = Number(t?.runs);
	if (t?.passRate == null || !Number.isFinite(pass) || pass < 0 || pass > 100 || !Number.isInteger(runs) || runs <= 0) return null;
	return { value: Math.max(0.1, Math.round((100 - pass) * 10) / 10), baseline: BASELINE, unit: "% of CI runs failing", runs, generatedAt: data.generatedAt ?? null };
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const res = await fetch(DATA_URL, { headers: { "cache-control": "no-cache" } });
	if (!res.ok) throw new Error(`${DATA_URL}: HTTP ${res.status}`);
	const r = failShare(await res.json());
	if (!r) throw new Error("data.json has no pass rate");
	console.log(JSON.stringify(r));
}
