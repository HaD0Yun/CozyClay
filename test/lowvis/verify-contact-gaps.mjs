#!/usr/bin/env node
// How far each contact of a motion is from what the Studio draws (src/lowvis/studio/gaps.js, the live query contact_gaps)
// and what the Studio agent is told of it (bin/agent/motion-fit.mjs, motion-door.mjs):
//  1. gaps.js on drawn sculpts (box parts: the signed distance of every probe is checked against this test's own box
//     arithmetic): a look of 1 part and of 40, larger and smaller than its box, the plain stand-in (no look yet); the
//     surface a seat rests on: under it, or the top of the part it is inside;
//  2. on the real door (turnMotionDoor, the draft harness's editor and scripted writer, the engine): the draft names the
//     contacts, a look edit answers motionFit with the gaps, the install answers contacts and gaps; a motion whose
//     bodies meet no object answers as before (no contacts, no gaps).
import "./block-figure.mjs"; // the block figure's numbers (figure.js: the launch names the look)
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import * as THREE from "three";
import { buildSculptGroup } from "../../src/sculpt-geometry.js";
import { contactGaps } from "../../src/lowvis/studio/gaps.js";
import { auxOf, contactsOf, gapLine, gapsOf, probesOf } from "../../src/lowvis/studio/contacts.js";
import { turnMotionDoor } from "../../bin/agent/motion-door.mjs";
import { bodiesOf, turnFitView } from "../../bin/agent/motion-fit.mjs";
import { addStandIn, installClip, standInOf } from "../../src/lowvis/studio/install.js";
import { studioScene } from "../../src/lowvis/studio/scene.js";
import { part, prop, recipe, scriptedWriter, stage, studioEditor, tick, written } from "./studio-draft-harness.mjs";

/** The stage as the Studio draws it: one group per shown record at its base pivot, turn and scale (a sculpt: its recipe). */
function drawn(rows) {
	const scene = new THREE.Scene();
	for (const row of rows) {
		if (row.hidden) continue;
		const group = new THREE.Group();
		group.userData.sceneObjectId = row.id;
		group.position.set(row.x, row.y ?? 0, row.z);
		group.rotation.set(((row.rotX ?? 0) * Math.PI) / 180, ((row.rot ?? 0) * Math.PI) / 180, ((row.rotZ ?? 0) * Math.PI) / 180);
		group.scale.set(row.scaleX ?? 1, row.scaleY ?? 1, row.scaleZ ?? 1);
		group.add(row.renderer === "sculpt" ? buildSculptGroup(row.recipe) : new THREE.Mesh(new THREE.BoxGeometry(row.footprint.width, row.height, row.footprint.depth).translate(0, row.height / 2, 0)));
		scene.add(group);
	}
	return scene;
}
/** Signed distance from p to a union of boxes ({ size, position: centre }): to the nearest outside, minus the deepest depth inside. */
function boxes(parts, p) {
	let near = Infinity, deep = 0;
	for (const { size, position } of parts) {
		const e = [0, 1, 2].map(k => Math.abs(p[k] - position[k]) - size[k] / 2), out = Math.hypot(...e.map(v => Math.max(v, 0))), inside = Math.max(...e);
		if (inside < 0) deep = Math.max(deep, -inside); else near = Math.min(near, out);
	}
	return deep > 0 ? -deep : near;
}

