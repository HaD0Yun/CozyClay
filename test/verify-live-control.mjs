#!/usr/bin/env node
import assert from "node:assert/strict";
import { captureFrameAt, refuseHiddenCapture } from "../src/live-capture-guard.js";
import {
	createLiveControl,
	dispatchLiveFrame,
	listenForWake,
	loadLiveWorkspaceId,
	mintLiveWorkspaceId,
	resolveLiveControlPort,
	LIVE_DUPLICATE_CLOSE_REASON,
	LIVE_PING_INTERVAL_MS,
	LIVE_PONG_TIMEOUT_MS,
	LIVE_RECONNECT_MAX_MS,
	LIVE_WORKSPACE_ID_KEY,
} from "../src/live-control.js";

const frames = [];
const workspaceHandles = [];
const handlers = { ping: () => ({ pong: true }), echo: (args) => args };
const liveControlSource = await import("node:fs/promises").then((fs) => fs.readFile(new URL("../src/live-control.js", import.meta.url), "utf8"));
assert.match(liveControlSource, /VITE_COZYCLAY_LIVE_PORT/);
assert.deepEqual(await dispatchLiveFrame(JSON.stringify({ type: "cmd", id: "1", name: "ping", args: {} }), handlers), {
	type: "result", id: "1", ok: true, value: { pong: true },
});
assert.deepEqual(await dispatchLiveFrame(JSON.stringify({ type: "cmd", id: "2", name: "missing", args: {} }), handlers), {
	type: "result", id: "2", ok: false, error: "Unknown command: missing",
});
assert.deepEqual(await dispatchLiveFrame(JSON.stringify({ type: "cmd", id: "3", name: "echo", args: { x: 4 } }), handlers), {
	type: "result", id: "3", ok: true, value: { x: 4 },
});
assert.equal(await dispatchLiveFrame("not json", handlers), null);

class FakeWebSocket {
	static OPEN = 1;
	static instances = [];
	constructor(url) {
		this.url = url;
		this.readyState = 0;
		FakeWebSocket.instances.push(this);
	}
	open() {
		this.readyState = FakeWebSocket.OPEN;
		this.onopen?.();
	}
	receive(frame) {
		this.onmessage?.({ data: JSON.stringify(frame) });
	}
	send(frame) { frames.push(JSON.parse(frame)); }
	close() {
		this.readyState = 3;
		this.onclose?.();
	}
}

const client = createLiveControl({
	WebSocketImpl: FakeWebSocket,
	handlers,
	onWorkspace: (handle) => workspaceHandles.push(handle),
});
const socket = FakeWebSocket.instances[0];
assert.equal(socket.url, "ws://127.0.0.1:5184/live");

