import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { LIVE_GUARDS, ossScore, parseRepo, runLiveGuards, scanRepo } from "../site/scan.mjs";

test("parseRepo takes owner/name or a GitHub link and nothing else", () => {
	assert.equal(parseRepo("flisk-sh/gel"), "flisk-sh/gel");
	assert.equal(parseRepo("  https://github.com/flisk-sh/gel/ "), "flisk-sh/gel");
	assert.equal(parseRepo("github.com/flisk-sh/gel.git"), "flisk-sh/gel");
	assert.equal(parseRepo("https://github.com/flisk-sh/gel/pull/3"), "flisk-sh/gel");
	assert.equal(parseRepo("flisk-sh"), null);
	assert.equal(parseRepo(""), null);
	assert.equal(parseRepo(null), null);
	assert.equal(parseRepo("a/.."), null);
});

test("runLiveGuards runs only the live guards, passes them the files, and drops one that throws", () => {
	const seen = [];
	const guards = {
		"pinned-actions": { run: ({ files, read }) => { seen.push([files, read(files[0])]); return { pass: false, findings: [{ file: files[0], line: 3, message: "unpinned" }] }; } },
		"workflow-permissions": { run: () => { throw new Error("boom"); } },
	};
	const out = runLiveGuards({ ".github/workflows/ci.yml": "on: push" }, guards, "o/r");
	assert.deepEqual(LIVE_GUARDS, ["pinned-actions", "workflow-permissions"]);
	assert.deepEqual(seen, [[[".github/workflows/ci.yml"], "on: push"]]);
	assert.deepEqual(out, [{ guard: "pinned-actions", level: "report", pass: false, findings: 1, top: [{ file: ".github/workflows/ci.yml", line: 3, message: "unpinned" }] }]);
});

test("scanRepo returns a one-repo snapshot with GEL's guards on it", async () => {
	const api = {
		"/repos/o/r": { name: "r", html_url: "https://github.com/o/r", default_branch: "main", pushed_at: "2026-11-12T00:00:00Z", stargazers_count: 7 },
		"/repos/o/r/actions/runs?branch=main&per_page=100&exclude_pull_requests=true": { workflow_runs: [] },
		"/repos/o/r/pulls?state=open&per_page=100": [{}, {}],
		"/repos/o/r/contents/?ref=main": [{ name: "README.md" }],
		"/repos/o/r/contents/.github/workflows?ref=main": [{ type: "file", name: "ci.yml", path: ".github/workflows/ci.yml", download_url: "https://raw/ci.yml" }],
	};
	const guards = { "pinned-actions": { run: () => ({ pass: true, findings: [] }) }, "workflow-permissions": { run: () => ({ pass: true, findings: [] }) } };
	const d = await scanRepo("o/r", { json: async (p) => { if (!(p in api)) throw new Error(p); return api[p]; }, text: async () => "on: push", guards, now: Date.parse("2026-11-12T12:00:00Z") });
	assert.equal(d.repo, "o/r");
	assert.equal(d.live, true);
	assert.equal(d.repos.length, 1);
	assert.equal(d.repos[0].openPRs, 2);
	assert.equal(d.repos[0].stars, 7);
	assert.equal(d.repos[0].gel.checked, 1);
	assert.equal(d.repos[0].gel.guards.length, 2);
	assert.equal(d.repos[0].gel.installed, false);
});

test("scanRepo lets a 404 from GitHub through for the page to explain", async () => {
	await assert.rejects(scanRepo("o/none", { json: async () => { throw Object.assign(new Error("404"), { status: 404 }); }, text: async () => "", guards: {} }), { status: 404 });
});

test("the page pins GEL to a full commit SHA, never a branch or tag", () => {
	const m = /GEL_BASE = "https:\/\/cdn\.jsdelivr\.net\/gh\/flisk-sh\/gel@([^/"]+)\//.exec(readFileSync(new URL("../site/index.html", import.meta.url), "utf8"));
	assert.ok(m, "GEL_BASE not found");
	assert.match(m[1], /^[0-9a-f]{40}$/);
});

test("the action ships scan.mjs next to the page", () => {
	const a = readFileSync(new URL("../action.yml", import.meta.url), "utf8");
	assert.match(a, /site\/scan\.mjs/);
	assert.match(a, /git add [^\n]*scan\.mjs/);
});

test("ossScore adds up the weighted checks to 100 for a well-run repo and to 0 for a bare one", () => {
	const good = ossScore({
		repo: { license: { spdx_id: "MIT" }, description: "x", topics: ["ci"] },
		rootNames: ["README.md", "CONTRIBUTING.md", "SECURITY.md", "CODE_OF_CONDUCT.md"],
		summary: { workflows: [{}], red: 0, passRate: 99 },
	});
	assert.equal(good.score, 100);
	const bare = ossScore({ repo: { license: null, description: null }, summary: { workflows: [], red: 0, passRate: null } });
	assert.equal(bare.score, 0);
	assert.equal(bare.checks.length, good.checks.length);
});

test("ossScore reads files under .github and does not call red CI green", () => {
	const r = ossScore({ repo: { license: { spdx_id: "NOASSERTION" } }, rootNames: ["LICENSE"], githubNames: ["SECURITY.md"], summary: { workflows: [{}], red: 1, passRate: 90 } });
	const by = Object.fromEntries(r.checks.map((c) => [c.id, c.pass]));
	assert.deepEqual([by.license, by.security, by.ci, by.green], [true, true, true, false]);
});

