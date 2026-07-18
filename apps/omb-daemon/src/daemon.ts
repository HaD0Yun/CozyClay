import { randomUUID } from "node:crypto";
import http from "node:http";
import {
	MUTATION_PROTOCOL_VERSION,
	MutationBridgeSession,
	negotiateMutationBridge,
	parseAddonBridgeMessage,
	parseClientMessage,
	parseDaemonBridgeMessage,
	parseHello,
	parseStartupRecord,
	PROTOCOL_VERSION,
	type CameraPlanV1,
	type CameraPlanMutationCandidate,
	type Request,
} from "@oh-my-blender/protocol";
import { SessionState, type ActiveRequest } from "./session-state.ts";
import { BearerToken, randomNonce, systemClock, type Clock } from "./token.ts";
import { acceptUpgrade, type WebSocketConnection } from "./ws-server.ts";

export type HandlerResult = { result: unknown; resulting_revision_id: string };
export interface ApplyCameraPlanProgress {
	readonly phase: string;
	readonly completed: number;
	readonly total: number;
}
export type ApplyCameraPlan = (
	plan: CameraPlanV1,
	context: {
		readonly signal: AbortSignal | undefined;
		readonly reportProgress: (progress: ApplyCameraPlanProgress) => void;
	},
) => Promise<CameraPlanMutationCandidate>;
export interface HandlerContext {
	readonly signal: AbortSignal;
	readonly request: Request;
	readonly reportProgress: (phase: string, completed: number, total: number) => void;
	readonly applyCameraPlan: ApplyCameraPlan;
	readonly beginDurableCommit: () => void;
}
export type Handler = (params: Record<string, unknown>, context: HandlerContext) => Promise<HandlerResult>;
export type DaemonOptions = {
	port: number;
	clock?: Clock;
	handlers: Record<string, Handler>;
	stdout?: (line: string) => void;
	stderr?: (line: string) => void;
	helloTimeoutMs?: number;
	idleTimeoutMs?: number;
};
export type Daemon = {
	port: number;
	startup: ReturnType<typeof parseStartupRecord>;
	stopped: Promise<void>;
	close(): Promise<void>;
};

type PendingBridge = {
	readonly id: string;
	readonly requestId: string;
	readonly reportProgress: (progress: ApplyCameraPlanProgress) => void;
	readonly resolve: (result: CameraPlanMutationCandidate) => void;
	readonly reject: (error: Error) => void;
	removeAbortListener(): void;
};

