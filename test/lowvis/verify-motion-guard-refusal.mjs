#!/usr/bin/env node
// A call on what a running motion holds is run, undone and refused (motion-door.mjs guard): the refusal's facts line
// (refusal.mjs) says the scene did not change only when the undo went through or the failed call changed nothing; an
// undo that failed says "unknown", one that found nothing to undo says true (the call's edits stand). Other
// MOTION_RUNNING refusals (raised before any command) still say false.
//   node test/lowvis/verify-motion-guard-refusal.mjs
import assert from "node:assert/strict";
import { createMotionDoor } from "../../bin/agent/motion-door.mjs";
import { asRefusal, refusalFacts } from "../../bin/agent/refusal.mjs";

const held = { characters: { c1: "c1" }, props: { crate: { id: "crate" } } };
function doorWith(rollback) {
	const run = async ({ onScene, signal }) => { onScene?.(held); await new Promise((resolve, reject) => signal?.addEventListener("abort", () => reject(Object.assign(new Error("stopped"), { code: "aborted" })), { once: true })); };
	const door = createMotionDoor({ run, mark: async () => ({}), rollback, background: true });
	const edit = { name: "sculpt", handler: async ({ id }) => ({ ok: true, affectedIds: [id] }) };
	const script = { name: "script", handler: async () => ({ ok: false, error: { message: "boom" }, rollback: true, calls: [{ ok: true, affectedIds: ["crate"] }] }) };
	return { door, tools: door.with([edit, script]) };
}
const refused = async promise => { try { await promise; } catch (error) { return error; } assert.fail("the call was not refused"); };
const factsLine = error => JSON.parse(asRefusal(error, { tool: "sculpt", args: { id: "crate" } }).message.split("\n").at(-1));

const cases = [
	["the undo went through", async () => ({ receiptId: "r" }), false, /its edits were undone/],
	["the undo failed", async () => { throw Object.assign(new Error("not ready"), { code: "TARGET_NOT_READY" }); }, "unknown", /its edits could not be undone \(TARGET_NOT_READY: not ready\)/],
	["the undo found nothing to undo", async () => null, true, /its edits could not be undone\./],
];
for (const [label, rollback, changed, text] of cases) {
	const { door, tools: [sculpt] } = doorWith(rollback);
	await door.handler({ request: "c1 pushes the crate" });
	const error = await refused(sculpt.handler({ id: "crate" }));
	assert.equal(error.code, "MOTION_RUNNING");
	assert.match(error.message, text);
	assert.equal(refusalFacts(error, { tool: "sculpt" }).changed, changed, label);
	assert.equal(factsLine(error).changed, changed, `${label}: the line the model reads`);
	console.log(`PASS ${label}: "changed": ${JSON.stringify(changed)}`);
}
{
	const { door, tools: [, script] } = doorWith(async () => ({ receiptId: "r" }));
	await door.handler({ request: "c1 pushes the crate" });
	const error = await refused(script.handler({}));
	assert.match(error.message, /This call failed \(boom\) and its edits were undone/);
	assert.equal(refusalFacts(error, { tool: "script" }).changed, false);
	console.log("PASS a failed script that rolled back its own edits: \"changed\": false");
	const again = await refused(door.handler({ request: "again" }));
	assert.equal(again.changed, undefined);
	assert.equal(refusalFacts(again, { tool: "motion" }).changed, false, "a second motion call is refused before any command");
	console.log("PASS a MOTION_RUNNING raised before any command: \"changed\": false as before");
}
