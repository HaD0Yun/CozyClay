import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

function pass(message) {
	console.log(`PASS ${message}`);
}

const manifest = JSON.parse(readFileSync("public/manifest.webmanifest", "utf8"));
assert.equal(manifest.name, "Cozy Clay");
assert.equal(manifest.start_url, "/app/");
assert.equal(manifest.scope, "/app/");
assert.equal(manifest.display, "standalone");
assert.equal(manifest.lang, "en");
pass("manifest launches the Cozy Clay studio at /app/");

const iconBySize = new Map(manifest.icons.map((icon) => [icon.sizes, icon]));
assert.equal(iconBySize.get("192x192")?.type, "image/png");
assert.equal(iconBySize.get("512x512")?.type, "image/png");
assert.ok(manifest.icons.some((icon) => icon.sizes === "512x512" && icon.purpose === "any"));
assert.ok(manifest.icons.some((icon) => icon.purpose === "maskable"));
for (const icon of manifest.icons) {
	const path = `public/${icon.src.replace(/^\.\//, "")}`;
	assert.ok(existsSync(path), `${icon.src} is missing`);
	const png = readFileSync(path);
	assert.equal(png.subarray(1, 4).toString("ascii"), "PNG");
	const [expectedWidth, expectedHeight] = icon.sizes.split("x").map(Number);
	assert.equal(png.readUInt32BE(16), expectedWidth);
	assert.equal(png.readUInt32BE(20), expectedHeight);
}
pass("manifest exposes installable 192px, 512px, and maskable PNG icons");

const index = readFileSync("app/index.html", "utf8");
// #972: browser page translation crashes the React tree (NotFoundError); the
// studio has its own en / ko / zh UI, the landing page stays translatable.
assert.match(index, /<html[^>]*\btranslate="no"/);
assert.match(index, /<meta name="google" content="notranslate" \/>/);
assert.doesNotMatch(readFileSync("index.html", "utf8"), /notranslate|translate="no"/);
// #1046: the workflow editor is a React app too; translation crashed it the same way.
const workflowIndex = readFileSync("workflow/index.html", "utf8");
assert.match(workflowIndex, /<html[^>]*\btranslate="no"/);
assert.match(workflowIndex, /<meta name="google" content="notranslate" \/>/);
pass("studio opts out of browser page translation; landing does not");
assert.match(index, /<html lang="en"[ >]/);
assert.match(index, /rel="manifest" href="\/manifest\.webmanifest"/);
assert.match(index, /name="theme-color" content="#232323"/);
assert.match(index, /rel="apple-touch-icon"/);
pass("document metadata advertises the manifest, theme, and Apple icon");

const main = readFileSync("src/main.jsx", "utf8");
assert.match(main, /registerPwa\(\)/);
const worker = readFileSync("public/sw.js", "utf8");
assert.match(worker, /addEventListener\("install"/);
assert.match(worker, /addEventListener\("activate"/);
assert.match(worker, /addEventListener\("fetch"/);
assert.match(worker, /SKIP_WAITING/);
assert.match(worker, /request\.headers\.has\("range"\)/);
assert.match(worker, /status:\s*206/);
pass("service worker registers install, activation, offline fetch, range requests, and update handling");

function simulateWorkerInstall(missingPath = null) {
	const listeners = new Map();
	const scope = {
		location: new URL("https://example.test/sw.js"),
		clients: { claim: async () => {} },
		skipWaiting: async () => {},
		addEventListener(type, handler) {
			listeners.set(type, handler);
		},
	};
	const cache = { put: async () => {} };
	runInNewContext(worker, {
		self: scope,
		caches: {
			open: async () => cache,
			keys: async () => [],
			delete: async () => true,
			match: async () => null,
		},
		fetch: async (input) => {
			const url = new URL(String(input), scope.location.href);
			if (missingPath && url.pathname.endsWith(missingPath)) return new Response("missing", { status: 404 });
			if (url.pathname === "/app/" || url.pathname === "/app/index.html") {
				return new Response('<link rel="manifest" href="/manifest.webmanifest"><script src="/assets/app.js"></script>');
			}
			return new Response("asset");
		},
		Response,
		URL,
		console,
	});
	let install;
	listeners.get("install")({ waitUntil(promise) { install = promise; } });
	return install;
}

await assert.doesNotReject(simulateWorkerInstall());
await assert.rejects(simulateWorkerInstall("models/x-bot-tpose.fbx"), /Required offline asset failed/);
pass("service worker installation fails fast when a required offline asset is missing");

const vite = readFileSync("vite.config.js", "utf8");
assert.match(vite, /base:\s*"\/"/);
pass("root Vite base keeps studio assets reachable from /app/");

console.log("all Cozy Clay PWA checks PASS");
