import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { collect, gh, retryable, dailyCounts, findGelRun, gelFromRecord, median, percentile, reposPath, resolveOrg, sdlcFlags, summarizeRuns, totals, workflowStats } from "./collect.mjs";

const NOW = Date.parse("2026-11-12T12:00:00Z");
const run = (workflow_id, name, conclusion, status = "completed", day = "2026-11-12") => ({
	workflow_id,
	name,
	conclusion,
	status,
	html_url: `https://x/${workflow_id}`,
	run_started_at: `${day}T10:00:00Z`,
	updated_at: `${day}T10:03:00Z`,
	head_sha: "abcdef123",
});

test("summarizeRuns keeps the newest completed run per workflow and counts only pass/fail runs", () => {
	const s = summarizeRuns([
		run(1, "CI", null, "in_progress"),
		run(1, "CI", "failure"),
		run(1, "CI", "success"),
		run(2, "Site", "success"),
		run(2, "Site", "cancelled"),
		run(3, "Lint", "skipped"),
	], NOW);
	assert.equal(s.red, 1);
	assert.deepEqual(
		s.workflows.map((w) => [w.name, w.conclusion]),
		[["CI", "failure"], ["Lint", "skipped"], ["Site", "success"]],
	);
	assert.equal(s.runs, 3);
	assert.equal(s.passRate, 66.7);
	assert.equal(s.medianMinutes, 3);
	assert.equal(s.ciMinutes, 15);
	assert.deepEqual(s.conclusions, { failure: 1, success: 2, cancelled: 1, skipped: 1 });
	assert.deepEqual(s.days.at(-1), { d: "2026-11-12", pass: 2, fail: 1 });
	const ci = s.workflows[0];
	assert.equal(ci.runs, 2);
	assert.equal(ci.passRate, 50);
	assert.equal(ci.recent, "sf");
	assert.equal(ci.flips, 1);
	assert.equal(ci.flaky, false);
});

test("summarizeRuns with no runs has no pass rate", () => {
	const s = summarizeRuns([], NOW);
	assert.equal(s.passRate, null);
	assert.equal(s.medianMinutes, null);
	assert.equal(s.days.length, 14);
	assert.ok(s.days.every((d) => d.pass === 0 && d.fail === 0));
});

test("totals weights pass rate by runs", () => {
	const t = totals([
		{ workflows: [{ flaky: true }], red: 1, runs: 10, passRate: 50, openPRs: 2, ciMinutes: 7 },
		{ workflows: [{}, {}], red: 0, runs: 30, passRate: 100, openPRs: 0, ciMinutes: 3 },
		{ workflows: [], red: 0, runs: 0, passRate: null, openPRs: 1 },
	]);
	assert.deepEqual(t, { repos: 3, workflows: 3, red: 1, redRepos: 1, passRate: 87.5, openPRs: 3, runs: 40, ciMinutes: 10, flaky: 1, sdlcReady: 0, gelRepos: 0, gelFindings: 0, gelBlocked: 0, northStars: 0, northStarsMet: 0 });
});

test("median handles even, odd and empty", () => {
	assert.equal(median([3, 1, 2]), 2);
	assert.equal(median([1, 2, 3, 4]), 2.5);
	assert.equal(median([null]), null);
});

test("workflowStats flags a workflow that flips between pass and red as flaky", () => {
	// newest first: f s f s s -> in run order s s f s f: three flips
	const w = workflowStats(["failure", "success", "failure", "success", "success"].map((c) => run(1, "E2E", c)));
	assert.equal(w.flips, 3);
	assert.equal(w.flaky, true);
	assert.equal(w.passRate, 60);
	assert.equal(w.recent, "ssfsf");
	const steady = workflowStats(["failure", "failure", "success", "cancelled", "success"].map((c) => run(1, "E2E", c)));
	assert.equal(steady.flips, 1);
	assert.equal(steady.flaky, false);
	assert.equal(steady.recent, "scsff");
});

test("dailyCounts buckets runs into the last 14 UTC days and drops older ones", () => {
	const days = dailyCounts([run(1, "CI", "success", "completed", "2026-11-10"), run(1, "CI", "timed_out", "completed", "2026-11-10"), run(1, "CI", "success", "completed", "2026-10-01")], NOW);
	assert.equal(days.length, 14);
	assert.equal(days[0].d, "2026-10-30");
	assert.deepEqual(days.find((d) => d.d === "2026-11-10"), { d: "2026-11-10", pass: 1, fail: 1 });
	assert.equal(days.reduce((n, d) => n + d.pass + d.fail, 0), 2);
});

