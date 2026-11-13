const CACHE_PREFIX = "cozyclay-pwa-";
// Bump on any change to what CORE_ASSETS resolves to. The icons are cached
// here, so a client on an older cache keeps serving the previous favicon from
// disk no matter what the server sends.
// v3: app shell moved from "/" to "/app/".
// v4: icons redrawn from the CozyClay mark.
// v5: tab icons cut to a circle so they stop reading as a sticker.
// v6: Google-sized frog set — 192 PNG first, ico frames 48/96/192.
// v6 also: hosted demo and ticket pages are network-only; never freeze queue state.
// v7: force-refresh the asset cache — v6 clients were holding a stale app shell
// (the html-flex crash-screen regression) and never re-fetching it.
// v8: CozyClay 3 drops the shipped walk clip (motion is compiled in the studio).
// v9: start-screen template thumbnails (public/thumbs, tools/render-start-thumbs.mjs).
// v10: the City Block starter and its thumbnails are removed.
const CACHE_NAME = `${CACHE_PREFIX}v10`;
// The installable app is the studio, not the landing page.
const APP_SHELL = "/app/";
const CORE_ASSETS = [
	APP_SHELL,
	"/app/index.html",
	"./manifest.webmanifest",
	"./icons/icon-192.png",
	"./icons/icon-512.png",
	"./icons/icon-maskable-512.png",
	"./icons/apple-touch-icon.png",
	"./favicon.ico",
	"./fonts/inter-latin.woff2",
	"./models/x-bot-tpose.fbx",
	"./models/y-bot-tpose.fbx",
	"./thumbs/blank-stage-light.webp",
	"./thumbs/blank-stage-dark.webp",
];

async function cacheResponse(cache, request, response) {
	if (!response.ok || response.type === "opaque") {
		throw new Error(`Required offline asset failed: ${request}`);
	}
	await cache.put(request, response.clone());
	return response;
}

async function cacheBuiltAssets(cache) {
	const response = await fetch(APP_SHELL, { cache: "reload" });
	if (!response.ok) throw new Error("Required offline app shell failed");
	await cache.put(APP_SHELL, response.clone());
	const html = await response.text();
	const assetUrls = [...html.matchAll(/(?:src|href)="([^"]+)"/g)]
		.map((match) => new URL(match[1], self.location.href))
		.filter((url) => url.origin === self.location.origin)
		.map((url) => url.href);
	await Promise.all(assetUrls.map(async (url) => {
		const asset = await fetch(url, { cache: "reload" });
		await cacheResponse(cache, url, asset);
	}));
}

self.addEventListener("install", (event) => {
	event.waitUntil((async () => {
		const cache = await caches.open(CACHE_NAME);
		await Promise.all(CORE_ASSETS.map(async (url) => {
			const response = await fetch(url, { cache: "reload" });
			await cacheResponse(cache, url, response);
		}));
		await cacheBuiltAssets(cache);
	})());
});

self.addEventListener("activate", (event) => {
	event.waitUntil((async () => {
		const names = await caches.keys();
		await Promise.all(names
			.filter((name) => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME)
			.map((name) => caches.delete(name)));
		await self.clients.claim();
	})());
});

self.addEventListener("message", (event) => {
	if (event.data?.type === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("fetch", (event) => {
	const { request } = event;
	const url = new URL(request.url);
	// Landing-page playground presets are edited in place; a cache-first hit
	// would pin the first version a visitor ever saw.
	if (url.pathname.startsWith("/scenes/")) return;
	if (request.method !== "GET") return;
	if (url.origin !== self.location.origin) return;
	if (request.headers.has("range")) {
		event.respondWith((async () => {
			try {
				return await fetch(request);
			} catch {
				const cached = await caches.match(url.href);
				if (!cached) return new Response(null, { status: 504 });
				const bytes = await cached.arrayBuffer();
				const range = request.headers.get("range")?.match(/bytes=(\d+)-(\d*)/);
				if (!range) return cached;
				const start = Number(range[1]);
				const end = range[2] ? Number(range[2]) : bytes.byteLength - 1;
				const chunk = bytes.slice(start, end + 1);
				return new Response(chunk, {
					status: 206,
					headers: {
						"accept-ranges": "bytes",
						"content-length": String(chunk.byteLength),
						"content-range": `bytes ${start}-${end}/${bytes.byteLength}`,
						"content-type": cached.headers.get("content-type") || "application/octet-stream",
					},
				});
			}
		})());
		return;
	}

	if (request.mode === "navigate") {
		event.respondWith((async () => {
			const cache = await caches.open(CACHE_NAME);
			try {
				const response = await fetch(request);
				return cacheResponse(cache, request, response);
			} catch {
				return (await cache.match(request)) || (await cache.match(APP_SHELL)) || (await cache.match("/app/index.html"));
			}
		})());
		return;
	}

	event.respondWith((async () => {
		const cached = await caches.match(request);
		if (cached) return cached;
		const cache = await caches.open(CACHE_NAME);
		const response = await fetch(request);
		return cacheResponse(cache, request, response);
	})());
});
