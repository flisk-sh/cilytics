import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { LIVE_GUARDS, parseRepo, runLiveGuards, scanRepo } from "../site/scan.mjs";

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
