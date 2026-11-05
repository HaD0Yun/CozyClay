import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { bucketMs, sanitizeProps } from "../src/analytics.js";
import { mcpToolCategory, mcpToolName } from "../src/execution-telemetry.js";

import { WebSocket, WebSocketServer } from "ws";

export const DEFAULT_COMMAND_TIMEOUT_MS = 5_000;
/** A per-call override may extend a non-motion command, never past this ceiling. */
export const MAX_COMMAND_TIMEOUT_MS = 300_000;
export const DEFAULT_HEARTBEAT_MS = 15_000;
export const RUN_WORKFLOW_TIMEOUT_MS = 180_000;

export const IMPORT_ASSET_TIMEOUT_MS = 30_000;
export const CAPTURE_FRAME_TIMEOUT_MS = 30_000;
export const STUDIO_COMMAND_TIMEOUT_MS = 30_000;
const studioCommands = new Set([
	"inspect_studio", "operate_studio", "arrange_objects", "arrange_characters", "patch_elements",
	"frame_shot", "verify_result", "undo_edit", "read_studio_context", "resolve_studio_image",
	"capture_framing_png", "capture_plan_png", "reconcile_studio_command", "run_action",
]);

const mutationCommands = new Set([
	"set_camera",
	"add_character",
	"update_character",
	"remove_character",
	"place_object",
	"update_object",
	"remove_object",
	"group_objects",
	"ungroup_objects",
		"apply_batch",
	"load_scenes",
	"operate_studio", "arrange_objects", "arrange_characters", "patch_elements", "frame_shot", "undo_edit", "run_action",
	"import_asset",
]);

export class LiveMutationUncertainError extends Error {
	code = "UNCERTAIN_APPLY";
}

/** Every hub failure carries a stable `.code`, so a caller branches on the code
 * and never on the wording of the human message. */
const hubError = (code, message, details) => Object.assign(new Error(message), details === undefined ? { code } : { code, details });

const RECOVERY = {
	UNCERTAIN_APPLY: "Do not retry the mutation; describe the scene first and choose a recovery action from what it reports.",
	AMBIGUOUS_WORKSPACE: "Repeat the command with one of the listed workspace handles.",
	STALE_HANDLE: "Read live status and use a workspace handle that is connected now.",
	NO_EDITOR: "Open the studio in a browser so an editor connects to this hub.",
	TIMEOUT: "The editor never answered; read the scene back before retrying.",
};

/** Error -> the `{code, message, recovery?}` body a controller reply carries. */
export const liveErrorBody = (error) => {
	const code = typeof error?.code === "string" ? error.code : "EDITOR_ERROR";
	return {
		code,
		message: error instanceof Error ? error.message : String(error),
		...(RECOVERY[code] ? { recovery: RECOVERY[code] } : {}),
		...(error?.details === undefined ? {} : { details: error.details }),
	};
};

// Only the MCP registration wrapper opts in. Agent commands and motion's own
// lifecycle continue through their existing hooks, without parallel events.
const executionObserver = new AsyncLocalStorage();
const safely = (work) => {
	try { return work(); } catch { return undefined; }
};
const mutationState = (name, description) => {
	if (!description || typeof description !== "object") return undefined;
	if (name === "set_camera") return description.camera;
	if (["add_character", "update_character", "remove_character"].includes(name)) return description.characters;
	if (name === "load_scenes") return description.document;
	return description.objects;
};

/**
 * Transport-only implementation of LIVE-PROTOCOL.md. Scene semantics remain
 * with the editor and the server's existing CozyClay imports.
 */
export class LiveHub {
	constructor(server = null, { token = null, owner = null, port = null, heartbeatMs = DEFAULT_HEARTBEAT_MS } = {}) {
		this.server = server;
		this.editors = new Map();
		this.pending = new Map();
		this.workspaceIds = new Map();
		this.workspaceMeta = new Map();
		this.workspaceQueues = new Map();
		this.onWorkspaceConnected = null;
		this.onEvent = null;
		// Terminal controllers: no scene of their own, and the hub token instead
		// of a browser origin as their admission proof.
		this.controllers = new Set();
		/** socket -> liveness and role bookkeeping for every accepted connection. */
		this.sockets = new Map();
		this.token = token;
		this.owner = owner;
		this.port = port;
		this.heartbeatMs = heartbeatMs;
		this.heartbeatTimer = null;
		/** Installed by the owner that also owns the tool registry. */
		this.serveTool = null;
	}

