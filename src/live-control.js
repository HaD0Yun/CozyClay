// Browser-side client for the editor half of mcp/LIVE-PROTOCOL.md. This
// module has no browser-only dependencies, so its frame dispatcher is directly
// testable in Node with a fake WebSocket.
import { sanitizeProps, track } from "./analytics.js";
import { EXECUTION_TELEMETRY_EVENTS, EXECUTION_TELEMETRY_PROPERTY_KEYS } from "./execution-telemetry.js";

const LIVE_TELEMETRY_EVENTS = new Set(EXECUTION_TELEMETRY_EVENTS.filter((event) => event.startsWith("mcp:")));

const LIVE_CONTROL_PORT = import.meta.env?.VITE_COZYCLAY_LIVE_PORT ?? "5184";
// The npm launcher serves a prebuilt bundle, so the build-time port above is
// fixed; it injects the hub port it actually started as __COZYCLAY_LIVE_PORT__
// (#862). A valid runtime value wins over the build-time default.
export const resolveLiveControlPort = (runtime = globalThis.__COZYCLAY_LIVE_PORT__) => (/^[1-9]\d{0,4}$/.test(String(runtime)) && Number(runtime) < 65536 ? String(runtime) : LIVE_CONTROL_PORT);
export const liveControlUrl = (port = resolveLiveControlPort()) => `ws://127.0.0.1:${port}/live`;
// Reconnect schedule: 1 s doubling to a 15 s cap with +-25 % jitter, so a hub
// that comes back does not take every editor's retry in the same millisecond.
const LIVE_RECONNECT_BASE_MS = 1_000;
export const LIVE_RECONNECT_MAX_MS = 15_000;
const LIVE_RECONNECT_JITTER = 0.25;
// App-level liveness, sent only to a hub that advertises `heartbeatMs`: a TCP
// connection to a dead hub can stay open for minutes without a single frame.
export const LIVE_PING_INTERVAL_MS = 20_000;
export const LIVE_PONG_TIMEOUT_MS = 10_000;
// A blocked main thread (a 30 s capture_frame) delays every timer at once. A
// tick that late is evidence of that stall, not of a dead hub, so the round is
// restarted instead of being counted as a missed pong.
const LIVE_HEARTBEAT_SLACK_MS = 2_000;
// Per-tab identity. sessionStorage is per tab and survives a reload, which is
// exactly the lifetime the hub routes retained motion outcomes to.
export const LIVE_WORKSPACE_ID_KEY = "cozyclay:live-workspace-id";
const LIVE_DUPLICATE_CLOSE_CODE = 1008;
export const LIVE_DUPLICATE_CLOSE_REASON = "Workspace id is already connected";

// Storage can be absent (Node), disabled, or throw on access alone; the tab
// still needs one stable id for as long as it lives.
let memoryWorkspaceId = "";

function workspaceStore(storage) {
	try {
		return storage ?? globalThis.sessionStorage ?? null;
	} catch {
		return null;
	}
}

