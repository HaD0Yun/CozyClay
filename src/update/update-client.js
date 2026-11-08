// The in-Studio update notice (U1): the launcher's GET/POST /__cozyclay/update
// (bin/update-routes.mjs) read and driven from the page. Pure apart from the
// injected fetch, timers, storage and window, so test/verify-update-client.mjs
// drives it under Node. A page without window.__COZYCLAY_RUNTIME__ (the hosted
// site, Vite dev) makes no request at all. Tabs share a dismiss, an install
// start and a phase change at once (U2): over a BroadcastChannel, or through a
// storage event where there is none. A hint only makes a tab fetch now; the
// launcher's answer stays the only phase a tab shows. Restart now (U2b, #960)
// hands the launcher to the new version and waits for it to answer.
export const UPDATE_URL = "/__cozyclay/update";
export const RESTART_URL = "/__cozyclay/update/restart";
export const RESTART_WAIT_MS = 30_000;
export const RESTART_POLL_MS = 1000;
export const DISMISS_KEY = "cozyclay:update-dismissed";
export const POLL_MS = 6 * 60 * 60 * 1000;
export const VISIBLE_STALE_MS = 60 * 60 * 1000;
export const UPDATING_POLL_MS = 2000;
export const CHANNEL_NAME = "cozyclay:update";
export const HINT_KEY = "cozyclay:update-hint";

const VERSION = /^\d+\.\d+\.\d+$/;
const KINDS = new Set(["global", "npx", "clone"]);
const STATUSES = new Set(["latest", "outdated", "unknown"]);
const PHASES = new Set(["idle", "updating", "restart_needed", "failed"]);
const ERROR_CLASSES = new Set(["permission", "network", "node_version", "npm_missing", "other"]);
const NOTES_PREFIX = "https://github.com/HaD0Yun/CozyClay/releases/tag/v";
const GLOBAL_COMMAND = "npm install -g cozyclay@latest";
const NPX_COMMAND = "npx cozyclay";
const RESTART_COMMAND = "cclay";

/** True on a page the npm launcher served (it injects window.__COZYCLAY_RUNTIME__). */
function hasLauncherRuntime(win = globalThis.window) {
	try { return Boolean(win?.__COZYCLAY_RUNTIME__); } catch { return false; }
}

const version = (value) => (typeof value === "string" && VERSION.test(value) ? value : null);

/** The route body as the client trusts it: closed values only; anything else reads as "unknown". */
export function normalizeUpdateInfo(body) {
	if (!body || typeof body !== "object") return null;
	const kind = KINDS.has(body.kind) ? body.kind : "clone";
	const latest = version(body.latest);
	const phase = PHASES.has(body.phase) ? body.phase : "idle";
	return {
		enabled: body.enabled === true,
		current: version(body.current),
		latest,
		status: STATUSES.has(body.status) ? body.status : "unknown",
		kind,
		canSelfUpdate: body.canSelfUpdate === true,
		phase,
		errorClass: phase === "failed" ? (ERROR_CLASSES.has(body.errorClass) ? body.errorClass : "other") : null,
		durationMs: Number.isFinite(body.durationMs) && body.durationMs >= 0 ? body.durationMs : null,
		installed: version(body.installed),
		// Opened in a new tab, so only the project's own release page is accepted.
		notesUrl: latest && body.notesUrl === `${NOTES_PREFIX}${latest}` ? body.notesUrl : null,
		command: kind === "npx" ? NPX_COMMAND : GLOBAL_COMMAND,
	};
}

async function request(fetchImpl, init, win, url = UPDATE_URL) {
	if (!hasLauncherRuntime(win) || typeof fetchImpl !== "function") return null;
	try {
		const response = await fetchImpl(url, { cache: "no-store", credentials: "same-origin", ...init });
		if (!response?.ok) return null;
		return normalizeUpdateInfo(await response.json());
	} catch {
		return null;
	}
}

/** GET the launcher's update state; null on a hosted page or any failure (the notice fails silently). */
export const fetchUpdateInfo = (fetchImpl = globalThis.fetch?.bind(globalThis), win = globalThis.window) => request(fetchImpl, { method: "GET" }, win);

/** POST: ask the launcher to install `latest`. The 202 body, or null (403/409/network). No body is sent. */
export const startUpdate = (fetchImpl = globalThis.fetch?.bind(globalThis), win = globalThis.window) => request(fetchImpl, { method: "POST" }, win);

/** POST: hand the launcher to the installed version. The 202 body, or null (403/409/network). No body is sent. */
export const requestRestart = (fetchImpl = globalThis.fetch?.bind(globalThis), win = globalThis.window) => request(fetchImpl, { method: "POST" }, win, RESTART_URL);

/** After the new launcher answers: reload only a saved project. True when it reloaded. */
export function reloadAfterRestart({ dirty, reload }) {
	if (dirty) return false;
	reload();
	return true;
}

/** patch | minor | major: how far `current` is behind `latest`. */
export function behindOf(current, latest) {
	const [a, b] = [current, latest].map((value) => (version(value) ?? "0.0.0").split(".").map(Number));
	if (a[0] !== b[0]) return "major";
	return a[1] !== b[1] ? "minor" : "patch";
}

