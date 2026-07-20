import assert from "node:assert/strict";
import { Duplex } from "node:stream";
import test from "node:test";
import { WebSocketConnection } from "../src/ws-server.ts";

class BlockedDuplex extends Duplex {
	readonly writes: Buffer[] = [];
	receive(bytes: Buffer): void {
		this.push(bytes);
	}

	_read(): void {}

	_write(chunk: Buffer, _encoding: BufferEncoding, _callback: (error?: Error | null) => void): void {
		this.writes.push(Buffer.from(chunk));
	}
}
class CapturingDuplex extends Duplex {
	readonly writes: Buffer[] = [];

	_read(): void {}

	_write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
		this.writes.push(Buffer.from(chunk));
		callback();
	}
}

test("per-socket outbound queue closes only the slow socket at the frame cap", () => {
	const socket = new BlockedDuplex({ writableHighWaterMark: 1 });
	const connection = new WebSocketConnection(socket);
	for (let index = 0; index < 257; index += 1) connection.sendText({ index });
	assert.equal(connection.closing, true);
	assert.equal(socket.destroyed, false);
});

test("per-socket outbound queue closes only the slow socket at the byte cap", () => {
	const socket = new BlockedDuplex({ writableHighWaterMark: 1 });
	const connection = new WebSocketConnection(socket);
	connection.sendText({ payload: "x".repeat(600_000) });
	connection.sendText({ payload: "x".repeat(600_000) });
	assert.equal(connection.closing, true);
});

test("a draining socket preserves ordered durable frames without drops", async () => {
	const socket = new CapturingDuplex();
	const connection = new WebSocketConnection(socket);
	for (let index = 0; index < 64; index += 1) connection.sendText({ type: "durable", index });
	await new Promise((resolve) => setImmediate(resolve));
	const combined = Buffer.concat(socket.writes);
	for (let index = 0; index < 64; index += 1) {
		assert.equal(combined.includes(Buffer.from(`\"index\":${index}`)), true);
	}
	assert.equal(connection.closing, false);
	connection.close();
});
test("pong control frames share the bounded outbound queue", () => {
	const socket = new BlockedDuplex({ writableHighWaterMark: 1 });
	const connection = new WebSocketConnection(socket);
	for (let index = 0; index < 257; index += 1) connection.pong(Buffer.alloc(0));
	assert.equal(connection.closing, true);
});

test("zero-byte fragmented messages close at the frame metadata bound", async () => {
	const socket = new BlockedDuplex();
	const connection = new WebSocketConnection(socket);
	const maskedEmpty = (opcode: number) => Buffer.from([opcode, 0x80, 1, 2, 3, 4]);
	socket.receive(maskedEmpty(1));
	for (let index = 0; index < 256; index += 1) socket.receive(maskedEmpty(0));
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(connection.closing, true);
});
