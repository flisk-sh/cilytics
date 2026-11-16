#!/usr/bin/env node
// End-to-end check of the GEL -> Cilytics chain, run after every hourly collect.
//   node scripts/e2e-gel.mjs cilytics-out/data.json [repo-name]
// flisk-sh/gel-e2e carries planted defects on its main branch. GEL runs there (on push and weekly), uploads a
// gel-record artifact, and the collect step reads it. If the dashboard data does not show exactly those findings,
// a link in the chain is broken: the caller, the reusable workflow, the artifact, the download or the parsing.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

// Planted in gel-e2e: guard -> [findings, file the top finding must name].
export const PLANTED = {
	"secret-scan": [0],
	"pinned-actions": [1, ".github/workflows/planted.yml"],
	"workflow-permissions": [1, ".github/workflows/planted.yml"],
	"dead-links": [1, "README.md"],
	"done-without-green": [0],
};
export const MAX_AGE_DAYS = 8; // gel-e2e runs GEL weekly; artifacts expire after 30 days

// Pure: dashboard data -> list of problems (empty when the chain works).
export function checkChain(data, name = "gel-e2e", now = Date.now()) {
	const repo = (data?.repos ?? []).find((r) => r.name === name);
	if (!repo) return [`${name} is not in data.json`];
	const g = repo.gel;
	if (!g?.installed) return [`${name} has no GEL run on its default branch`];
	if (!Array.isArray(g.guards) || !g.guards.length) return [`${name}: the GEL run's gel-record artifact was not read (expired or unreadable)`];
	const problems = [];
	const age = (now - Date.parse(g.at)) / 864e5;
	if (!(age <= MAX_AGE_DAYS)) problems.push(`${name}: latest GEL run is ${Number.isFinite(age) ? age.toFixed(1) + " days" : "of unknown age"} old, over ${MAX_AGE_DAYS}`);
	for (const [guard, [n, file]] of Object.entries(PLANTED)) {
		const r = g.guards.find((x) => x.guard === guard);
		if (!r) { problems.push(`${name}: guard ${guard} is missing`); continue; }
		if (r.findings !== n) problems.push(`${name}: ${guard} has ${r.findings} finding(s), planted ${n}`);
		if (file && !r.top.some((t) => String(typeof t === "string" ? t : t.file ?? "").startsWith(file))) problems.push(`${name}: ${guard} does not name ${file}`);
	}
	return problems;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
	const [file = "cilytics-out/data.json", name = "gel-e2e"] = process.argv.slice(2);
	const problems = checkChain(JSON.parse(readFileSync(file, "utf8")), name);
	const lines = ["## GEL to Cilytics end-to-end", "", problems.length ? problems.map((p) => `- ${p}`).join("\n") : `Planted findings in ${name} reached data.json: ${Object.entries(PLANTED).map(([g, [n]]) => `${g} ${n}`).join(", ")}.`];
	console.log(lines.join("\n"));
	if (process.env.GITHUB_STEP_SUMMARY) writeFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join("\n") + "\n", { flag: "a" });
	process.exit(problems.length ? 1 : 0);
}
