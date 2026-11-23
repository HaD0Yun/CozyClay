#!/usr/bin/env node
// The motion writer's scene keeps every object an installed take moves (src/lowvis/studio/scene.js studioScene).
// - In a scene past the prop count (45 crates), a carried pen 9 mm thick (under the 3 cm floor cut), a tilted can and a
//   point effect that a take's object track moves are offered by id, beside the first 40 crates as before; an object of
//   the same name that no take moves gets the second id; an attached object and the moved ones are named with their
//   Studio ids (scene.studioIds); a scene no take moves is offered as it was.
// - Two motions in one conversation on the Studio's own object reducers (studio-draft-harness.mjs studioEditor): the
//   first adds the pen as a stand-in and moves it on a track; the second motion's request lists the pen with its Studio
//   id, and its install moves that object again instead of adding a second pen.
// - What is offered without a take keeps its id and its slot of the counts when a take moves it: of two boxes of one
//   name the second, once a take moves it, is still the second id, and a motion sent again moves that same box; the take
//   read is the stage's (the one the Studio plays), not a cast row's saved one; a tilted object is named as tilted and
//   gets no parts.
// Every scene here is made up for this test.
import assert from "node:assert/strict";
import { buildClip } from "../../src/lowvis/engine-simple/engine.js";
import { serializeClip } from "../../src/lowvis/clip.js";
import { studioScene, POINT } from "../../src/lowvis/studio/scene.js";
import { addStandIn, installClip, standInOf } from "../../src/lowvis/studio/install.js";
import { runMotion } from "../../bin/agent/motion-run.mjs";
import { studioEditor } from "./studio-draft-harness.mjs";

const crate = n => ({ id: `cube-${n}`, name: `Crate ${n}`, renderer: "cube", x: n, y: 0, z: 0, rot: 0, footprint: { width: 1, depth: 1 }, height: 1, scaleX: 0.4, scaleY: 0.4, scaleZ: 0.4 });
const pen = { id: "cube-90", name: "pen", renderer: "sculpt", x: 0.3, y: 1, z: 0.2, rot: 30, footprint: { width: 0.009, depth: 0.054 }, height: 0.009 };
const can = { id: "cylinder-3", name: "can", renderer: "cylinder", x: -1, y: 0.8, z: 0, rot: 0, rotX: 90, footprint: { width: 1, depth: 1 }, height: 1, scaleX: 0.06, scaleY: 0.12, scaleZ: 0.06 };
const smoke = { id: "effect-4", name: "puff", renderer: "effect", effect: { preset: "smoke" }, x: 0, y: 1.5, z: 0, rot: 0, footprint: { width: 0, depth: 0 }, height: 0, parent: null };
const otherPen = { ...crate(91), id: "cube-91", name: "pen" };
const shades = { id: "sculpt-7", name: "shades", renderer: "sculpt", x: 0, y: 0.1, z: 0.1, rot: 0, footprint: { width: 0.14, depth: 0.04 }, height: 0.05, attach: { characterId: "a", bone: "head" } };
const lamps = Array.from({ length: 41 }, (_, n) => ({ id: `light-${n}`, name: `Lamp ${n}`, renderer: "light", light: { type: "point" }, x: n, y: 3, z: 0, rot: 0, footprint: { width: 0, depth: 0 }, height: 0 }));
const objects = [...Array.from({ length: 45 }, (_, n) => crate(n)), otherPen, ...lamps, pen, can, smoke, shades];
const takeOf = ids => ({ spec: { raw: { objects: Object.fromEntries(ids.map(id => [id, { pos: "", quat: "" }])) } } });
const staged = ids => ({ characters: [{ id: "a", model: "x-bot-tpose", x: 0, z: 0, rot: 0, scale: 1 }], objects,
	document: { activeSceneId: "s1", scenes: [{ id: "s0", stage: { characters: [{ id: "a", motionTake: takeOf(["cube-0"]) }] } }, { id: "s1", stage: { characters: [{ id: "a", motionTake: takeOf(ids) }] } }] } });

