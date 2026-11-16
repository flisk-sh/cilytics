import assert from "node:assert/strict";
import { test } from "node:test";
import { checkChain } from "./e2e-gel.mjs";

const NOW = Date.parse("2026-11-16T13:00:00Z");
const top = (file) => [{ file, line: 1, message: "x" }];
// The gel field as cilytics.flisk.si published it for gel-e2e on 2026-11-16.
const good = () => ({
	repos: [{
		name: "gel-e2e",
		gel: {
			installed: true, runUrl: "https://github.com/flisk-sh/gel-e2e/actions/runs/43865350464", at: "2026-11-16T12:18:32Z", lane: "C",
			guards: [
				{ guard: "secret-scan", level: "report", pass: true, findings: 0, top: [] },
				{ guard: "pinned-actions", level: "report", pass: false, findings: 1, top: top(".github/workflows/planted.yml") },
				{ guard: "workflow-permissions", level: "report", pass: false, findings: 1, top: top(".github/workflows/planted.yml") },
				{ guard: "dead-links", level: "report", pass: false, findings: 1, top: top("README.md") },
				{ guard: "done-without-green", level: "report", pass: true, findings: 0, top: [] },
			],
		},
	}],
});

test("the published planted findings pass", () => {
	assert.deepEqual(checkChain(good(), "gel-e2e", NOW), []);
});

test("each broken link in the chain is reported", () => {
	assert.match(checkChain({ repos: [] }, "gel-e2e", NOW)[0], /not in data.json/);

	const noRun = good(); noRun.repos[0].gel = { installed: false };
	assert.match(checkChain(noRun, "gel-e2e", NOW)[0], /no GEL run/);

	const expired = good(); expired.repos[0].gel = { installed: true, runUrl: "u", at: "2026-11-16T12:18:32Z", record: null };
	assert.match(checkChain(expired, "gel-e2e", NOW)[0], /artifact was not read/);

	const stale = good(); stale.repos[0].gel.at = "2026-11-01T00:00:00Z";
	assert.match(checkChain(stale, "gel-e2e", NOW).join(), /days old/);

	const lost = good(); lost.repos[0].gel.guards[3].findings = 0;
	assert.match(checkChain(lost, "gel-e2e", NOW).join(), /dead-links has 0 finding\(s\), planted 1/);

	const noisy = good(); noisy.repos[0].gel.guards[0].findings = 2;
	assert.match(checkChain(noisy, "gel-e2e", NOW).join(), /secret-scan has 2/);

	const wrongFile = good(); wrongFile.repos[0].gel.guards[1].top = top("other.yml");
	assert.match(checkChain(wrongFile, "gel-e2e", NOW).join(), /pinned-actions does not name/);

	const missing = good(); missing.repos[0].gel.guards.pop();
	assert.match(checkChain(missing, "gel-e2e", NOW).join(), /done-without-green is missing/);
});
