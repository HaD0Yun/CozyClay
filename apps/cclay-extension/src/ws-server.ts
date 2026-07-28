// Server-side WebSocket for the in-extension Blender bridge. Adapted from the
// daemon's ws-server (transitional: the daemon is removed once this stack is
// proven live). Blender is the client; this process is the server, so frames
// arriving here are masked and frames leaving are not.
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

/** Blender attaches with `X-CCLAY-Role: bridge`; no controller peers exist here. */
export type ClientRole = "bridge" | "legacy";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const DEFAULT_MAX_MESSAGE_BYTES = 18 * 1024 * 1024;
const MAX_OUTBOUND_FRAMES = 256;
const MAX_OUTBOUND_BYTES = 18 * 1024 * 1024;
const MAX_FRAGMENT_FRAMES = 256;
const OUTBOUND_DRAIN_TIMEOUT_MS = 2_000;

function encodeFrame(opcode: number, payload: Buffer): Buffer {
	const length = payload.byteLength;
	let header: Buffer;
	if (length < 126) {
		header = Buffer.alloc(2);
		header[1] = length;
	} else if (length < 65536) {
		header = Buffer.alloc(4);
		header[1] = 126;
		header.writeUInt16BE(length, 2);
	} else {
		header = Buffer.alloc(10);
		header[1] = 127;
		header.writeBigUInt64BE(BigInt(length), 2);
	}
	header[0] = 0x80 | opcode;
	return Buffer.concat([header, payload]);
}

export class WebSocketConnection extends EventEmitter {
	private buffer = Buffer.alloc(0);
	private fragments: Buffer[] = [];
	private fragmentBytes = 0;
	private fragmentOpcode = 0;
	private closed = false;
	private lastClose: { readonly code: number; readonly reason: string; readonly source: "local" | "peer" } | undefined;
	private readonly maxMessageBytes: number;
	private readonly outbound: Buffer[] = [];
	private outboundBytes = 0;
	private writing = false;
	private waitingDrain = false;
	private drainTimer: ReturnType<typeof setTimeout> | undefined;
	readonly socket: Duplex;

	constructor(socket: Duplex, maxMessageBytes = DEFAULT_MAX_MESSAGE_BYTES) {
		super();
		this.socket = socket;
		this.maxMessageBytes = maxMessageBytes;
		socket.on("data", (bytes) => this.read(bytes));
		socket.on("close", () => {
			this.clearOutbound();
			this.emit("disconnect", this.closeInfo());
		});
		socket.on("end", () => {
			if (!socket.writableEnded) socket.end();
		});
		socket.on("error", () => {
			// The close event owns connection cleanup.
		});
	}

	get closing(): boolean {
		return this.closed || this.socket.writableEnded || this.socket.destroyed;
	}

	sendText(value: unknown): boolean {
		return this.enqueueFrame(encodeFrame(1, Buffer.from(JSON.stringify(value))));
	}

	pong(payload: Buffer): void {
		this.writeControl(10, payload);
	}

	close(code = 1000, reason = ""): void {
		if (this.closed) return;
		this.closed = true;
		// The socket "close" event is the only cleanup signal downstream, and it
		// carries no code. Remember who closed and why so the bridge can log the
		// first close instead of a bare disconnect after the fact.
		if (this.lastClose === undefined) this.lastClose = { code, reason, source: "local" };
		this.clearOutbound();
		const boundedReason = Buffer.from(reason).subarray(0, 123);
		const payload = Buffer.alloc(2 + boundedReason.byteLength);
		payload.writeUInt16BE(code);
		boundedReason.copy(payload, 2);
		this.writeControl(8, payload);
		this.socket.end();
	}

	closeInfo(): { readonly code: number; readonly reason: string; readonly source: "local" | "peer" } | undefined {
		return this.lastClose;
	}

	private clearOutbound(): void {
		if (this.drainTimer !== undefined) clearTimeout(this.drainTimer);
		this.drainTimer = undefined;
		this.waitingDrain = false;
		this.outbound.length = 0;
		this.outboundBytes = 0;
	}

	private enqueueFrame(frame: Buffer): boolean {
		if (this.closing) return false;
		if (this.outbound.length >= MAX_OUTBOUND_FRAMES || this.outboundBytes + frame.byteLength > MAX_OUTBOUND_BYTES) {
			this.close(1013, "outbound queue overflow");
			return false;
		}
		this.outbound.push(frame);
		this.outboundBytes += frame.byteLength;
		this.pumpOutbound();
		return true;
	}

	private pumpOutbound(): void {
		if (this.writing || this.waitingDrain || this.closing) return;
		const frame = this.outbound[0];
		if (frame === undefined) return;
		this.writing = true;
		const writable = this.socket.write(frame, (error) => {
			this.writing = false;
			if (error) {
				this.close(1011, "socket write failure");
				return;
			}
			if (this.outbound[0] === frame) {
				this.outbound.shift();
				this.outboundBytes -= frame.byteLength;
			}
			if (!this.waitingDrain) this.pumpOutbound();
		});
		if (!writable) {
			this.waitingDrain = true;
			this.socket.once("drain", () => {
				if (this.closing) return;
				this.waitingDrain = false;
				if (this.drainTimer !== undefined) clearTimeout(this.drainTimer);
				this.drainTimer = undefined;
				this.pumpOutbound();
			});
			this.drainTimer = setTimeout(() => this.close(1013, "outbound drain timeout"), OUTBOUND_DRAIN_TIMEOUT_MS);
			this.drainTimer.unref();
		}
	}

