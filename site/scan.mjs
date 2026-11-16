// Cilytics' pure logic: what a workflow run, a repo and an account add up to. No node imports, so the same file runs in
// the collector (scripts/collect.mjs, once an hour) and in the page (site/index.html, live for one repo).
export const ACTIVE_DAYS = 90;
const RED = new Set(["failure", "timed_out", "startup_failure"]);
const COUNTED = new Set(["success", "failure", "timed_out", "startup_failure"]);
export const HISTORY_MAX = 24 * 45; // hourly points for 45 days

const minutes = (run) => {
	const start = Date.parse(run.run_started_at || run.created_at);
	const end = Date.parse(run.updated_at);
	return Number.isFinite(start) && Number.isFinite(end) && end >= start ? Math.round((end - start) / 600) / 100 : null;
};

export function median(values) {
	const v = values.filter((x) => x !== null).sort((a, b) => a - b);
	if (!v.length) return null;
	const m = Math.floor(v.length / 2);
	return v.length % 2 ? v[m] : Math.round(((v[m - 1] + v[m]) / 2) * 100) / 100;
}

const DAYS = 14; // per-repo daily pass/fail bars
const RECENT = 20; // per-workflow outcome strip

// One letter per run for the outcome strip: s success, f red, c cancelled, - anything else.
const letter = (c) => (c === "success" ? "s" : RED.has(c) ? "f" : c === "cancelled" ? "c" : "-");

export function percentile(values, p) {
	const v = values.filter((x) => x !== null).sort((a, b) => a - b);
	if (!v.length) return null;
	return v[Math.min(v.length - 1, Math.ceil((p / 100) * v.length) - 1)];
}

// Pure: one workflow's completed runs (newest first) -> pass rate, durations, outcome strip and flakiness.
// A flip is a pass followed by a red run or the other way round, in run order; cancelled and skipped runs are ignored.
// A workflow is flaky when it flipped at least three times in its window.
export function workflowStats(runs) {
	const counted = runs.filter((r) => COUNTED.has(r.conclusion));
	const pass = counted.filter((r) => r.conclusion === "success").length;
	const order = counted.map((r) => r.conclusion === "success").reverse();
	let flips = 0;
	for (let i = 1; i < order.length; i++) if (order[i] !== order[i - 1]) flips++;
	const mins = runs.map(minutes);
	return {
		runs: counted.length,
		passRate: counted.length ? Math.round((pass / counted.length) * 1000) / 10 : null,
		medianMinutes: median(mins),
		p90Minutes: percentile(mins, 90),
		flips,
		flaky: flips >= 3,
		recent: runs
			.slice(0, RECENT)
			.reverse()
			.map((r) => letter(r.conclusion))
			.join(""),
	};
}

// Pure: completed runs -> the last DAYS UTC days, oldest first, with pass and red counts per day.
export function dailyCounts(runs, now) {
	const day = (t) => new Date(t).toISOString().slice(0, 10);
	const days = Array.from({ length: DAYS }, (_, i) => ({ d: day(now - (DAYS - 1 - i) * 86400e3), pass: 0, fail: 0 }));
	const at = new Map(days.map((x) => [x.d, x]));
	for (const r of runs) {
		const slot = at.get(day(Date.parse(r.run_started_at || r.created_at)));
		if (!slot) continue;
		if (r.conclusion === "success") slot.pass++;
		else if (RED.has(r.conclusion)) slot.fail++;
	}
	return days;
}