function newWorkspaceId() {
	const uuid = globalThis.crypto?.randomUUID?.();
	return uuid ?? `live-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function storeWorkspaceId(id, storage) {
	memoryWorkspaceId = id;
	try {
		workspaceStore(storage)?.setItem(LIVE_WORKSPACE_ID_KEY, id);
	} catch {
		// A full or disabled store leaves the in-memory id as this tab's identity.
	}
	return id;
}

/** This tab's live identity, minted once and reused across reloads. */
export function loadLiveWorkspaceId(storage) {
	try {
		const stored = workspaceStore(storage)?.getItem(LIVE_WORKSPACE_ID_KEY);
		if (typeof stored === "string" && stored) {
			memoryWorkspaceId = stored;
			return stored;
		}
	} catch {
		// Fall through to the in-memory identity.
	}
	return memoryWorkspaceId || storeWorkspaceId(newWorkspaceId(), storage);
}

/** Take a new identity: a duplicated tab starts out claiming this tab's id. */
export function mintLiveWorkspaceId(storage) {
	return storeWorkspaceId(newWorkspaceId(), storage);
}

/**
 * Subscribe to the moments a tab is worth retrying immediately: the network
 * returned, or the tab itself came back. A restored page ships from the
 * back/forward cache with a socket that is already gone.
 */
export function listenForWake(wake, { target = globalThis, doc = globalThis.document } = {}) {
	if (typeof target?.addEventListener !== "function") return () => {};
	const onVisible = () => {
		if (doc?.visibilityState === "visible") wake();
	};
	const names = ["online", "focus", "pageshow"];
	for (const name of names) target.addEventListener(name, wake);
	doc?.addEventListener?.("visibilitychange", onVisible);
	return () => {
		for (const name of names) target.removeEventListener(name, wake);
		doc?.removeEventListener?.("visibilitychange", onVisible);
	};
}

const defaultTimers = {
	setTimeout: (callback, ms) => setTimeout(callback, ms),
	clearTimeout: (handle) => clearTimeout(handle),
	// Monotonic where it exists: a wall-clock jump must not read as a stall.
	now: () => globalThis.performance?.now?.() ?? Date.now(),
};

function isDuplicateWorkspaceClose(event) {
	return event?.code === LIVE_DUPLICATE_CLOSE_CODE
		&& typeof event.reason === "string"
		&& event.reason.includes(LIVE_DUPLICATE_CLOSE_REASON);
}

function errorMessage(error) {
	if (error instanceof Error && error.message) return error.message;
	return typeof error === "string" && error ? error : "Command failed";
}

function result(id, ok, body) {
	return ok
		? { type: "result", id, ok: true, value: body ?? {} }
		: { type: "result", id, ok: false, error: body };
}

/**
 * Parse and dispatch one incoming text frame. Non-command frames are ignored;
 * a command with a valid id always receives a protocol result, including for
 * malformed arguments and unknown command names.
 */
export async function dispatchLiveFrame(data, handlers = {}) {
	if (typeof data !== "string") return null;
	let frame;
	try {
		frame = JSON.parse(data);
	} catch {
		return null;
	}
	if (!frame || typeof frame !== "object" || Array.isArray(frame) || frame.type !== "cmd") return null;
	if (typeof frame.id !== "string") return null;
	if (typeof frame.name !== "string" || !frame.name) return result(frame.id, false, "Invalid command name");
	if (!frame.args || typeof frame.args !== "object" || Array.isArray(frame.args)) return result(frame.id, false, "Invalid command arguments");
	const handler = handlers[frame.name];
	if (typeof handler !== "function") return result(frame.id, false, `Unknown command: ${frame.name}`);
	try {
		return result(frame.id, true, await handler(frame.args));
	} catch (error) {
		return result(frame.id, false, typeof error?.code === "string" ? { code: error.code, message: errorMessage(error) } : errorMessage(error));
	}
}

// Open the editor's one-way client connection. Failures are intentionally
// silent: a studio remains a fully local editor when the MCP server is absent.
export function createLiveControl({
	handlers = {},
	onWorkspace = () => {},
	onEvent = () => {},
	// A duplicated tab carries a copy of this tab's id; the hub refuses the
	// second socket, so the loser mints and stores a new identity, then retries.
	onDuplicate = () => mintLiveWorkspaceId(),
	captureTelemetry = track,
	workspaceId = "",
	// Optional identity for the hub's live_status listing (scene/project names).
	meta = null,
	WebSocketImpl = globalThis.WebSocket,
	url = liveControlUrl(),
	timers = defaultTimers,
	random = Math.random,
	// Aliased on purpose: an unqualified call to a binding named `listen` reads
	// as a server bind to the loopback scan in test/verify-mcp-invariants.mjs.
	listen: subscribeWake = listenForWake,
} = {}) {
	let currentHandlers = handlers;
	let currentWorkspaceId = workspaceId;
	let socket = null;
	let retry = null;
	let attempt = 0;
	let stopped = false;
	let heartbeat = null;
	let heartbeatArmedAt = 0;
	let heartbeatDelay = 0;
	let heartbeatOn = false;
	let pingSentAt = null;
	const capturedStages = new Set();
	const receiveTelemetry = (payload) => {
		if (!LIVE_TELEMETRY_EVENTS.has(payload.event)) return;
		const props = sanitizeProps(payload.event, payload.props);
		const correlationId = props.request_id;
		if (!correlationId) return;
		if (EXECUTION_TELEMETRY_EVENTS.includes(payload.event)
			// A hub older than tool_name still sends a complete frame without it.
			&& EXECUTION_TELEMETRY_PROPERTY_KEYS[payload.event]?.some((key) => key !== "tool_name" && !Object.hasOwn(props, key))) return;
		const key = `${correlationId}:${payload.event}`;
		if (capturedStages.has(key)) return;
		capturedStages.add(key);
		try {
			Promise.resolve(captureTelemetry(payload.event, props)).catch(() => {
				// SDK failures must not affect command dispatch or generation.
			});
		} catch {
			// The shared analytics gate and SDK are both best effort.
		}
	};

	const clearRetry = () => {
		if (retry !== null) timers.clearTimeout(retry);
		retry = null;
	};
	const backoffMs = () => {
		const base = Math.min(LIVE_RECONNECT_BASE_MS * 2 ** attempt, LIVE_RECONNECT_MAX_MS);
		attempt += 1;
		return Math.round(base * (1 + (random() * 2 - 1) * LIVE_RECONNECT_JITTER));
	};
	const scheduleReconnect = () => {
		if (stopped || retry !== null || socket) return;
		retry = timers.setTimeout(() => {
			retry = null;
			connect();
		}, backoffMs());
	};
	// The network or the tab just came back: the pending backoff is stale.
	const wake = () => {
		if (stopped || socket) return;
		clearRetry();
		connect();
	};
	const stopHeartbeat = () => {
		if (heartbeat !== null) timers.clearTimeout(heartbeat);
		heartbeat = null;
		heartbeatOn = false;
		pingSentAt = null;
	};
	const armHeartbeat = (delay) => {
		if (heartbeat !== null) timers.clearTimeout(heartbeat);
		heartbeatArmedAt = timers.now();
		heartbeatDelay = delay;
		heartbeat = timers.setTimeout(heartbeatTick, delay);
	};
	const startHeartbeat = (heartbeatMs) => {
		stopHeartbeat();
		// Hubs that do not advertise a heartbeat get no app-level pings at all.
		if (typeof heartbeatMs !== "number" || !(heartbeatMs > 0)) return;
		heartbeatOn = true;
		armHeartbeat(LIVE_PING_INTERVAL_MS);
	};
	function heartbeatTick() {
		heartbeat = null;
		if (stopped || !heartbeatOn || !socket) return;
		const now = timers.now();
		// Decide on elapsed time, never on which timer ran first: a stalled main
		// thread releases every overdue timer at once, ahead of the pong already
		// sitting in the socket's queue.
		if (now - heartbeatArmedAt > heartbeatDelay + LIVE_HEARTBEAT_SLACK_MS) {
			pingSentAt = null;
			armHeartbeat(LIVE_PING_INTERVAL_MS);
			return;
		}
		if (pingSentAt === null) {
			send({ type: "ping" });
			pingSentAt = now;
			armHeartbeat(LIVE_PONG_TIMEOUT_MS);
			return;
		}
		const waited = now - pingSentAt;
		if (waited >= LIVE_PONG_TIMEOUT_MS) {
			dropSocket();
			return;
		}
		armHeartbeat(LIVE_PONG_TIMEOUT_MS - waited);
	}
	// Give up on a socket this client no longer trusts and retry from scratch.
	const dropSocket = () => {
		const current = socket;
		socket = null;
		stopHeartbeat();
		try {
			current?.close();
		} catch {
			// An already-dead socket needs no closing.
		}
		scheduleReconnect();
	};
	const send = (frame) => {
		if (!socket || socket.readyState !== (socket.OPEN ?? 1)) return;
		try {
			socket.send(JSON.stringify(frame));
		} catch {
			// A close between readyState and send is indistinguishable from an
			// absent server to the editor, so leave it silent and retry on close.
		}
	};
	const connect = () => {
		if (stopped || !WebSocketImpl) return;
		clearRetry();
		stopHeartbeat();
		try {
			socket = new WebSocketImpl(url);
		} catch {
			socket = null;
			scheduleReconnect();
			return;
		}
		const connected = socket;
		connected.onopen = () => {
			if (socket !== connected || stopped) return;
			send({
				type: "hello",
				role: "editor",
				version: 1,
				...(currentWorkspaceId ? { workspaceId: currentWorkspaceId } : {}),
				// Identify the workspace to live_status: bare UUIDs alone left an
				// agent unable to tell two editor tabs apart.
				...(meta ? { meta } : {}),
			});
		};
		connected.onmessage = async (event) => {
			if (socket !== connected || stopped) return;
			if (typeof event?.data === "string") {
				try {
					const frame = JSON.parse(event.data);
					if (frame?.type === "workspace" && typeof frame.handle === "string") {
						// A completed handshake is the only proof the hub is healthy.
						attempt = 0;
						startHeartbeat(frame.heartbeatMs);
						onWorkspace(frame.handle);
						return;
					}
					if (frame?.type === "pong") {
						if (heartbeatOn) {
							pingSentAt = null;
							armHeartbeat(LIVE_PING_INTERVAL_MS);
						}
						return;
					}
					if (frame?.type === "event" && typeof frame.name === "string" && frame.payload && typeof frame.payload === "object") {
						if (frame.name === "motion_telemetry" || frame.name === "telemetry") {
							receiveTelemetry(frame.payload);
							return;
						}
						onEvent(frame.name, frame.payload);
						return;
					}
				} catch {
					// dispatchLiveFrame owns malformed command handling.
				}
			}
			const response = await dispatchLiveFrame(event?.data, currentHandlers);
			if (response) send(response);
		};
		// Suppress browser error reporting for an optional local endpoint.
		connected.onerror = () => {};
		connected.onclose = (event) => {
			if (socket === connected) {
				socket = null;
				stopHeartbeat();
			}
			if (isDuplicateWorkspaceClose(event)) {
				// Not a failing hub: this tab is the duplicate. Retry from the top of
				// the schedule under the identity the hook just stored.
				attempt = 0;
				try {
					const minted = onDuplicate();
					if (typeof minted === "string" && minted) currentWorkspaceId = minted;
				} catch {
					// Keeping the old id only repeats the refusal; it never shows an error.
				}
			}
			scheduleReconnect();
		};
	};

	const unsubscribeWake = subscribeWake(wake) ?? (() => {});
	connect();
	return {
		setHandlers(nextHandlers) {
			currentHandlers = nextHandlers && typeof nextHandlers === "object" ? nextHandlers : {};
		},
		// Opening another project renames the tab; the next hello carries the new
		// label and an open socket tells the hub now, so status stays truthful.
		setMeta(nextMeta) {
			meta = nextMeta && typeof nextMeta === "object" ? nextMeta : null;
			if (meta) send({ type: "meta", meta });
		},
		close() {
			stopped = true;
			clearRetry();
			stopHeartbeat();
			try {
				unsubscribeWake();
			} catch {
				// Optional transport cleanup must not affect the editor.
			}
			const current = socket;
			socket = null;
			try {
				current?.close();
			} catch {
				// Optional transport cleanup must not affect the editor.
			}
		},
	};
}
