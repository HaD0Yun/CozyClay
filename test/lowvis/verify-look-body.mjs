#!/usr/bin/env node
// A character at scale 1 is the body of the look the Studio draws it in (src/lowvis/studio/figure.js lookBody): for the
// cube look the owner's 1.50 m body, for the block look the rig's own, as before.
//  1. the manual: at the rig's body it is the manual of before, byte for byte, for every variant and set of switched-off
//     names; at the cube's it states that body's sizes, each the engine's own body at scale 1 to the rounding
//  2. the compile tool (figure cube) builds a body of scale s as the rig's times 0.81 s, tells its scale as written and
//     its height as built, and keeps the scene as written; runScene states the look's body in the manual
//  3. the drawn cube look at scale 1 stands 1.50 m in the T-pose
//  4. installClip: a clip body of the engine's size is the cast member's scale over the look's body; its take is of the
//     engine's size; runMotion's request is the one of the block look
//  5. a stage stored under a look of another body is carried over: each rig character stands as large as before, its
//     take and everything else as stored; a stage of the page's own body (the block look: none) is byte for byte
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OFF, VARIANTS, systemPrompt } from "../../src/lowvis/pi/prompt.mjs";
import { createCompileTool } from "../../src/lowvis/pi/compile-tool.mjs";
import { runScene } from "../../src/lowvis/pi/harness.mjs";
import * as THREE from "three";
import { INDEX as J, REST, TIPS } from "../../src/lowvis/rig17.js";
import { cube } from "../../src/lowvis/looks/cube.js";
import { bodyScale, carriedOver, lookBody, scaleOf, scaleRoom } from "../../src/lowvis/studio/figure.js";
import { studioScene } from "../../src/lowvis/studio/scene.js";
import { installClip } from "../../src/lowvis/studio/install.js";
import { clipTrack, TRACK_RIG } from "../../src/lowvis/studio/take.js";
import { decodeRawTrack } from "../../src/motion-v4/track/codec.js";
import { skeletonFor } from "../../src/motion3/rigs/index.js";
import { createSceneStage, serializeSceneDocument, readSceneDocument } from "../../src/scenes.js";
import { runMotion } from "../../bin/agent/motion-run.mjs";

const B = lookBody("cube"), tmp = mkdtempSync(join(tmpdir(), "look-body-"));
const subsets = list => list.reduce((all, x) => [...all, ...all.map(s => [...s, x])], [[]]);
const SAID = /^Metres, Y up, .*?It stands ([\d.]+) m tall, Hips joint ([\d.]+) m and shoulders ([\d.]+) m over the floor, ([\d.]+) m from shoulder to wrist\.(.*)$/m;
assert.equal(lookBody(), 1, "no look given at launch: the rig's own body");
assert.equal(lookBody("block"), 1);
assert.ok(B > 0 && B < 1, `the cube look has a body of its own (${B})`);
assert.equal(bodyScale({ model: TRACK_RIG, scale: 1.2 }, "cube"), 1.2 * B);
assert.equal(bodyScale({ model: "y-bot-tpose", scale: 1.2 }, "cube"), 1.2, "only the rig the looks are drawn over has the look's body");

