/**
 * The terminal half of the live hub (mcp/LIVE-PROTOCOL.md, "Controller role").
 *
 * Discovery is the endpoint file the hub owner publishes; admission is the
 * token inside that mode-0600 file, which only a local process can read. The
 * transport is the global WebSocket Node ships from 22.13, so `cclay live`
 * adds no transport dependency. Project saves load scene-model dependencies
 * from the existing staged MCP runtime in installed packages.
 */
import { randomUUID } from "node:crypto";

import { readLiveEndpoint } from "../live-endpoint.mjs";

const DEFAULT_LIVE_PORT = 5184;
/** The hub caps one command at 300 s; give up a little past that, so a hub
 * that answers nothing at all can never hang a terminal forever. */
const REQUEST_CEILING_MS = 330_000;

/** Every failure this CLI reports carries a stable code; the exit-code table in
 * cli.mjs branches on the code and never on the wording of the message. */
export class LiveCliError extends Error {
	constructor(code, message, { recovery, details } = {}) {
		super(message);
		this.name = "LiveCliError";
		this.code = code;
		if (recovery !== undefined) this.recovery = recovery;
		if (details !== undefined) this.details = details;
	}
}

/** A published endpoint whose owner is gone is the same thing as no hub. */
function processAlive(pid) {
	if (!Number.isInteger(pid)) return true;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// EPERM means the process exists but belongs to somebody else.
		return error?.code === "EPERM";
	}
}

export function resolveLivePort(explicit) {
	if (explicit !== undefined) return explicit;
	const fromEnvironment = Number(process.env.COZYCLAY_LIVE_PORT);
	return Number.isInteger(fromEnvironment) && fromEnvironment > 0 ? fromEnvironment : DEFAULT_LIVE_PORT;
}

export function discoverEndpoint(port) {
	const record = readLiveEndpoint(port);
	if (record && !processAlive(record.pid)) {
		throw new LiveCliError("NO_SERVER", `The live hub that published port ${port} is gone (pid ${record.pid} is not running).`);
	}
	const token = process.env.COZYCLAY_LIVE_TOKEN || record?.token || null;
	if (!token) throw new LiveCliError("NO_SERVER", `No live hub is published on port ${port}.`);
	return { port, token, owner: record?.owner ?? null, pid: record?.pid ?? null };
}

/**
 * One controller socket: request/response by frame id, plus the buffered
 * lifecycle events `--wait` blocks on.
 */
export async function connectController({ port, token }) {
	const url = `ws://127.0.0.1:${port}/live`;
	const socket = new WebSocket(url);
	const pending = new Map();
	const waiters = new Set();
	const events = [];
	let closedError = null;

	const abandon = (error) => {
		closedError = error;
		for (const entry of [...pending.values()]) entry.reject(error);
		pending.clear();
		for (const waiter of [...waiters]) waiter.reject(error);
		waiters.clear();
	};

	let announceReady;
	let refuseReady;
	const ready = new Promise((resolve, reject) => {
		announceReady = resolve;
		refuseReady = reject;
	});
	// A rejection that lands before the await below is still delivered by the
	// await; this handler only keeps it from being reported as unhandled.
	ready.catch(() => {});

	socket.addEventListener("message", (event) => {
		let frame;
		try {
			frame = JSON.parse(String(event.data));
		} catch {
			return;
		}
		if (frame?.type === "ready") {
			announceReady(frame);
			return;
		}
		if (frame?.type === "result" && typeof frame.id === "string") {
			const entry = pending.get(frame.id);
			if (!entry) return;
			pending.delete(frame.id);
			entry.resolve(frame);
			return;
		}
		if (frame?.type !== "event" || typeof frame.name !== "string") return;
		events.push(frame);
		for (const waiter of [...waiters]) {
			if (waiter.name !== frame.name) continue;
			waiters.delete(waiter);
			waiter.resolve(frame);
		}
	});
	socket.addEventListener("error", () => {
		const error = new LiveCliError("NO_SERVER", `Nothing answered a live controller on ${url}.`);
		refuseReady(error);
		abandon(error);
	});
	socket.addEventListener("close", (event) => {
		const reason = typeof event?.reason === "string" && event.reason ? `: ${event.reason}` : ".";
		const error = event?.code === 1008
			? new LiveCliError("NO_SERVER", `The live hub refused this controller${reason}`)
			: new LiveCliError("NO_SERVER", `The live hub closed the connection${reason}`);
		refuseReady(error);
		abandon(error);
	});

	const opened = new Promise((resolve, reject) => {
		socket.addEventListener("open", () => resolve(), { once: true });
		ready.catch(reject);
	});
	opened.catch(() => {});
	await opened;
	socket.send(JSON.stringify({ type: "hello", role: "controller", version: 1, token }));
	const readyFrame = await ready;

	const request = (frame, { timeoutMs } = {}) => new Promise((resolve, reject) => {
		if (closedError) {
			reject(closedError);
			return;
		}
		const id = randomUUID();
		const bound = Number.isFinite(timeoutMs) && timeoutMs > 0
			? Math.min(timeoutMs + 10_000, REQUEST_CEILING_MS)
			: REQUEST_CEILING_MS;
		const timer = setTimeout(() => {
			pending.delete(id);
			reject(new LiveCliError("TIMEOUT", `The live hub did not answer ${frame.name ?? frame.type} within ${bound} ms.`));
		}, bound);
		pending.set(id, {
			resolve: (value) => {
				clearTimeout(timer);
				resolve(value);
			},
			reject: (error) => {
				clearTimeout(timer);
				reject(error);
			},
		});
		try {
			socket.send(JSON.stringify({ ...frame, id }));
		} catch (error) {
			clearTimeout(timer);
			pending.delete(id);
			reject(new LiveCliError("NO_SERVER", `Could not send ${frame.type} to the live hub: ${error.message}`));
		}
	});

	/** Events are buffered, so a caller marks its place BEFORE the read that
	 * might race the event and never misses one that arrived in between. */
	const nextEvent = (name, { since = 0, timeoutMs } = {}) => new Promise((resolve, reject) => {
		const seen = events.slice(since).find((frame) => frame.name === name);
		if (seen) {
			resolve(seen);
			return;
		}
		if (closedError) {
			reject(closedError);
			return;
		}
		let timer = null;
		const waiter = {
			name,
			resolve: (frame) => {
				if (timer) clearTimeout(timer);
				resolve(frame);
			},
			reject: (error) => {
				if (timer) clearTimeout(timer);
				reject(error);
			},
		};
		if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
			timer = setTimeout(() => {
				waiters.delete(waiter);
				reject(new LiveCliError("TIMEOUT", `No ${name} event arrived within ${timeoutMs} ms.`));
			}, timeoutMs);
		}
		waiters.add(waiter);
	});

	return {
		server: readyFrame.server ?? { port, owner: null, pid: null },
		request,
		nextEvent,
		eventCount: () => events.length,
		close: () => {
			try {
				socket.close();
			} catch {
				/* a socket that is already gone needs no closing */
			}
		},
	};
}
