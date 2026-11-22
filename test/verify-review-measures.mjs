// The turn's review measures against what the viewport draws and what the scene itself says, so a thing the scene's
// own data means is not told to the model as a failure every round:
// - a sight line passes a see-through part (glass) and the opening of a routed object drawn where its route has it,
//   while an opaque panel, glass its tint or finish makes a wall, a closed body and a body on a route still hide;
// - an object a take draws on its own track from frame 0 is not measured at its scene pose (it is never drawn there),
//   while one the track says is not yet in hand on frame 0, and any object no take moves, still is;
// - a body and what it carries (attached to it, moved by its own take) are not an overlap, while a body standing in
//   anything else still is;
// - a shot that names its subjects judges those only; one that names no one, or lists none, judges as before.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createSceneObject, createSculptObject } from "../src/scene-objects.js";
import { createCharacterEntry } from "../src/scenes.js";
import { framingChecks, placementChecks } from "../src/studio-agent-commands.js";
import { solidOf } from "../src/solid-shape.js";
import { loadMeshScene, loadedMeshScene } from "../src/scene-mesh-cache.js";
import * as THREE from "three";
import { objectTransformAt } from "../src/object-path.js";
import { findingItems, findingLines } from "../bin/agent/review-findings.mjs";

const box = (id, size, position, extra = {}) => ({ id, shape: "box", size, position, ...extra });
const sculpt = (id, recipe, at = {}) => ({ ...createSculptObject({ recipe }).object, id, name: id, ...at });
const cube = (id, at) => ({ ...createSceneObject("cube"), id, name: id, ...at });
// A 1.8 m figure as the editor's bounds port hands it over (its box and posed bones), and an object's box where it is
// drawn on the frame: on its route (object-path.js), else at its own fields; an attached one at the head of its carrier.
const JOINTS = [[0, 0.08, 0.05], [0.1, 0.08, 0], [-0.1, 0.08, 0], [0.1, 0.5, 0], [-0.1, 0.5, 0], [0.1, 0.95, 0], [-0.1, 0.95, 0], [0, 1.0, 0], [0, 1.2, 0], [0, 1.4, 0],
	[0.2, 1.45, 0], [-0.2, 1.45, 0], [0.3, 1.15, 0], [-0.3, 1.15, 0], [0.35, 0.9, 0], [-0.35, 0.9, 0], [0, 1.55, 0], [0, 1.7, 0]];
const ports = (extra = {}) => ({ ...extra, bounds: ({ entity, frame, state }) => {
	if (!entity.renderer) {
		const y = entity.y ?? 0;
		return { min: { x: entity.x - 0.35, y, z: entity.z - 0.15 }, max: { x: entity.x + 0.35, y: y + 1.8, z: entity.z + 0.15 }, points: JOINTS.map(([x, dy, z]) => ({ x: entity.x + x, y: y + dy, z: entity.z + z })) };
	}
	const on = entity.attach ? state.characters.find(c => c.id === entity.attach.characterId) : null;
	const at = on ? { x: on.x, y: 1.55, z: on.z } : objectTransformAt(entity, frame, { frameCount: state.frameCount, fps: 24 }) ?? entity;
	const w = entity.footprint.width * entity.scaleX / 2, d = entity.footprint.depth * entity.scaleZ / 2, h = entity.height * entity.scaleY;
	return { min: { x: at.x - w, y: at.y ?? 0, z: at.z - d }, max: { x: at.x + w, y: (at.y ?? 0) + h, z: at.z + d } };
} });
const scene = (objects, characters = [createCharacterEntry({ id: "ann", subject: "Ann", x: 0, z: 0 })], camera = { x: 0, y: 1.4, z: 5 }) => ({
	frame: 0, frameCount: 48, objects, characters, shotDocument: { shots: [] },
	camera: { position: camera, lookAt: { x: 0, y: 1, z: 0 }, focalMm: 35, sensorId: "fullFrame" }, filmback: { sensorId: "fullFrame", aspectRatio: 16 / 9 } });
const occluded = objects => framingChecks(["ann"], scene(objects), ports()).occluded;

const PANEL = material => ({ parts: [box("frame", [2.2, 0.2, 0.3], [0, 0.1, 0]), box("pane", [2.2, 2.4, 0.1], [0, 1.4, 0], material ? { material } : {})] });
const ARCH = { parts: [box("postL", [0.3, 2.2, 0.3], [-0.8, 1.1, 0]), box("postR", [0.3, 2.2, 0.3], [0.8, 1.1, 0]), box("lintel", [1.9, 0.3, 0.3], [0, 2.35, 0])] };
const BLOCK = { parts: [box("block", [1.9, 2.5, 0.3], [0, 1.25, 0])] };

