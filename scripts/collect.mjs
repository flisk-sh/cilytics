// Cilytics collector: a deterministic snapshot of CI across a GitHub org or user account, for checks/index.html.
//
//   GITHUB_TOKEN=... CILYTICS_ORG=<org or user> node scripts/collect.mjs --out data.json [--scores scores.json [--scores-repo owner/repo] [--scores-url https://.../{id}.mjs]] [--history history.json]
//
// The account is CILYTICS_ORG, else the owner of the repository running in Actions, else flisk-sh (this project's own dogfood). CILYTICS_MAX_REPOS caps
// how many repos are read (most recently pushed first). For every public, non-archived, non-fork repo pushed in the last 90 days it reads the last 100 workflow runs on the
// default branch (pull-request runs excluded) and keeps, per workflow, the newest completed run. A workflow is red when
// that run failed or timed out. Pass rate counts success against failure and timed_out only; cancelled, skipped and
// neutral runs are left out. No model, no guessing: the same API answers give the same file.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { ACTIVE_DAYS, HISTORY_MAX, LIVE_GUARDS, featuredRow, scanRepo, dailyCounts, findGelRun, gelFromRecord, isGelRun, median, percentile, repoEntry, sdlcFlags, summarizeRuns, totals, workflowStats } from "../site/scan.mjs";

export { dailyCounts, findGelRun, gelFromRecord, isGelRun, median, percentile, sdlcFlags, summarizeRuns, totals, workflowStats };

