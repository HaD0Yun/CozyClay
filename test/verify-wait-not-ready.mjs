#!/usr/bin/env node
// A TARGET_NOT_READY whose cause clears by itself (a rig still loading): the editor marks it retryable, and the
// sidecar re-sends it within a stated bound instead of handing the model a refusal (bin/agent/wait-not-ready.mjs).
import assert from "node:assert/strict";
import { createCommandBus } from "../src/command-bus.js";
import { createStudioActionRegistry } from "../src/studio-actions.js";
import { createStudioCommandJournal } from "../src/studio-agent-commands.js";
import { StudioProtocolError } from "../src/studio-agent-protocol.js";
import { NOT_READY_WAIT_MS, waitWhileNotReady } from "../bin/agent/wait-not-ready.mjs";

// --- the editor side: a refusal marked transient answers recovery retry, any other stays inspect ---
const identity = { workspaceId: "tab-7", documentEpoch: "doc-3", sceneId: "scene-main", sceneEpoch: "scene-open-4" };
let loadedAfter = 2, calls = 0;
const registry = createStudioActionRegistry();
const probe = (id, run) => registry.register({ id, label: id, kind: "transient", input: { type: "object", properties: {}, required: [], additionalProperties: false }, available: () => true, run });
probe("probe.loading", () => {
	calls++;
	if (calls <= loadedAfter) throw new StudioProtocolError("TARGET_NOT_READY", "Character bounds require its loaded rig.", { transient: true });
	return { affectedIds: [], summary: "measured" };
});
probe("probe.capsule", () => { throw new StudioProtocolError("TARGET_NOT_READY", "Capsule figures have no rig - attaching a prop works on rigged characters only."); });
const journal = createStudioCommandJournal({ host: identity });
const bus = createCommandBus({ registry, ports: { read: () => ({ host: identity, revision: 1, viewRevision: 0, busy: false, domainRevisions: {} }), journal: () => journal, remember: (receipt) => receipt } });

const first = bus.run("probe.loading", {});
assert.equal(first.ok, false);
assert.equal(first.code, "TARGET_NOT_READY");
assert.deepEqual(first.recovery, { action: "retry", retryAllowed: true }, "before: inspect, do not retry; now: retry allowed");
const capsule = bus.run("probe.capsule", {});
assert.deepEqual(capsule.recovery, { action: "inspect", retryAllowed: false }, "a lasting cause stays inspect");

// --- the sidecar side: the same throw the agent's attempt() makes from a refused receipt ---
const send = (id) => async () => {
	const receipt = bus.run(id, {});
	if (receipt.ok === false) throw Object.assign(new Error(receipt.message), { code: receipt.code, receipt });
	return receipt;
};
const slept = [];
const sleep = async (ms) => { slept.push(ms); return true; };

calls = 0; loadedAfter = 2;
const landed = await waitWhileNotReady(send("probe.loading"), { sleep })("run_action", {}, "c1");
assert.equal(landed.summary, "measured");
assert.deepEqual(slept, [250, 500]);
assert.equal(landed.warnings.at(-1).code, "NOT_READY_WAITED");
assert.match(landed.warnings.at(-1).message, /waited 750 ms and re-sent/);

// A lasting cause reaches the model at once, untouched.
slept.length = 0;
await assert.rejects(waitWhileNotReady(send("probe.capsule"), { sleep })("run_action", {}, "c2"), (error) => /^Capsule figures have no rig/.test(error.message) && !/Waited/.test(error.message));
assert.deepEqual(slept, []);

// Past the bound: refused, saying how long it waited.
calls = 0; loadedAfter = 1000; slept.length = 0;
await assert.rejects(waitWhileNotReady(send("probe.loading"), { sleep })("run_action", {}, "c3"), (error) => error.code === "TARGET_NOT_READY" && /Waited \d+ ms for it to become ready \(the bound is 8000 ms\); still not ready\./.test(error.message));
assert.ok(slept.reduce((a, b) => a + b, 0) <= NOT_READY_WAIT_MS);

console.log("verify-wait-not-ready: all checks passed");