// Pure: runs (newest first, as the API returns them) -> per-workflow latest state and repo totals.
export function summarizeRuns(runs, now = Date.now()) {
	const done = runs.filter((r) => r.status === "completed");
	const byWorkflow = new Map();
	for (const run of done) {
		if (!byWorkflow.has(run.workflow_id)) byWorkflow.set(run.workflow_id, []);
		byWorkflow.get(run.workflow_id).push(run);
	}
	const workflows = [...byWorkflow.values()]
		.map((list) => {
			const run = list[0];
			return {
				name: run.name,
				conclusion: run.conclusion,
				red: RED.has(run.conclusion),
				url: run.html_url,
				at: run.updated_at,
				minutes: minutes(run),
				sha: run.head_sha?.slice(0, 7),
				...workflowStats(list),
			};
		})
		.sort((a, b) => Number(b.red) - Number(a.red) || a.name.localeCompare(b.name));
	const counted = done.filter((r) => COUNTED.has(r.conclusion));
	const pass = counted.filter((r) => r.conclusion === "success").length;
	const conclusions = {};
	for (const r of done) conclusions[r.conclusion] = (conclusions[r.conclusion] || 0) + 1;
	return {
		workflows,
		red: workflows.filter((w) => w.red).length,
		runs: counted.length,
		passRate: counted.length ? Math.round((pass / counted.length) * 1000) / 10 : null,
		medianMinutes: median(done.map(minutes)),
		p95Minutes: percentile(done.map(minutes), 95),
		ciMinutes: Math.round(done.reduce((n, r) => n + (minutes(r) ?? 0), 0)),
		conclusions,
		days: dailyCounts(done, now),
	};
}

// Pure: names in a repo's root folder -> the AI-SDLC harness flags Cilytics shows. ci comes from the workflow runs.
export function sdlcFlags(rootNames, workflowCount, gelInstalled = false) {
	const has = (n) => rootNames.includes(n);
	const flags = { agents: has("AGENTS.md"), claude: has("CLAUDE.md"), settings: has(".claude"), ci: workflowCount > 0, gel: gelInstalled };
	return { ...flags, score: Object.values(flags).filter(Boolean).length };
}

// Pure: the OSS score, 0 to 100, of how well a public repo is run as open source: a licence people can use, a README,
// the files that tell a newcomer how to contribute and where to report a vulnerability, a described and tagged repo,
// and CI that exists and is green. Root file names are matched without case; files under .github/ count as present
// when the folder holds them (`githubNames`). Each check is worth its weight; the same inputs give the same score.
export const OSS_CHECKS = [
	["license", "Licence", 20],
	["readme", "README", 10],
	["contributing", "CONTRIBUTING", 10],
	["security", "SECURITY", 10],
	["conduct", "Code of conduct", 5],
	["about", "Description and topics", 10],
	["ci", "CI workflows", 15],
	["green", "CI green", 20],
];
export function ossScore({ repo, rootNames = [], githubNames = [], summary }) {
	const names = [...rootNames, ...githubNames].map((n) => n.toLowerCase());
	const has = (re) => names.some((n) => re.test(n));
	const lic = repo.license && repo.license.spdx_id && repo.license.spdx_id !== "NOASSERTION";
	const pass = {
		license: Boolean(lic) || has(/^licen[sc]e(\.|$)/),
		readme: has(/^readme(\.|$)/),
		contributing: has(/^contributing(\.|$)/),
		security: has(/^security(\.|$)/),
		conduct: has(/^code[_-]of[_-]conduct(\.|$)/),
		about: Boolean(repo.description) && (repo.topics ?? []).length > 0,
		ci: summary.workflows.length > 0,
		green: summary.workflows.length > 0 && summary.red === 0 && (summary.passRate ?? 0) >= 80,
	};
	const checks = OSS_CHECKS.map(([id, label, weight]) => ({ id, label, weight, pass: pass[id] }));
	return { score: checks.reduce((n, c) => n + (c.pass ? c.weight : 0), 0), checks };
}

// Pure: is this workflow run a GEL run? The caller's workflow is named "GEL" (flisk-sh/gel itself uses "GEL dogfood");
// a workflow file called gel.yml counts too.
export const isGelRun = (r) => r.name === "GEL" || String(r.name || "").startsWith("GEL ") || String(r.path || "").endsWith("/gel.yml");

// Pure: runs (newest first) -> the newest completed GEL run, or undefined.
export const findGelRun = (runs) => runs.find((r) => r.status === "completed" && isGelRun(r));