test("percentile picks the nearest-rank value", () => {
	assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 90), 9);
	assert.equal(percentile([4], 90), 4);
	assert.equal(percentile([], 90), null);
});

test("sdlcFlags reads the harness files from the root folder and CI from the workflow count", () => {
	assert.deepEqual(sdlcFlags(["README.md", "AGENTS.md", ".claude"], 2), { agents: true, claude: false, settings: true, ci: true, gel: false, score: 3 });
	assert.equal(sdlcFlags([], 0).score, 0);
	assert.deepEqual(sdlcFlags(["AGENTS.md", "CLAUDE.md", ".claude"], 1, true), { agents: true, claude: true, settings: true, ci: true, gel: true, score: 5 });
});

const REC = { ts: "t", repo: "x", sha: "s", event: "pull_request", lane: "B", laneReason: "r", needsPerson: true, files: 3, results: [{ guard: "a", level: "block", pass: false, findings: 2 }, { guard: "b", level: "report", pass: true, findings: 4 }], blocked: ["a"], ms: 900 };
const GRUN = { html_url: "https://x/gel", updated_at: "2026-11-12T10:03:00Z" };

test("gelFromRecord takes the last JSON line and keeps the lane, blocked guards and per-guard findings", () => {
	const g = gelFromRecord(`${JSON.stringify({ ...REC, lane: "A" })}\n${JSON.stringify(REC)}\n`, GRUN);
	assert.deepEqual(g, {
		installed: true, runUrl: "https://x/gel", at: GRUN.updated_at, lane: "B", needsPerson: true, blocked: ["a"], ms: 900,
		guards: [{ guard: "a", level: "block", pass: false, findings: 2, top: [] }, { guard: "b", level: "report", pass: true, findings: 4, top: [] }],
	});
});

test("gelFromRecord never throws: garbage, empty and missing records become installed with record null", () => {
	for (const bad of ["not json", "", null, undefined, "[1]", "{"]) {
		assert.deepEqual(gelFromRecord(bad, GRUN), { installed: true, runUrl: GRUN.html_url, at: GRUN.updated_at, record: null });
	}
	assert.deepEqual(gelFromRecord('{"lane":"C"}', GRUN).blocked, []);
});

test("findGelRun picks the newest completed run named GEL or ending in /gel.yml", () => {
	const runs = [
		{ id: 1, name: "GEL", status: "in_progress" },
		{ id: 2, name: "CI", status: "completed" },
		{ id: 3, name: "Guards", path: ".github/workflows/gel.yml", status: "completed" },
		{ id: 4, name: "GEL", status: "completed" },
	];
	assert.equal(findGelRun(runs).id, 3);
	assert.equal(findGelRun(runs.slice(0, 2)), undefined);
	assert.equal(findGelRun([{ id: 9, name: "GEL dogfood", status: "completed" }]).id, 9);
	assert.equal(findGelRun([{ id: 8, name: "GELATO", status: "completed" }]), undefined);
});

test("totals counts GEL repos, failing-guard findings and repos blocked, and tolerates repos without gel", () => {
	const base = { workflows: [], red: 0, runs: 0, passRate: null, openPRs: 0 };
	const t = totals([
		{ ...base, sdlc: { score: 5 }, gel: gelFromRecord(JSON.stringify(REC), GRUN) },
		{ ...base, sdlc: { score: 4 }, gel: { installed: true, record: null } },
		{ ...base, gel: { installed: false } },
		{ ...base },
	]);
	assert.equal(t.gelRepos, 2);
	assert.equal(t.gelFindings, 2);
	assert.equal(t.gelBlocked, 1);
	assert.equal(t.sdlcReady, 1);
});

test("summarizeRuns reports p95 next to the median", () => {
	const s = summarizeRuns([run(1, "CI", "success"), run(1, "CI", "success")], NOW);
	assert.equal(s.p95Minutes, 3);
	assert.equal(summarizeRuns([], NOW).p95Minutes, null);
});

test("resolveOrg prefers CILYTICS_ORG, then the Actions repo owner, then flisk-sh", () => {
	assert.equal(resolveOrg({ CILYTICS_ORG: "tldraw", GITHUB_REPOSITORY_OWNER: "me" }), "tldraw");
	assert.equal(resolveOrg({ CILYTICS_ORG: "", GITHUB_REPOSITORY_OWNER: "me" }), "me");
	assert.equal(resolveOrg({}), "flisk-sh");
});

test("reposPath lists an organization's public repos and a user's own repos", () => {
	assert.equal(reposPath("Organization", "tldraw"), "/orgs/tldraw/repos?type=public&sort=pushed");
	assert.equal(reposPath("User", "alice"), "/users/alice/repos?type=owner&sort=pushed");
});

