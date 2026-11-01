import { defineConfig } from "vite";
import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";

const { version } = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));

const livePort = process.env.COZYCLAY_LIVE_PORT ?? "5184";
const oauthPort = process.env.COZYCLAY_OAUTH_PORT?.trim();
const oauthUrl = oauthPort ? `http://127.0.0.1:${oauthPort}` : null;
const agentUrl = oauthUrl;

export default defineConfig({
	define: {
		"import.meta.env.VITE_COZYCLAY_LIVE_PORT": JSON.stringify(livePort),
	},
	// Root-absolute on purpose: the site has its own apex domain, and the studio
	// is served from "/app/" while its public assets stay at the root. A relative
	// base would resolve those to "/app/models/..." and 404.
	base: "/",
	build: {
		rollupOptions: {
			input: {
				// The crawlable landing page: static HTML, no bundle.
				landing: resolve(import.meta.dirname, "index.html"),
				// The studio itself.
				app: resolve(import.meta.dirname, "app/index.html"),
				// Search-facing article on camera control for AI video.
				aiCameraControl: resolve(import.meta.dirname, "ai-camera-control/index.html"),
				greyboxToVideo: resolve(import.meta.dirname, "greybox-to-video/index.html"),
				previsSoftware: resolve(import.meta.dirname, "previs-software/index.html"),
				seedanceCameraControl: resolve(import.meta.dirname, "seedance-camera-control/index.html"),
				privacy: resolve(import.meta.dirname, "privacy/index.html"),
				// Standalone Vibe-Workflow inspired graph editor.
				workflow: resolve(import.meta.dirname, "workflow/index.html"),
			},
		},
	},
	plugins: [
		react(),
		// The landing shows the release it was built from (#903).
		{
			name: "cozyclay-landing-version",
			transformIndexHtml: (html) => html.replaceAll("%COZYCLAY_VERSION%", version),
		},
		// A service worker registered by an earlier PRODUCTION visit to this same
		// origin outlives the tab and keeps serving its cached bundle to the dev
		// server's port — edits appear to do nothing, and no amount of reloading
		// helps because the worker answers before the network does. Dev therefore
		// serves a self-destructing worker: it unregisters itself, drops every
		// CozyClay cache, and reloads the clients it was holding.
		{
			name: "cozyclay-dev-kill-sw",
			apply: "serve",
			configureServer(server) {
				server.middlewares.use((req, res, next) => {
					const path = (req.url || "").split("?")[0];
					// Dev only: the root opens the Studio so a fresh checkout starts in
					// the complete authoring surface. The production root stays the crawlable landing
					// page at cozyclay.org; a redirect baked into index.html would
					// hide it from every visitor and from search. /index.html still
					// serves the landing so it can be previewed locally.
					if (path === "/") {
						const query = (req.url || "").slice(path.length);
						res.statusCode = 302;
						res.setHeader("location", `/app/${query}`);
						res.end();
						return;
					}
					if (!oauthUrl && /^\/oauth\/(start|status|logout)$/.test(path)) {
						res.statusCode = 503;
						res.setHeader("content-type", "application/json; charset=utf-8");
						res.end(JSON.stringify({ error: "oauth sidecar is not configured" }));
						return;
					}
					// Every route the panel calls, including the Studio turn's event
					// replay and its explicit job acceptance: without them a dev server
					// answers those two with the SPA's index.html, which the panel then
					// fails to parse instead of reporting a missing sidecar.
					if (!agentUrl && /^\/agent\/(turn|stop|models|providers(\/[^/]+)?|turn\/[^/]+\/events|turn\/[^/]+\/steer|jobs\/[^/]+\/accept|motion-fill)$/.test(path)) {
						res.statusCode = 503;
						res.setHeader("content-type", "application/json; charset=utf-8");
						res.end(JSON.stringify({ error: "agent sidecar is not configured" }));
						return;
					}
					if ((req.url || "").split("?")[0] !== "/sw.js") return next();
					res.setHeader("content-type", "text/javascript; charset=utf-8");
					res.setHeader("cache-control", "no-store");
					res.end(
						`self.addEventListener("install", () => self.skipWaiting());\n` +
							`self.addEventListener("activate", (event) => {\n` +
							`\tevent.waitUntil((async () => {\n` +
							`\t\tconst keys = await caches.keys();\n` +
							`\t\tawait Promise.all(keys.filter((k) => k.startsWith("cozyclay-pwa-")).map((k) => caches.delete(k)));\n` +
							`\t\tawait self.registration.unregister();\n` +
							`\t\tconst clients = await self.clients.matchAll({ type: "window" });\n` +
							`\t\tfor (const client of clients) client.navigate(client.url);\n` +
							`\t})());\n` +
							`});\n`,
					);
				});
			},
		},
	],
	server: {
		port: 5180,
		// Dev-only: the OAuth/agent sidecar is an optional companion on loopback.
		// The production build stays fully static, so this proxy must never
		// become a requirement.
		...(oauthUrl
			? {
				proxy: {
					"/oauth": { target: oauthUrl }, "/agent": { target: agentUrl },
				},
			}
			: {}),
	},
});