// Given a local live port supplied by the dev server at build time
// When the editor creates its live-control client
// Then it connects to that loopback endpoint rather than a hardcoded port.
const configuredClient = createLiveControl({
	WebSocketImpl: FakeWebSocket,
	handlers,
	url: "ws://127.0.0.1:5199/live",
});
const configuredSocket = FakeWebSocket.instances[1];
assert.equal(configuredSocket.url, "ws://127.0.0.1:5199/live");
configuredClient.close();
socket.open();
assert.deepEqual(frames.shift(), { type: "hello", role: "editor", version: 1 });
// Given the hub assigns this editor's fresh workspace handle
// When it reaches the browser live client
// Then the editor surfaces the opaque handle without treating it as a command.
socket.receive({ type: "workspace", handle: "workspace-1" });
assert.deepEqual(workspaceHandles, ["workspace-1"]);
socket.receive({ type: "cmd", id: "wire-1", name: "ping", args: {} });
await new Promise((resolve) => queueMicrotask(resolve));
assert.deepEqual(frames.shift(), { type: "result", id: "wire-1", ok: true, value: { pong: true } });
socket.receive({ type: "cmd", id: "wire-2", name: "unknown", args: {} });
await new Promise((resolve) => queueMicrotask(resolve));
assert.deepEqual(frames.shift(), { type: "result", id: "wire-2", ok: false, error: "Unknown command: unknown" });
client.close();
const executionEvents = [];
const executionClient = createLiveControl({
	WebSocketImpl: FakeWebSocket,
	handlers,
	captureTelemetry: (event, props) => executionEvents.push({ event, props }),
});
const executionSocket = FakeWebSocket.instances[2];
executionSocket.open();
const requestId = "a".repeat(32);
executionSocket.receive({
	type: "event",
	name: "telemetry",
	payload: {
		event: "mcp:tool_executed",
		props: { request_id: requestId, tool_category: "read", outcome: "succeeded", duration_bucket: "lt1s", prompt: "private" },
	},
});
executionSocket.receive({
	type: "event",
	name: "telemetry",
	payload: {
		event: "mcp:tool_executed",
		props: { request_id: requestId, tool_category: "read", outcome: "succeeded", duration_bucket: "lt1s" },
	},
});
executionSocket.receive({
	type: "event",
	name: "telemetry",
	payload: { event: "mcp:result_applied", props: { request_id: requestId } },
});
executionSocket.receive({
	type: "event",
	name: "telemetry",
	payload: { event: "mcp:tool_executed", props: { request_id: requestId, tool_category: "private", outcome: "succeeded", duration_bucket: "lt1s" } },
});
// A current hub names the tool; an out-of-list name is dropped, not relayed.
for (const [id, tool_name] of [["b".repeat(32), "describe_scene"], ["c".repeat(32), "private_unlisted_tool"]]) {
	executionSocket.receive({
		type: "event",
		name: "telemetry",
		payload: { event: "mcp:tool_requested", props: { request_id: id, tool_category: "read", tool_name } },
	});
}
assert.deepEqual(executionEvents, [
	{ event: "mcp:tool_executed", props: { request_id: requestId, tool_category: "read", outcome: "succeeded", duration_bucket: "lt1s" } },
	{ event: "mcp:result_applied", props: { request_id: requestId } },
	{ event: "mcp:tool_requested", props: { request_id: "b".repeat(32), tool_category: "read", tool_name: "describe_scene" } },
	{ event: "mcp:tool_requested", props: { request_id: "c".repeat(32), tool_category: "read" } },
]);
executionClient.close();

// A controllable clock: the reconnect schedule and the heartbeat are decided
// from elapsed time, so the fake must own `now` as well as the timer queue.
function createClock() {
	let now = 0;
	let sequence = 0;
	const scheduled = new Map();
	const dueBefore = (limit) => [...scheduled.entries()].filter(([, timer]) => timer.at <= limit).sort((a, b) => a[1].at - b[1].at);
	return {
		timers: {
			setTimeout(callback, ms) {
				sequence += 1;
				scheduled.set(sequence, { at: now + ms, callback });
				return sequence;
			},
			clearTimeout(handle) { scheduled.delete(handle); },
			now: () => now,
		},
		time: () => now,
		pending: () => scheduled.size,
		advance(ms) {
			const target = now + ms;
			for (;;) {
				const [next] = dueBefore(target);
				if (!next) break;
				const [handle, timer] = next;
				scheduled.delete(handle);
				now = timer.at;
				timer.callback();
			}
			now = target;
		},
		// A blocked main thread: the clock moves while nothing runs, then every
		// overdue timer fires late, together.
		stall(ms) {
			now += ms;
			for (const [handle, timer] of dueBefore(now)) {
				scheduled.delete(handle);
				timer.callback();
			}
		},
	};
}

class Socket {
	static OPEN = 1;
	static opened = [];
	constructor(url) {
		this.url = url;
		this.readyState = 0;
		this.sent = [];
		Socket.opened.push(this);
	}
	static last() { return Socket.opened[Socket.opened.length - 1]; }
	open(frame = null) {
		this.readyState = Socket.OPEN;
		this.onopen?.();
		if (frame) this.receive(frame);
		return this;
	}
	receive(frame) { this.onmessage?.({ data: JSON.stringify(frame) }); }
	send(raw) { this.sent.push(JSON.parse(raw)); }
	close(code = 1006, reason = "") {
		if (this.readyState === 3) return;
		this.readyState = 3;
		this.onclose?.({ code, reason });
	}
}