// --- 1. gaps.js on drawn looks ---
{
	// a hand the engine puts on a table top (the box's top, 0.75 m), the table at [0, 0, 0.6]
	const w = written(stage([prop("table", [0.8, 0.75, 0.6], [0, 0, 0.6])]), { a1: [[0, "idle"], [0, "pose", { R: { on: "table", at: [0.1, 0.375, -0.1] }, over: 12 }]] });
	const rows = contactsOf(w.clip, auxOf(w.scene, w.clip ? w.spec : null, w.clip)).get("table"), probes = probesOf(w.clip, "table", rows);
	assert.deepEqual(rows.map(r => `${r.who} ${r.part}`), ["a1 right hand"]);
	const looks = {
		"no look yet (the stand-in)": [part("box", [0.8, 0.75, 0.6], [0, 0, 0])],
		"1 part, smaller (the left half of the top)": [part("top", [0.4, 0.04, 0.6], [-0.2, 0.71, 0])],
		"40 parts": [part("top", [0.8, 0.04, 0.6], [0, 0.71, 0]), ...Array.from({ length: 39 }, (_, k) => part(`slat${k}`, [0.015, 0.7, 0.015], [-0.38 + k * 0.02, 0, -0.28]))],
		"larger (twice the box)": [part("block", [1.6, 1.5, 1.2], [0, 0, 0])],
	};
	const told = {};
	for (const [name, list] of Object.entries(looks)) {
		const row = { id: "t1", renderer: "sculpt", recipe: recipe(...list), x: 0, y: 0, z: 0.6, rot: 0 };
		const ask = { objects: [{ id: "t1", points: [...probes.parts, ...probes.inside].map(p => p.local), columns: [] }] }, got = contactGaps(() => drawn([row]))(ask).objects[0];
		assert.equal(got.drawn, true);
		ask.objects[0].points.forEach((pts, i) => pts.forEach((p, j) => assert.ok(Math.abs(got.points[i][j] - boxes(list, p)) < 1e-3, `${name}: point ${i}.${j} ${got.points[i][j]} vs ${boxes(list, p)}`)));
		const n = probes.parts.length, line = gapLine("table (t1)", gapsOf(rows, probes, { parts: got.points.slice(0, n), inside: got.points.slice(n), seats: [] }));
		told[name] = line;
	}
	assert.doesNotMatch(told["no look yet (the stand-in)"] ?? "", /right hand/, "the stand-in is the box: the hand is on it (what the motion itself puts in the box is told as it is)");
	assert.equal(told["40 parts"], null, "a top over the hand");
	assert.match(told["1 part, smaller (the left half of the top)"], /^table \(t1\), off the drawn look: a1 right hand at \[[^\]]+\] f\d+-59: \d+ mm from the drawn look$/);
	assert.match(told["larger (twice the box)"], /a1 right hand at .*: \d+ mm inside the drawn look/);
	assert.deepEqual(contactGaps(() => drawn([]))({ objects: [{ id: "t1", points: [[[0, 0, 0]]] }] }).objects, [{ id: "t1", drawn: false }], "nothing drawn: no numbers");
	// the surface under a point 0.58 m up: a top below it, the top of the solid part it is inside, the floor of a hollow
	// shell (a lid over it is not what it rests on), a roof over an open seat left out, a hump that rises 0.04 m behind
	// the point (in its column, the point not in it) left out too; nothing drawn there: null
	const column = (list, at = [0, 0, 0.58]) => contactGaps(() => drawn([{ id: "s", renderer: "sculpt", recipe: recipe(...list), x: 0, y: 0, z: 0, rot: 0 }]))({ objects: [{ id: "s", columns: [at] }] }).objects[0].columns[0];
	const seat = part("seat", [0.4, 0.45, 0.4], [0, 0, 0]);
	assert.deepEqual([column([seat]), column([part("block", [0.4, 0.9, 0.4], [0, 0, 0])]), column([part("floor", [0.4, 0.05, 0.4], [0, 0, 0]), part("lid", [0.4, 0.05, 0.4], [0, 0.85, 0])]), column([seat, part("roof", [0.4, 0.05, 0.4], [0, 1.6, 0])]), column([seat, part("hump", [0.4, 0.8, 0.06], [0, 0, -0.07])]), column([seat], [1, 1, 0.58])], [0.45, 0.9, 0.05, 0.45, 0.45, null]);
	// the gap of a look from the drawn part of a joint that carries it (a closed solid: a box 0.2 x 0.2 x 0.2 m whose top is
	// 0.04 m over the object's base): a look sunk into the part reads how deep it is in it, also a thin one that the part
	// is not in; a look round the part is at it; a look apart reads the distance, also turned
	const lo = [-0.1, -0.16, -0.1], corners = [0, 1, 2, 3, 4, 5, 6, 7].map(i => [0, 1, 2].map(k => lo[k] + ((i >> k) & 1) * 0.2));
	const solid = { v: corners, t: [[0, 2, 1], [1, 2, 3], [4, 5, 6], [5, 7, 6], [0, 1, 4], [1, 5, 4], [2, 6, 3], [3, 6, 7], [0, 4, 2], [2, 4, 6], [1, 3, 5], [3, 7, 5]] };
	const gap = (list, part = solid) => contactGaps(() => drawn([{ id: "h", renderer: "sculpt", recipe: recipe(...list), x: 0, y: 0, z: 0, rot: 0 }]))({ objects: [{ id: "h", solids: [[part], [part]] }] }).objects[0].solids;
	assert.deepEqual([gap([part("brim", [0.26, 0.05, 0.28], [0, 0, 0])]), gap([part("plate", [0.1, 0.01, 0.1], [0, 0, 0])]), gap([part("shell", [0.5, 0.6, 0.5], [0, -0.3, 0])]), gap([part("lifted", [0.26, 0.05, 0.28], [0, 0.09, 0])]), gap([part("beside", [0.1, 0.1, 0.1], [0.25, -0.1, 0])])],
		[[-0.04, -0.04], [-0.04, -0.04], [0, 0], [0.05, 0.05], [0.1, 0.1]], "sunk 40 mm (brim, thin plate), round it, 50 mm over it, 100 mm beside it");
	// the part turned 20 degrees about z: its upper edge rises to 0.1 sin 20 + 0.04 cos 20 = 0.0718 m, 0.018 m under the look
	const sin = Math.sin(Math.PI / 9), cos = Math.cos(Math.PI / 9), tilted = gap([part("lifted", [0.26, 0.05, 0.28], [0, 0.09, 0])], { ...solid, v: corners.map(([x, y, z]) => [x * cos - y * sin, x * sin + y * cos, z]) })[0];
	assert.ok(Math.abs(tilted - 0.018) < 0.0015, `turned: ${tilted}`);
	console.log(`PASS gaps.js: every probe's distance equals the box arithmetic for 4 looks; ${Object.entries(told).map(([k, v]) => `${k}: ${v ?? "within"}`).join(" | ")}; a carrying part: the look sunk in it, round it, apart`);
}

