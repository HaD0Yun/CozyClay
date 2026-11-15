#!/usr/bin/env node
/**
 * verify-sculpt-mode (#739): the pure parts of Sculpt mode — the fifth mode on
 * key 5, the isolation helper, turntable framing, the
 * Place in scene placement, and the command tap a sculpt run listens to.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// The toolbar's import graph is the whole studio, so its MODES table is read
// from source: every `{ id, key }` row of `const MODES = [...]`.
const toolbar = readFileSync(new URL("../src/shell/ViewportToolbar.jsx", import.meta.url), "utf8");
const modesBlock = toolbar.match(/const MODES = \[([\s\S]*?)\n\];/)?.[1] ?? "";
const WORKFLOW_MODES = [...modesBlock.matchAll(/\{ id: "(\w+)", key: "(\d)"/g)].map(([, id, key]) => ({ id, key }));
// Every mode is offered (verify-layout pins the text).
assert.ok(toolbar.includes("{MODES.map((mode) => {"));
const {
	SCULPT_LAYER, SCULPT_VIEWS, agentSessionReady, chatgptSignedIn, createCommandTap, isolatedObjectIds,
	sculptAgentClient, sculptFraming, sculptPlacement, sculptTargetFromSelection,
	sculptModelChoice,
	sculptModelLabel,
	readSculptModel,
	storeSculptModel,
} = await import("../src/sculpt-mode.js");
const { placementInFront, SCULPT_KIND } = await import("../src/scene-objects.js");

let failures = 0;
const check = (name, fn) => {
	try { fn(); console.log(`PASS ${name}`); }
	catch (error) { failures += 1; console.log(`FAIL ${name} - ${error.message}`); }
};
const close = (actual, expected, label) => assert.ok(Math.abs(actual - expected) < 1e-9, `${label}: ${actual} != ${expected}`);

check("the mode list ends with Sculpt on key 5", () => {
	assert.deepEqual(WORKFLOW_MODES.map((mode) => [mode.id, mode.key]), [["scene", "1"], ["pose", "2"], ["camera", "3"], ["motion", "4"], ["sculpt", "5"]]);
});

check("App binds Digit5 to sculpt", () => {
	const app = readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");
	assert.ok(app.includes('Digit4: "motion", Digit5: "sculpt" }[event.code]'));
});

const objects = [
	{ id: "box", renderer: "box" },
	{ id: "sculpt", renderer: SCULPT_KIND },
	{ id: "sculpt-2", renderer: SCULPT_KIND },
];

check("isolation keeps the target id and nothing else", () => {
	assert.deepEqual(isolatedObjectIds(objects, "sculpt-2"), ["sculpt-2"]);
	assert.deepEqual(isolatedObjectIds(objects, "gone"), []);
	assert.deepEqual(isolatedObjectIds(objects, null), []);
});

check("the selected sculpt is the target; anything else means a new sculpt", () => {
	assert.equal(sculptTargetFromSelection(objects, "sculpt"), "sculpt");
	assert.equal(sculptTargetFromSelection(objects, "box"), null);
	assert.equal(sculptTargetFromSelection(objects, null), null);
});

check("the turntable layer is not one dualview owns", () => {
	assert.ok(![2, 3, 4, 5].includes(SCULPT_LAYER));
});

check("front, side and back frame the sculpt from its own front, left and back", () => {
	const object = { x: 1, y: 0, z: -2, rot: 0 };
	const size = { width: 1, height: 2, depth: 1 };
	const front = sculptFraming(object, size, "front");
	assert.deepEqual(front.target, [1, 1, -2]);
	assert.ok(front.position[2] > front.target[2] && Math.abs(front.position[0] - 1) < 1e-9, "front looks from +Z");
	const side = sculptFraming(object, size, "side");
	assert.ok(side.position[0] > 1 && Math.abs(side.position[2] + 2) < 1e-9, "side looks from the subject's left (+X)");
	const back = sculptFraming(object, size, "back");
	assert.ok(back.position[2] < -2, "back looks from -Z");
	const turned = sculptFraming({ ...object, rot: 90 }, size, "front");
	assert.ok(turned.position[0] > 1, "a sculpt turned 90° is framed from its turned front");
	assert.deepEqual(Object.keys(SCULPT_VIEWS), ["front", "side", "back"]);
	// The whole sculpt fits the lens: distance clears the bounding radius.
	const distance = Math.hypot(front.position[0] - 1, front.position[1] - 1, front.position[2] + 2);
	assert.ok(distance > front.radius / Math.sin((17.5 * Math.PI) / 180));
});

check("Place in scene stands the sculpt on the ground where + Add would put it", () => {
	const camera = { x: 3, y: 2, z: 4 };
	const yaw = 0.6;
	const placed = sculptPlacement(camera, yaw);
	assert.deepEqual(placed, { ...placementInFront({ x: 3, z: 4 }, yaw), y: 0 });
	const straight = sculptPlacement({ x: 0, y: 1.6, z: 5 }, 0);
	close(straight.x, 0, "x");
	close(straight.z, 2.4, "z");
	assert.equal(straight.y, 0);
});

check("a throwing tap listener never changes what the wrapped handler returns", () => {
	const tap = createCommandTap();
	tap.subscribe(() => { throw new Error("listener bug"); });
	const receipt = { ok: true, action: "object.sculpt", status: "applied", receiptId: "t1", affectedIds: ["sculpt"] };
	const handlers = tap.wrap({ run_action: () => receipt });
	const quiet = console.error;
	console.error = () => {};
	try { assert.equal(handlers.run_action({ args: { action: "object.sculpt", args: {} } }), receipt); }
	finally { console.error = quiet; }
});

check("the command tap reports finished receipts once, with job output and inner args", () => {
	const tap = createCommandTap();
	const busListeners = new Set();
	const bus = { subscribe(listener) { busListeners.add(listener); return () => busListeners.delete(listener); } };
	const events = [];
	const off = tap.subscribe((event) => events.push(event), bus);
	const sculptReceipt = { ok: true, action: "object.sculpt", status: "applied", receiptId: "r1", affectedIds: ["sculpt"] };
	const handlers = tap.wrap({ run_action: () => sculptReceipt, verify: () => ({ ok: true, receiptId: "x" }) });
	handlers.run_action({ args: { action: "object.sculpt", args: { id: "sculpt", edits: [] } } });
	handlers.verify({});
	assert.equal(events.length, 1);
	assert.equal(events[0].action, "object.sculpt");
	assert.deepEqual(events[0].args, { id: "sculpt", edits: [] });
	assert.deepEqual(events[0].result.affectedIds, ["sculpt"]);

	const compare = { ok: true, action: "sculpt.compare", status: "completed", receiptId: "r2", output: { report: { iou: 0.91 }, sheetDataUrl: "data:image/png;base64,AA==" } };
	tap.report({ args: { action: "sculpt.compare", args: {} } }, { ok: true, action: "sculpt.compare", status: "started", receiptId: "r0" });
	tap.report({ args: { action: "sculpt.compare", args: {} } }, compare);
	for (const listener of busListeners) listener({ type: "job.completed", receipt: compare });
	assert.equal(events.length, 2, "a started job and a job reported twice add one event");
	assert.equal(events[1].result.report.iou, 0.91);
	assert.equal(events[1].result.sheetDataUrl, "data:image/png;base64,AA==");

	tap.report(null, { ok: false, action: "object.sculpt", receiptId: "r3" });
	assert.equal(events.length, 2, "a refusal is not reported");
	off();
	assert.equal(busListeners.size, 0, "unsubscribing leaves the bus");
});

{
	const tap = createCommandTap();
	const events = [];
	tap.subscribe((event) => events.push(event));
	const handlers = tap.wrap({ run_action: async () => ({ ok: true, action: "object.sculpt", receiptId: "a1" }) });
	await handlers.run_action({ args: { action: "object.sculpt", args: { recipe: {} } } });
	check("an async live handler is reported when it settles", () => assert.equal(events.length, 1));
}

{
	const tap = createCommandTap();
	const busListeners = new Set();
	const bus = { subscribe(listener) { busListeners.add(listener); return () => busListeners.delete(listener); } };
	const events = [];
	tap.subscribe((event) => events.push(event), bus);
	const turnId = crypto.randomUUID();
	const handlers = tap.wrap({ run_action: (request) => ({ ok: true, action: request.args.action, status: request.args.action === "sculpt.compare" ? "started" : "applied", receiptId: crypto.randomUUID(), jobId: "job-1" }) });
	handlers.run_action({ turnId, args: { action: "object.sculpt", args: {} } });
	handlers.run_action({ args: { action: "object.sculpt", args: {} } });
	handlers.run_action({ turnId, args: { action: "sculpt.compare", args: {} } });
	for (const listener of busListeners) listener({ type: "job.completed", receipt: { ok: true, action: "sculpt.compare", status: "completed", receiptId: "done-1", jobId: "job-1" } });
	for (const listener of busListeners) listener({ type: "job.completed", receipt: { ok: true, action: "sculpt.compare", status: "completed", receiptId: "done-2", jobId: "job-other" } });
	check("the command tap names the agent turn behind each receipt, a background job included", () => {
		assert.deepEqual(events.map((event) => event.turnId), [turnId, null, turnId, null]);
	});
}

check("leaving Sculpt mode or the scene cancels the run", () => {
	const app = readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");
	assert.match(app, /useEffect\(\(\) => \{\s*if \(!sculptMode\) sculptRunRef\.current\?\.cancel\(\);\s*\}, \[sculptMode\]\);/);
	assert.match(app, /useEffect\(\(\) => \(\) => sculptRunRef\.current\?\.cancel\(\), \[activeSceneId\]\);/);
});

check("Start follows the Agent panel's readiness rule", () => {
	assert.equal(agentSessionReady({ signedIn: true }), true);
	assert.equal(agentSessionReady({ signedIn: false, providersConfigured: 2 }), true);
	assert.equal(agentSessionReady({ signedIn: false, providersConfigured: 0 }), false);
	assert.equal(agentSessionReady(null), false);
	// #970: the blueprint needs the ChatGPT token itself; a provider key alone (the API-key-only user) does not count.
	assert.equal(chatgptSignedIn({ signedIn: true, providersConfigured: 0 }), true);
	assert.equal(chatgptSignedIn({ signedIn: false, providersConfigured: 2 }), false, "API-key-only: Start is ready, the blueprint is not");
	assert.equal(agentSessionReady({ signedIn: false, providersConfigured: 2 }) && !chatgptSignedIn({ signedIn: false, providersConfigured: 2 }), true);
	assert.equal(chatgptSignedIn(null), false);
});

check("the run's agent client carries the live editor context", () => {
	const sent = [];
	const client = sculptAgentClient({ turn: (request, onEvent, signal) => { sent.push({ request, onEvent, signal }); return "ok"; } }, () => ({ host: { workspaceHandle: "h" } }));
	const onEvent = () => {};
	assert.equal(client.turn({ surface: "studio", text: "go", context: null }, onEvent, "signal"), "ok");
	assert.deepEqual(sent[0].request, { surface: "studio", text: "go", context: { host: { workspaceHandle: "h" } } });
	assert.equal(sent[0].onEvent, onEvent);
	assert.equal(sent[0].signal, "signal");
});

check("Sculpt picks a model the sidecar can run: current, then remembered, then the Agent panel's, then the first runnable", () => {
	const advertised = {
		providers: [
			{ id: "openai-codex", signedIn: true, models: [{ key: "openai-codex/gpt-6-astra" }, { key: "openai-codex/gpt-6.1-sol" }] },
			{ id: "anthropic", signedIn: false, models: [{ key: "anthropic/opus" }] },
		],
		models: [
			{ id: "openai-codex/gpt-6-astra", label: "GPT-6 Astra", efforts: ["low", "medium", "high"], defaultEffort: "medium" },
			{ id: "openai-codex/gpt-6.1-sol", label: "GPT-6.1 Sol", efforts: ["medium", "high"] },
			{ id: "anthropic/opus", label: "Opus" },
		],
	};
	const sol = { model: "openai-codex/gpt-6.1-sol", effort: "high" };
	assert.deepEqual(sculptModelChoice(advertised, sol, null, null), sol, "the current pick stays while runnable");
	assert.deepEqual(sculptModelChoice(advertised, null, sol, "openai-codex/gpt-6-astra"), sol, "Sculpt's own memory beats the Agent panel's model");
	assert.deepEqual(sculptModelChoice(advertised, null, null, "openai-codex/gpt-6.1-sol"), { model: "openai-codex/gpt-6.1-sol", effort: null }, "the Agent panel's model is the first default");
	assert.deepEqual(sculptModelChoice(advertised, { model: "anthropic/opus", effort: null }, null, null), { model: "openai-codex/gpt-6-astra", effort: null }, "a provider without a credential is never chosen");
	assert.deepEqual(sculptModelChoice(advertised, { model: "openai-codex/gpt-6-astra", effort: "ultra" }, null, null), { model: "openai-codex/gpt-6-astra", effort: null }, "an effort the model lacks falls back to its default");
	assert.deepEqual(sculptModelChoice({ models: [], providers: [] }, sol, sol, null), { model: "", effort: null }, "no list, no guess");
	assert.equal(sculptModelLabel(advertised, "openai-codex/gpt-6.1-sol"), "GPT-6.1 Sol");
	assert.equal(sculptModelLabel(advertised, "x/unknown"), "x/unknown");
	const store = new Map();
	const storage = { getItem: (key) => store.get(key) ?? null, setItem: (key, value) => store.set(key, value) };
	storeSculptModel(sol, storage);
	assert.deepEqual(readSculptModel(storage), sol);
	assert.equal(readSculptModel({ getItem: () => "{broken" }), null);
});

if (failures) {
	console.log(`${failures} check(s) failed`);
	process.exit(1);
}
console.log("verify-sculpt-mode: all checks passed");
