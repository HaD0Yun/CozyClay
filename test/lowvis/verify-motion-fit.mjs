#!/usr/bin/env node
// Motion first, then dressing. installClip makes a new box as a sculpt of that one box (src/lowvis/studio/install.js),
// so object.sculpt { id, recipe } gives it a look in place through the real objects command: the id, place, turn and
// the take's track (keyed by the id) stay, and one undo takes the look back. motion-fit.mjs: the differences between
// an object and the box the motion used (fitOf), told on the result of an edit of a used object (turnFitView).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { objectsFixture } from "../bus/objects-fixture.mjs";
import { installClip } from "../../src/lowvis/studio/install.js";
import { fitOf, rememberBoxes, turnFitView } from "../../bin/agent/motion-fit.mjs";

// --- dress in place through the editor's own command ---
{
	const clip = JSON.parse(readFileSync(new URL("../../public/lowvis/clips/simple/sit.json", import.meta.url), "utf8"));
	const cup = { id: "cup", size: [0.08, 0.1, 0.08], pos: [], quat: [] }; // carried: it moves along X
	for (let f = 0; f < clip.frameCount; f++) { cup.pos.push(0.5 + f * 0.01, 0.8, 0.3); cup.quat.push(0, 0, 0, 1); }
	clip.props = [clip.props[0], cup];
	const f = objectsFixture([]);
	try {
		let raw = null;
		const run = async (action, args) => {
			if (action === "character.add") return { affectedIds: [args.character.id] };
			if (action === "motion.v4.install") { raw = args.raw; return { affectedIds: [args.characterId] }; }
			const receipt = f.run(action, args, "agent");
			return receipt.ok === false ? null : receipt;
		};
		const out = await installClip(clip, run, { label: "sit" });
		assert.equal(out.ok, true);
		const cupId = out.placed.cup, chairId = out.placed.chair, row = id => f.objects.read().find(object => object.id === id);
		assert.deepEqual([row(chairId).renderer, row(cupId).renderer], ["sculpt", "sculpt"]);
		assert.deepEqual([row(cupId).scaleX, row(cupId).footprint, row(cupId).height], [1, { width: 0.08, depth: 0.08 }, 0.1], "the stand-in measures its box at scale 1");
		assert.deepEqual(Object.keys(raw.objects), [cupId], "the moving prop rides a track under its id");
		const before = row(cupId), bench = row(chairId);
		const dressed = f.run("object.sculpt", { id: cupId, recipe: { version: 1, parts: [{ id: "body", shape: "lathe", size: [0.08, 0.1, 0.08], position: [0, 0.05, 0], profile: [[0, 0], [0.8, 0.02], [1, 1]], material: "ceramic" }, { id: "handle", shape: "torus", size: [0.03, 0.05, 0.01], position: [0.045, 0.05, 0], rotation: [90, 0, 0] }] } }, "agent");
		assert.equal(dressed.ok !== false, true, JSON.stringify(dressed));
		const after = row(cupId);
		assert.deepEqual([after.id, after.x, after.y, after.z, after.rot, after.scaleX, after.scaleY, after.scaleZ], [before.id, before.x, before.y, before.z, before.rot, 1, 1, 1], "id, place, turn and scale stay");
		assert.equal(after.recipe.parts.length, 2);
		assert.deepEqual(Object.keys(raw.objects), [after.id], "the track still names the dressed object");
		assert.equal(row(chairId), bench, "the other stand-in is untouched");
		assert.equal(f.run("edit.undo", { receiptId: dressed.receiptId }, "agent").status, "undone");
		assert.deepEqual(row(cupId).recipe, before.recipe, "one undo takes the look back");
	} finally { f.dispose(); }
	console.log("PASS dress in place: object.sculpt by id keeps id, place, turn, scale and the track; undo takes it back");
}