	get connected() {
		return this.editors.size > 0;
	}

	get workspaceHandles() {
		return [...this.editors.keys()];
	}

	/** handle → the editor's self-label ({ project, scene, cast }), when given. */
	workspaceHandleDetails() {
		return [...this.editors.keys()].map((handle) => ({ handle, meta: this.workspaceMeta.get(handle) ?? null }));
	}

	resolveWorkspace(name, workspaceHandle) {
		if (workspaceHandle !== undefined) {
			const socket = this.editors.get(workspaceHandle);
			if (socket?.readyState === WebSocket.OPEN) return workspaceHandle;
			throw hubError("STALE_HANDLE", `Unknown or stale live workspace handle "${workspaceHandle}".`);
		}
		const handles = this.workspaceHandles;
		if (handles.length === 0) throw hubError("NO_EDITOR", "No live editor is connected.");
		if (handles.length === 1) return handles[0];
		throw hubError(
			"AMBIGUOUS_WORKSPACE",
			`Live command ${name} requires workspace_handle; connected workspaces: ${handles.join(", ")}.`,
			{ candidates: handles },
		);
	}

	static commandTimeoutMs(name) {
		
		// A 32 MiB mesh as a data URL will not decode, store and stand in 5 s.
		if (name === "import_asset") return IMPORT_ASSET_TIMEOUT_MS;
		// Close two-person shots (OTS) raycast two skinned rigs over a full-frame
		// AABB; 5 s is not enough. The PNG itself is cheap; the rays are not.
		if (name === "capture_frame") return CAPTURE_FRAME_TIMEOUT_MS;
		// A workflow run captures a frame and may generate an image upstream.
		if (name === "run_workflow") return RUN_WORKFLOW_TIMEOUT_MS;
		if (studioCommands.has(name)) return STUDIO_COMMAND_TIMEOUT_MS;
		return DEFAULT_COMMAND_TIMEOUT_MS;
	}

	static commandMayMutate(name) {
		return mutationCommands.has(name);
	}

	workspaceId(workspaceHandle) {
		const workspaceId = this.workspaceIds.get(workspaceHandle);
		if (!workspaceId) throw hubError("STALE_HANDLE", `Unknown or stale live workspace handle "${workspaceHandle}".`);
		return workspaceId;
	}

	// Resolve the current command handle from the job's stable workspace id.
	// Motion jobs outlive socket handles across editor reconnects.
	handleForWorkspaceId(workspaceId) {
		for (const [handle, id] of this.workspaceIds) {
			if (id !== workspaceId) continue;
			const socket = this.editors.get(handle);
			if (socket && socket.readyState === WebSocket.OPEN) return handle;
		}
		return null;
	}

	runExclusive(name, workspaceHandle, work) {
		const handle = this.resolveWorkspace(name, workspaceHandle);
		// The MCP server mirrors one selected editor into one in-process scene
		// document while a tool runs. Serialize across workspaces so another
		// editor cannot replace that mirror between refresh and mutation.
		const queueKey = "__global_live_state__";
		const previous = this.workspaceQueues.get(queueKey) ?? Promise.resolve();
		const current = previous.catch(() => {}).then(() => work(handle));
		this.workspaceQueues.set(queueKey, current);
		return current.finally(() => {
			if (this.workspaceQueues.get(queueKey) === current) this.workspaceQueues.delete(queueKey);
		});
	}

