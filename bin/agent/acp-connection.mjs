// A minimal Agent Client Protocol client (https://agentclientprotocol.com): newline-delimited
// JSON-RPC 2.0 over a spawned agent's stdio. Used by the google-antigravity lane, which launches
// Google's official antigravity-acp binary unmodified and talks to it exactly as an editor does.
// Only what the lane needs: requests, notifications, agent→client requests, stderr lines, close.
import { spawn as defaultSpawn } from "node:child_process";

const ACP_PROTOCOL_VERSION = 1;
// JSON-RPC error the ACP spec reserves for "authentication required".
const ACP_AUTH_REQUIRED = -32000;

/**
 * Spawns `command args` and returns the connection. `onNotification(method, params)` sees every
 * agent notification; `onRequest(method, params)` answers agent→client requests (its return value
 * is the result, a throw the error); `onStderr(line)` sees the agent's log lines.
 */
export function openAcpConnection({ command, args = [], env, cwd, spawn = defaultSpawn, onNotification, onRequest, onStderr } = {}) {
	const child = spawn(command, args, { env, cwd, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
	const pending = new Map();
	let nextId = 0;
	let closed = false;
	let exitError;
	const write = (message) => {
		if (closed || !child.stdin?.writable) return;
		child.stdin.write(`${JSON.stringify(message)}\n`);
	};
	const failAll = (error) => {
		for (const { reject } of pending.values()) reject(error);
		pending.clear();
	};
	const handle = async (message) => {
		if (message.id !== undefined && message.method === undefined) {
			const waiter = pending.get(message.id);
			if (!waiter) return;
			pending.delete(message.id);
			if (message.error) waiter.reject(acpError(message.error));
			else waiter.resolve(message.result);
			return;
		}
		if (typeof message.method !== "string") return;
		if (message.id === undefined) {
			try { onNotification?.(message.method, message.params ?? {}); } catch { /* a listener bug never breaks the pipe */ }
			return;
		}
		try {
			const result = onRequest ? await onRequest(message.method, message.params ?? {}) : undefined;
			if (result === undefined) write({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `Method not found: ${message.method}` } });
			else write({ jsonrpc: "2.0", id: message.id, result });
		} catch (error) {
			write({ jsonrpc: "2.0", id: message.id, error: { code: -32603, message: String(error?.message ?? error) } });
		}
	};
	lines(child.stdout, (line) => {
		let message;
		try { message = JSON.parse(line); } catch { return; }
		void handle(message);
	});
	lines(child.stderr, (line) => { try { onStderr?.(line); } catch { /* ignore */ } });
	child.on("error", (error) => { exitError = error; closed = true; failAll(error); });
	child.on("exit", (code, signal) => {
		closed = true;
		failAll(exitError ?? Object.assign(new Error(`The Antigravity agent exited (${signal ?? code}).`), { code: "AGENT_EXITED" }));
	});
	child.stdin?.on("error", () => {});

	return {
		child,
		request(method, params) {
			if (closed) return Promise.reject(exitError ?? Object.assign(new Error("The Antigravity agent is not running."), { code: "AGENT_EXITED" }));
			const id = ++nextId;
			return new Promise((resolve, reject) => {
				pending.set(id, { resolve, reject });
				write({ jsonrpc: "2.0", id, method, params });
			});
		},
		notify(method, params) { write({ jsonrpc: "2.0", method, params }); },
		close() {
			if (!closed) {
				closed = true;
				try { child.stdin?.end(); } catch { /* ignore */ }
				try { child.kill(); } catch { /* ignore */ }
			}
			failAll(Object.assign(new Error("The Antigravity agent was closed."), { code: "AGENT_CLOSED" }));
		},
		get closed() { return closed; },
	};
}

/** The handshake every ACP client sends first. No fs/terminal capability: the agent gets CozyClay's tools only. */
export function initializeParams(version) {
	return {
		protocolVersion: ACP_PROTOCOL_VERSION,
		clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
		clientInfo: { name: "cozyclay", title: "CozyClay Studio", version: String(version ?? "0") },
	};
}

function acpError(error) {
	const data = error?.data;
	const detail = typeof data?.message === "string" ? data.message : typeof data === "string" ? data : "";
	const message = [error?.message, detail].filter(Boolean).join(": ") || "The Antigravity agent refused the request.";
	return Object.assign(new Error(message), { acpCode: error?.code, ...(error?.code === ACP_AUTH_REQUIRED ? { code: "AUTH_REQUIRED" } : {}) });
}

function lines(stream, onLine) {
	if (!stream) return;
	let buffer = "";
	stream.setEncoding?.("utf8");
	stream.on("data", (chunk) => {
		buffer += chunk;
		let index;
		while ((index = buffer.indexOf("\n")) >= 0) {
			const line = buffer.slice(0, index).replace(/\r$/, "");
			buffer = buffer.slice(index + 1);
			if (line.trim()) onLine(line);
		}
	});
	stream.on("end", () => { if (buffer.trim()) onLine(buffer); buffer = ""; });
}