// --- 1: the manual ---
{
	let n = 0;
	for (const variant of VARIANTS) for (const off of subsets(OFF)) {
		const plain = systemPrompt(variant, off);
		for (const b of [1, undefined, Number.NaN, "0.81", null, 0, -1]) assert.equal(systemPrompt(variant, off, b), plain, `${variant} -${off}: body ${b} is the manual of the rig's body`);
		const cube = systemPrompt(variant, off, B), said = SAID.exec(cube);
		assert.ok(said[5].startsWith(` That is the engine's reference figure (${TIPS.Head[1].toFixed(2)} m tall) times ${B}: every length the SPEC text and the tool's lines give as the engine's own is the reference figure's, and the engine multiplies it by ${B}`), said[5]);
		assert.equal(cube.replace(said[0], ""), plain.replace(SAID.exec(plain)[0], ""), `${variant} -${off}: nothing but CONVENTIONS' sizes differs`);
		n++;
	}
	assert.doesNotMatch(systemPrompt("studio"), /new figures start at|starts at scale|unless the tool's bodies line/, "no start size is told any more");
	console.log(`ok manual: ${n} manuals of the rig's body as before; at the cube's body only the sizes line differs`);
}

// --- 2: the compile tool and runScene ---
const tool = createCompileTool({ name: "look-body", outDir: join(tmp, "sheets"), clipFile: join(tmp, "clip.json"), variant: "studio", figure: "cube" });
const scene = { frames: 24, characters: [{ id: "n", at: [0, 0], heading: 0 }, { id: "w", at: [1, 0], heading: 0, scale: 1.2 }], props: [] };
const r = tool.call({ scene, spec: { n: [[0, "idle"]], w: [[0, "idle"]] } });
assert.equal(r.status, "ok", r.error);
const built = JSON.parse((await import("node:fs")).readFileSync(tool.clipFile, "utf8"));
assert.deepEqual(built.characters.map(c => c.scale), [B, 1.2 * B], "the clip holds each body at the engine's size");
assert.deepEqual(tool.state.last.scene.characters.map(c => c.scale ?? 1), [1, 1.2], "the scene stays as written");
{
	const said = SAID.exec(systemPrompt("studio", [], B)).slice(1, 5).map(Number), c = built.characters[0];
	const at = j => [0, 1, 2].map(k => c.pos[j * 3 + k]), d = (a, b) => Math.hypot(...a.map((v, k) => v - b[k]));
	const real = [TIPS.Head[1] * B, at(J.Hips)[1], at(J.LeftArm)[1], d(at(J.LeftArm), at(J.LeftForeArm)) + d(at(J.LeftForeArm), at(J.LeftHand))];
	real.forEach((v, k) => assert.ok(Math.abs(said[k] - v) <= 0.03, `size ${k}: the manual's ${said[k]} against the built ${v.toFixed(3)}`));
	assert.match(r.text, new RegExp(`^bodies \\(as built and drawn\\): w: scale 1\\.2 = ${(TIPS.Head[1] * 1.2 * B).toFixed(2)} m tall$`, "m"), "the bodies line: the scale as written, the height as built");
}
for (const [env, b] of [[{ COZYCLAY_FIGURE: "cube" }, B], [{}, 1]]) {
	const record = await runScene({ name: "look-body", request: "x", variant: "studio", env, outDir: join(tmp, "run") });
	assert.equal(record.infraError?.at, "setup", "no proxy in this test: the run stops before a model call");
	assert.equal(record.prompt.systemChars, systemPrompt("studio", [], b, env.COZYCLAY_FIGURE ?? null).length, `${JSON.stringify(env)}: the manual of body ${b} and of that look's drawn parts`);
	assert.equal(record.body, b === 1 ? undefined : b, "the run record names the look's body when it is not the rig's");
}
console.log("ok compile tool and runScene: the cube's scale 1 is built as the rig's times its body, told as written");

// --- 3: the drawn cube look at scale 1 ---
{
	const figure = cube();
	figure.setPose(new Float32Array(REST.flat()), new Float32Array(REST.flatMap(() => [0, 0, 0, 1])), 0);
	figure.object3D.updateMatrixWorld(true);
	const top = new THREE.Box3().setFromObject(figure.object3D).max.y;
	assert.ok(Number.isFinite(top) && Math.abs(top * B - 1.5) < 0.005, `the cube look stands ${(top * B).toFixed(3)} m tall in the T-pose at scale 1`);
	console.log(`ok the cube look at scale 1: ${(top * B).toFixed(3)} m in the T-pose`);
}

// --- 4: installClip and runMotion ---
{
	const steps = [], run = async (action, args) => { steps.push([action, args]); return { affectedIds: [args?.character?.id ?? args?.characterId ?? "x"] }; };
	const clip = JSON.parse(JSON.stringify({ ...built, characters: [built.characters[0], { ...built.characters[1], scale: 0.95 * B }] }));
	const out = await installClip(clip, run, { body: B, source: { name: "agent-x", scene, spec: {} } });
	assert.ok(out.ok);
	const adds = steps.filter(([a]) => a === "character.add").map(([, args]) => args.character.scale);
	assert.deepEqual(adds, [undefined, 0.95], "a body of the cube's scale 1 is a new character at scale 1; one of 0.95 at 0.95");
	const installs = steps.filter(([a]) => a === "motion.v4.install").map(([, args]) => args);
	assert.deepEqual(installs.map(a => a.lowvis), [{ name: "agent-x", scene, spec: {}, as: "n", attached: [] }, { name: "agent-x", scene, spec: {}, as: "w", attached: [] }], "the source goes with every take, with the writer's id of its character and what its install put on its bones (none)");
	assert.deepEqual(installs.map(a => decodeRawTrack(a.raw, skeletonFor(TRACK_RIG)).scale), [B, 0.95 * B], "each take is of the engine's size");
	assert.equal(clipTrack(built, 0).scale, B);
	const DESCRIBE = { characters: [{ id: "c1", model: TRACK_RIG, x: 0, z: 0, rot: 0, scale: 0.8, tint: "#aa3311" }, { id: "c2", model: TRACK_RIG, x: 1, z: 0, rot: 90, scale: 1, tint: null }], objects: [] };
	const go = async env => {
		const runs = [], deps = { studioScene, installClip: async () => ({ characterIds: [], objectIds: [], switched: [], ok: true }), readClip: () => built, runScene: async options => { runs.push(options); return { wallMs: 1000, compiles: 1, report: "Done.\nMissing: none", missing: "none", final: { clip: "clip.json", scene: { characters: [], props: [] }, spec: {} } }; } };
		await runMotion({ words: "they wave", memoryKey: null, hub: { command: async () => DESCRIBE }, workspaceHandle: "ws", invoke: async () => ({ affectedIds: [] }), env, deps });
		return runs[0];
	};
	const plain = await go({}), cube = await go({ COZYCLAY_FIGURE: "cube" });
	assert.equal(cube.request, plain.request, "the request is the block look's: no start size, no scale 1 written out");
	assert.deepEqual(cube.bodies, plain.bodies);
	console.log("ok installClip and runMotion: the cast member's scale is the clip's over the look's body, the take of the engine's size");
}

// --- 5: a stage stored under another body ---
{
	const take = { schema: "cozyclay.take.v3", rig: TRACK_RIG, spec: { schema: "cozyclay.motion-spec.v1", frames: 4, raw: { scale: B } }, placement: { position: [0, 0, 0], yaw: 0 } };
	const stored = { figureBody: B, characters: [{ id: "a", model: TRACK_RIG, scale: 1, motionTake: take }, { id: "b", model: TRACK_RIG, scale: 0.95 }, { id: "y", model: "y-bot-tpose", scale: 0.9 }, { id: "p", model: "proxy-figure", scale: 1 }] };
	const open = createSceneStage(stored); // this page (node: no look given at launch) has the rig's own body
	assert.deepEqual(open.characters.map(c => c.scale), [B, 0.95 * B, 0.9, 1], "each rig character as large as before; other models as stored");
	assert.deepEqual(open.characters[0].motionTake, createSceneStage({ characters: [stored.characters[0]] }).characters[0].motionTake, "its take as stored");
	assert.equal(open.characters[0].motionTake.spec.raw.scale, B, "of the size it was made for");
	assert.equal("figureBody" in open, false, "the page's body is the rig's: no mark");
	assert.deepEqual(open.characters.map(c => bodyScale(c, null)), stored.characters.map(c => bodyScale(c, c.model === TRACK_RIG ? "cube" : null)), "the world size of every character is the stored one");
	const plain = { characters: [{ id: "a", model: TRACK_RIG, scale: 1 }, { id: "b", model: TRACK_RIG, scale: 0.8 }] };
	const doc = { version: 5, activeSceneId: "s", scenes: [{ id: "s", name: "S", objects: [], stage: createSceneStage(plain) }] };
	const once = serializeSceneDocument(readSceneDocument(serializeSceneDocument(doc)).document);
	assert.equal(serializeSceneDocument(readSceneDocument(once).document), once, "a stage of the page's own body loads and saves byte for byte");
	assert.equal(once.includes("figureBody"), false);
	console.log("ok stages: one stored under the cube's body opens with each rig character as large as before; the rig's own is byte-stable");
}

// --- 6: a stored scale up to the Studio's largest keeps its size through the carry; the rig's own body keeps its limits ---
{
	const LIMITS = { min: 0.2, max: 3 }, room = look => scaleRoom(LIMITS, TRACK_RIG, look), inRoom = (v, r) => v >= r.min && v <= r.max;
	assert.deepEqual(room(null), LIMITS, "the rig's own body: the Studio's limits, as before");
	assert.deepEqual(room("block"), LIMITS);
	assert.equal(room("cube").min, 0.2);
	assert.ok(room("cube").max > 3.7 && room("cube").max < 3.71);
	assert.deepEqual(scaleRoom(LIMITS, "y-bot-tpose", "cube"), LIMITS, "another model: the Studio's limits");
	for (const s of [0.2, 0.5, 0.81, 2.43, 2.6, 3]) {
		const over = carriedOver({ model: TRACK_RIG, scale: s }, undefined, "cube"), back = carriedOver({ model: TRACK_RIG, scale: over.scale }, B, null);
		assert.ok(inRoom(over.scale, room("cube")), `a rig-body row at ${s} fits under the cube look (${over.scale})`);
		assert.ok(Math.abs(bodyScale(over, "cube") - s) < 1e-12, "and stands as large");
		assert.ok(inRoom(back.scale, room(null)) && Math.abs(back.scale - s) < 1e-12, "and back under the rig's body");
	}
	assert.equal(scaleOf(0.81 * 0.9, B), 0.9); assert.equal(scaleOf(1.23456789, 1), 1.23456789, "the rig's own body: the size itself");
	console.log("ok limits: a carried row keeps its size from 0.2 to 3 of the rig's body");
}
rmSync(tmp, { recursive: true, force: true });
console.log("PASS verify-look-body");