	/** Observe one already-targeted MCP execution. IDs and state evidence are
	 * ephemeral; only enums, buckets and the fresh ID reach the editor relay. */
	async observeExecution(name, handle, work, { randomId = () => randomBytes(16).toString("hex"), now = () => performance.now() } = {}) {
		const socket = this.editors.get(handle);
		if (socket?.readyState !== WebSocket.OPEN) return work();
		const requestId = safely(randomId);
		const startedAt = safely(now);
		if (typeof requestId !== "string" || !/^[a-f0-9]{32}$/.test(requestId) || !Number.isFinite(startedAt)) return work();
		const workspaceId = this.workspaceId(handle);
		const category = mcpToolCategory(name), toolName = mcpToolName(name);
		const emit = (event, props) => safely(() => {
			// Do not reconstruct this lifecycle on a replacement connection.
			if (this.editors.get(handle) !== socket || socket.readyState !== WebSocket.OPEN) return;
			Promise.resolve(this.sendEvent(workspaceId, "telemetry", { event, props: sanitizeProps(event, props) })).catch(() => {});
		});
		let terminal = false;
		let applied = false;
		let appliedEmitted = false;
		let failure = null;
		let description;
		let studioContext;
		let mutation;
		let acknowledgedMutation = false;
		const emitApplied = () => {
			if (!applied || !terminal || appliedEmitted) return;
			appliedEmitted = true;
			emit("mcp:result_applied", { request_id: requestId });
		};
		const observer = {
			hub: this, handle,
			before(command) {
				if (!LiveHub.commandMayMutate(command) || command === "run_action") return false;
				mutation = { name: command, before: mutationState(command, description), acknowledged: false };
				description = undefined;
				return mutation.before === undefined;
			},
			baseline(value) { if (mutation) mutation.before = mutationState(mutation.name, value); },
			receipt(command, value) {
				if (command === "inspect_studio") {
					studioContext = value?.context ?? (value?.host && value?.revision ? { host: value.host, revision: value.revision } : undefined);
				} else if (command === "run_action") {
					// The bus attests application itself. No legacy describe diff or
					// post-ack read may turn an admitted refusal into uncertainty.
					if (value?.ok === false) {
						failure = value.mutated === "unknown" || value.code === "UNCERTAIN_APPLY" ? "uncertain" : "failed";
					} else if (value?.ok === true) {
						acknowledgedMutation = true;
						// A journal replay has already reached its after revision; it
						// does not count as another application on this invocation.
						if (studioContext && ((value.authored && value.revision.after > studioContext.revision.scene) ||
							(value.nextHost && ["workspaceId", "documentEpoch", "sceneId", "sceneEpoch"].some(key => value.nextHost[key] !== studioContext.host[key])))) applied = true;
						if (value.output?.rolledBack === true || value.output?.failed?.length > 0) failure = "failed";
					}
					studioContext = undefined;
				} else if (command === "describe") {
					if (mutation?.acknowledged && !mutation.rolledBack) {
						const after = mutationState(mutation.name, value);
						if (mutation.before !== undefined && after !== undefined && !isDeepStrictEqual(mutation.before, after)) applied = true;
					}
					description = value;
					mutation = null;
				} else if (LiveHub.commandMayMutate(command)) {
					acknowledgedMutation = true;
					if (mutation) mutation.acknowledged = true;
					if (command === "apply_batch") {
						if (mutation) mutation.rolledBack = value?.rolledBack === true;
						if (value?.rolledBack === true || value?.failed?.length > 0) failure = "failed";
					}
					
				}
				emitApplied();
			},
			error(command, error) {
				if (error instanceof LiveMutationUncertainError || (command === "describe" && mutation?.acknowledged)) failure = "uncertain";
				else if (failure !== "uncertain") failure = error?.name === "AbortError" || error?.code === "ABORT_ERR" ? "cancelled" : "failed";
			},
		};
		const finish = (value, error) => safely(() => {
			if (terminal) return;
			if (error) observer.error(null, error);
			if (value?.isError === true && !failure) failure = acknowledgedMutation ? "uncertain" : "failed";
			terminal = true;
			const endedAt = safely(now);
			if (Number.isFinite(endedAt)) emit("mcp:tool_executed", { request_id: requestId, tool_category: category, tool_name: toolName, outcome: failure ?? "succeeded", duration_bucket: bucketMs(endedAt - startedAt) });
			emitApplied();
			// Never retain scene data with an asynchronous motion job.
			description = undefined;
			studioContext = undefined;
			mutation = null;
		});
		emit("mcp:tool_requested", { request_id: requestId, tool_category: category, tool_name: toolName });
		return executionObserver.run(observer, async () => {
			try {
				const value = await work();
				finish(value);
				return value;
			} catch (error) {
				finish(null, error);
				throw error;
			}
		});
	}