test("a sight line passes glass: a glass pane or a glass cube in front of the figure hides it no more; a metal pane still does", () => {
	assert.equal(occluded([sculpt("pane", PANEL("glass"), { z: 1.5 })]), false, "a glass pane between the camera and the figure");
	assert.equal(occluded([sculpt("pane", PANEL("metal"), { z: 1.5 })]), true, "the same pane in metal");
	assert.equal(occluded([sculpt("pane", PANEL(null), { z: 1.5 })]), true, "the same pane in clay");
	assert.equal(occluded([cube("glass", { z: 1.5, scaleX: 2, scaleY: 2.5, scaleZ: 0.1, material: "glass" })]), false, "a glass cube");
	assert.equal(occluded([cube("wall", { z: 1.5, scaleX: 2, scaleY: 2.5, scaleZ: 0.1 })]), true, "a clay cube");
});

test("glass a tint or a finish closes still hides: what is behind is drawn times the tint and blurred by the roughness", () => {
	const pane = look => occluded([sculpt("pane", { parts: [box("frame", [2.2, 0.2, 0.3], [0, 0.1, 0]), box("pane", [2.2, 2.4, 0.1], [0, 1.4, 0], look)] }, { z: 1.5 })]);
	const wall = look => occluded([cube("glass", { z: 1.5, scaleX: 2, scaleY: 2.5, scaleZ: 0.1, ...look })]);
	for (const [name, see] of [["a pane", pane], ["a cube", wall]]) {
		assert.equal(see({ material: "glass", color: "#141414" }), true, `${name} of black glass`);
		assert.equal(see({ material: "glass", color: "#3a4a5c" }), true, `${name} of dark blue glass`);
		assert.equal(see({ material: "glass", finish: "matte" }), true, `${name} of frosted glass`);
		assert.equal(see({ material: "glass", color: "#9fb8c8" }), false, `${name} of light blue glass`);
		assert.equal(see({ material: "glass", finish: "gloss" }), false, `${name} of polished glass`);
		assert.equal(see({ material: "glass", finish: "satin" }), false, `${name} of satin glass`);
	}
	assert.equal(occluded([sculpt("pane", { parts: [box("pane", [2.2, 2.6, 0.1], [0, 1.3, 0], { material: "glass" })] }, { z: 1.5 }), cube("wall", { z: 2.5, scaleX: 2, scaleY: 2.5, scaleZ: 0.1 })]), true, "a clay wall behind a glass pane");
	// the record's colour multiplies into its parts' own: the same clear pane under a dark record colour, and under a light one
	assert.equal(occluded([sculpt("pane", PANEL("glass"), { z: 1.5, color: "#202020" })]), true, "a clear pane in a sculpt coloured dark");
	assert.equal(occluded([sculpt("pane", PANEL("glass"), { z: 1.5, color: "#e8e8e8" })]), false, "in a sculpt coloured light");
});

test("an imported model's meshes hide by the material the viewport draws them in", async () => {
	// a slab 2 x 2.5 x 0.1 as OBJ text, one copy of the file per material
	const v = [], f = [];
	for (const x of [-1, 1]) for (const y of [0, 2.5]) for (const z of [-0.05, 0.05]) v.push(`v ${x} ${y} ${z}`);
	for (const [a, c, d, e] of [[0, 1, 3, 2], [4, 6, 7, 5], [0, 4, 5, 1], [2, 3, 7, 6], [0, 2, 6, 4], [1, 5, 7, 3]]) f.push(`f ${a + 1} ${c + 1} ${d + 1} ${e + 1}`);
	const bytes = new TextEncoder().encode([...v, ...f].join("\n"));
	let n = 0;
	const slab = async (material, extra = {}) => {
		const assetId = `mesh-review-slab-${n++}`;
		await loadMeshScene(assetId, { id: assetId, type: "model/obj", bytes });
		if (material) loadedMeshScene(assetId).traverse(node => { if (node.isMesh) node.material = material; });
		return occluded([{ ...createSceneObject("cube"), id: "slab", name: "slab", renderer: "mesh", assetId, footprint: { width: 2, depth: 0.1 }, height: 2.5, z: 1.5, ...extra }]);
	};
	const glass = (fields = {}) => new THREE.MeshPhysicalMaterial({ transmission: 1, roughness: 0.05, color: "#ffffff", ...fields });
	assert.equal(await slab(null), true, "the file's plain material");
	assert.equal(await slab(glass()), false, "clear glass");
	assert.equal(await slab(glass(), { clay: true }), true, "the same file drawn in clay");
	assert.equal(await slab(glass({ color: "#141414" })), true, "black glass");
	assert.equal(await slab(glass({ roughness: 0.9 })), true, "frosted glass");
	assert.equal(await slab(glass({ transmission: 0.2 })), true, "a fifth of the light through");
	assert.equal(await slab(new THREE.MeshStandardMaterial({ transparent: true, opacity: 0.3 })), false, "30% opaque");
	assert.equal(await slab(new THREE.MeshStandardMaterial({ transparent: true, opacity: 0.8 })), true, "80% opaque");
	assert.equal(await slab([glass(), new THREE.MeshStandardMaterial()]), true, "a mesh with a glass and a plain material");
});