// --- fitOf ---
const box = { id: "s1", name: "seat", size: [1.2, 0.45, 0.4], base: [0, 0, 1], turn: 90, sphere: false };
const row = extra => ({ id: "s1", x: 0, y: 0, z: 1, rot: 90, footprint: { width: 1.2, depth: 0.4 }, height: 0.45, scaleX: 1, scaleY: 1, scaleZ: 1, tops: [{ y: 0.45, x0: -0.6, z0: -0.2, x1: 0.6, z1: 0.2 }], ...extra });
{
	assert.deepEqual(fitOf(box, row()), [], "a look that keeps its box fits");
	assert.deepEqual(fitOf(box, row({ x: 0.3, rot: 0 })), ["base at [0.3, 0, 1], the box's at [0, 0, 1]", "turn 0°, the box's 90°"]);
	assert.deepEqual(fitOf(box, row({ tops: [{ y: 0.46, x0: -0.6, z0: -0.2, x1: 0.6, z1: 0.2 }] })), [], "1 cm is inside the tolerance");
	assert.deepEqual(fitOf(box, undefined), ["removed: the motion uses it"]);
	assert.deepEqual(fitOf(box, row({ hidden: true })), ["hidden: the motion uses it"]);
	assert.deepEqual(fitOf({ ...box, moves: true }, row({ x: 2, y: 0.9, rot: 0, footprint: { width: 1.5, depth: 0.4 } })), ["width (x) 1.5 m, 0.3 m over the box's 1.2 m"], "a prop that moves: its track has its place and turn, so only the size counts");
	// a box 0.45 m on a side the body sits on; the feet stand on the floor in front of it (+z) and walk in along x = -2..0
	const seat = { id: "s2", name: "block", size: [0.45, 0.45, 0.45], base: [0, 0, 0], turn: 0, sphere: false };
	const feet = [[0.05, 0.35], [-0.05, 0.35], [0.05, 0.45], ...[-2, -1.5, -1, -0.5].map(x => [x, 0.35])];
	const look = extra => ({ id: "s2", x: 0, y: 0, z: 0, rot: 0, footprint: { width: 0.45, depth: 0.45 }, height: 0.88, scaleX: 1, scaleY: 1, scaleZ: 1, ...extra });
	const withBack = [{ y: 0.45, x0: -0.225, z0: -0.17, x1: 0.225, z1: 0.225 }, { y: 0.88, x0: -0.225, z0: -0.225, x1: 0.225, z1: -0.17 }];
	assert.deepEqual(fitOf(seat, look({ tops: withBack }), feet), [], "a part rising above the box away from the body is no difference");
	assert.deepEqual(fitOf(seat, look({ tops: withBack.map((t, k) => (k ? t : { ...t, y: 0.4 })) }), feet),
		["no flat top at the box's top (0.45 m over its base, within 0.02 m) over half its footprint; its flat tops (height over its base: width x depth m): 0.4: 0.45 x 0.4, 0.88: 0.45 x 0.05"], "a top 5 cm lower is a difference");
	assert.deepEqual(fitOf(seat, look({ tops: withBack, footprint: { width: 0.45, depth: 0.8 } }), feet),
		["footprint 0.45 x 0.8 m reaches past the box (0.45 x 0.45 m) onto floor the feet use (2 cells of 0.1 m)"], "a footprint grown into where the feet stand is a difference");
	assert.deepEqual(fitOf(seat, look({ tops: withBack, footprint: { width: 0.8, depth: 0.45 } }), feet), [], "grown away from the feet: no difference");
	console.log("PASS fitOf: only where the body meets the object: place, turn, the flat top at its height, the floor the feet use; a moving prop by its size");
}

// --- turnFitView ---
{
	const scene = { props: [{ id: "seat", size: [1.2, 0.45, 0.4], at: [0, 0.225, 1], turn: 90 }, { id: "lamp", size: [0.2, 1.5, 0.2], at: [3, 0.75, 3] }] };
	rememberBoxes("conv-f", scene, { seat: "s1" });
	let describe = { objects: [row({ tops: [{ y: 0.5, x0: -0.6, z0: -0.2, x1: 0.6, z1: 0.2 }] })] };
	const asked = [];
	const hub = { command: async (name, args, handle) => { asked.push([name, args, handle]); return describe; } };
	const value = { sessionId: "conv-f", context: { host: { workspaceHandle: "ws" } } };
	const tool = answer => ({ name: "run_action", handler: async () => answer });
	const [wrapped] = turnFitView({ value, env: {}, hub, delayMs: 0 }).tools([tool({ ok: true, affectedIds: ["s1"] })]);
	const told = await wrapped.handler({});
	assert.deepEqual(asked[0], ["describe", { tops: true }, "ws"]);
	assert.equal(told.motionFit.fits, false);
	assert.deepEqual(told.motionFit.objects, [{ id: "s1", name: "seat", differs: ["no flat top at the box's top (0.45 m over its base, within 0.02 m) over half its footprint; its flat tops (height over its base: width x depth m): 0.5: 1.2 x 0.4"] }]);
	assert.match(told.motionFit.note, /a drawn part is at each contact/);
	describe = { objects: [row()] };
	assert.deepEqual((await wrapped.handler({})).motionFit, { fits: true, ids: ["s1"] });
	const [other] = turnFitView({ value, env: {}, hub, delayMs: 0 }).tools([tool({ ok: true, affectedIds: ["lamp-2"] })]);
	assert.equal("motionFit" in await other.handler({}), false, "an edit of an object the motion does not use has no fit line");
	const [task] = turnFitView({ value: { sessionId: "task-run", task: { parentId: "conv-f" }, context: value.context }, env: {}, hub, delayMs: 0 }).tools([tool({ ok: true, affectedIds: ["s1"] })]);
	assert.equal((await task.handler({})).motionFit.fits, true, "a task reads the boxes of its coordinator's conversation");
	const list = [tool({ ok: true, affectedIds: ["s1"] })];
	assert.equal(turnFitView({ value, env: { COZYCLAY_MOTION_ENGINE: "old" }, hub }).tools(list), list, "the old engine: the tools as they are");
	console.log("PASS turnFitView: an edit of a used object answers motionFit; others, and the old engine, are unchanged");
}