// --- 1. the scene the writer reads ---
{
	const off = studioScene(staged([]), { turn: true, kinds: true }), on = studioScene(staged(["cube-90", "cylinder-3", "effect-4"]), { turn: true, kinds: true });
	assert.deepEqual(off.scene.props.map(p => p.id).filter(id => /^(pen|can|puff)/.test(id)), [], "no take moves them: the pen (thin), the can (tilted) and the puff (past 40 point objects) are left out, as before");
	assert.equal(off.scene.props.filter(p => !p.kind).length, 40, "40 solids");
	assert.equal(off.scene.studioIds?.shades, "sculpt-7", "the attached shades are named with their Studio id");
	assert.ok(!studioScene(staged([]), { turn: true, kinds: true }).scene.props.some(p => p.id === "pen_2"), "the plain pen crate is past the 40");
	const props = Object.fromEntries(on.scene.props.map(p => [p.id, p]));
	assert.deepEqual(props.pen, { id: "pen", size: [0.009, 0.009, 0.054], at: [0.3, 1.005, 0.2], turn: 30 }, "the pen a take moves, by its own box and turn");
	assert.deepEqual(props.can.size, [0.06, 0.12, 0.06]);
	assert.deepEqual(props.can.at, [-1, 0.8, 0.06], "the tilted can, upright about its centre (its base turned 90 degrees about X)");
	assert.deepEqual([on.ids.props.can.x, on.ids.props.can.y, on.ids.props.can.z].map(v => Math.round(v * 1000) / 1000), [-1, 0.74, 0.06], "the base the install compares with is that upright box's");
	assert.deepEqual(props.puff, { id: "puff", size: [POINT, POINT, POINT], at: [0, 1.5, 0], kind: "effect smoke", hollow: true });
	assert.equal(on.ids.props.pen.id, "cube-90", "the pen id is the object the take moves, not the crate named pen");
	assert.deepEqual(on.scene.studioIds, { pen: "cube-90", can: "cylinder-3", puff: "effect-4", shades: "sculpt-7" });
	assert.deepEqual(on.scene.props.filter(p => !p.kind && !["pen", "can"].includes(p.id)), off.scene.props.filter(p => !p.kind), "the 40 crates are the ones offered before");
	assert.equal(on.scene.props.filter(p => p.kind).length, 41, "40 lamps and the puff");
	assert.deepEqual(on.scene.tilted, ["can"], "the can is named as standing tilted");
	assert.equal(off.scene.tilted, undefined);
	// its drawn parts are measured in its own frame, which is the prop's own (the take turns the prop as the object is turned): told as when upright
	const topped = staged(["cylinder-3", "cube-2"]), drawn = [{ name: "a", at: [0, 0.02, 0], size: [0.05, 0.04, 0.05] }, { name: "b", at: [0, 0.05, 0], size: [0.02, 0.02, 0.02] }];
	topped.objects = topped.objects.map(o => (["cylinder-3", "cube-2"].includes(o.id) ? { ...o, parts: drawn } : o));
	const bridged = studioScene(topped, { turn: true, kinds: true, tops: true }), withTops = Object.fromEntries(bridged.scene.props.map(p => [p.id, p]));
	assert.deepEqual(withTops.can.parts, [{ name: "a", at: [0, -0.04, 0], size: [0.05, 0.04, 0.05] }, { name: "b", at: [0, -0.01, 0], size: [0.02, 0.02, 0.02] }], "the tilted can a take moves has its parts, from the centre of its upright box");
	assert.deepEqual(bridged.ids.shapes.can, { h: 0.12, parts: drawn }, "and its shape from its base, for the motion tool");
	assert.equal(withTops.Crate_2.parts.length, 2, "an upright crate a take moves keeps its parts");
	// a take that moves offered objects (crates 3 and 39) changes nothing of what is offered but the Studio ids line
	const inCount = studioScene(staged(["cube-3", "cube-39"]), { turn: true, kinds: true });
	assert.deepEqual([inCount.scene.props, inCount.ids], [off.scene.props, off.ids], "the same props under the same ids: a moved crate keeps its slot of the 40");
	assert.deepEqual(inCount.scene.studioIds, { Crate_3: "cube-3", Crate_39: "cube-39", shades: "sculpt-7" });
	// the take the Studio plays is the stage row's: a cast row's saved take that moved the pen does not count against it
	const stale = staged([]);
	stale.characters = [{ ...stale.characters[0], motionTake: takeOf(["cube-90"]) }];
	assert.ok(!studioScene(stale, { turn: true, kinds: true }).scene.props.some(p => p.id === "pen"), "the stage's take moves no pen");
	assert.equal(studioScene({ ...stale, document: undefined }, { turn: true, kinds: true }).scene.studioIds.pen, "cube-90", "a describe with no stage rows: the cast row's take");
	// two boxes of one name, both offered: once a take moves the second it is still the second id
	const twin = n => ({ ...crate(n), name: "Box" }), pair = ids => ({ ...staged(ids), objects: [twin(1), twin(2)] });
	const [early, late] = [studioScene(pair([]), { turn: true }), studioScene(pair(["cube-2"]), { turn: true })];
	assert.deepEqual([late.scene.props, late.ids], [early.scene.props, early.ids], "the ids name the same boxes before and after the take");
	assert.deepEqual(late.scene.studioIds, { Box_2: "cube-2" });
	console.log("ok studioScene: a thin, a tilted and a point object a take moves are offered past the counts, by id, with their Studio ids; what was offered keeps its id and slot");
}

