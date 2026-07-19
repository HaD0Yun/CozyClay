import assert from "node:assert/strict";
import test from "node:test";
import { InterruptController } from "../src/interrupt.ts";

test("first interrupt cancels an active turn and second exits", () => {
	const controller = new InterruptController();
	assert.deepEqual(controller.interrupt("request-1"), { action: "cancel", requestId: "request-1" });
	assert.deepEqual(controller.interrupt("request-1"), { action: "exit" });
});

test("interrupt exits immediately when no turn is active", () => {
	const controller = new InterruptController();
	assert.deepEqual(controller.interrupt(undefined), { action: "exit" });
});

test("a terminal turn resets the double-interrupt latch", () => {
	const controller = new InterruptController();
	controller.interrupt("request-1");
	controller.turnTerminated();
	assert.deepEqual(controller.interrupt("request-2"), { action: "cancel", requestId: "request-2" });
});
