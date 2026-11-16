import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const canonicalUrl = "https://cilytics.flisk.si/";
const html = readFileSync(new URL("../site/index.html", import.meta.url), "utf8");
const head = html.match(/<head\b[^>]*>([\s\S]*?)<\/head>/i)?.[1] ?? "";
const activeTags = head.replace(/<!--[\s\S]*?-->/g, "");

function metadata(key) {
	const entries = [...activeTags.matchAll(/<meta\s+(?:name|property)="([^"]+)"\s+content="([^"]*)"\s*>/g)];
	const matches = entries.filter(([, name]) => name === key);
	assert.equal(matches.length, 1, key);
	assert.ok(matches[0][2].trim(), key);
	return matches[0][2];
}

test("Cilytics declares one canonical page URL", () => {
	const canonical = [...activeTags.matchAll(/<link\s+rel="canonical"\s+href="([^"]+)"\s*>/g)];
	assert.deepEqual(canonical.map(([, href]) => href), [canonicalUrl]);
});

test("Cilytics has a complete Open Graph preview", () => {
	const title = head.match(/<title>([^<]+)<\/title>/i)?.[1];
	assert.equal(metadata("og:title"), title);
	assert.equal(metadata("og:description"), metadata("description"));
	assert.equal(metadata("og:url"), canonicalUrl);
	assert.equal(metadata("og:type"), "website");
	assert.equal(new URL(metadata("og:image")).protocol, "https:");
});

test("Cilytics has a matching large image card", () => {
	assert.equal(metadata("twitter:card"), "summary_large_image");
	assert.equal(metadata("twitter:title"), metadata("og:title"));
	assert.equal(metadata("twitter:description"), metadata("og:description"));
	assert.equal(metadata("twitter:image"), metadata("og:image"));
});

test("Cilytics offers a token field when GitHub's anonymous limit is used up", () => {
	assert.match(html, /cilytics-gh-token/);
	assert.match(html, /Authorization = "Bearer "/);
	assert.match(html, /tokenForm\(\)/);
});