export async function start(options: DaemonOptions): Promise<Daemon> {
	const clock = options.clock ?? systemClock;
	const token = new BearerToken(clock);
	const launchId = randomUUID();
	const nonces = new Set<string>();
	const seenRequestIds = new Set<string>();
	let accepted = false;
	let connection: WebSocketConnection | undefined;
	let draining = false;
	let idle: ReturnType<typeof setTimeout> | undefined;
	let resolveStopped!: () => void;
	const stopped = new Promise<void>((resolve) => {
		resolveStopped = resolve;
	});
	const server = http.createServer((_request, response) => {
		response.writeHead(403);
		response.end();
	});
	const closeServer = () =>
		new Promise<void>((resolve, reject) => {
			if (!server.listening) return resolve();
			server.close((error) => (error ? reject(error) : resolve()));
		});
	const addressPort = () => {
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("not listening");
		return address.port;
	};
	server.on("upgrade", (request, socket) => {
		const websocket = acceptUpgrade(request, socket, token, addressPort(), accepted);
		if (!websocket) return;
		accepted = true;
		connection = websocket;
		run(websocket);
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(options.port, "127.0.0.1", resolve);
	});
	const startup = parseStartupRecord({
		type: "omb_daemon_ready",
		protocol: PROTOCOL_VERSION,
		port: addressPort(),
		pid: process.pid,
		launch_id: launchId,
		bearer_token: token.value,
		expires_in_ms: 10_000,
	});
	token.startExpiry();
	(options.stdout ?? ((line) => process.stdout.write(`${line}\n`)))(JSON.stringify(startup));

	function run(websocket: WebSocketConnection) {
		let helloComplete = false;
		let mutationSession: MutationBridgeSession | undefined;
		let pendingBridge: PendingBridge | undefined;
		let drainPromise: Promise<void> | undefined;
		const activeHandlers = new Set<Promise<void>>();
		const helloTimer = setTimeout(() => {
			if (!helloComplete) websocket.close(1008, "hello timeout");
		}, options.helloTimeoutMs ?? 3_000);
		const state = new SessionState(clock, (request) => void finishCancellation(request));
		const resetIdle = () => {
			clearTimeout(idle);
			idle = setTimeout(() => websocket.close(1000, "idle"), options.idleTimeoutMs ?? 60_000);
		};
		resetIdle();
		websocket.on("text", (text: string) => {
			resetIdle();
			void message(text);
		});
		websocket.on("disconnect", () => {
			clearTimeout(helloTimer);
			clearTimeout(idle);
			void drain("DISCONNECT", false);
		});

		function failPendingBridge(code: string, message: string): void {
			if (pendingBridge === undefined) return;
			const pending = pendingBridge;
			pendingBridge = undefined;
			pending.removeAbortListener();
			pending.reject(new Error(`${code}: ${message}`));
		}

		async function message(text: string) {
			let raw: unknown;
			try {
				raw = JSON.parse(text);
			} catch {
				state.consumeToken();
				return;
			}
			if (!helloComplete) {
				try {
					const hello = parseHello(raw);
					if (nonces.has(hello.client_nonce)) return websocket.close(1008, "nonce reused");
					nonces.add(hello.client_nonce);
					helloComplete = true;
					clearTimeout(helloTimer);
					const ack =
						hello.protocol === MUTATION_PROTOCOL_VERSION
							? {
									type: "hello_ack" as const,
									protocol: MUTATION_PROTOCOL_VERSION,
									daemon_version: "0.1.0",
									launch_id: launchId,
									session_id: randomUUID(),
									server_nonce: randomNonce(),
									capabilities: ["mutation_bridge_v2" as const],
								}
							: {
									type: "hello_ack" as const,
									protocol: PROTOCOL_VERSION,
									daemon_version: "0.1.0",
									launch_id: launchId,
									session_id: randomUUID(),
									server_nonce: randomNonce(),
									capabilities: ["inspect_project"],
								};
					if (hello.protocol === MUTATION_PROTOCOL_VERSION) mutationSession = negotiateMutationBridge(hello, ack);
					websocket.sendText(ack);
					return;
				} catch {
					return websocket.close(1008, "invalid hello");
				}
			}
			if (typeof raw === "object" && raw !== null && (raw as { type?: unknown }).type === "hello") {
				const nonce = (raw as { client_nonce?: unknown }).client_nonce;
				if (typeof nonce === "string" && nonces.has(nonce)) return websocket.close(1008, "nonce reused");
				return websocket.close(1008, "hello already completed");
			}
			const rawType = typeof raw === "object" && raw !== null ? (raw as { type?: unknown }).type : undefined;
			if (typeof rawType === "string" && rawType.startsWith("bridge_")) {
				if (mutationSession === undefined || pendingBridge === undefined) return;
				try {
					const bridgeMessage = parseAddonBridgeMessage(raw, mutationSession);
					if (bridgeMessage.id !== pendingBridge.id || bridgeMessage.request_id !== pendingBridge.requestId) return;
					if (bridgeMessage.type === "bridge_progress") {
						pendingBridge.reportProgress({
							phase: bridgeMessage.phase,
							completed: bridgeMessage.completed,
							total: bridgeMessage.total,
						});
						return;
					}
					const pending = pendingBridge;
					pendingBridge = undefined;
					pending.removeAbortListener();
					if (bridgeMessage.type === "bridge_result") {
						pending.resolve(bridgeMessage.result as CameraPlanMutationCandidate);
					} else if (bridgeMessage.type === "bridge_error") {
						pending.reject(new Error(`${bridgeMessage.code}: ${bridgeMessage.message}`));
					} else {
						pending.reject(new Error("CANCELLED: add-on acknowledged bridge cancellation"));
					}
				} catch {
					failPendingBridge("INVALID_BRIDGE_MESSAGE", "invalid add-on mutation bridge message");
				}
				return;
			}
			if (rawType === "request") {
				if (!state.consumeToken()) {
					return websocket.sendText(protocolError((raw as { id?: string }).id ?? "", "RATE_LIMITED", "rate limit exceeded", true));
				}
				const deadline = (raw as { deadline_ms?: unknown }).deadline_ms;
				if (!Number.isInteger(deadline) || (deadline as number) < 100 || (deadline as number) > 30_000) {
					return websocket.sendText(
						protocolError((raw as { id?: string }).id ?? "", "INVALID_DEADLINE", "deadline_ms must be 100..30000", false),
					);
				}
				let request: Request;
				try {
					request = parseClientMessage(raw) as Request;
				} catch {
					return websocket.sendText(protocolError((raw as { id?: string }).id ?? "", "INVALID_REQUEST", "invalid request", false));
				}
				return execute(request);
			}
			let parsed: ReturnType<typeof parseClientMessage>;
			try {
				parsed = parseClientMessage(raw);
			} catch {
				state.consumeToken();
				return;
			}
			if (parsed.type === "ping") {
				websocket.sendText({ type: "pong", nonce: parsed.nonce });
				return;
			}
			if (parsed.type === "cancel") {
				const status = state.cancel(parsed.id);
				websocket.sendText({ type: "cancel_ack", id: parsed.id, status });
				return;
			}
			if (parsed.type === "shutdown") await drain("SHUTDOWN", true);
		}

		async function applyCameraPlan(
			request: Request,
			plan: CameraPlanV1,
			context: Parameters<ApplyCameraPlan>[1],
		): Promise<CameraPlanMutationCandidate> {
			if (mutationSession === undefined) {
				throw new Error("MUTATION_BRIDGE_UNAVAILABLE: apply_camera_plan requires protocol v2");
			}
			if (pendingBridge !== undefined) throw new Error("BUSY: one mutation bridge is already open");
			if (plan.expected_revision_id !== request.expected_revision_id) {
				throw new Error(
					`STALE_BASE: plan expected ${plan.expected_revision_id}, request expected ${request.expected_revision_id}`,
				);
			}
			const id = randomUUID();
			const bridgeRequest = parseDaemonBridgeMessage(
				{
					type: "bridge_request",
					id,
					request_id: request.id,
					method: "apply_camera_plan",
					params: plan,
					expected_revision_id: request.expected_revision_id,
					deadline_ms: request.deadline_ms,
				},
				mutationSession,
				new Set([request.id]),
			);
			return new Promise<CameraPlanMutationCandidate>((resolve, reject) => {
				const abort = () => {
					if (pendingBridge?.id !== id || mutationSession === undefined) return;
					try {
						websocket.sendText(
							parseDaemonBridgeMessage(
								{ type: "bridge_cancel", id, request_id: request.id },
								mutationSession,
								new Set([request.id]),
							),
						);
					} catch {
						failPendingBridge("CANCELLED", "mutation bridge cancellation failed");
					}
				};
				const signal = context.signal;
				pendingBridge = {
					id,
					requestId: request.id,
					reportProgress: context.reportProgress,
					resolve,
					reject,
					removeAbortListener: () => signal?.removeEventListener("abort", abort),
				};
				signal?.addEventListener("abort", abort, { once: true });
				websocket.sendText(bridgeRequest);
				if (signal?.aborted) abort();
			});
		}

		async function execute(request: Request) {
			if (draining) return websocket.sendText(protocolError(request.id, "SHUTTING_DOWN", "daemon is shutting down", true));
			if (seenRequestIds.has(request.id)) {
				return websocket.sendText(protocolError(request.id, "INVALID_REQUEST", "request id has already been used", false));
			}
			seenRequestIds.add(request.id);
			if (state.begin(request.id, request.deadline_ms) === "busy") {
				return websocket.sendText(protocolError(request.id, "BUSY", "one request is already active", true));
			}
			const active = state.current!;
			const handler = options.handlers[request.method];
			if (!handler) {
				state.complete(active);
				state.terminal(active);
				return websocket.sendText(protocolError(request.id, "METHOD_NOT_ALLOWED", "method is not allowed", false));
			}
			const task = (async () => {
				try {
					const output = await handler(request.params, {
						signal: active.controller.signal,
						request,
						reportProgress: (phase, completed, total) => {
							if (active.phase === "running") {
								websocket.sendText({ type: "progress", id: active.id, phase, completed, total });
							}
						},
						applyCameraPlan: (plan, context) => applyCameraPlan(request, plan, context),
						beginDurableCommit: () => {
							if (!state.beginDurableCommit(active)) {
								throw new Error(`${active.cause ?? "CANCELLED"}: cancellation won before durable commit`);
							}
						},
					});
					if (state.complete(active)) {
						state.terminal(active);
						websocket.sendText({ type: "response", id: active.id, ...output });
					}
				} catch (cause) {
					if (state.complete(active)) {
						state.terminal(active);
						const message = cause instanceof Error ? cause.message : "handler failed";
						const parsed = /^([A-Z][A-Z0-9_]+):\s*([\s\S]*)$/.exec(message);
						websocket.sendText(
							protocolError(active.id, parsed?.[1] ?? "HANDLER_ERROR", parsed?.[2] ?? message, false),
						);
					}
				}
			})();
			activeHandlers.add(task);
			try {
				await task;
			} finally {
				activeHandlers.delete(task);
			}
		}

		async function finishCancellation(request: ActiveRequest) {
			await Promise.resolve();
			if (state.terminal(request) && !websocket.socket.destroyed) {
				websocket.sendText(
					protocolError(
						request.id,
						request.cause === "TIMEOUT" ? "TIMEOUT" : "CANCELLED",
						request.cause === "TIMEOUT" ? "deadline expired" : "request cancelled",
						false,
					),
				);
			}
		}

		function drain(cause: "SHUTDOWN" | "DISCONNECT", acknowledge: boolean): Promise<void> {
			if (drainPromise) return drainPromise;
			draining = true;
			server.close();
			const active = state.current;
			if (active) state.cancel(active.id, cause);
			if (cause === "DISCONNECT") failPendingBridge("DISCONNECT", "add-on disconnected during mutation");
			drainPromise = (async () => {
				if (activeHandlers.size) {
					let timer: ReturnType<typeof setTimeout> | undefined;
					const bounded = new Promise<void>((resolve) => {
						timer = setTimeout(resolve, 5_000);
					});
					await Promise.race([Promise.allSettled(Array.from(activeHandlers)), bounded]);
					clearTimeout(timer);
				}
				if (acknowledge && !websocket.socket.destroyed) websocket.sendText({ type: "shutdown_ack" });
				if (!websocket.socket.destroyed) websocket.close(1000);
				clearTimeout(idle);
				token.zero();
				try {
					await closeServer();
				} catch (error) {
					(options.stderr ?? ((line) => process.stderr.write(`${line}\n`)))(
						`daemon cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
					);
				}
				resolveStopped();
			})();
			return drainPromise;
		}
	}

	return {
		port: addressPort(),
		startup,
		stopped,
		close: async () => {
			draining = true;
			clearTimeout(idle);
			connection?.close(1000);
			token.zero();
			await closeServer();
			resolveStopped();
		},
	};
}

const protocolError = (id: string, code: string, message: string, retryable: boolean) => ({
	type: "error",
	id,
	code,
	message,
	retryable,
});
