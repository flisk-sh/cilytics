// Measures the north star: the share of flisk.si websites that pass the five-second test.
// Reads the live sites.json Cilytics publishes (rows with status pass, fail, unchecked or error) and writes north-star.json.
// Pages drawn by script ("unchecked") and non-pages ("error") are left out of both sides, like the Websites tab does.
import { writeFileSync } from "node:fs";

const BASELINE = 18 / 31; // 13 of 31 websites failed in the first scoring on 2026-11-17, before the fixes
const url = process.argv[2] ?? "https://cilytics.flisk.si/sites.json";
const { rows } = await (await fetch(`${url}?t=${Date.now()}`)).json();
const checked = rows.filter((r) => r.status === "pass" || r.status === "fail");
const pass = checked.filter((r) => r.status === "pass").length;
const value = checked.length ? pass / checked.length : 0;
writeFileSync(
	new URL("../north-star.json", import.meta.url),
	JSON.stringify({ value: Number(value.toFixed(4)), baseline: Number(BASELINE.toFixed(4)), unit: "share passing", measuredAt: new Date().toISOString(), pass, checked: checked.length, run: url }, null, 2) + "\n",
);
console.log(`${pass} of ${checked.length} websites pass (${(value * 100).toFixed(0)}%), baseline ${(BASELINE * 100).toFixed(0)}%`);