function startClient(options = {}) {
	const clock = createClock();
	const wakeWindow = new EventTarget();
	const wakeDocument = Object.assign(new EventTarget(), { visibilityState: "visible" });
	const before = Socket.opened.length;
	const control = createLiveControl({
		WebSocketImpl: Socket,
		handlers,
		url: "ws://127.0.0.1:5184/live",
		timers: clock.timers,
		random: () => 0.5,
		listen: (wake) => listenForWake(wake, { target: wakeWindow, doc: wakeDocument }),
		...options,
	});
	return { clock, control, wakeWindow, wakeDocument, sockets: () => Socket.opened.slice(before) };
}

// Given a hub that is not listening
// When the editor's connection attempts keep failing
// Then each retry waits 1 s * 2^n, capped at 15 s, with the injected jitter.
{
	let jitter = 0.5;
	const { clock, control, sockets } = startClient({ random: () => jitter });
	const expectRetryAfter = (ms, label) => {
		const before = sockets().length;
		sockets()[before - 1].close();
		clock.advance(ms - 1);
		assert.equal(sockets().length, before, `${label}: reconnected before ${ms} ms`);
		clock.advance(1);
		assert.equal(sockets().length, before + 1, `${label}: no reconnect at ${ms} ms`);
	};
	assert.equal(sockets().length, 1);
	for (const delay of [1_000, 2_000, 4_000, 8_000, LIVE_RECONNECT_MAX_MS, LIVE_RECONNECT_MAX_MS]) {
		expectRetryAfter(delay, `backoff ${delay}`);
	}
	jitter = 0;
	expectRetryAfter(LIVE_RECONNECT_MAX_MS * 0.75, "jitter floor");
	jitter = 1;
	expectRetryAfter(LIVE_RECONNECT_MAX_MS * 1.25, "jitter ceiling");

	// Given a reconnect that finally completes its handshake
	// When the socket drops again
	// Then the schedule starts over at 1 s instead of staying at the cap.
	jitter = 0.5;
	sockets()[sockets().length - 1].open({ type: "workspace", handle: "workspace-backoff" });
	expectRetryAfter(1_000, "reset after workspace frame");
	control.close();
}

// Given a tab waiting out a backoff
// When the network or the tab itself comes back
// Then the pending retry is dropped and the editor connects immediately.
for (const trigger of ["online", "focus", "pageshow", "visibilitychange"]) {
	const { clock, control, wakeWindow, wakeDocument, sockets } = startClient();
	sockets()[0].close();
	clock.advance(500);
	assert.equal(sockets().length, 1, `${trigger}: unexpected early reconnect`);
	assert.equal(clock.pending(), 1, `${trigger}: no retry was scheduled`);
	if (trigger === "visibilitychange") {
		wakeDocument.visibilityState = "hidden";
		wakeDocument.dispatchEvent(new Event(trigger));
		assert.equal(sockets().length, 1, "a hidden tab must not reconnect");
		wakeDocument.visibilityState = "visible";
		wakeDocument.dispatchEvent(new Event(trigger));
	} else {
		wakeWindow.dispatchEvent(new Event(trigger));
	}
	assert.equal(sockets().length, 2, `${trigger}: did not reconnect immediately`);
	assert.equal(clock.pending(), 0, `${trigger}: left the stale retry armed`);
	control.close();
}

// Given a hub that advertises no heartbeat
// When the connection sits idle
// Then the editor sends no app-level pings at all.
{
	const { clock, control, sockets } = startClient();
	const socket = sockets()[0].open({ type: "workspace", handle: "workspace-silent" });
	clock.advance(5 * LIVE_PING_INTERVAL_MS);
	assert.deepEqual(socket.sent.filter((frame) => frame.type === "ping"), []);
	assert.equal(socket.readyState, Socket.OPEN);
	control.close();
}