// Runs collect() against a stubbed GitHub API and returns the data plus every path it asked for.
async function collectStubbed(account, type) {
	const paths = [];
	const real = globalThis.fetch;
	globalThis.fetch = async (url) => {
		const path = String(url).replace("https://api.github.com", "");
		paths.push(path);
		const json = (b) => new Response(JSON.stringify(b), { status: 200 });
		if (path === `/users/${account}`) return json({ type });
		if (path.includes("/repos?") && path.includes("page=1")) return json([{ name: "app", html_url: `https://github.com/${account}/app`, default_branch: "main", pushed_at: new Date().toISOString(), stargazers_count: 1, archived: false, fork: false }]);
		if (path.includes("/actions/runs?")) return json({ workflow_runs: [] });
		if (path.includes("/contents/")) return json([{ name: "AGENTS.md" }]);
		return json([]);
	};
	try {
		return { data: await collect(Date.now(), account, Infinity), paths };
	} finally {
		globalThis.fetch = real;
	}
}

test("collect reads the account it is given, whether an organization or a user", async () => {
	const o = await collectStubbed("tldraw", "Organization");
	assert.equal(o.data.org, "tldraw");
	assert.equal(o.data.ownerType, "Organization");
	assert.ok(o.paths.some((p) => p.startsWith("/orgs/tldraw/repos")));
	assert.ok(o.paths.some((p) => p.startsWith("/repos/tldraw/app/actions/runs")));
	assert.ok(o.paths.every((p) => !p.includes("flisk-sh")));
	const u = await collectStubbed("alice", "User");
	assert.equal(u.data.org, "alice");
	assert.equal(u.data.ownerType, "User");
	assert.ok(u.paths.some((p) => p.startsWith("/users/alice/repos")));
	assert.ok(u.paths.every((p) => !p.includes("/orgs/") && !p.includes("flisk-sh")));
	assert.equal(u.data.repos[0].sdlc.agents, true);
});

test("the page takes its title and header from the org in the data, not from fixed text", () => {
	const html = readFileSync(new URL("../site/index.html", import.meta.url), "utf8");
	const orgText = new Function(`${html.split("/*org-text*/")[1].split("/*end-org-text*/")[0]}; return orgText;`)();
	const t = orgText("tldraw");
	assert.equal(t.title, "Cilytics · tldraw CI");
	assert.match(t.sub, /tldraw/);
	assert.match(t.intro, /Every active public repository of tldraw/);
	assert.equal(orgText(undefined), null); // old snapshots without an org keep the static text
	assert.ok(!html.slice(0, html.indexOf("<script>\n(() =>")).includes("flisk-sh CI"), "no fixed org name in the static title or header");
});