	private writeControl(opcode: number, payload: Buffer): void {
		if (this.socket.destroyed || !this.socket.writable) return;
		if (opcode === 10) {
			this.enqueueFrame(encodeFrame(opcode, payload));
			return;
		}
		this.socket.write(encodeFrame(opcode, payload), () => {});
	}

	private read(chunk: Buffer): void {
		this.buffer = Buffer.concat([this.buffer, chunk]);
		while (this.buffer.length >= 2) {
			const first = this.buffer[0]!;
			const second = this.buffer[1]!;
			if ((first & 0x70) !== 0) return this.close(1008, "reserved bits unsupported");
			const final = (first & 0x80) !== 0;
			const opcode = first & 0x0f;
			if ((second & 0x80) === 0) return this.close(1008, "client frames must be masked");
			let length = second & 0x7f;
			let offset = 2;
			if (length === 126) {
				if (this.buffer.length < 4) return;
				length = this.buffer.readUInt16BE(2);
				offset = 4;
			} else if (length === 127) {
				if (this.buffer.length < 10) return;
				const wideLength = this.buffer.readBigUInt64BE(2);
				if (wideLength > BigInt(this.maxMessageBytes)) return this.close(1009);
				length = Number(wideLength);
				offset = 10;
			}
			if (this.buffer.length < offset + 4 + length) return;
			const mask = this.buffer.subarray(offset, offset + 4);
			offset += 4;
			const data = Buffer.from(this.buffer.subarray(offset, offset + length));
			this.buffer = this.buffer.subarray(offset + length);
			for (let index = 0; index < data.length; index += 1) data[index] ^= mask[index & 3]!;
			if (opcode >= 8 && (!final || length > 125)) return this.close(1008);
			if (opcode === 8) {
				const code = data.length >= 2 ? data.readUInt16BE(0) : 1000;
				this.lastClose = {
					code,
					reason: data.length > 2 ? data.subarray(2).toString("utf8") : "",
					source: "peer",
				};
				this.close(code);
				return;
			}
			if (opcode === 9) {
				this.pong(data);
				continue;
			}
			if (opcode === 10) {
				this.emit("pong", data);
				continue;
			}
			if (opcode === 2) return this.close(1008, "binary unsupported");
			if (opcode === 1) {
				if (this.fragmentOpcode !== 0) return this.close(1008);
				if (final) {
					if (length > this.maxMessageBytes) return this.close(1009);
					this.emit("text", data.toString("utf8"));
				} else {
					this.fragmentOpcode = 1;
					this.fragments = [data];
					this.fragmentBytes = length;
				}
			} else if (opcode === 0) {
				if (this.fragmentOpcode === 0) return this.close(1008);
				this.fragmentBytes += length;
				if (this.fragmentBytes > this.maxMessageBytes) return this.close(1009);
				if (this.fragments.length >= MAX_FRAGMENT_FRAMES) return this.close(1009);
				this.fragments.push(data);
				if (final) {
					const message = Buffer.concat(this.fragments).toString("utf8");
					this.fragments = [];
					this.fragmentOpcode = 0;
					this.fragmentBytes = 0;
					this.emit("text", message);
				}
			} else {
				return this.close(1008);
			}
		}
	}
}

function readUniqueHeader(request: IncomingMessage, name: string): string | undefined {
	const normalized = name.toLowerCase();
	const values: string[] = [];
	for (let index = 0; index < request.rawHeaders.length; index += 2) {
		if (request.rawHeaders[index]?.toLowerCase() === normalized) values.push(request.rawHeaders[index + 1] ?? "");
	}
	if (values.length !== 1 || values[0]!.includes(",")) return undefined;
	return values[0];
}

export function readClientRole(request: IncomingMessage): ClientRole | undefined {
	const values: string[] = [];
	for (let index = 0; index < request.rawHeaders.length; index += 2) {
		if (request.rawHeaders[index]?.toLowerCase() === "x-cclay-role") values.push(request.rawHeaders[index + 1] ?? "");
	}
	if (values.length === 0) return "legacy";
	if (values.length !== 1 || values[0]!.includes(",")) return undefined;
	const value = values[0];
	if (value === "bridge") return value;
	return undefined;
}

export function acceptUpgrade(
	request: IncomingMessage,
	socket: Duplex,
	port: number,
	authenticate: (credential: string) => boolean,
	maxMessageBytes = DEFAULT_MAX_MESSAGE_BYTES,
): WebSocketConnection | undefined {
	const reject = () => {
		socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
		return undefined;
	};
	if (
		request.headers.host !== `127.0.0.1:${port}` ||
		(request.headers.origin !== undefined && request.headers.origin !== `http://127.0.0.1:${port}`)
	) {
		return reject();
	}
	const key = readUniqueHeader(request, "sec-websocket-key");
	const authorization = readUniqueHeader(request, "authorization");
	if (
		request.headers.upgrade?.toLowerCase() !== "websocket" ||
		request.headers["sec-websocket-version"] !== "13" ||
		typeof key !== "string" ||
		Buffer.from(key, "base64").length !== 16 ||
		typeof authorization !== "string" ||
		!authorization.startsWith("Bearer ") ||
		!authenticate(authorization.slice(7))
	) {
		return reject();
	}
	const accept = createHash("sha1").update(key + GUID).digest("base64");
	socket.write(
		`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
	);
	return new WebSocketConnection(socket, maxMessageBytes);
}