// Given a hub that advertises heartbeatMs
// When it keeps answering
// Then the editor pings every 20 s and holds the socket open.
{
	const { clock, control, sockets } = startClient();
	const socket = sockets()[0].open({ type: "workspace", handle: "workspace-live", heartbeatMs: 20_000 });
	clock.advance(LIVE_PING_INTERVAL_MS);
	assert.deepEqual(socket.sent.filter((frame) => frame.type === "ping"), [{ type: "ping" }]);
	clock.advance(1_000);
	socket.receive({ type: "pong" });
	clock.advance(LIVE_PING_INTERVAL_MS - 1);
	assert.equal(socket.sent.filter((frame) => frame.type === "ping").length, 1, "the next ping must wait 20 s after the pong");
	clock.advance(1);
	assert.equal(socket.sent.filter((frame) => frame.type === "ping").length, 2);
	assert.equal(socket.readyState, Socket.OPEN);

	// Given a 30 s main-thread block (a capture) that delays every timer
	// When the overdue pong check finally runs
	// Then elapsed time proves the stall, not a dead hub, so the socket lives.
	clock.stall(30_000);
	assert.equal(socket.readyState, Socket.OPEN, "a stalled main thread must not look like a dead hub");
	socket.receive({ type: "pong" });
	clock.advance(LIVE_PING_INTERVAL_MS);
	assert.equal(socket.sent.filter((frame) => frame.type === "ping").length, 3);
	assert.equal(socket.readyState, Socket.OPEN);
	control.close();
}

// Given a hub that stops answering its own advertised heartbeat
// When no pong arrives within 10 s of a ping
// Then the editor drops that socket and reconnects on the backoff schedule.
{
	const { clock, control, sockets } = startClient();
	const socket = sockets()[0].open({ type: "workspace", handle: "workspace-dead", heartbeatMs: 20_000 });
	clock.advance(LIVE_PING_INTERVAL_MS);
	clock.advance(LIVE_PONG_TIMEOUT_MS - 1);
	assert.equal(socket.readyState, Socket.OPEN, "closed before the pong deadline");
	clock.advance(1);
	assert.equal(socket.readyState, 3, "a missed pong must close the socket");
	assert.equal(sockets().length, 1);
	clock.advance(1_000);
	assert.equal(sockets().length, 2, "a dead hub must be retried");
	control.close();
}

// Given a duplicated tab, which carries a copy of this tab's sessionStorage
// When the hub refuses the second socket with 1008
// Then the client mints a new identity through onDuplicate and reconnects.
{
	const minted = [];
	const { clock, control, sockets } = startClient({
		workspaceId: "tab-original",
		onDuplicate: () => {
			minted.push("called");
			return "tab-minted";
		},
	});
	const first = sockets()[0].open();
	assert.deepEqual(first.sent[0], { type: "hello", role: "editor", version: 1, workspaceId: "tab-original" });
	first.close(1008, LIVE_DUPLICATE_CLOSE_REASON);
	assert.deepEqual(minted, ["called"]);
	clock.advance(1_000);
	assert.equal(sockets().length, 2, "a refused duplicate must retry from the start of the schedule");
	const second = sockets()[1].open();
	assert.deepEqual(second.sent[0], { type: "hello", role: "editor", version: 1, workspaceId: "tab-minted" });

	// A hub that closes for any other reason keeps this tab's identity, and the
	// backoff carries on from where the refused duplicate left it.
	second.close(1006, "");
	clock.advance(2_000);
	assert.deepEqual(minted, ["called"]);
	sockets()[2].open();
	assert.equal(sockets()[2].sent[0].workspaceId, "tab-minted");
	control.close();
}

