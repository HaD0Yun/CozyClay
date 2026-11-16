#!/usr/bin/env node
// The bridge between the Studio and the lowvis engine: studioScene (src/lowvis/studio/scene.js) turns the editor's
// describe answer into the scene the motion writer may use, installClip (src/lowvis/studio/install.js) puts a clip
// into the Studio through editor actions. Here on a hand-written describe answer and with a fake action runner.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { studioScene } from "../../src/lowvis/studio/scene.js";
import { installClip } from "../../src/lowvis/studio/install.js";

const box = (id, extra = {}) => ({ id, name: id, renderer: "cube", x: 0, y: 0, z: 0, rot: 0, footprint: { width: 1, depth: 0.5 }, height: 0.8, ...extra });
const describe = {
	characters: [
		{ id: "xb", model: "x-bot-tpose", x: 1, z: 2, rot: 90, scale: 1 },
		{ id: "yb", model: "y-bot-tpose", x: -1, z: 0, rot: 0, scale: 1 },
		{ id: "cap", model: "proxy-figure", x: 0, z: 0, rot: 0, scale: 1 },
		{ id: "imp", model: "rig-abc123", x: 0, z: 0, rot: 0, scale: 1 },
		{ id: "big", model: "x-bot-tpose", x: 0, z: 0, rot: 0, scale: 1.2 },
		{ id: "gone", model: "x-bot-tpose", x: 0, z: 0, rot: 0, scale: 1, hidden: true },
	],
	objects: [
		box("table", { x: 2, z: 1, rot: 30, footprint: { width: 1.2, depth: 0.6 }, height: 0.75 }),
		box("hidden", { hidden: true }),
		box("held", { attach: { characterId: "xb" } }),
		box("tilted", { rotX: 20 }),
		box("rug", { height: 0.01 }),
		box("bench", { x: -2, z: 0.5, rot: 90, footprint: { width: 1.2, depth: 0.5 }, height: 0.9,
			tops: [{ y: 0.45, x0: -0.6, z0: -0.14, x1: 0.6, z1: 0.25 }, { y: 0.9, x0: -0.6, z0: -0.25, x1: 0.6, z1: -0.14 }] }),
		box("crate", { x: 0, z: -2, footprint: { width: 0.5, depth: 0.5 }, height: 0.5, tops: [{ y: 0.5, x0: -0.25, z0: -0.25, x1: 0.25, z1: 0.25 }] }),
	],
};
const near = (a, b, what) => a.forEach((v, i) => assert.ok(Math.abs(v - b[i]) < 1e-3, `${what}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`));

// --- studioScene ---
{
	const { scene, ids } = studioScene(describe);
	assert.deepEqual(scene.props.map(p => p.id), ["table", "bench", "crate"], "hidden, attached, tilted and flat objects are left out");
	assert.deepEqual(scene.characters.map(c => c.id), ["xb", "yb"], "an X Bot and a Y Bot at scale 1 are offered; a hidden one is not");
	assert.deepEqual(ids.characters, { xb: "xb", yb: "yb" });
	assert.deepEqual(ids.switch, ["yb"], "the Y Bot is listed to be switched");
	assert.deepEqual(scene.others, [{ id: "cap", why: "box figure" }, { id: "imp", why: "imported rig" }, { id: "big", why: "scale 1.2" }], "the others say why");
	assert.deepEqual(scene.characters[0], { id: "xb", at: [1, 2], heading: 90 });
	// without the turn flag a prop is the square box around the footprint
	const table = scene.props[0], c = Math.cos(Math.PI / 6), s = Math.sin(Math.PI / 6);
	near(table.size, [1.2 * c + 0.6 * s, 0.75, 1.2 * s + 0.6 * c], "the footprint box of the table");
	assert.equal(table.turn, undefined, "no turn without the flag");
	near(table.at, [2, 0.375, 1], "the table's centre");
	assert.equal(scene.props[1].heights, undefined, "no heights without the tops flag");
	assert.deepEqual(ids.props.table, { id: "table", x: 2, y: 0, z: 1, rot: 30 });
	console.log("ok studioScene: rows left out, X Bot and Y Bot offered, Y Bot to switch, others with reasons, footprint boxes");
}
{
	const { scene } = studioScene(describe, { turn: true });
	const table = scene.props.find(p => p.id === "table");
	assert.deepEqual(table.size, [1.2, 0.75, 0.6], "with turn the table keeps its own size");
	assert.equal(table.turn, 30, "and gets its turn");
	assert.equal(scene.props.find(p => p.id === "crate").turn, undefined, "a prop at turn 0 has no turn field");
	console.log("ok studioScene { turn }: own size and turn 30");
}
{
	const { scene } = studioScene(describe, { turn: true, tops: true });
	const bench = scene.props.find(p => p.id === "bench");
	assert.equal(bench.heights?.length, 2, "a prop with two tops gets heights");
	// rot 90: the object's own +Z points along world +X
	assert.equal(bench.heights[0].y, 0.45);
	near(bench.heights[0].at, [-2 + 0.055, 0.5], "the lower top in the world");
	near(bench.heights[0].size, [1.2, 0.39], "its size along the prop's own sides");
	assert.equal(bench.heights[1].y, 0.9);
	near(bench.heights[1].at, [-2 - 0.195, 0.5], "the higher top in the world");
	assert.equal(scene.props.find(p => p.id === "crate").heights, undefined, "one top at the box's own height adds nothing");
	const square = studioScene(describe, { tops: true }).scene.props.find(p => p.id === "bench");
	near(square.heights[0].size, [0.39, 1.2], "without turn the size is the square box around the top");
	console.log("ok studioScene { tops }: heights in world coordinates");
}

