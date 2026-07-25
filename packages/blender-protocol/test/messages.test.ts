import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
	parseCancel,
	parseClientMessage,
	parseHello,
	parseHelloAck,
	parseRequest,
	parseServerMessage,
	parseStartupRecord,
} from "../src/messages.ts";

const messageTypes = [
	"cclay_daemon_ready",
	"hello",
	"hello_ack",
	"request",
	"progress",
	"response",
	"error",
	"cancel",
	"cancel_ack",
	"rollback_ack",
	"shutdown",
	"shutdown_ack",
	"ping",
	"pong",
] as const;
const clientTypes = new Set(["hello", "request", "cancel", "rollback_ack", "shutdown", "ping"]);
const directParsers: Record<string, (input: unknown) => unknown> = {
	cclay_daemon_ready: parseStartupRecord,
	hello: parseHello,
	hello_ack: parseHelloAck,
	request: parseRequest,
	cancel: parseCancel,
};

function fixture(type: string, variant: string): unknown {
	return JSON.parse(readFileSync(new URL(`fixtures/protocol-v1/${type}.${variant}.json`, import.meta.url), "utf8"));
}
function parser(type: string): (input: unknown) => unknown {
	return directParsers[type] ?? (clientTypes.has(type) ? parseClientMessage : parseServerMessage);
}

describe("architecture §4 protocol v1 fixtures", () => {
	for (const type of messageTypes) {
		it(`§4 ${type} accepts its valid exact message`, () => {
			assert.deepEqual(parser(type)(fixture(type, "valid")), fixture(type, "valid"));
		});
		for (const variant of ["invalid-unknown", "invalid-wrong-type", "invalid-out-of-range"]) {
			it(`§4 ${type} rejects ${variant}`, () => {
				assert.throws(() => parser(type)(fixture(type, variant)));
			});
		}
	}

	it("§4 client and server unions reject unknown message types", () => {
		assert.throws(() => parseClientMessage({ type: "future" }));
		assert.throws(() => parseServerMessage({ type: "future" }));
	});
});