// Pure: which account to read. An explicit setting wins, then the Actions repo owner, then flisk-sh.
export const resolveOrg = (env = process.env) => env.CILYTICS_ORG || env.GITHUB_REPOSITORY_OWNER || "flisk-sh";
// Pure: the repo-list endpoint for an account type from GET /users/{name} ("Organization" or "User").
export const reposPath = (type, name) => (type === "User" ? `/users/${name}/repos?type=owner&sort=pushed` : `/orgs/${name}/repos?type=public&sort=pushed`);
async function gh(path) {
	const res = await fetch(`https://api.github.com${path}`, {
		headers: {
			accept: "application/vnd.github+json",
			"x-github-api-version": "2022-11-28",
			...(process.env.GITHUB_TOKEN ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
		},
	});
	if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
	return res.json();
}

async function ghAll(path) {
	const out = [];
	for (let page = 1; page <= 10; page++) {
		const sep = path.includes("?") ? "&" : "?";
		const batch = await gh(`${path}${sep}per_page=100&page=${page}`);
		out.push(...batch);
		if (batch.length < 100) break;
	}
	return out;
}

// Download the gel-record artifact of a run and return gel-record.jsonl's text. Throws on any failure.
async function fetchGelRecord(run, org) {
	const headers = { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", authorization: `Bearer ${process.env.GITHUB_TOKEN}` };
	const repo = run.repository?.full_name ?? `${org}/${run.repository?.name}`;
	const list = await gh(`/repos/${repo}/actions/runs/${run.id}/artifacts`);
	const art = (list.artifacts || []).find((a) => a.name === "gel-record" && !a.expired);
	if (!art) throw new Error("no gel-record artifact");
	// The archive URL redirects to a signed host; follow it by hand so the token is not sent there.
	let res = await fetch(art.archive_download_url, { headers, redirect: "manual" });
	if (res.status >= 300 && res.status < 400) res = await fetch(res.headers.get("location"));
	if (!res.ok) throw new Error(`artifact download: HTTP ${res.status}`);
	const dir = mkdtempSync(join(tmpdir(), "gel-"));
	try {
		const zip = join(dir, "a.zip");
		writeFileSync(zip, Buffer.from(await res.arrayBuffer()));
		return execFileSync("unzip", ["-p", zip, "gel-record.jsonl"], { encoding: "utf8", maxBuffer: 16e6 });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

async function collectGel(runs, org) {
	const run = findGelRun(runs);
	if (!run) return { installed: false };
	try {
		return gelFromRecord(await fetchGelRecord(run, org), run);
	} catch {
		return gelFromRecord(null, run);
	}
}

export async function collect(now, org = resolveOrg(), maxRepos = Number(process.env.CILYTICS_MAX_REPOS) || Infinity) {
	const cutoff = now - ACTIVE_DAYS * 86400e3;
	const owner = await gh(`/users/${org}`); // works for organizations and users alike
	const all = await ghAll(reposPath(owner.type, org));
	const active = all.filter((r) => !r.archived && !r.fork && Date.parse(r.pushed_at) >= cutoff).slice(0, maxRepos);
	const repos = [];
	for (const r of active) {
		const runs = (
			await gh(`/repos/${org}/${r.name}/actions/runs?branch=${encodeURIComponent(r.default_branch)}&per_page=100&exclude_pull_requests=true`)
		).workflow_runs;
		const prs = await ghAll(`/repos/${org}/${r.name}/pulls?state=open`);
		let rootNames = [];
		try {
			rootNames = (await gh(`/repos/${org}/${r.name}/contents/?ref=${encodeURIComponent(r.default_branch)}`)).map((f) => f.name);
		} catch {}
		let githubNames = [];
		try {
			githubNames = (await gh(`/repos/${org}/${r.name}/contents/.github?ref=${encodeURIComponent(r.default_branch)}`)).map((f) => f.name);
		} catch {}
		const gel = await collectGel(runs, org);
		repos.push(repoEntry({ repo: r, runs, openPRs: prs.length, rootNames, githubNames, gel, now }));
	}
	repos.sort((a, b) => b.red - a.red || (a.passRate ?? 101) - (b.passRate ?? 101) || a.name.localeCompare(b.name));
	const skipped = all.length - active.length;
	return { org, ownerType: owner.type, generatedAt: new Date(now).toISOString(), activeDays: ACTIVE_DAYS, skipped, totals: totals(repos), repos };
}

// GEL's guards are plain modules with no imports, so they load from a pinned commit through a data: URL.
const GEL_BASE = "https://raw.githubusercontent.com/flisk-sh/gel/414b5100876f01f96b8208ead5d2db9a11ec2545/";
async function loadGuards() {
	const guards = {};
	for (const n of LIVE_GUARDS) {
		try {
			const res = await fetch(`${GEL_BASE}guards/${n}/index.mjs`);
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const src = await res.text();
			guards[n] = await import(`data:text/javascript;base64,${Buffer.from(src).toString("base64")}`);
		} catch {}
	}
	return guards;
}

// Scan each featured repo (the same scan the page runs live) and keep one small row per repo. A repo that fails is left out.
export async function collectFeatured(list, now) {
	const guards = await loadGuards();
	const text = async (url) => (await fetch(url)).text();
	const rows = [], scans = {};
	for (const full of list) {
		try {
			const snap = await scanRepo(full, { json: gh, text, guards, now });
			rows.push(featuredRow(snap));
			scans[full] = snap; // the page shows this instantly and when GitHub's anonymous limit blocks a live scan
		} catch {}
	}
	return { generatedAt: new Date(now).toISOString(), rows, scans };
}

// A long list (Ranker's repos) cannot all be scanned in one run under the workflow token's hourly quota, so each run scans one
// rotating window of `size` repos and keeps the other rows from the previous run. Pure: returns the repos to scan now.
export function rankedWindow(list, hour, size) {
	const all = [...new Set(list)].sort();
	if (all.length <= size) return all;
	const start = (hour * size) % all.length;
	return Array.from({ length: size }, (_, i) => all[(start + i) % all.length]);
}

// Pure: rows from this run replace the previous run's rows for the same repo; a repo no longer in the list is dropped.
export function mergeRankedRows(list, prevRows, newRows) {
	const keep = new Set(list), by = new Map();
	for (const r of prevRows) if (keep.has(r.repo)) by.set(r.repo, r);
	for (const r of newRows) by.set(r.repo, r);
	return [...by.values()];
}

export async function collectRanked(list, prevRows, now, size = 60) {
	const guards = await loadGuards();
	const text = async (url) => (await fetch(url)).text();
	const fresh = [];
	for (const full of rankedWindow(list, Math.floor(now / 3600000), size)) {
		try {
			fresh.push({ ...featuredRow(await scanRepo(full, { json: gh, text, guards, now })), at: new Date(now).toISOString() });
		} catch {}
	}
	return mergeRankedRows(list, prevRows, fresh);
}

const readJson = (file, fallback) => {
	try {
		return JSON.parse(readFileSync(file, "utf8"));
	} catch {
		return fallback;
	}
};

if (import.meta.url === `file://${process.argv[1]}`) {
	const { values } = parseArgs({ options: { out: { type: "string" }, scores: { type: "string" }, "scores-repo": { type: "string" }, "scores-url": { type: "string" }, history: { type: "string" }, featured: { type: "string" }, "featured-out": { type: "string" }, ranked: { type: "string" }, "ranked-prev": { type: "string" } } });
	const data = await collect(Date.now());
	if (values.scores) {
		const rows = readJson(values.scores, []);
		data.scores = {
			repo: values["scores-repo"] ?? null,
			url: /^https:\/\//.test(values["scores-url"] ?? "") ? values["scores-url"] : null,
			rows: rows.map(({ id, title, mode, unit, value, baseline, target, status, summary, better }) => ({
				id, title, mode, unit, value, baseline, target, status, summary, better,
			})),
		};
	}
	if (values.history) {
		const history = readJson(values.history, []);
		const t = data.totals;
		history.push({
			at: data.generatedAt,
			red: t.red,
			redRepos: t.redRepos,
			passRate: t.passRate,
			openPRs: t.openPRs,
			runs: t.runs,
			flaky: t.flaky,
			gelRepos: t.gelRepos,
			scoresFailing: data.scores ? data.scores.rows.filter((r) => ["fail", "error"].includes(r.status)).length : null,
		});
		writeFileSync(values.history, `${JSON.stringify(history.slice(-HISTORY_MAX))}\n`);
	}
	if (values.featured && values["featured-out"]) {
		const f = await collectFeatured(readJson(values.featured, []), Date.now());
		writeFileSync(values["featured-out"], `${JSON.stringify({ generatedAt: f.generatedAt, rows: f.rows })}\n`);
		writeFileSync(values["featured-out"].replace(/featured-scores\.json$/, "featured-scans.json"), `${JSON.stringify({ generatedAt: f.generatedAt, scans: f.scans })}\n`);
	}
	const json = `${JSON.stringify(data, null, 1)}\n`;
	if (values.out) writeFileSync(values.out, json);
	else process.stdout.write(json);
}