	sendEvent(workspaceId, name, payload) {
		let delivered = 0;
		for (const [handle, socket] of this.editors) {
			if (this.workspaceIds.get(handle) !== workspaceId || socket.readyState !== WebSocket.OPEN) continue;
			socket.send(JSON.stringify({ type: "event", name, payload }));
			delivered += 1;
		}
		return delivered;
	}

	async command(name, args, workspaceHandle, { timeoutMs } = {}) {
		const handle = this.resolveWorkspace(name, workspaceHandle);
		const current = executionObserver.getStore();
		const observer = current?.hub === this && current.handle === handle ? current : null;
		if (observer && safely(() => observer.before(name))) {
			// Existing acknowledgements do not distinguish same-value updates.
			// Only when the handler has not already described the scene, take one
			// best-effort read before mutation. It never controls tool execution.
			try {
				const baseline = await this.sendCommand("describe", {}, handle);
				safely(() => observer.baseline(baseline));
			} catch { /* Missing evidence omits application, not the real command. */ }
		}
		try {
			const value = await this.sendCommand(name, args, handle, { timeoutMs });
			safely(() => observer?.receipt(name, value));
			return value;
		} catch (error) {
			safely(() => observer?.error(name, error));
			throw error;
		}
	}

	async sendCommand(name, args, handle, { timeoutMs } = {}) {
		const socket = this.editors.get(handle);
		if (!socket || socket.readyState !== WebSocket.OPEN) throw hubError("STALE_HANDLE", `Unknown or stale live workspace handle "${handle}".`);

		const id = randomUUID();
		// The caller's per-call deadline (a controller frame's timeoutMs, or a
		// command's declared one), capped at the ceiling; else the name's default.
		const bound = Number.isFinite(timeoutMs) && timeoutMs > 0
			? Math.min(timeoutMs, MAX_COMMAND_TIMEOUT_MS)
			: LiveHub.commandTimeoutMs(name);
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				const message = `Live editor timed out running ${name}.`;
				const error = LiveHub.commandMayMutate(name)
					? new LiveMutationUncertainError(`${message} The mutation may have been applied. Do not retry it; describe the scene before choosing a recovery action.`)
					: hubError("TIMEOUT", message);
				reject(error);
			}, bound);
			// Each waiting frame keeps the deadline it runs under.
			this.pending.set(id, { name, socket, resolve, reject, timer, timeoutMs: bound });
			try {
				socket.send(JSON.stringify({ type: "cmd", id, name, args }));
			} catch (error) {
				clearTimeout(timer);
				this.pending.delete(id);
				reject(hubError("EDITOR_ERROR", `Could not send ${name} to the live editor: ${error.message}`));
			}
		});
	}

	accept(socket, request = null) {
		const origin = request?.headers?.origin;
		if (typeof origin === "string") {
			let allowed = false;
			try {
				const parsed = new URL(origin);
				allowed = parsed.protocol === "http:" && (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost");
			} catch {
				allowed = false;
			}
			if (!allowed) {
				socket.close(1008, "Live editor origin must be loopback");
				return;
			}
		}
		const now = Date.now();
		this.sockets.set(socket, { role: null, connectedAt: now, lastSeenAt: now, awaitingPong: false });
		socket.on("pong", () => this.markAlive(socket));
		socket.on("ping", () => this.markAlive(socket));
		let role = null;
		socket.on("message", (message, isBinary) => {
			this.markAlive(socket);
			if (isBinary) return;
			let frame;
			try {
				frame = JSON.parse(message.toString());
			} catch {
				return;
			}
			if (role === null) {
				if (frame?.type !== "hello" || frame.version !== 1 || (frame.role !== "editor" && frame.role !== "controller")) {
					socket.close(1002, "Expected an editor or controller hello version 1");
					return;
				}
				if (frame.role === "controller") {
					// A controller drives the whole hub, so it proves it is a local
					// process holding the endpoint token. A browser page can hold a
					// loopback origin but never that file, so an Origin header at all
					// disqualifies the connection.
					if (typeof origin === "string") {
						socket.close(1008, "Live controller must not be a browser connection");
						return;
					}
					if (typeof this.token !== "string" || !this.token || frame.token !== this.token) {
						socket.close(1008, "Live controller token is required");
						return;
					}
					role = "controller";
					const state = this.sockets.get(socket);
					if (state) state.role = role;
					this.controllers.add(socket);
					socket.send(JSON.stringify({ type: "ready", role, heartbeatMs: this.heartbeatMs, server: this.status().server }));
					return;
				}
				role = "editor";
				// A hello that names its workspace gets that id as its handle, so the
				// same tab resumes the same handle after any reconnect. Only a hello
				// without one still gets a random per-socket handle.
				const workspaceId = typeof frame.workspaceId === "string" && frame.workspaceId ? frame.workspaceId : randomUUID();
				const workspaceHandle = workspaceId;
				if ([...this.workspaceIds.values()].includes(workspaceId)) {
					socket.close(1008, "Workspace id is already connected");
					return;
				}
				const state = this.sockets.get(socket);
				if (state) state.role = role;
				this.editors.set(workspaceHandle, socket);
				this.workspaceIds.set(workspaceHandle, workspaceId);
				// The editor can label itself so live_status can tell tabs apart.
				const meta = frame.meta && typeof frame.meta === "object" ? frame.meta : null;
				this.workspaceMeta.set(workspaceHandle, meta);
				socket.send(JSON.stringify({ type: "workspace", handle: workspaceHandle, heartbeatMs: this.heartbeatMs }));
				this.broadcastControllerEvent("editor_connected", { handle: workspaceHandle, workspaceId, meta });
				this.onWorkspaceConnected?.({ workspaceHandle, workspaceId });
				return;
			}
			// An editor watching for a dead hub can ask at the application level;
			// the transport pong alone never reaches its page.
			if (frame?.type === "ping") {
				socket.send(JSON.stringify({ type: "pong" }));
				return;
			}
			if (role === "controller") {
				void this.serveController(socket, frame);
				return;
			}
			// Meta and event frames both act for this socket's workspace. A meta frame
			// relabels the tab after it opens another project; the handle stays.
			const workspaceHandle = [...this.editors.entries()].find(([, editor]) => editor === socket)?.[0];
			if (frame?.type === "meta" && workspaceHandle && frame.meta && typeof frame.meta === "object") this.workspaceMeta.set(workspaceHandle, frame.meta);
			else if (frame?.type === "event" && typeof frame.name === "string" && frame.payload && typeof frame.payload === "object") {
				if (workspaceHandle) this.onEvent?.({ workspaceHandle, workspaceId: this.workspaceId(workspaceHandle), name: frame.name, payload: frame.payload });
			}
			if (frame?.type !== "result" || typeof frame.id !== "string") return;
			const pending = this.pending.get(frame.id);
			if (!pending || pending.socket !== socket) return;
			clearTimeout(pending.timer);
			this.pending.delete(frame.id);
			if (frame.ok === true) {
				pending.resolve(frame.value);
			} else {
				pending.reject(hubError(typeof frame.error?.code === "string" ? frame.error.code : "EDITOR_ERROR", typeof frame.error === "string" ? frame.error : frame.error?.message ?? "Live editor rejected the command."));
			}
		});
		socket.on("close", () => this.disconnect(socket));
		socket.on("error", () => this.disconnect(socket));
	}

	disconnect(socket) {
		this.sockets.delete(socket);
		this.controllers.delete(socket);
		for (const [handle, editor] of this.editors) {
			if (editor === socket) {
				const workspaceId = this.workspaceIds.get(handle) ?? null;
				const meta = this.workspaceMeta.get(handle) ?? null;
				this.editors.delete(handle);
				this.workspaceIds.delete(handle);
				this.workspaceMeta.delete(handle);
				this.broadcastControllerEvent("editor_disconnected", { handle, workspaceId, meta });
			}
		}
		for (const [id, pending] of this.pending) {
			if (pending.socket !== socket) continue;
			clearTimeout(pending.timer);
			this.pending.delete(id);
			const message = "Live editor disconnected while a command was running.";
			const error = LiveHub.commandMayMutate(pending.name)
				? new LiveMutationUncertainError(`${message} The mutation may have been applied. Do not retry it; describe the scene before choosing a recovery action.`)
				: hubError("NO_EDITOR", message);
			pending.reject(error);
		}
	}

	/** Any frame or pong proves the peer is still there. */
	markAlive(socket) {
		const state = this.sockets.get(socket);
		if (!state) return;
		state.lastSeenAt = Date.now();
		state.awaitingPong = false;
	}

	/** One timer for every socket: a peer that missed the previous tick's ping
	 * is dropped through the ordinary disconnect path, so an in-flight mutation
	 * rejects as uncertain instead of hanging until its own timeout. */
	startHeartbeat(heartbeatMs = this.heartbeatMs) {
		this.stopHeartbeat();
		if (!Number.isFinite(heartbeatMs) || heartbeatMs <= 0) return;
		this.heartbeatMs = heartbeatMs;
		this.heartbeatTimer = setInterval(() => this.sweepHeartbeat(), heartbeatMs);
		this.heartbeatTimer.unref?.();
	}

	stopHeartbeat() {
		if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
		this.heartbeatTimer = null;
	}

	sweepHeartbeat() {
		for (const [socket, state] of [...this.sockets]) {
			if (state.awaitingPong) {
				safely(() => socket.terminate?.());
				this.disconnect(socket);
				continue;
			}
			state.awaitingPong = true;
			try {
				socket.ping();
			} catch {
				safely(() => socket.terminate?.());
				this.disconnect(socket);
			}
		}
	}

	broadcastControllerEvent(name, payload) {
		for (const socket of this.controllers) {
			if (socket.readyState !== WebSocket.OPEN) continue;
			safely(() => socket.send(JSON.stringify({ type: "event", name, payload })));
		}
	}

	/** What a controller needs to pick a workspace without guessing: who owns
	 * the hub, and how long ago each editor was last heard from. */
	status() {
		const now = Date.now();
		return {
			server: { port: this.port, owner: this.owner, pid: process.pid },
			editors: [...this.editors].map(([handle, socket]) => {
				const state = this.sockets.get(socket);
				return {
					handle,
					workspaceId: this.workspaceIds.get(handle) ?? null,
					meta: this.workspaceMeta.get(handle) ?? null,
					connectedAt: state?.connectedAt ?? null,
					lastSeenMs: state ? now - state.lastSeenAt : null,
					inFlight: [...this.pending.values()].filter((entry) => entry.socket === socket).length,
				};
			}),
		};
	}

	/** Controller frames reuse the routing the MCP surface already has; nothing
	 * here decides which editor a command reaches. */
	async serveController(socket, frame) {
		const id = typeof frame?.id === "string" ? frame.id : null;
		if (!id) return;
		const reply = (body) => safely(() => socket.send(JSON.stringify(body)));
		try {
			let value;
			if (frame.type === "cmd" || frame.type === "tool") {
				if (typeof frame.name !== "string" || !frame.name) throw hubError("EDITOR_ERROR", `A controller ${frame.type} frame must name what to run.`);
				if (frame.type === "cmd") {
					value = await this.command(frame.name, frame.args ?? {}, frame.workspaceHandle, { timeoutMs: frame.timeoutMs });
				} else {
					if (typeof this.serveTool !== "function") throw hubError("CAPABILITY_MISSING", "This live hub owner does not serve registry tools.");
					value = await this.serveTool(frame.name, frame.args ?? {}, frame.workspaceHandle);
				}
			} else if (frame.type === "status") {
				value = this.status();
			} else {
				throw hubError("UNKNOWN_FRAME", `Unsupported controller frame "${frame.type}".`);
			}
			reply({ type: "result", id, ok: true, value });
		} catch (error) {
			reply({ type: "result", id, ok: false, error: liveErrorBody(error) });
		}
	}
}

/** Bind only to loopback. A taken port is an intentional memory-only mode. */
export async function startLiveHub(port, { token = null, owner = null, heartbeatMs = DEFAULT_HEARTBEAT_MS } = {}) {
	let server;
	try {
		server = new WebSocketServer({ host: "127.0.0.1", port, path: "/live" });
		await new Promise((resolve, reject) => {
			server.once("listening", resolve);
			server.once("error", reject);
		});
	} catch (error) {
		if (server) server.close();
		if (error?.code === "EADDRINUSE") return null;
		throw error;
	}
	const address = server.address();
	const hub = new LiveHub(server, { token, owner, port: typeof address === "object" && address ? address.port : port, heartbeatMs });
	server.on("connection", (socket, request) => hub.accept(socket, request));
	server.on("close", () => hub.stopHeartbeat());
	hub.startHeartbeat();
	return hub;
}
