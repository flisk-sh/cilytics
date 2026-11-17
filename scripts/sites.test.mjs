import assert from "node:assert/strict";
import { test } from "node:test";
import { firstScreen, scoreSites } from "./sites.mjs";

const fake = (pages) => async (u) => { const p = pages[u]; return { ok: p !== undefined, status: p === undefined ? 404 : 200, text: async () => p ?? "" }; };
// The real guard is checked out in CI; here a stand-in with the same run() contract keeps the test offline.
const guard = { run: ({ root }) => ({ pass: false, findings: [{ message: "five-second test: the headline uses jargon" }] }) };
const goodGuard = { run: () => ({ pass: true, findings: [] }) };

test("firstScreen reads the headline and the first paragraph after it", () => {
	assert.deepEqual(firstScreen("<h1>Free <b>AI</b></h1><p>Get a key.</p>"), { h1: "Free AI", lead: "Get a key." });
	assert.deepEqual(firstScreen("<p>x</p>"), { h1: "", lead: "" });
});

test("a failing page lists the guard's findings, a script-drawn page is unchecked, a 404 is an error", async () => {
	const pages = { "https://a.test": "<h1>Serverless inference</h1><p>x</p>", "https://b.test": "<div id=r></div><script>draw()</script>" };
	const out = await scoreSites(["https://a.test", "https://b.test", "https://c.test"], guard, fake(pages));
	const by = Object.fromEntries(out.rows.map((r) => [r.url, r]));
	assert.equal(by["https://a.test"].status, "fail");
	assert.deepEqual(by["https://a.test"].findings, ["the headline uses jargon"]);
	assert.equal(by["https://b.test"].status, "unchecked");
	assert.equal(by["https://c.test"].status, "error");
	assert.equal(out.rows[0].status, "fail"); // worst first
});

test("a passing page passes and sorts last; duplicates are scored once", async () => {
	const out = await scoreSites(["https://a.test", "https://a.test"], goodGuard, fake({ "https://a.test": "<h1>Hi</h1><p>x</p>" }));
	assert.equal(out.rows.length, 1);
	assert.equal(out.rows[0].status, "pass");
});