// Pure: the last JSON line of gel-record.jsonl (plus the run it came from) -> the repo's gel field.
// Anything unreadable becomes installed:true with record:null, never an error.
export function gelFromRecord(text, run = {}) {
	const base = { installed: true, runUrl: run.html_url ?? null, at: run.updated_at ?? null };
	try {
		const lines = String(text ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
		const rec = JSON.parse(lines[lines.length - 1]);
		if (!rec || typeof rec !== "object" || Array.isArray(rec)) throw new Error("not an object");
		return {
			...base,
			lane: rec.lane ?? null,
			needsPerson: Boolean(rec.needsPerson),
			blocked: Array.isArray(rec.blocked) ? rec.blocked : [],
			ms: rec.ms ?? null,
			guards: (Array.isArray(rec.results) ? rec.results : []).map((g) => ({ guard: g.guard, level: g.level, pass: Boolean(g.pass), findings: Number(g.findings) || 0, top: Array.isArray(g.top) ? g.top.slice(0, 10) : [] })),
		};
	} catch {
		return { ...base, record: null };
	}
}

export function totals(repos) {
	const runs = repos.reduce((n, r) => n + r.runs, 0);
	const passed = repos.reduce((n, r) => n + (r.passRate === null ? 0 : (r.passRate / 100) * r.runs), 0);
	return {
		repos: repos.length,
		workflows: repos.reduce((n, r) => n + r.workflows.length, 0),
		red: repos.reduce((n, r) => n + r.red, 0),
		redRepos: repos.filter((r) => r.red > 0).length,
		passRate: runs ? Math.round((passed / runs) * 1000) / 10 : null,
		openPRs: repos.reduce((n, r) => n + r.openPRs, 0),
		runs,
		ciMinutes: repos.reduce((n, r) => n + (r.ciMinutes ?? 0), 0),
		flaky: repos.reduce((n, r) => n + r.workflows.filter((w) => w.flaky).length, 0),
		sdlcReady: repos.filter((r) => r.sdlc?.score === 5).length,
		gelRepos: repos.filter((r) => r.gel?.installed).length,
		gelFindings: repos.reduce((n, r) => n + (r.gel?.guards ?? []).filter((g) => !g.pass).reduce((m, g) => m + (g.findings || 0), 0), 0),
		gelBlocked: repos.filter((r) => (r.gel?.blocked ?? []).length > 0).length,
	};
}


// Pure: GitHub's repo object, its runs (newest first), open PR count, root file names and the GEL result -> one repo row,
// the same shape in the hourly snapshot and in a live scan.
export function repoEntry({ repo, runs, openPRs, rootNames, githubNames = [], gel, now }) {
	const summary = summarizeRuns(runs, now);
	return {
		name: repo.name,
		url: repo.html_url,
		defaultBranch: repo.default_branch,
		pushedAt: repo.pushed_at,
		stars: repo.stargazers_count,
		openPRs,
		...summary,
		gel,
		sdlc: sdlcFlags(rootNames, summary.workflows.length, gel.installed),
		oss: ossScore({ repo, rootNames, githubNames, summary }),
	};
}

// Pure: "owner/name", a github.com link to it, or a link to a page inside it -> "owner/name", else null.
export function parseRepo(input) {
	const m = /^(?:https?:\/\/)?(?:www\.)?(?:github\.com\/)?([A-Za-z0-9](?:[\w-]*[A-Za-z0-9])?)\/([\w.-]+?)(?:\.git)?(?:[/?#].*)?$/.exec(String(input ?? "").trim());
	return m && !/^\.+$/.test(m[2]) ? `${m[1]}/${m[2]}` : null;
}

// The GEL guards that judge workflow files alone, so they can run on a repo nobody checked out. The other three
// (secret-scan, dead-links, done-without-green) need a checkout or a pull request: `npx github:flisk-sh/gel run`.
export const LIVE_GUARDS = ["pinned-actions", "workflow-permissions"];

// Pure: workflow file texts ({path: text}) -> GEL's own guards run on them. `guards` maps a guard name to its module
// (loaded from flisk-sh/gel); a guard that is missing or throws is left out, never faked.
export function runLiveGuards(files, guards, repo) {
	const paths = Object.keys(files);
	const read = (f) => files[f] ?? null;
	const out = [];
	for (const name of LIVE_GUARDS) {
		try {
			const res = guards[name].run({ files: paths, cfg: { repo }, read });
			out.push({ guard: name, level: "report", pass: res.pass, findings: res.findings.length, top: res.findings.slice(0, 10).map((f) => ({ file: f.file, line: f.line, message: f.message })) });
		} catch {}
	}
	return out;
}

// One repo, scanned now from a browser or any fetch: `json(path)` answers api.github.com, `text(url)` a raw file.
// Four API calls, no token, so it fits the 60 requests an hour GitHub gives an anonymous address.
// Returns a snapshot in the hourly file's shape (one repo, no history), with GEL's live guard results on the repo.
export async function scanRepo(full, { json, text, guards, now = Date.now() }) {
	const [owner, name] = full.split("/");
	const repo = await json(`/repos/${owner}/${name}`);
	const ref = encodeURIComponent(repo.default_branch);
	const [runs, pulls, root, flows, gh] = await Promise.all([
		json(`/repos/${full}/actions/runs?branch=${ref}&per_page=100&exclude_pull_requests=true`).then((r) => r.workflow_runs ?? []),
		json(`/repos/${full}/pulls?state=open&per_page=100`).catch(() => []),
		json(`/repos/${full}/contents/?ref=${ref}`).catch(() => []),
		json(`/repos/${full}/contents/.github/workflows?ref=${ref}`).catch(() => []),
		json(`/repos/${full}/contents/.github?ref=${ref}`).catch(() => []),
	]);
	const wf = (Array.isArray(flows) ? flows : []).filter((f) => f.type === "file" && /\.ya?ml$/.test(f.name) && f.download_url).slice(0, 40);
	const files = {};
	await Promise.all(wf.map(async (f) => { try { files[f.path] = await text(f.download_url); } catch {} }));
	const rootNames = (Array.isArray(root) ? root : []).map((f) => f.name);
	const run = findGelRun(runs);
	const installed = Boolean(run) || rootNames.includes("gel.json") || wf.some((f) => f.name === "gel.yml");
	const results = runLiveGuards(files, guards, full);
	const gel = { installed, live: true, runUrl: run?.html_url ?? null, at: run?.updated_at ?? null, lane: null, needsPerson: false, blocked: [], guards: results, checked: Object.keys(files).length };
	const githubNames = (Array.isArray(gh) ? gh : []).map((f) => f.name);
	const entry = repoEntry({ repo, runs, openPRs: pulls.length, rootNames, githubNames, gel, now });
	return { org: owner, repo: full, live: true, ownerType: "Repository", generatedAt: new Date(now).toISOString(), activeDays: ACTIVE_DAYS, skipped: 0, totals: totals([entry]), repos: [entry] };
}

// Pure: a scanned snapshot of one repo -> the small row the page shows on a chip: OSS score, GEL guards passed of run,
// pass rate and red workflows.
export function featuredRow(snapshot) {
	const r = snapshot.repos[0], guards = r.gel.guards ?? [];
	const row = { repo: snapshot.repo, oss: r.oss.score, gelPass: guards.filter((g) => g.pass).length, gelRun: guards.length, gelInstalled: Boolean(r.gel.installed), passRate: r.passRate, red: r.red, flaky: r.workflows.filter((w) => w.flaky).length, sdlc: r.sdlc.score, sdlcMax: r.sdlc.gel === undefined ? 4 : 5 };
	return { ...row, health: healthScore(row) };
}

// Pure: one 0 to 100 score from every dimension Cilytics measures, so a repo cannot rank high on one of them alone.
// OSS 25, pass rate 25, agent-readiness 20, GEL guards 20 (a guard that did not run counts as unverified, out of 5),
// and a 10-point clean-CI bonus that each red or flaky workflow takes 5 from. Missing inputs score zero, never full.
export function healthScore({ oss = 0, passRate = null, sdlc = 0, sdlcMax = 5, gelPass = 0, gelRun = 0, red = 0, flaky = 0 }) {
	const n = (v) => (Number.isFinite(v) ? v : 0);
	const total = 0.25 * n(oss) + 0.25 * n(passRate) + 20 * (n(sdlc) / (n(sdlcMax) || 5)) + 20 * (n(gelPass) / Math.max(n(gelRun), 5)) + (Number.isFinite(passRate) ? Math.max(0, 10 - 5 * (n(red) + n(flaky))) : 0);
	return Math.round(Math.min(100, Math.max(0, total)));
}
