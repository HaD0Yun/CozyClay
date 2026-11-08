// Writes the repo's GitHub star count into dist/index.html after `vite build`,
// rounded down to the hundred ("1.4k"). The Pages workflow also runs once a
// day, so the number on cozyclay.org is at most a day old. Any failure (no
// network, rate limit, missing dist) leaves the badge hidden and the build green.
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const REPO = "HaD0Yun/CozyClay";
const BADGE = '<span class="gh-stars" hidden></span>';

export function formatStars(count) {
	if (!Number.isInteger(count) || count < 0) return null;
	if (count < 100) return String(count);
	const hundreds = Math.floor(count / 100) * 100;
	if (hundreds < 1000) return String(hundreds);
	return `${String(hundreds / 1000).replace(/\.0$/, "")}k`;
}

export function fillStars(html, label) {
	if (!label || !html.includes(BADGE)) return html;
	return html
		.replace(BADGE, `<span class="gh-stars">${label}</span>`)
		.replace('aria-label="CozyClay on GitHub"', `aria-label="CozyClay on GitHub, ${label} stars"`);
}

async function fetchStars() {
	const headers = { accept: "application/vnd.github+json", "user-agent": "cozyclay-site-build" };
	if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
	const res = await fetch(`https://api.github.com/repos/${REPO}`, { headers, signal: AbortSignal.timeout(5000) });
	if (!res.ok) throw new Error(`GitHub API ${res.status}`);
	return (await res.json()).stargazers_count;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
	const file = resolve(import.meta.dirname, "..", "dist", "index.html");
	try {
		const label = formatStars(await fetchStars());
		writeFileSync(file, fillStars(readFileSync(file, "utf8"), label));
		console.log(`github-stars: ${label}`);
	} catch (error) {
		console.log(`github-stars: skipped (${error.message})`);
	}
}