// --- 2. two motions in one conversation: the second moves the first one's pen again ---
{
	const studio = studioEditor(), raws = new Map();
	for (let n = 0; n < 42; n++) await studio.run("object.add", { kind: "cube", name: `Crate ${n}`, placement: { x: n - 20, y: 0, z: 6 } }).then(r => studio.run("object.update", { id: r.affectedIds[0], patch: { scaleX: 0.4, scaleY: 0.4, scaleZ: 0.4 } }));
	const run = async (action, args) => { if (action === "motion.v4.install") raws.set(args.characterId, args.raw); return studio.run(action, args); };
	const hub = { command: async (name, args) => ({ ...studio.describe(args), document: { activeSceneId: "s1", scenes: [{ id: "s1", stage: { characters: [...raws].map(([id, raw]) => ({ id, motionTake: { spec: { raw } } })) } }] } }) };
	const requests = [], scenes = [];
	const writer = (scene, spec) => async ({ request }) => { requests.push(request); scenes.push(scene(request)); return { wallMs: 0, compiles: 1, report: "Done.\nMissing: none", missing: "none", final: { clip: "c.json", scene: scenes.at(-1), spec } }; };
	const SPEC = { a1: [[0, "idle"]], pen: [[0, "move", { to: [0.6, 0.9, 0.5], over: 20 }]] };
	const clipOf = (scene, spec) => JSON.parse(serializeClip(buildClip(structuredClone({ demo: "x", ...spec }), structuredClone({ ...scene, props: scene.props.map(p => (spec[p.id] ? { ...p, moves: true } : p)) })).clip));
	const call = (scene, spec = SPEC) => runMotion({ words: "he twirls the pen", memoryKey: "conv", hub, workspaceHandle: "ws", invoke: run, env: {},
		deps: { studioScene, installClip, addStandIn, standInOf, runScene: writer(scene, spec), readClip: () => clipOf(scenes.at(-1), spec) } });
	const first = await call(() => ({ frames: 30, characters: [{ id: "a1", at: [0, 0], heading: 0 }], props: [{ id: "pen", size: [0.009, 0.009, 0.054], at: [0.3, 1, 0.2] }] }));
	const made = studio.named("pen");
	assert.equal(made.length, 1, "the first motion adds the pen");
	assert.deepEqual(first.objectIds.slice(0, 1), [made[0].id]);
	assert.ok(Object.keys([...raws.values()][0].objects).includes(made[0].id), "its take moves the pen on a track");
	await call(request => {
		const listed = JSON.parse(request.split("\n").find(line => line.startsWith('{"characters"'))).props.find(p => p.id === "pen");
		assert.ok(listed, "the second request lists the pen although 42 crates come before it and it is 9 mm thick");
		assert.ok(request.includes(`The objects a take already moves or a bone carries, as your ids and the Studio's: pen = ${made[0].id}.`), "and names its Studio id");
		return { frames: 30, characters: [{ id: "a1", at: [0, 0], heading: 0 }], props: [{ ...listed, at: [listed.at[0], listed.at[1] + 0.1, listed.at[2]] }] };
	});
	assert.deepEqual(studio.named("pen").map(row => row.id), [made[0].id], "the second motion moves the same pen: no second stand-in");
	// the pen is tilted in the Studio (another caller's edit): the third request lists it upright about the centre it has
	// there and says so, and a motion that leaves it in place does not touch it
	await studio.run("object.update", { id: made[0].id, patch: { rotX: 90 } });
	const lying = studio.row(made[0].id), half = lying.height * lying.scaleY / 2, before = JSON.stringify(lying);
	await call(request => {
		const listed = JSON.parse(request.split("\n").find(line => line.startsWith('{"characters"'))).props.find(p => p.id === "pen");
		assert.deepEqual(listed.at, [lying.x, lying.y, lying.z + half].map(v => Math.round(v * 1000) / 1000), "its centre as it lies: half its height along +z of its base");
		assert.ok(request.includes(`pen = ${made[0].id} (tilted in the Studio, upright here about the same centre).`), "the request says the pen stands tilted");
		return { frames: 30, characters: [{ id: "a1", at: [0, 0], heading: 0 }], props: [listed] };
	}, { a1: [[0, "idle"]] });
	assert.equal(JSON.stringify(studio.row(made[0].id)), before, "left in place: the tilted pen is as it was");
	console.log("ok runMotion: a later motion in the conversation moves the pen its first take moved, past 42 crates, without a new stand-in; a tilted one is told as tilted");
}