// --- installClip ---
const clip = JSON.parse(readFileSync(new URL("../../public/lowvis/clips/simple/sit.json", import.meta.url), "utf8"));
assert.deepEqual(clip.characters.map(c => c.id), ["a"]);
assert.deepEqual(clip.props.map(p => p.id), ["chair", "mat"]);
function recorder(refuse = null) {
	const calls = [];
	let n = 0;
	const run = async (action, args) => {
		calls.push({ action, args });
		if (action === refuse) return null;
		return { affectedIds: [action === "character.add" ? args.character.id : `obj-${++n}`] };
	};
	return { calls, run, names: () => calls.map(c => c.action) };
}
// the clip's props at the places the clip has them: a known prop is not moved
const known = { chair: { id: "S-chair", x: 0, y: 0, z: 1.6, rot: 0 }, mat: { id: "S-mat", x: 2, y: 0, z: 1.6, rot: 0 } };
{
	const r = recorder(), out = await installClip(clip, r.run);
	assert.deepEqual(r.names(), ["object.sculpt", "object.sculpt", "character.add", "motion.v4.install"], "a new clip makes its props (boxes: sculpts of one box) and its character, then the take");
	assert.equal(out.ok, true);
	assert.deepEqual(out.characterIds, ["lowvis-a"]);
	assert.deepEqual(out.objectIds, ["obj-1", "obj-2"]);
	assert.deepEqual(out.placed, { chair: "obj-1", mat: "obj-2" });
	assert.deepEqual(out.switched, []);
	// the stand-in: one sharp box of the prop's size standing on the object's base, at scale 1 (object.sculpt { id, recipe } re-sculpts it in place)
	assert.deepEqual(r.calls[1].args.recipe, { version: 1, parts: [{ id: "box", shape: "box", size: clip.props[1].size, position: [0, clip.props[1].size[1] / 2, 0], roundness: 0 }] });
	assert.equal(r.calls[1].args.name, "mat");
	assert.deepEqual(Object.keys(r.calls[1].args.placement), ["x", "y", "z", "rot"]);
	assert.equal(r.calls[2].args.character.model, "x-bot-tpose");
	assert.equal(r.calls[3].args.characterId, "lowvis-a");
	console.log("ok installClip, new clip:", r.names().join(", "));
}
{
	const r = recorder(), out = await installClip(clip, r.run, { existing: { characters: { a: "C1" }, props: known, switch: [] } });
	assert.deepEqual(r.names(), ["character.clearWaypoints", "motion.v4.install"], "a known character loses its root path before the take; nothing is added");
	assert.deepEqual(r.calls[0].args, { characterId: "C1" });
	assert.equal(r.calls[1].args.characterId, "C1");
	assert.deepEqual(out, { characterIds: [], objectIds: [], switched: [], placed: { chair: "S-chair", mat: "S-mat" }, ok: true });
	console.log("ok installClip, known character:", r.names().join(", "));
}
{
	const r = recorder(), out = await installClip(clip, r.run, { existing: { characters: { a: "Y1" }, props: known, switch: ["Y1"] } });
	assert.deepEqual(r.names(), ["character.update", "character.clearWaypoints", "motion.v4.install"], "a Y Bot is changed to the clip's rig first");
	assert.deepEqual(r.calls[0].args, { characterId: "Y1", patch: { model: "x-bot-tpose" } });
	assert.deepEqual(out.switched, ["Y1"]);
	assert.equal(out.ok, true);
	console.log("ok installClip, Y Bot switched:", r.names().join(", "));
}
// a ball and a box under 0.05 m tall stay a sphere and a scaled cube (a sculpt measures at least 0.05 m tall)
{
	const still = (pos, n) => ({ pos: Array.from({ length: n }, () => pos).flat(), quat: Array.from({ length: n }, () => [0, 0, 0, 1]).flat() });
	const small = { ...clip, characters: [], props: [{ id: "ball", shape: "sphere", size: [0.3, 0.3, 0.3], ...still([0, 0.15, 0], clip.frameCount) }, { id: "plate", size: [0.3, 0.02, 0.3], ...still([1, 0.01, 0], clip.frameCount) }] };
	const r = recorder(), out = await installClip(small, r.run);
	assert.deepEqual(r.names(), ["object.add", "object.update", "object.add", "object.update"]);
	assert.deepEqual([r.calls[0].args.kind, r.calls[2].args.kind], ["sphere", "cube"]);
	assert.deepEqual(r.calls[3].args.patch, { scaleX: 0.3, scaleY: 0.02, scaleZ: 0.3 });
	assert.deepEqual(out.placed, { ball: "obj-1", plate: "obj-3" });
	console.log("ok installClip, a ball and a thin box stay primitives");
}
for (const refuse of ["object.sculpt", "character.add", "character.clearWaypoints", "character.update"]) {
	const existing = refuse === "character.clearWaypoints" || refuse === "character.update" ? { characters: { a: "Y1" }, props: known, switch: ["Y1"] } : null;
	const r = recorder(refuse), out = await installClip(clip, r.run, { existing });
	assert.equal(out.ok, false, `${refuse} refused: ok false`);
	assert.equal(r.names().at(-1), refuse, `${refuse} refused: no later call (${r.names().join(", ")})`);
	assert.ok(!r.names().includes("motion.v4.install"), `${refuse} refused: no take installed`);
}
console.log("ok installClip, a refused step stops the install");
console.log("PASS verify-lowvis-bridge");