// The in-progress export phases (App.jsx updateExportStatus; StatusBar.jsx BUSY). completed, failed and
// cancelled stay in exportStatus after the job ends, so a non-null status alone is not "exporting".
const EXPORT_BUSY_PHASES = new Set(["preparing", "encoding", "finalizing"]);

/** "Update now" waits while an agent turn, an export or a recording runs: they would cross the file swap. */
export function updateBlocked({ agentRunning = false, exportStatus = null, recState = "idle" } = {}) {
	return Boolean(agentRunning) || EXPORT_BUSY_PHASES.has(exportStatus?.phase) || recState === "recording";
}

const HIDDEN = Object.freeze({ view: "hidden", actions: [] });

const RESTART_ACTIONS = { restarting: [], restarted: ["reload"], restart_timeout: ["copy_command"] };

/**
 * The chip and dialog view for one poll result and the local state: { dismissed }, and { restart }
 * (restarting | restarted | restart_timeout) once Restart now ran here or in another tab.
 */
export function nextUpdateState(info, local = {}) {
	if (!info || !info.enabled) return HIDDEN;
	const base = {
		current: info.current, latest: info.latest, kind: info.kind, notesUrl: info.notesUrl,
		command: info.command, canSelfUpdate: info.canSelfUpdate, errorClass: null,
	};
	if (RESTART_ACTIONS[local.restart]) return { ...base, latest: local.target ?? info.latest, view: local.restart, command: RESTART_COMMAND, actions: RESTART_ACTIONS[local.restart] };
	const oneClick = info.kind === "global" && info.canSelfUpdate;
	// "Installing X" and "Updated to X" name the version npm installs, which the registry may have passed since.
	const installed = info.installed ?? info.latest;
	if (info.phase === "updating") return { ...base, latest: installed, view: "updating", actions: [] };
	if (info.phase === "restart_needed") return { ...base, latest: installed, view: "restart_needed", command: RESTART_COMMAND, actions: ["restart", "copy_command"] };
	if (info.phase === "failed") {
		return { ...base, view: "failed", errorClass: info.errorClass ?? "other", command: GLOBAL_COMMAND,
			actions: oneClick ? ["retry", "copy_command"] : ["copy_command"] };
	}
	const shown = info.status === "outdated" && (info.kind === "global" || info.kind === "npx") && info.latest && local.dismissed !== info.latest;
	if (!shown) return HIDDEN;
	return { ...base, view: "available", behind: behindOf(info.current, info.latest), actions: [oneClick ? "update_now" : "copy_command", "later"] };
}

// Reading window.localStorage itself throws when site data is blocked, so even the default is guarded.
const safeStorage = () => { try { return globalThis.localStorage; } catch { return null; } };

/** The dismissed version, or null. Storage that throws reads as "nothing dismissed". */
export function readDismissed(storage = safeStorage()) {
	try { return version(storage?.getItem(DISMISS_KEY)); } catch { return null; }
}

/** Hide `latest` for good (per version). False when storage refused; the notice still hides for this page. */
export function writeDismissed(latest, storage = safeStorage()) {
	try { storage.setItem(DISMISS_KEY, latest); return true; } catch { return false; }
}

const HINTS = new Set(["dismiss", "install", "phase", "restart"]);

// A missing or throwing BroadcastChannel is null: hints then travel as a storage event.
function openUpdateChannel() {
	try { return typeof globalThis.BroadcastChannel === "function" ? new globalThis.BroadcastChannel(CHANNEL_NAME) : null; } catch { return null; }
}

const defaultTimers = {
	set: (fn, ms) => setTimeout(fn, ms),
	clear: (timer) => clearTimeout(timer),
	now: () => Date.now(),
	// After the Studio's first frame, then idle: the check never competes with boot.
	afterFirstFrame(fn) {
		const idle = globalThis.requestIdleCallback ?? ((run) => setTimeout(run, 200));
		const frame = globalThis.requestAnimationFrame ?? ((run) => setTimeout(run, 16));
		frame(() => idle(fn));
	},
};

/**
 * The poll loop: once after the first frame and idle, every 6 h, on a visible
 * tab whose last check is over 1 h old, every 2 s while installing. `onState`
 * gets { state, info } after every change. Returns { dismiss, update, stop }.
 * `channel` is a BroadcastChannel-shaped object (default: one is opened when
 * the browser has it); null sends the other tabs' hints through `storage`.
 * restart() and a restart hint poll every 1 s, failures included, until the
 * launcher's `current` is the installed version, for up to 30 s.
 */