// --- 3. two boxes of one name: a motion sent again moves the box it moved before ---
{
	const studio = studioEditor(), raws = new Map();
	for (const x of [-1.5, 1.5]) await studio.run("object.add", { kind: "cube", name: "Box", placement: { x, y: 0, z: 1 } }).then(r => studio.run("object.update", { id: r.affectedIds[0], patch: { scaleX: 0.4, scaleY: 0.4, scaleZ: 0.4 } }));
	const [left, right] = studio.named("Box").map(row => row.id);
	const run = async (action, args) => { if (action === "motion.v4.install") raws.set(args.characterId, args.raw); return studio.run(action, args); };
	const hub = { command: async (name, args) => ({ ...studio.describe(args), document: { activeSceneId: "s1", scenes: [{ id: "s1", stage: { characters: [...raws].map(([id, raw]) => ({ id, motionTake: { spec: { raw } } })) } }] } }) };
	const SPEC = { a1: [[0, "idle"]], Box_2: [[0, "move", { to: [2, 0.2, 1.5], over: 20 }]] }, requests = [];
	let scene = null;
	const clipOf = () => JSON.parse(serializeClip(buildClip(structuredClone({ demo: "x", ...SPEC }), structuredClone({ ...scene, props: scene.props.map(p => (p.id === "Box_2" ? { ...p, moves: true } : p)) })).clip));
	const call = () => runMotion({ words: "the far box slides", memoryKey: "twins", hub, workspaceHandle: "ws", invoke: run, env: {}, deps: { studioScene, installClip, addStandIn, standInOf, readClip: clipOf,
		runScene: async ({ request }) => {
			requests.push(request);
			// the first call writes its scene from the request's; the second sends the scene and spec the tool holds
			scene ??= { frames: 30, characters: [{ id: "a1", at: [0, 0], heading: 0 }], props: JSON.parse(request.split("\n").find(line => line.startsWith('{"characters"'))).props };
			return { wallMs: 0, compiles: 1, report: "Done.\nMissing: none", missing: "none", final: { clip: "c.json", scene, spec: SPEC } };
		} } });
	await call();
	assert.deepEqual(Object.keys(raws.get("a1").objects), [right], "the first motion moves the second box");
	await call();
	assert.ok(requests[1].includes(`as your ids and the Studio's: Box_2 = ${right}.`), "the second request names the moved box by the id it had");
	assert.ok(!/differs from it/.test(requests[1]), "and the Studio scene is the scene the tool holds");
	assert.deepEqual(Object.keys(raws.get("a1").objects), [right], "the same motion again moves the same box");
	assert.deepEqual([studio.row(left).x, studio.row(right).x], [-1.5, 1.5], "both boxes stand where they stood");
	console.log("ok runMotion: of two boxes of one name the one a take moves keeps its id, and the motion sent again moves it again");
}