import { featuredRow, healthScore } from "../site/scan.mjs";
test("featuredRow keeps every dimension and a health score", () => {
	const row = featuredRow({ repo: "a/b", repos: [{ oss: { score: 70 }, passRate: 91.5, red: 2, workflows: [{ flaky: true }, {}], sdlc: { score: 3, gel: false }, gel: { installed: false, guards: [{ pass: true }, { pass: false }] } }] });
	assert.deepEqual(row, { repo: "a/b", oss: 70, gelPass: 1, gelRun: 2, gelInstalled: false, passRate: 91.5, red: 2, flaky: 1, sdlc: 3, sdlcMax: 5, health: healthScore({ oss: 70, passRate: 91.5, sdlc: 3, gelPass: 1, gelRun: 2, red: 2, flaky: 1 }) });
});

test("healthScore: strong on one dimension cannot rank a repo high", () => {
	assert.equal(healthScore({ oss: 100, passRate: 100, sdlc: 5, gelPass: 5, gelRun: 5 }), 100);
	// flisk on 2026-11-16: OSS 80, 88.9% pass, 4/5 agent-ready, 2/2 live guards, 2 red workflows.
	const flisk = healthScore({ oss: 80, passRate: 88.9, sdlc: 4, gelPass: 2, gelRun: 2, red: 2 });
	assert.ok(flisk < 70, String(flisk));
	assert.ok(flisk < healthScore({ oss: 80, passRate: 88.9, sdlc: 4, gelPass: 2, gelRun: 2, red: 0 }));
	assert.equal(healthScore({}), 0);
});

import { guardLevels, northStarFrom, totals } from "../site/scan.mjs";

const NOW = Date.parse("2026-11-22T00:00:00Z");
const cfg = (target, extra = {}) => ({ north_star: { metric: "warm start to healthy", baseline: "Docker Compose", target, result: "docs/north-star/result.json", evidence: "docs/x.md", ...extra } });

test("northStarFrom: null when the repo names no north star", () => {
	assert.equal(northStarFrom(null, null, NOW), null);
	assert.equal(northStarFrom({ guards: {} }, null, NOW), null);
});

test("northStarFrom: met when the ratio reaches the target and the number is fresh", () => {
	const n = northStarFrom(cfg({ ratio: 2, better: "lower" }), { value: 3, baseline: 9, unit: "s", measuredAt: "2026-11-20T00:00:00Z" }, NOW);
	assert.equal(n.status, "met");
	assert.equal(n.ratio, 3);
	assert.equal(n.ageDays, 2);
	assert.equal(n.unit, "s");
	assert.equal(n.metric, "warm start to healthy");
});

test("northStarFrom: missed under target, higher-is-better uses value / baseline", () => {
	const n = northStarFrom(cfg({ ratio: 1.2, better: "higher" }), { value: 110, baseline: 100, measuredAt: "2026-11-21T00:00:00Z" }, NOW);
	assert.equal(n.ratio, 1.1);
	assert.equal(n.status, "missed");
});

test("northStarFrom: stale past max_age_days (default 30), even when the ratio is met", () => {
	const old = { value: 1, baseline: 10, measuredAt: "2026-09-01T00:00:00Z" };
	assert.equal(northStarFrom(cfg({ ratio: 2, better: "lower" }), old, NOW).status, "stale");
	assert.equal(northStarFrom(cfg({ ratio: 2, better: "lower" }, { max_age_days: 120 }), old, NOW).status, "met");
	assert.equal(northStarFrom(cfg({ ratio: 2, better: "lower" }), { value: 1, baseline: 10 }, NOW).status, "stale");
});

test("northStarFrom: unmeasured when the result file is missing or has no numbers", () => {
	assert.equal(northStarFrom(cfg({ ratio: 2, better: "lower" }), null, NOW).status, "unmeasured");
	assert.equal(northStarFrom(cfg({ ratio: 2, better: "lower" }), { value: "fast" }, NOW).status, "unmeasured");
});

test("guardLevels counts block and report repos per guard and names the failing ones", () => {
	const repos = [
		{ name: "a", gel: { guards: [{ guard: "secret-scan", level: "block", pass: true }, { guard: "repo-health", level: "report", pass: false, findings: 2 }] } },
		{ name: "b", gel: { guards: [{ guard: "secret-scan", level: "report", pass: false, findings: 1 }] } },
		{ name: "c", gel: { installed: false } },
	];
	assert.deepEqual(guardLevels(repos), [
		{ guard: "secret-scan", block: 1, report: 1, failing: 1, findings: 1, failingRepos: ["b"] },
		{ guard: "repo-health", block: 0, report: 1, failing: 1, findings: 2, failingRepos: ["a"] },
	]);
});

test("totals counts north stars and how many are met", () => {
	const base = { runs: 0, passRate: null, workflows: [], red: 0, openPRs: 0 };
	const t = totals([{ ...base, northStar: { status: "met" } }, { ...base, northStar: { status: "stale" } }, base]);
	assert.equal(t.northStars, 2);
	assert.equal(t.northStarsMet, 1);
});