export function createUpdatePoller({
	fetchImpl = globalThis.fetch?.bind(globalThis), onState = () => {}, timers = defaultTimers,
	storage = safeStorage(), win = globalThis.window, doc = globalThis.document, channel: injected,
} = {}) {
	const noop = { dismiss() {}, update: async () => null, restart: async () => null, stop() {} };
	if (!hasLauncherRuntime(win)) return noop;
	const channel = injected === undefined ? openUpdateChannel() : injected;
	let info = null, timer = null, stopped = false, inflight = null, lastCheck = -Infinity, hints = 0;
	let dismissed = readDismissed(storage), restart = null, target = null, following = null;
	const emit = () => { if (!stopped) onState({ state: nextUpdateState(info, { dismissed, restart, target }), info }); };
	const schedule = () => {
		if (stopped) return;
		if (timer !== null) timers.clear(timer);
		timer = timers.set(check, info?.phase === "updating" ? UPDATING_POLL_MS : POLL_MS);
	};
	// Tell the other tabs; a lost hint only costs them the wait for their next poll.
	const hint = (type, latest = null) => {
		try {
			if (channel) channel.postMessage({ type, latest });
			else if (type !== "dismiss") storage?.setItem(HINT_KEY, `${type}:${timers.now()}:${(hints += 1)}:${version(latest) ?? ""}`);
		} catch { /* best effort */ }
	};
	// Emitted first, so this tab's update:finished claim is in storage before any other tab re-polls.
	// A change a hint led to is not hinted again: the other tabs had the same hint.
	const apply = (next, cause = "phase") => {
		if (!next) return;
		const changed = info !== null && info.phase !== next.phase;
		info = next;
		emit();
		if (cause === "install" || (changed && cause === "phase")) hint(cause);
	};
	function check(cause = "phase") {
		if (stopped) return Promise.resolve(info);
		if (inflight) return inflight;
		// An early check (a visible tab) replaces the pending poll; the schedule never doubles.
		if (timer !== null) { timers.clear(timer); timer = null; }
		lastCheck = timers.now();
		inflight = fetchUpdateInfo(fetchImpl, win);
		return inflight.then((next) => { inflight = null; apply(next, cause); schedule(); return info; });
	}
	const onVisible = () => {
		if (doc?.visibilityState === "visible" && timers.now() - lastCheck > VISIBLE_STALE_MS) void check();
	};
	// A fetch already in flight may predate the hint, so one more follows it.
	const refresh = () => (inflight ? inflight.then(() => check("hinted")) : check("hinted"));
	// The old launcher stops answering for a moment, so a failed fetch is only another try.
	const followRestart = (to) => {
		if (following || !to) return following ?? Promise.resolve(null);
		restart = "restarting";
		target = to;
		emit();
		const deadline = timers.now() + RESTART_WAIT_MS;
		following = (async () => {
			for (;;) {
				await new Promise((done) => timers.set(done, RESTART_POLL_MS));
				if (stopped) return null;
				const next = await fetchUpdateInfo(fetchImpl, win);
				if (next?.current === to) { info = next; restart = "restarted"; break; }
				if (timers.now() >= deadline) { restart = "restart_timeout"; break; }
			}
			emit();
			return restart === "restarted" ? "ok" : "timeout";
		})();
		return following;
	};
	// The version the launcher installed, not the registry's latest: a newer release may appear while it waits.
	const restartTarget = (latest) => version(latest) ?? (info?.phase === "restart_needed" ? info.installed ?? info.latest : null);
	const onHint = (type, latest = null) => {
		if (stopped || !HINTS.has(type)) return;
		if (type === "restart") return void followRestart(restartTarget(latest));
		if (type !== "dismiss") return void refresh();
		dismissed = readDismissed(storage) ?? version(latest) ?? dismissed;
		emit();
	};
	const onMessage = (event) => onHint(event?.data?.type, event?.data?.latest);
	const onStorage = (event) => {
		if (event?.key === HINT_KEY) { const [type, , , latest] = String(event.newValue ?? "").split(":"); return onHint(type, latest || null); }
		if (event?.key !== DISMISS_KEY && event?.key !== null) return;
		dismissed = readDismissed(storage);
		emit();
	};
	try {
		doc?.addEventListener?.("visibilitychange", onVisible);
		win?.addEventListener?.("storage", onStorage);
		channel?.addEventListener?.("message", onMessage);
	} catch { /* no listeners: the 6 h poll still runs */ }
	timers.afterFirstFrame(() => { if (!stopped) void check(); });
	return {
		dismiss(latest) {
			if (!version(latest)) return;
			writeDismissed(latest, storage);
			dismissed = latest;
			emit();
			hint("dismiss", latest);
		},
		async update() {
			const next = await startUpdate(fetchImpl, win);
			apply(next, "install");
			schedule();
			return next;
		},
		// Resolves to the outcome (ok | timeout), or null when the launcher refused.
		async restart() {
			const to = restartTarget(null);
			if (!to || following) return following;
			if (!(await requestRestart(fetchImpl, win))) return null;
			hint("restart", to);
			return followRestart(to);
		},
		stop() {
			stopped = true;
			if (timer !== null) timers.clear(timer);
			try {
				doc?.removeEventListener?.("visibilitychange", onVisible);
				win?.removeEventListener?.("storage", onStorage);
				channel?.removeEventListener?.("message", onMessage);
				channel?.close?.();
			} catch { /* best effort */ }
		},
	};
}
