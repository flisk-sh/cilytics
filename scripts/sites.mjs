// The five-second test on live websites: fetch each URL, score its first screen with GEL's five-second-test guard
// (the real guard, from a GEL checkout), and write sites.json for the page's "5-second" tab.
//   node scripts/sites.mjs --urls urls.json --gel path/to/gel --out cilytics-out/sites.json
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const strip = (h) => h.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

export function firstScreen(html) {
	const h1 = /<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(html);
	const lead = h1 ? /<p\b[^>]*>([\s\S]*?)<\/p>/i.exec(html.slice(h1.index + h1[0].length)) : null;
	return { h1: h1 ? strip(h1[1]) : "", lead: lead ? strip(lead[1]) : "" };
}

// status: "pass" | "fail" | "unchecked" (the page builds its text with a script, so a plain fetch cannot read it) | "error"
export async function scoreSite(url, guard, fetchImpl = fetch) {
	try {
		const r = await fetchImpl(url, { redirect: "follow", signal: AbortSignal.timeout(15000), headers: { "user-agent": "cilytics-five-second-test" } });
		const html = await r.text();
		const sc = firstScreen(html);
		// A page that answers 503 on purpose (a paused service) still has a first screen a visitor reads: score it.
		if (!r.ok && !sc.h1) return { url, status: "error", error: `HTTP ${r.status}`, findings: [] };
		if (!sc.h1 && /<script/i.test(html)) return { url, status: "unchecked", ...sc, findings: ["the page is drawn by a script, so its first screen cannot be read without a browser"] };
		const dir = mkdtempSync(join(tmpdir(), "five-"));
		try {
			writeFileSync(join(dir, "index.html"), html);
			const res = guard.run({ root: dir, files: ["index.html"], cfg: {} });
			return { url, status: res.pass ? "pass" : "fail", ...sc, findings: res.findings.map((f) => f.message.replace(/^five-second test: /, "")) };
		} finally { rmSync(dir, { recursive: true, force: true }); }
	} catch (e) { return { url, status: "error", error: String(e.message || e), findings: [] }; }
}

export async function scoreSites(urls, guard, fetchImpl) {
	const rows = await Promise.all([...new Set(urls)].map((u) => scoreSite(u, guard, fetchImpl)));
	const order = { fail: 0, error: 1, unchecked: 2, pass: 3 };
	rows.sort((a, b) => order[a.status] - order[b.status] || b.findings.length - a.findings.length || a.url.localeCompare(b.url));
	return { at: new Date().toISOString(), rows };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const arg = (n) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : null; };
	const guard = await import(pathToFileURL(join(arg("--gel"), "guards", "five-second-test", "index.mjs")).href);
	const out = await scoreSites(JSON.parse(readFileSync(arg("--urls"), "utf8")), guard);
	writeFileSync(arg("--out"), JSON.stringify(out));
	console.log(`five-second test: ${out.rows.filter((r) => r.status === "pass").length} pass, ${out.rows.filter((r) => r.status === "fail").length} fail, ${out.rows.filter((r) => r.status === "unchecked").length} unchecked, ${out.rows.filter((r) => r.status === "error").length} error`);
}
