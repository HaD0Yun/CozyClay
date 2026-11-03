import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fillStars, formatStars } from "../tools/github-stars.mjs";

const cases = [
	[0, "0"],
	[42, "42"],
	[100, "100"],
	[999, "900"],
	[1000, "1k"],
	[1408, "1.4k"],
	[1499, "1.4k"],
	[2001, "2k"],
	[12345, "12.3k"],
	[-1, null],
	[1.5, null],
	[undefined, null],
];
for (const [count, want] of cases) assert.equal(formatStars(count), want, `formatStars(${count})`);

// The landing page ships the empty, hidden badge that the build fills in.
const html = readFileSync(resolve(import.meta.dirname, "..", "index.html"), "utf8");
assert.ok(html.includes('<span class="gh-stars" hidden></span>'), "index.html has the hidden star badge");
const filled = fillStars(html, "1.4k");
assert.ok(filled.includes('<span class="gh-stars">1.4k</span>'), "badge filled");
assert.ok(filled.includes('aria-label="CozyClay on GitHub, 1.4k stars"'), "link label names the count");
assert.equal(fillStars(html, null), html, "no count leaves the page unchanged");

console.log(`verify-github-stars: ${cases.length} format cases, fill ok`);