test("the page and the action carry no fixed org, and load the Flisk bar and analytics only on *.flisk.si", () => {
	const html = readFileSync(new URL("../site/index.html", import.meta.url), "utf8");
	assert.ok(!/<script[^>]+src="https:\/\/flisk\.sh\/a\.js/.test(html), "analytics is added by script, never as a fixed tag, so distributed copies stay clean");
	assert.ok(!/<script[^>]+src="https:\/\/flisk\.si/.test(html), "the bar is added by script, never as a fixed tag");
	assert.match(html, /\\\.flisk\\\.si\$\/\.test\(location\.hostname\)\)\{var b=/, "the bar loads only on *.flisk.si");
	assert.match(html, /flisk\.sh\/a\.js".*a\.setAttribute\("data-domain","cilytics\.flisk\.si"\)/, "analytics loads only inside the *.flisk.si hostname check");
	const action = readFileSync(new URL("../action.yml", import.meta.url), "utf8");
	assert.ok(!/flisk-sh\/flisk\b/.test(action));
	assert.match(action, /scripts\/collect\.mjs/);
});

import { rankedWindow, mergeRankedRows } from "./collect.mjs";
test("rankedWindow rotates through the list and covers it in turn", () => {
	const list = Array.from({ length: 10 }, (_, i) => `o/r${i}`);
	assert.deepEqual(rankedWindow(list, 5, 20), [...list].sort());
	const seen = new Set();
	for (let h = 0; h < 4; h++) rankedWindow(list, h, 3).forEach((x) => seen.add(x));
	assert.equal(seen.size, 10);
});
test("mergeRankedRows keeps old rows for repos not rescanned, prefers new ones, drops removed repos", () => {
	const rows = mergeRankedRows(["a/a", "b/b"], [{ repo: "a/a", oss: 1 }, { repo: "gone/x", oss: 9 }], [{ repo: "b/b", oss: 2 }, { repo: "a/a", oss: 3 }]);
	assert.deepEqual(rows.map((r) => [r.repo, r.oss]).sort(), [["a/a", 3], ["b/b", 2]]);
});

import { deliveryMetrics } from "./collect.mjs";
test("deliveryMetrics counts merges, lead time, CI time, first passes and failed commits in the window", () => {
	const now = Date.parse("2026-11-16T12:00:00Z");
	const pr = (created, merged) => ({ created_at: created, merged_at: merged });
	const r = (sha, conclusion, attempt = 1, at = "2026-11-15T10:10:00Z") => ({ status: "completed", conclusion, run_attempt: attempt, head_sha: sha, run_started_at: "2026-11-15T10:00:00Z", updated_at: at });
	const d = deliveryMetrics({
		now,
		pulls: [
			pr("2026-11-15T00:00:00Z", "2026-11-15T02:00:00Z"), // 2 h
			pr("2026-11-14T00:00:00Z", "2026-11-15T00:00:00Z"), // 24 h
			pr("2026-11-01T00:00:00Z", null), // closed, not merged
			pr("2026-09-01T00:00:00Z", "2026-09-02T00:00:00Z"), // outside 30 days
		],
		runs: [
			r("a", "success"),
			r("a", "failure"),
			r("b", "success", 2), // green only after a re-run
			r("c", "success"),
			r("c", "cancelled"), // not a pass or a fail
			r("old", "failure", 1, "2026-09-01T00:00:00Z"), // outside 30 days
			{ status: "in_progress", head_sha: "d" },
		],
	});
	assert.equal(d.merged, 2);
	assert.equal(d.mergedPerDay, 0.07);
	assert.deepEqual(d.leadTimeHours, { p50: 2, p95: 24 });
	assert.deepEqual(d.ciMinutes, { p50: 10, p95: 10 });
	assert.equal(d.firstPassRate, 50); // a and c passed first time; a's failure and b's re-run did not
	assert.equal(d.commits, 3);
	assert.equal(d.changeFailureRate, 33.3); // a of a, b, c
});

test("deliveryMetrics says null, not zero, when there is nothing to measure", () => {
	const d = deliveryMetrics({ now: Date.now(), runs: [], pulls: [] });
	assert.equal(d.merged, 0);
	assert.deepEqual(d.leadTimeHours, { p50: null, p95: null });
	assert.equal(d.firstPassRate, null);
	assert.equal(d.changeFailureRate, null);
});

test("collect adds org-wide delivery and reads closed pull requests per repo", async () => {
	const o = await collectStubbed("tldraw", "Organization");
	assert.ok(o.paths.some((p) => p.startsWith("/repos/tldraw/app/pulls?state=closed")));
	assert.equal(o.data.delivery.days, 30);
	assert.equal(o.data.repos[0].delivery.merged, 0);
});

test("the page shows the delivery row only when the snapshot has delivery numbers", () => {
	const html = readFileSync(new URL("../site/index.html", import.meta.url), "utf8");
	assert.match(html, /id="kd" hidden/);
	assert.match(html, /kpis\(\); delivery\(\);/);
});

test("gh retries a GitHub 5xx and returns the later good answer", async () => {
	const real = globalThis.fetch, seen = [];
	globalThis.fetch = async () => { seen.push(1); return seen.length < 3 ? { ok: false, status: 504 } : { ok: true, status: 200, json: async () => ({ ok: 1 }) }; };
	try { assert.deepEqual(await gh("/x", 4, 1), { ok: 1 }); assert.equal(seen.length, 3); } finally { globalThis.fetch = real; }
});

test("gh does not retry a real answer like 404, and gives up after the last try", async () => {
	const real = globalThis.fetch;
	let n = 0;
	globalThis.fetch = async () => { n++; return { ok: false, status: 404 }; };
	try { await assert.rejects(gh("/x", 4, 1), /HTTP 404/); assert.equal(n, 1); n = 0; globalThis.fetch = async () => { n++; return { ok: false, status: 502 }; }; await assert.rejects(gh("/x", 3, 1), /HTTP 502/); assert.equal(n, 3); } finally { globalThis.fetch = real; }
	assert.equal(retryable(403), false);
	assert.equal(retryable(null), true);
});

import { collectNorthStar } from "./collect.mjs";

test("collectNorthStar reads docs/gel.json, then the result it names; no GEL config means no API call", async () => {
	const files = {
		"docs/gel.json": { north_star: { metric: "share of repos green", baseline: "first run", target: { ratio: 1.2, better: "higher" }, result: "./docs/north-star/result.json" } },
		"docs/north-star/result.json": { value: 90, baseline: 60, measuredAt: "2026-11-21T00:00:00Z" },
	};
	const asked = [];
	const read = async (full, path, ref) => { asked.push(`${full}:${path}@${ref}`); return ref === "main" ? (files[path] ?? null) : null; };
	const readText = async (full, path, ref) => { asked.push(`${full}:${path}@${ref}`); return null; };
	const n = await collectNorthStar("o/r", "main", ["docs", "README.md"], Date.parse("2026-11-22T00:00:00Z"), read, readText);
	assert.equal(n.status, "met");
	assert.equal(n.ratio, 1.5);
	assert.equal(n.run, null, "a committed result with no run link was typed by hand");
	assert.deepEqual(asked, ["o/r:docs/gel.json@main", "o/r:docs/north-star/result.json@main", "o/r:docs/north-star/result.json@north-star", "o/r:history.jsonl@north-star"]);
	asked.length = 0;
	assert.equal(await collectNorthStar("o/r", "main", ["README.md"], 0, read, readText), null);
	assert.deepEqual(asked, []);
});

test("collectNorthStar falls back to a root gel.json when docs/ has none", async () => {
	const read = async (_f, path) => (path === "gel.json" ? { north_star: { metric: "a b c", target: { ratio: 2, better: "lower" }, result: "r.json" } } : null);
	const n = await collectNorthStar("o/r", "main", ["docs", "gel.json"], 0, read, async () => null);
	assert.equal(n.status, "unmeasured");
});

test("collectNorthStar judges the newer of the committed result and the one a run published to the north-star branch", async () => {
	const cfg = { north_star: { metric: "start time", baseline: "compose", target: { ratio: 8, better: "lower" }, result: "bench/ns.json" } };
	const run = "https://github.com/o/r/actions/runs/7";
	const branch = { value: 2.5, baseline: 26.1, unit: "s", measuredAt: "2026-11-21T00:00:00Z", run };
	const old = { value: 20, baseline: 26.1, unit: "s", measuredAt: "2026-11-01T00:00:00Z" };
	const at = (main, ns) => async (_f, path, ref) => (path === "docs/gel.json" ? cfg : ref === "main" ? main : ns);
	const history = async () => '{"value":3}\n{"value":2.5}\n';
	const now = Date.parse("2026-11-22T00:00:00Z");
	let n = await collectNorthStar("o/r", "main", ["docs"], now, at(old, branch), history);
	assert.equal(n.status, "met");
	assert.equal(n.value, 2.5);
	assert.equal(n.run, run);
	assert.equal(n.runs, 2);
	// only on the branch: still found
	n = await collectNorthStar("o/r", "main", ["docs"], now, at(null, branch), history);
	assert.equal(n.run, run);
	// the committed file is newer: it wins, and it has no run
	n = await collectNorthStar("o/r", "main", ["docs"], now, at({ ...old, measuredAt: "2026-11-21T12:00:00Z" }, branch), async () => null);
	assert.equal(n.value, 20);
	assert.equal(n.run, null);
	assert.equal(n.runs, 0);
});

import { BASELINE, failShare } from "./measure-north-star.mjs";

test("the north star measure is the share of CI runs that fail", () => {
	assert.deepEqual(failShare({ generatedAt: "t", totals: { runs: 3712, passRate: 91.8 } }), { value: 8.2, baseline: BASELINE, unit: "% of CI runs failing", runs: 3712, generatedAt: "t" });
	assert.equal(failShare({ totals: { runs: 0, passRate: 100 } }), null);
	assert.equal(failShare({ totals: { runs: 10, passRate: 101 } }), null);
	assert.equal(failShare({ totals: { runs: 10 } }), null);
	assert.equal(failShare(null), null);
});

test("a perfect pass rate is a tiny failure share, not an invalid measurement", () => {
	assert.equal(failShare({ totals: { runs: 100, passRate: 100 } }).value, 0.1);
});

test("the north star ratio reads right: more failures is worse, fewer is better, halving meets the target", () => {
	const ratio = (passRate) => BASELINE / failShare({ totals: { runs: 100, passRate } }).value; // lower is better
	assert.ok(ratio(80) < 1, "more failing than the first snapshot is below 1x");
	assert.ok(ratio(91.8) > 1 && ratio(91.8) < 2, "today is better than the baseline but short of the 2x target");
	assert.ok(ratio(94.2) >= 2, "failures halved meets the target");
});