// --- 2. on the real door ---
const proxy = createServer((req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ data: [{ id: "claude-opus-5-5" }] })); });
proxy.listen(0, "127.0.0.1"); await once(proxy, "listening");
const env = { COZYCLAY_FIGURE: "block", CLIPROXY_BASE_URL: `http://127.0.0.1:${proxy.address().port}`, CLIPROXY_API_KEY: "test" };
/** One plain turn on turnMotionDoor over the harness's editor; the hub answers describe and contact_gaps (the drawn stage). */
function turnOf(studio, writer, key) {
	const asked = [], hub = { command: async (name, args) => { asked.push(name); return name === "contact_gaps" ? contactGaps(() => drawn(studio.rows()))(args) : studio.describe(args); } };
	const deps = { runScene: writer.runScene, installClip, addStandIn, standInOf, studioScene, readClip: writer.readClip };
	const value = { sessionId: key, turnId: "t1", text: "the user's words", context: { host: { workspaceHandle: "ws" } } };
	return { asked, hub, value, door: turnMotionDoor({ value, env, hub, tools: { internal: { invoke: async (_, { action, args }) => studio.run(action, args) } }, transaction: { mark: studio.mark, rollback: studio.rollback }, signal: new AbortController().signal, deps }) };
}
try {
	const sit = written(stage([prop("stool", [0.4, 0.45, 0.4], [0, 0, -0.3]), prop("crate", [0.5, 0.5, 0.5], [3, 0, 3])]), { a1: [[0, "sit", { on: "stool", over: 0 }]] });
	const studio = studioEditor(), writer = scriptedWriter([sit, sit]), { door, hub, value, asked } = turnOf(studio, writer, "conv-c");
	const door1 = await door, tools = door1.with([]), result = () => tools.find(tool => tool.name === "motion_result").handler({}, {});
	assert.deepEqual(await door1.handler({ request: "sit on the stool" }, {}), { ok: true, started: true });
	const early = result();
	await writer.step();
	const draft = await early, stool = studio.named("stool")[0].id, crate = studio.named("crate")[0].id;
	assert.deepEqual(draft.contacts, [`stool (${stool}), where bodies meet it: a1 seat at [0, 0.45, 0.02] f0-59`], "the draft names where the body meets the stand-in; the crate no body meets has no row");
	// the agent gives the stool a look whose seat is 10 cm lower: the edit answers the gap
	const [sculpt] = turnFitView({ value, env: {}, hub, delayMs: 0 }).tools([{ name: "object.sculpt", handler: args => studio.run("object.sculpt", args) }]);
	const low = recipe(part("seat", [0.4, 0.04, 0.4], [0, 0.31, 0]), ...[[-0.17, -0.17], [0.17, -0.17], [-0.17, 0.17], [0.17, 0.17]].map(([x, z], k) => part(`leg${k}`, [0.04, 0.31, 0.04], [x, 0, z])));
	const edited = await sculpt.handler({ id: stool, recipe: low });
	assert.equal(edited.motionFit.fits, false);
	const entry = edited.motionFit.objects.find(o => o.id === stool);
	assert.match(entry.gaps, new RegExp(`^stool \\(${stool}\\), off the drawn look: a1 seat at \\[0, 0.45, 0.02\\] f0-59: floats 100 mm over the drawn surface under it$`));
	assert.match(edited.motionFit.note, /a drawn part is at each contact/);
	await writer.step(); await writer.step();
	const done = await result();
	assert.equal(done.installed, true);
	assert.deepEqual(done.contacts, draft.contacts, "the install names the final motion's contacts");
	assert.deepEqual(done.gaps, [entry.gaps], "and how far the drawn look is from them");
	assert.ok(asked.includes("contact_gaps"));
	assert.ok(!done.contacts.some(line => line.includes(crate)));
	// a look taller than the box, the hips inside it: the seat is under that part's top (not "floating" over its underside)
	const tall = (await sculpt.handler({ id: stool, recipe: recipe(part("block", [0.4, 0.9, 0.4], [0, 0, 0])) })).motionFit.objects.find(o => o.id === stool);
	assert.match(tall.gaps, /a1 seat at \[0, 0\.45, 0\.02\] f0-59: sinks 450 mm below the drawn surface/);
	assert.doesNotMatch(tall.gaps, /floats/);
	// a body resized after the install: the contacts' places are the clip's, so an edit says they were not measured and
	// gives no number; the box itself is still compared (the stand-in's own box fits)
	const plain = recipe(part("box", [0.4, 0.45, 0.4], [0, 0, 0])), unread = "not measured (a body's scale is not the one these contacts were read at)";
	assert.deepEqual((await sculpt.handler({ id: stool, recipe: plain })).motionFit, { fits: true, ids: [stool] }, "the body at the motion's size, the look the box: fits, no gap");
	await studio.run("character.update", { characterId: "a1", patch: { scale: 2 } });
	assert.deepEqual((await sculpt.handler({ id: stool, recipe: plain })).motionFit, { fits: true, ids: [stool], gaps: unread });
	const lowAgain = (await sculpt.handler({ id: stool, recipe: low })).motionFit;
	assert.deepEqual([lowAgain.fits, lowAgain.gaps, lowAgain.objects.some(o => "gaps" in o)], [false, unread, false]);
	// and after the take was fitted again to that size (motion-refit.mjs sets the body the fit lines know): the contacts
	// kept are still the first clip's
	bodiesOf("conv-c").set("a1", { id: "a1", scale: 2, tint: null });
	assert.equal((await sculpt.handler({ id: stool, recipe: plain })).motionFit.gaps, unread, "a refit does not read the contacts again");
	await studio.run("character.update", { characterId: "a1", patch: { scale: 1 } });
	assert.match((await sculpt.handler({ id: stool, recipe: low })).motionFit.objects[0].gaps, /floats 100 mm/, "back at the clip's size: measured again");

	// a motion whose body meets no object answers as before: no contacts, no gaps
	const stand = written(stage([prop("crate", [0.5, 0.5, 0.5], [3, 0, 3])]), { a1: [[0, "idle"]] });
	const other = studioEditor(), writer2 = scriptedWriter([stand]), second = turnOf(other, writer2, "conv-d"), door2 = await second.door, tools2 = door2.with([]);
	await door2.handler({ request: "stand" }, {});
	const early2 = tools2.find(tool => tool.name === "motion_result").handler({}, {});
	await writer2.step();
	const draft2 = await early2;
	assert.equal("contacts" in draft2, false);
	await writer2.step();
	const done2 = await tools2.find(tool => tool.name === "motion_result").handler({}, {});
	assert.deepEqual(["contacts" in done2, "gaps" in done2, second.asked.includes("contact_gaps")], [false, false, false]);
	await tick();
	console.log("PASS door: the draft names the contacts, a look edit answers its gaps, the install both; no contact: as before");
} finally { proxy.close(); }
