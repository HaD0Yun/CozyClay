import { createHash, randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import net, { type Socket } from "node:net";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const MAX_MESSAGE_BYTES = 1024 * 1024;
const UUID_V4_LOWERCASE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export class ControllerWebSocket extends EventEmitter {
	private readonly socket: Socket;
	private buffer = Buffer.alloc(0);
	private fragments: Buffer[] = [];
	private fragmentBytes = 0;
	private fragmentOpcode = 0;
	private closed = false;

	constructor(socket: Socket) {
		super();
		this.socket = socket;
		socket.on("data", (chunk) => this.read(chunk));
		socket.on("close", () => this.closeOnce());
		socket.on("end", () => this.closeOnce());
		socket.on("error", () => this.closeOnce());
	}

	feed(chunk: Buffer): void {
		if (chunk.length > 0) this.read(chunk);
	}

	send(value: unknown): void {
		this.sendFrame(1, Buffer.from(JSON.stringify(value)));
	}

	async next(predicate: (message: unknown) => boolean, timeoutMs = 2_000, signal?: AbortSignal): Promise<unknown> {
		return new Promise((resolve, reject) => {
			if (signal?.aborted) {
				reject(new Error("CONTROLLER_RECONNECT_ABORTED"));
				return;
			}
			const timer = setTimeout(() => {
				cleanup();
				reject(new Error("CONTROLLER_TIMEOUT: daemon message timed out"));
			}, timeoutMs);
			const onMessage = (message: unknown) => {
				if (!predicate(message)) return;
				cleanup();
				resolve(message);
			};
			const onClose = () => {
				cleanup();
				reject(new Error("CONTROLLER_DISCONNECTED: daemon connection closed"));
			};
			const onAbort = () => {
				cleanup();
				reject(new Error("CONTROLLER_RECONNECT_ABORTED"));
			};
			const cleanup = () => {
				clearTimeout(timer);
				this.off("message", onMessage);
				this.off("close", onClose);
				signal?.removeEventListener("abort", onAbort);
			};
			this.on("message", onMessage);
			this.on("close", onClose);
			signal?.addEventListener("abort", onAbort, { once: true });
		});
	}

	disconnect(): void {
		if (this.closed) return;
		this.closed = true;
		this.socket.destroy();
		this.emit("close");
	}

	close(code: number, reason: string): void {
		if (this.closed) return;
		const reasonBytes = Buffer.from(reason, "utf8").subarray(0, 123);
		const payload = Buffer.alloc(2 + reasonBytes.length);
		payload.writeUInt16BE(code, 0);
		reasonBytes.copy(payload, 2);
		try {
			this.sendFrame(8, payload);
			this.socket.end();
		} finally {
			this.closed = true;
			this.emit("close");
		}
	}

	private closeOnce(): void {
		if (this.closed) return;
		this.closed = true;
		this.emit("close");
	}

	private sendFrame(opcode: number, payload: Buffer): void {
		if (this.closed || this.socket.destroyed || !this.socket.writable) {
			throw new Error("CONTROLLER_DISCONNECTED: daemon connection is closed");
		}
		const lengthBytes = payload.length < 126 ? 0 : payload.length <= 65_535 ? 2 : 8;
		const header = Buffer.alloc(2 + lengthBytes + 4);
		header[0] = 0x80 | opcode;
		header[1] = 0x80 | (lengthBytes === 0 ? payload.length : lengthBytes === 2 ? 126 : 127);
		if (lengthBytes === 2) header.writeUInt16BE(payload.length, 2);
		if (lengthBytes === 8) header.writeBigUInt64BE(BigInt(payload.length), 2);
		const maskOffset = 2 + lengthBytes;
		const mask = randomBytes(4);
		mask.copy(header, maskOffset);
		const masked = Buffer.from(payload);
		for (let index = 0; index < masked.length; index++) masked[index] ^= mask[index & 3]!;
		this.socket.write(Buffer.concat([header, masked]));
	}

	private read(chunk: Buffer): void {
		this.buffer = Buffer.concat([this.buffer, chunk]);
		while (this.buffer.length >= 2) {
			const first = this.buffer[0]!;
			const second = this.buffer[1]!;
			const finished = (first & 0x80) !== 0;
			const opcode = first & 0x0f;
			if ((first & 0x70) !== 0 || (second & 0x80) !== 0) return this.disconnect();
			let length = second & 0x7f;
			let offset = 2;
			if (length === 126) {
				if (this.buffer.length < 4) return;
				length = this.buffer.readUInt16BE(2);
				offset = 4;
			} else if (length === 127) {
				if (this.buffer.length < 10) return;
				const largeLength = this.buffer.readBigUInt64BE(2);
				if (largeLength > BigInt(MAX_MESSAGE_BYTES)) return this.disconnect();
				length = Number(largeLength);
				offset = 10;
			}
			if (length > MAX_MESSAGE_BYTES || this.buffer.length < offset + length) return;
			const payload = Buffer.from(this.buffer.subarray(offset, offset + length));
			this.buffer = this.buffer.subarray(offset + length);
			if (opcode >= 8 && (!finished || length > 125)) return this.disconnect();
			if (opcode === 8) return this.disconnect();
			if (opcode === 9) {
				this.sendFrame(10, payload);
				continue;
			}
			if (opcode === 10) continue;
			if (opcode === 1) {
				if (this.fragmentOpcode !== 0) return this.disconnect();
				if (finished) this.emitText(payload);
				else {
					this.fragmentOpcode = opcode;
					this.fragments = [payload];
					this.fragmentBytes = payload.length;
				}
				continue;
			}
			if (opcode !== 0 || this.fragmentOpcode === 0) return this.disconnect();
			this.fragments.push(payload);
			this.fragmentBytes += payload.length;
			if (this.fragmentBytes > MAX_MESSAGE_BYTES) return this.disconnect();
			if (finished) {
				this.emitText(Buffer.concat(this.fragments));
				this.fragments = [];
				this.fragmentBytes = 0;
				this.fragmentOpcode = 0;
			}
		}
	}

	private emitText(payload: Buffer): void {
		try {
			this.emit("message", JSON.parse(payload.toString("utf8")) as unknown);
		} catch {
			this.disconnect();
		}
	}
}

export async function connectWebSocket(options: {
	readonly host: "127.0.0.1";
	readonly port: number;
	readonly credential: string;
	readonly launchId?: string;
	readonly timeoutMs?: number;
	readonly signal?: AbortSignal;
}): Promise<ControllerWebSocket> {
	return new Promise((resolve, reject) => {
		if (options.signal?.aborted) {
			reject(new Error("CONTROLLER_RECONNECT_ABORTED"));
			return;
		}
		if (options.launchId !== undefined && !UUID_V4_LOWERCASE.test(options.launchId)) {
			reject(new Error("CONTROLLER_AUTH_FAILED: invalid launch id"));
			return;
		}
		const socket = net.connect(options.port, options.host);
		const key = randomBytes(16).toString("base64");
		const expectedAccept = createHash("sha1").update(key + GUID).digest("base64");
		let response = Buffer.alloc(0);
		let settled = false;
		const finish = (error: Error | undefined, websocket?: ControllerWebSocket) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			socket.off("connect", onConnect);
			socket.off("data", onData);
			socket.off("error", onError);
			options.signal?.removeEventListener("abort", onAbort);
			if (error !== undefined) {
				socket.destroy();
				reject(error);
			} else resolve(websocket!);
		};
		const onAbort = () => finish(new Error("CONTROLLER_RECONNECT_ABORTED"));
		const onConnect = () => {
			const launchHeader = options.launchId === undefined ? "" : `X-OMB-Launch-ID: ${options.launchId}\r\n`;
			socket.write(
				`GET / HTTP/1.1\r\nHost: 127.0.0.1:${options.port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${key}\r\nAuthorization: Bearer ${options.credential}\r\n${launchHeader}X-OMB-Role: controller\r\n\r\n`,
			);
		};
		const onData = (chunk: Buffer) => {
			response = Buffer.concat([response, chunk]);
			if (response.length > 16 * 1024) return finish(new Error("CONTROLLER_AUTH_FAILED: oversized upgrade response"));
			const end = response.indexOf("\r\n\r\n");
			if (end === -1) return;
			const header = response.subarray(0, end).toString("latin1");
			if (!header.startsWith("HTTP/1.1 101 ") || !header.toLowerCase().includes(`sec-websocket-accept: ${expectedAccept.toLowerCase()}`)) {
				return finish(new Error("CONTROLLER_AUTH_FAILED: daemon rejected controller connection"));
			}
			socket.off("data", onData);
			const websocket = new ControllerWebSocket(socket);
			websocket.feed(response.subarray(end + 4));
			finish(undefined, websocket);
		};
		const onError = () => finish(new Error("CONTROLLER_CONNECT_FAILED: daemon endpoint is unavailable"));
		const timer = setTimeout(() => finish(new Error("CONTROLLER_CONNECT_FAILED: daemon connection timed out")), options.timeoutMs ?? 2_000);
		options.signal?.addEventListener("abort", onAbort, { once: true });
		socket.once("connect", onConnect);
		socket.on("data", onData);
		socket.once("error", onError);
	});
}