// Given a tab that reloads
// When the live client asks for this tab's identity
// Then sessionStorage returns the same id, and a mint replaces it.
assert.equal(LIVE_WORKSPACE_ID_KEY, "cozyclay:live-workspace-id");
{
	const entries = new Map();
	const storage = {
		getItem: (key) => (entries.has(key) ? entries.get(key) : null),
		setItem: (key, value) => entries.set(key, value),
	};
	const first = loadLiveWorkspaceId(storage);
	assert.ok(first, "an empty tab must mint an id");
	assert.equal(entries.get(LIVE_WORKSPACE_ID_KEY), first);
	assert.equal(loadLiveWorkspaceId(storage), first, "a reload must reuse the stored id");
	const replaced = mintLiveWorkspaceId(storage);
	assert.notEqual(replaced, first);
	assert.equal(loadLiveWorkspaceId(storage), replaced);
	assert.equal(entries.get(LIVE_WORKSPACE_ID_KEY), replaced);
}

// Given storage that throws on every access (private mode, blocked storage)
// When the client asks for an identity
// Then it falls back to memory instead of surfacing an error.
{
	const storage = {
		getItem() { throw new Error("storage is blocked"); },
		setItem() { throw new Error("storage is blocked"); },
	};
	const fallback = loadLiveWorkspaceId(storage);
	assert.ok(fallback);
	assert.equal(loadLiveWorkspaceId(storage), fallback, "the in-memory identity must be stable");
	const replaced = mintLiveWorkspaceId(storage);
	assert.notEqual(replaced, fallback);
	assert.equal(loadLiveWorkspaceId(storage), replaced);
}

// Given a prebuilt bundle served by the npm launcher with a custom hub port
// When the launcher injects that port into the page at run time
// Then the client dials it instead of the build-time default (#862).
{
	assert.equal(resolveLiveControlPort(undefined), "5184", "no runtime port keeps the build-time default");
	assert.equal(resolveLiveControlPort(5824), "5824");
	assert.equal(resolveLiveControlPort("5824"), "5824");
	for (const invalid of [null, 0, -1, 65536, 58.5, "nope", Number.NaN]) {
		assert.equal(resolveLiveControlPort(invalid), "5184", `invalid runtime port ${invalid} falls back`);
	}
	globalThis.__COZYCLAY_LIVE_PORT__ = 5824;
	try {
		const before = FakeWebSocket.instances.length;
		const client = createLiveControl({ WebSocketImpl: FakeWebSocket, handlers });
		assert.equal(FakeWebSocket.instances[before].url, "ws://127.0.0.1:5824/live");
		client.close();
	} finally {
		delete globalThis.__COZYCLAY_LIVE_PORT__;
	}
}

// Given an editor connected under its startup label "Untitled" (#864)
// When the user opens a named project and the editor relabels itself
// Then the open socket reports the new label and every later hello carries it.
{
	const sent = [];
	class MetaSocket extends FakeWebSocket {
		send(frame) { sent.push(JSON.parse(frame)); }
	}
	const relabeled = createLiveControl({ WebSocketImpl: MetaSocket, handlers, workspaceId: "tab-a", meta: { project: "Untitled" } });
	relabeled.setMeta({ project: "Before open" });
	assert.equal(sent.length, 0, "a socket that is not open yet sends nothing");
	const first = FakeWebSocket.instances.at(-1);
	first.open();
	assert.deepEqual(sent.shift(), { type: "hello", role: "editor", version: 1, workspaceId: "tab-a", meta: { project: "Before open" } });
	relabeled.setMeta({ project: "Example project", scene: "Scene 1" });
	assert.deepEqual(sent.shift(), { type: "meta", meta: { project: "Example project", scene: "Scene 1" } });
	relabeled.close();
}

{
	// A live capture from a hidden tab is refused with a stable code; a visible page (or headless Chrome, which reports visible) passes.
	assert.doesNotThrow(() => refuseHiddenCapture({ visibilityState: "visible" }));
	assert.doesNotThrow(() => refuseHiddenCapture(undefined));
	assert.throws(() => refuseHiddenCapture({ visibilityState: "hidden" }), (error) => error.code === "TAB_HIDDEN" && /front.*headless Chrome/.test(error.message));
	const frame = JSON.stringify({ type: "cmd", id: "c1", name: "capture_framing_png", args: {} });
	const result = await dispatchLiveFrame(frame, { capture_framing_png: () => refuseHiddenCapture({ visibilityState: "hidden" }) });
	assert.equal(result.ok, false);
	assert.equal(result.error.code, "TAB_HIDDEN", "the code survives the editor transport");
}