test("glass still counts for contact: a point inside a glass part is inside the solid", () => {
	const glass = solidOf(sculpt("pane", PANEL("glass"))), metal = solidOf(sculpt("pane", PANEL("metal")));
	const at = { pos: [0, 0, 0], R: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], half: [1.1, 1.3, 0.15] };
	assert.ok(glass.depth(at, [0, 1.4, 0]) > 0, "inside the glass pane");
	assert.equal(glass.depth(at, [0, 1.4, 0]), metal.depth(at, [0, 1.4, 0]), "the same depth as the opaque pane");
	assert.ok(glass.top(at, { min: [-0.5, 0, -0.05], max: [0.5, 3, 0.05] }) > 2.5, "its top reaches the pane's top");
	// a glass ball is a ball for contact, not its box: the box's corner is outside it, its middle inside, its top the ball's
	const ball = look => solidOf({ ...createSceneObject("sphere"), ...look }), unit = { pos: [0, 0, 0], R: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], half: [0.5, 0.5, 0.5] };
	const clear = ball({ material: "glass" }), clay = ball({}), column = { min: [0.3, 0, 0.3], max: [0.45, 1, 0.45] };
	assert.equal(clear.depth(unit, [0.45, 0.9, 0.45]), 0, "the corner of a glass ball's box is outside the ball");
	assert.equal(clear.depth(unit, [0, 0.5, 0.2]), clay.depth(unit, [0, 0.5, 0.2]), "inside it, as deep as in a clay ball");
	assert.equal(clear.top(unit, column), clay.top(unit, column), "its top over a corner column is the ball's, not the box's");
	assert.ok(clay.top(unit, column) < 0.9, "which is under the box's top");
	assert.equal(clear.hits(unit, [0, 0.5, 3], [0, 0.5, -3]), false, "and a sight line passes it");
	assert.equal(clay.hits(unit, [0, 0.5, 3], [0, 0.5, -3]), true, "not a clay one");
});

test("a routed object hides with its drawn shape where its route has it, not its box", () => {
	const route = { points: [{ x: 0, y: 0, z: 1.5 }, { x: 0, y: 0, z: 30 }] };
	assert.equal(occluded([sculpt("arch", ARCH, { x: 9, z: 9, path: route })]), false, "the figure seen through the opening of an arch on a route");
	assert.equal(occluded([sculpt("block", BLOCK, { x: 9, z: 9, path: route })]), true, "a closed block on the same route");
	assert.equal(occluded([sculpt("arch", ARCH, { x: 9, z: 9 })]), false, "the arch standing at its own place, off the sight line");
});

const take = objects => ({ motion: { schema: "cozyclay.take.v3", frameCount: 48, objects } });
const track = (hold = null) => ({ pos: new Float32Array(48 * 3), quat: new Float32Array(48 * 4), ...(hold ? { hold } : {}) });

test("an object a take draws on its own track from frame 0 is not measured at its scene pose; one not yet in hand is", () => {
	const objects = [cube("cup", { x: 0.3, y: 1.4, z: 0, scaleX: 0.08, scaleY: 0.1, scaleZ: 0.08 })], state = scene(objects);
	assert.deepEqual(placementChecks(["cup"], state, ports()).unsupportedIds, ["cup"], "no take: a cup 1.4 m up stands off the floor");
	assert.deepEqual(placementChecks(["cup"], state, ports({ takes: new Map([["ann", take({ cup: track() })]]) })).unsupportedIds, [], "a take draws it from frame 0 (an engine's take, no spec)");
	const later = new Uint8Array(48).fill(1, 20);
	assert.deepEqual(placementChecks(["cup"], state, ports({ takes: new Map([["ann", take({ cup: track(later) })]]) })).unsupportedIds, ["cup"], "grabbed at frame 20: it stands at its scene pose until then");
	assert.deepEqual(placementChecks(["cup"], state, ports({ takes: new Map([["ann", take({ cup: { vis: new Uint8Array(48) } })]]) })).unsupportedIds, ["cup"], "a switch track moves nothing");
});

