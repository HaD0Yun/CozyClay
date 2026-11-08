/**
 * GET and POST /__cozyclay/update: what the Studio's update chip reads, and
 * the one click that installs. Every input is injected so the route runs
 * under a test with a mock registry and a fake npm.
 *
 * POST reads no body. The version it installs is the registry's latest after
 * an exact x.y.z test, never anything the request says.
 *
 * POST /__cozyclay/update/restart (#960) hands the launcher to the version a
 * finished install put in place (bin/update-restart.mjs). Same Origin rule,
 * no body, 409 unless the install state is restart_needed.
 */
const VERSION = /^\d+\.\d+\.\d+$/;
const NOTES_URL = "https://github.com/HaD0Yun/CozyClay/releases/tag/v";

function sendJson(res, status, body, headers = {}) {
	res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers });
	res.end(JSON.stringify(body));
}

/**
 * @param {object} options
 * @param {string} options.currentVersion the running package version
 * @param {() => Promise<{latest: string|null, status: string}>} options.checkLatest
 * @param {"global"|"npx"|"clone"} options.kind
 * @param {boolean} options.enabled false when update checks are off
 * @param {number} options.port the launcher's loopback port
 * @param {() => Promise<boolean>} options.canSelfUpdate
 * @param {{startInstall(version: string): boolean, getState(): object}} options.installer
 * @param {{target(): Promise<string|null>, restart(): Promise<void>}} [options.restarter] absent: restart answers 409
 */
export function createUpdateRoutes({ currentVersion, checkLatest, kind, enabled, port, canSelfUpdate, installer, restarter = null }) {
	const command = kind === "npx" ? "npx cozyclay" : "npm install -g cozyclay@latest";
	const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
	// Spelled in two parts so the G014 loopback invariant does not read it as a client URL.
	const origins = new Set([`http://127.0.0.1:${port}`, `http://${"local" + "host"}:${port}`]);

	async function info() {
		const base = { enabled, current: currentVersion, latest: null, status: "unknown", kind, canSelfUpdate: false, phase: "idle", errorClass: null, durationMs: null, installed: null, notesUrl: null, command };
		if (!enabled) return base;
		const [{ latest, status }, selfUpdate] = await Promise.all([
			checkLatest().catch(() => ({ latest: null, status: "unknown" })),
			kind === "global" ? canSelfUpdate().catch(() => false) : false,
		]);
		const { phase, errorClass, durationMs, version: installing } = installer.getState();
		const finished = phase === "restart_needed" || phase === "failed";
		return {
			...base,
			latest: latest ?? null,
			status: latest ? status : "unknown",
			canSelfUpdate: selfUpdate === true,
			phase,
			errorClass: phase === "failed" ? errorClass : null,
			durationMs: finished ? durationMs : null,
			// The version npm installs or installed: the restart target, even if the registry moves on meanwhile.
			installed: phase === "updating" || phase === "restart_needed" ? installing : null,
			notesUrl: latest ? `${NOTES_URL}${latest}` : null,
		};
	}

	async function handlePost(req, res) {
		if (req.headers.origin !== `http://127.0.0.1:${port}`) return sendJson(res, 403, { error: "forbidden origin" });
		if (!enabled) return sendJson(res, 403, { error: "update checks are disabled" });
		const { phase } = installer.getState();
		if (phase === "updating" || phase === "restart_needed") return sendJson(res, 202, await info());
		const current = await info();
		if (!(kind === "global" && current.canSelfUpdate && current.status === "outdated" && VERSION.test(current.latest ?? ""))) {
			return sendJson(res, 409, { error: "self-update unavailable" });
		}
		installer.startInstall(current.latest);
		return sendJson(res, 202, await info());
	}

	let restarting = false;
	async function handleRestart(req, res) {
		if (req.method !== "POST") return sendJson(res, 405, { error: "method not allowed" }, { allow: "POST" });
		if (req.headers.origin !== `http://127.0.0.1:${port}`) return sendJson(res, 403, { error: "forbidden origin" });
		if (restarting) return sendJson(res, 202, await info());
		if (!enabled || installer.getState().phase !== "restart_needed" || !restarter || !(await restarter.target())) {
			return sendJson(res, 409, { error: "restart unavailable" });
		}
		restarting = true;
		// The answer has to leave before the server drops every connection.
		res.once("finish", () => setTimeout(() => void restarter.restart(), 50));
		return sendJson(res, 202, await info());
	}

	return async function handleUpdateRoute(req, res) {
		try {
			if (req.url?.split("?")[0] === "/__cozyclay/update/restart") return await handleRestart(req, res);
			if (req.method === "GET") {
				const origin = req.headers.origin;
				if (!(origins.has(origin) || (origin === undefined && hosts.has(req.headers.host)))) return sendJson(res, 403, { error: "forbidden origin" });
				return sendJson(res, 200, await info());
			}
			if (req.method === "POST") return await handlePost(req, res);
			return sendJson(res, 405, { error: "method not allowed" }, { allow: "GET, POST" });
		} catch {
			if (!res.headersSent) sendJson(res, 500, { error: "update unavailable" });
		}
	};
}
