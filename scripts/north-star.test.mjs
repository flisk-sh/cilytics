import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

function measure(t, status, rows) {
	const dir = mkdtempSync(join(tmpdir(), "cilytics-north-star-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const scripts = join(dir, "scripts");
	const script = join(scripts, "north-star.mjs");
	mkdirSync(scripts);
	copyFileSync(new URL("./north-star.mjs", import.meta.url), script);
	const report = join(dir, "north-star.json");
	const previous = '{"value":0.75,"checked":4}\n';
	writeFileSync(report, previous);

	const body = JSON.stringify({ rows });
	const mock = `globalThis.fetch = async () => new Response(${JSON.stringify(body)}, { status: ${status} });`;
	const result = spawnSync(process.execPath, ["--import", `data:text/javascript,${encodeURIComponent(mock)}`, script], {
		encoding: "utf8",
		timeout: 5000,
	});
	assert.ifError(result.error);
	return { ...result, previous, report: readFileSync(report, "utf8") };
}

test("keeps the previous measurement when none of the pages were checked", (t) => {
	const result = measure(t, 200, [{ status: "unchecked" }, { status: "error" }]);
	assert.equal(result.status, 1, result.stderr);
	assert.match(result.stderr, /no checked pages/);
	assert.equal(result.report, result.previous);
});

test("keeps the previous measurement when the snapshot request fails", (t) => {
	const result = measure(t, 503, [{ status: "pass" }]);
	assert.equal(result.status, 1, result.stderr);
	assert.match(result.stderr, /HTTP 503/);
	assert.equal(result.report, result.previous);
});

test("records zero when pages were checked and actually failed", (t) => {
	const result = measure(t, 200, [{ status: "fail" }, { status: "unchecked" }]);
	assert.equal(result.status, 0, result.stderr);
	const { value, pass, checked } = JSON.parse(result.report);
	assert.deepEqual({ value, pass, checked }, { value: 0, pass: 0, checked: 1 });
});