test("a body and what it carries are no overlap; a body standing in anything else still is", () => {
	const helmet = cube("helmet", { scaleX: 0.3, scaleY: 0.3, scaleZ: 0.3, attach: { characterId: "ann", bone: "Head" } });
	const crate = cube("crate", { x: 0, z: 0, scaleX: 0.6, scaleY: 1.2, scaleZ: 0.6 });
	const bike = cube("bike", { x: 0, z: 0, scaleX: 0.5, scaleY: 0.9, scaleZ: 1.8 });
	const ids = state => placementChecks(["ann"], state, ports({ takes: new Map([["ann", take({ bike: track() })]]) })).overlapIds;
	assert.deepEqual(placementChecks(["ann"], scene([helmet]), ports()).overlapIds, [], "a helmet attached to her head");
	assert.deepEqual(ids(scene([bike])), [], "a bike her own take moves under her");
	assert.deepEqual(placementChecks(["ann"], scene([bike]), ports()).overlapIds, ["bike"], "the same bike no take moves");
	assert.deepEqual(ids(scene([helmet, crate, bike])), ["crate"], "a crate she stands in");
	const ben = createCharacterEntry({ id: "ben", subject: "Ben", x: 3, z: 0 }), hers = { ...helmet, x: 3, attach: { characterId: "ben", bone: "Head" } };
	assert.deepEqual(placementChecks(["ann"], scene([hers], [createCharacterEntry({ id: "ann", subject: "Ann", x: 3, z: 0 }), ben]), ports()).overlapIds.sort(), ["ben", "helmet"], "another's helmet in her head");
});

test("a body in a thing on a route: inside its solid is told, inside its hollow is not; a carried thing through the set is told", () => {
	// a booth 1.6 m square and 2.1 m tall round her: floor, roof, four corner posts, a low wall and a glass pane on each side
	const posts = [-1, 1].flatMap(x => [-1, 1].map(z => box(`post${x}${z}`, [0.08, 2.1, 0.08], [x * 0.76, 1.05, z * 0.76])));
	const sides = [-1, 1].flatMap(s => [box(`lowz${s}`, [1.6, 0.5, 0.05], [0, 0.25, s * 0.775]), box(`lowx${s}`, [0.05, 0.5, 1.6], [s * 0.775, 0.25, 0]),
		box(`panez${s}`, [1.44, 1.55, 0.02], [0, 1.275, s * 0.775], { material: "glass" }), box(`panex${s}`, [0.02, 1.55, 1.44], [s * 0.775, 1.275, 0], { material: "glass" })]);
	const BOOTH = { parts: [box("floor", [1.6, 0.05, 1.6], [0, 0.025, 0]), box("roof", [1.6, 0.05, 1.6], [0, 2.075, 0]), ...posts, ...sides] };
	const here = { points: [{ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 30 }] }, check = objects => { const state = scene(objects); return { overlap: placementChecks(["ann"], state, ports()).overlapIds, hidden: framingChecks(["ann"], state, ports()).occluded }; };
	assert.deepEqual(check([sculpt("booth", BOOTH, { x: 9, z: 9, path: here })]), { overlap: [], hidden: false }, "in a booth its route has round her: seen through its panes, in no wall");
	assert.deepEqual(check([sculpt("block", { parts: [box("b", [1.6, 2.1, 1.6], [0, 1.05, 0])] }, { x: 9, z: 9, path: here })]), { overlap: ["block"], hidden: true }, "a solid block of the same size on the same route");
	// 0.675 m aside its low wall (5 cm thick, centred 0.775 m from the booth's middle) stands on her left leg's joints (x -0.1)
	assert.deepEqual(check([sculpt("booth", BOOTH, { x: 0.675, z: 9, path: { points: [{ x: 0.675, y: 0, z: 0 }, { x: 0.675, y: 0, z: 30 }] } })]).overlap, ["booth"], "the booth aside: its wall through her leg");
	const helmet = cube("helmet", { scaleX: 0.3, scaleY: 0.3, scaleZ: 0.3, attach: { characterId: "ann", bone: "Head" } }), beam = cube("beam", { x: 0, y: 1.6, z: 0, scaleX: 3, scaleY: 0.2, scaleZ: 0.2 });
	assert.deepEqual(placementChecks(["helmet"], scene([helmet, beam]), ports()).overlapIds, ["beam"], "her helmet in a beam of the set");
});