{
	// #1074: a named frame renders through the export path and never seeks.
	const asked = [];
	const live = { timeline: { frameCount: 48 }, partColours: null,
		captureShotFrame: (frame) => { asked.push(frame); return { dataUrl: frame === 47 ? null : "data:image/png;base64,AA==", width: 1920, height: 1080, shotId: "shot-1" }; },
		captureShotMeta: (frame) => ({ frame }) };
	assert.deepEqual(captureFrameAt(live, 12), { dataUrl: "data:image/png;base64,AA==", width: 1920, height: 1080, shotId: "shot-1", frame: 12, partColours: null, meta: { frame: 12 } });
	for (const frame of [-1, 48, 1.5, "3"]) assert.throws(() => captureFrameAt(live, frame), /outside the timeline \(0-47\)/);
	assert.throws(() => captureFrameAt(live, 47), /shot renderer is not ready/);
	assert.deepEqual(asked, [12, 47], "an out-of-range frame never reaches the renderer");
}

{
	// #1138: the agent's own looks are not refused in a hidden tab; they take the export's way, which needs no animation frame.
	const { captureHiddenFraming, captureV4Sheet, tabHidden } = await import("../src/live-capture-guard.js");
	assert.equal(tabHidden({ visibilityState: "hidden" }), true); assert.equal(tabHidden({ visibilityState: "visible" }), false); assert.equal(tabHidden(undefined), false);
	const asked = [];
	const live = (currentFrame, frameCount = 48) => ({ timeline: { frameCount, currentFrame }, partColours: null,
		captureShotFrame: (frame) => { asked.push(frame); return { dataUrl: "data:image/png;base64,AA==", width: 1920, height: 1080, shotId: "shot-1" }; },
		captureShotMeta: (frame) => ({ frame }), captureShotReferences: () => ["sheet"] });
	// the shot frame at the playhead, in the visible capture's shape (the references ride along)
	assert.deepEqual(captureHiddenFraming(live(12)), { dataUrl: "data:image/png;base64,AA==", width: 1920, height: 1080, shotId: "shot-1", frame: 12, partColours: null, meta: { frame: 12 }, references: ["sheet"] });
	for (const playhead of [12.6, 99, undefined, -3]) captureHiddenFraming(live(playhead));
	assert.deepEqual(asked, [12, 13, 47, 0, 0], "the playhead's frame, whole and inside the timeline");
	// the v4 render sheet: every cell goes through renderFrameBuffer, in a hidden tab as in a visible one
	const before = globalThis.document, rendered = [];
	const ports = { renderFrameBuffer: (frame, view) => { rendered.push([frame, view.output.width]); return { data: new Uint8Array(view.output.width * view.output.height * 4).fill(128), width: view.output.width, height: view.output.height }; }, encodePng: (data, sheet) => `png:${sheet.width}x${sheet.height}` };
	const args = { tile: { width: 64, height: 48 }, columns: 2, cells: [{ frame: 3, eye: [0, 1, 3], quaternion: [0, 0, 0, 1], fovDeg: 40 }, { frame: 9, eye: [3, 1, 0], quaternion: [0, 0.7071, 0, 0.7071], fovDeg: 40 }] };
	try {
		globalThis.document = { visibilityState: "visible" };
		const shown = captureV4Sheet(args, ports);
		globalThis.document = { visibilityState: "hidden" };
		const hidden = captureV4Sheet(args, ports);
		assert.equal(hidden.dataUrl, "png:128x48"); assert.equal(hidden.cells, 2);
		assert.deepEqual({ ...hidden, ms: 0 }, { ...shown, ms: 0 }, "a hidden tab draws the same sheet");
		assert.deepEqual(rendered, [[3, 64], [9, 64], [3, 64], [9, 64]]);
	} finally { globalThis.document = before; }
}

console.log("all live control checks PASS");