// The framing result of a whole-clip review: two shots, the driver cut by the frame edge in both.
const framed = shots => ({ checks: { framing: { sampledFrames: [0, 30], sampledChecks: [{ frame: 0, shot: "s1" }, { frame: 30, shot: "s2" }],
	issueFrames: [0, 30].map(frame => ({ frame, codes: ["CLIPPED"], subjects: [{ id: "driver", codes: ["CLIPPED"], inFrame: 0.2, hidden: 0 }] })) } },
	geometry: { subjects: [{ id: "driver" }, { id: "rider" }], shots } });

test("a shot that names its subjects judges those only; a shot that names no one judges as before", () => {
	const lines = shots => findingLines(findingItems({ framing: framed(shots) }));
	assert.deepEqual(lines([{ shotId: "s1", subjectIds: ["rider"] }, { shotId: "s2", subjectIds: ["rider"] }]), [], "the driver is the subject of neither shot");
	assert.deepEqual(lines([{ shotId: "s1", subjectIds: ["driver"] }, { shotId: "s2", subjectIds: ["rider"] }]), ["framing: driver cut by the frame edge at frame 0 (least in the picture: 20% of its body)"], "only the shot that names him");
	assert.deepEqual(lines([{ shotId: "s1", subjectIds: ["driver", "rider"] }, { shotId: "s2", subjectIds: ["driver", "rider"] }]), ["framing: driver cut by the frame edge at frames 0–30 (least in the picture: 20% of its body)"], "shots that name everyone: as before");
	assert.deepEqual(lines(undefined), ["framing: driver cut by the frame edge at frames 0–30 (least in the picture: 20% of its body)"], "no geometry: as before");
	// a shot the geometry lists no subject for (no camera of its own, its named subjects gone) names no one: judged as before
	assert.deepEqual(lines([{ shotId: "s1", subjectIds: [], camera: null }, { shotId: "s2", subjectIds: [] }]), ["framing: driver cut by the frame edge at frames 0–30 (least in the picture: 20% of its body)"], "shots with no listed subject: as before");
	assert.deepEqual(lines([{ shotId: "s1", subjectIds: ["rider"] }, { shotId: "s2", subjectIds: [] }]), ["framing: driver cut by the frame edge at frame 30 (least in the picture: 20% of its body)"], "only the shot that lists none");
});

test("the not-in-the-picture line comes only when no sampled frame shows the figure", () => {
	const out = { codes: ["CLIPPED"], inFrame: 0, hidden: 0 }, part = { codes: ["CLIPPED"], inFrame: 0.4, hidden: 0 };
	const result = (rows, shots) => ({ checks: { framing: { sampledFrames: [0, 30], sampledChecks: [{ frame: 0, shot: "s1" }, { frame: 30, shot: "s2" }],
		issueFrames: [0, 30].flatMap((frame, i) => (rows[i] ? [{ frame, codes: rows[i].codes, subjects: [{ id: "driver", ...rows[i] }] }] : [])) } }, geometry: { subjects: [{ id: "driver" }, { id: "rider" }], shots } });
	const lines = (rows, shots) => findingLines(findingItems({ framing: result(rows, shots) }));
	const rider = { shotId: "s1", subjectIds: ["rider"] }, open = { shotId: "s2", subjectIds: ["driver", "rider"] };
	assert.deepEqual(lines([part, out], [rider, open]), [], "in the picture of the rider's shot, out of the open shot: he is not in that shot, and no line says he is nowhere");
	assert.deepEqual(lines([out, out], [rider, open]), ["framing: not in the picture at any of the 2 sampled frames: driver"], "in no sampled frame at all");
	assert.deepEqual(lines([out, out], [rider, { shotId: "s2", subjectIds: ["rider"] }]), [], "no shot is about him");
	assert.deepEqual(lines([out, out], [{ shotId: "s1", subjectIds: ["driver"] }, open]), ["framing: driver cut by the frame edge at frame 0 (least in the picture: 0% of its body)"], "the shot that names him says he is out of it");
});

test("the overlap line states the ids and the number the evidence carries: the boxes' footprint overlap", () => {
	const crate = cube("crate", { x: 0, z: 0, scaleX: 0.6, scaleY: 1.2, scaleZ: 0.6 }), state = scene([crate]), checks = placementChecks(["ann"], state, ports());
	assert.deepEqual(checks.overlapIds, ["crate"]);
	assert.equal(checks.maximumFootprintOverlapM, 0.3, "her 0.7 x 0.3 m box inside the crate's 0.6 x 0.6 m: 0.3 m on the shorter side");
	assert.deepEqual(findingLines(findingItems({ placement: { checks: { placement: checks } } })), ["placement: overlapping another body: crate (footprints overlap up to 0.3 m)"]);
});
