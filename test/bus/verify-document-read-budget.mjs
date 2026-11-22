#!/usr/bin/env node
// A scene-document read is bounded at its source (sessions 9240db36 and 1c631d0c: one read of motion answered
// 460k characters, each character's take source twice, ~300k tokens a model call for the rest of the turn):
// a take answers its specId, and its spec only for a character named in ids, once and without the scene boxes;
// a read of several kinds keeps under its budget and names what it left out; one kind alone answers whole;
// motion.compile { base } finds the installed take's spec after a reload; one tool result is cut past its limit.
import assert from "node:assert/strict";
import { readElementDocument } from "../../src/commands/elements.js";
import "../../src/commands/elements/motion.js";
import "../../src/commands/elements/character.js";
import "../../src/commands/elements/stage.js";
import "../../src/commands/elements/scene.js";
import "../../src/commands/elements/object.js";
import { specIdOf } from "../../src/motion3/spec-store.js";
import { createStudioAppActions } from "../../src/commands/index.js";
import { resultText, RESULT_CHARS } from "../../bin/agent/pi-tools.mjs";
import { SCENE_OBJECTS, CHARACTER } from "../motion3/fixtures/cup-scene.mjs";

const check = (name, fn) => { fn(); console.log(`PASS ${name}`); };
const chars = value => JSON.stringify(value).length;

// a take source the size of the etst project's (a spec of ~50k characters, scene boxes of ~60k)
const spec = { schema: "cozyclay.motion-spec.v1", fps: 24, frames: 844, label: "driver", keys: Array.from({ length: 400 }, (_, f) => ({ f, set: { yaw: f / 10, spine_pitch: 2.5 } })) };
const scene = { objects: Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`cube-${i}`, { box: { min: [i, 0, 0], max: [i + 1, 1, 1] }, q: [0, 0, 0, 1] }])) };
const source = { schema: "cozyclay.take.v3", rig: "y-bot-tpose", spec, placement: { position: [0, 0, 0], yaw: 0 }, scene };
const take = { resourceId: "restore:char-a:t1", frames: 844, fps: 24, prompt: "driver", studioTakeId: "t1", source };
const row = id => ({ id, take: { ...take, resourceId: `restore:${id}:t1` }, fullTake: { ...take, resourceId: `restore:${id}:t1` }, ikKeys: [], ikPins: [], ikPinResiduals: [], committedIkEdits: [], takeRecipe: null, takeVersions: [] });
const motion = [row("char-a"), row("char-b")];
const before = chars(motion);

check("a motion read answers each take's specId, not its source", () => {
	const read = readElementDocument({ motion }, { select: ["motion"] }, "scene-1");
	const after = chars(read.document.motion);
	for (const r of read.document.motion) for (const t of [r.take, r.fullTake]) {
		assert.equal(t.specId, specIdOf(spec));
		assert.equal(typeof t.source, "string");
		assert.match(t.source, /name this character in ids/);
	}
	assert.ok(after < 2000, `${before} -> ${after}`);
	console.log(`  motion read: ${before} -> ${after} characters`);
});
check("a character named in ids gets its spec and placement once, never the scene boxes", () => {
	const read = readElementDocument({ motion }, { select: ["motion"], ids: ["char-a"] }, "scene-1");
	const [r] = read.document.motion;
	assert.deepEqual(r.take.source.spec, spec);
	assert.deepEqual(r.take.source.placement, source.placement);
	assert.match(r.take.source.scene, /left out \(the 300 scene objects/);
	assert.equal(typeof r.fullTake.source, "string", "the full take is the take: its source is not sent twice");
	assert.ok(chars(r) < chars(spec) + 2000, `${chars(r)}`);
});
check("the cast, the stage and every saved scene answer a saved take's specId too", () => {
	const cast = [{ id: "char-a", subject: "driver", motionTake: { ...source, takeId: "t1" } }];
	const read = readElementDocument({ characters: cast, stage: { characters: cast }, scenes: [{ id: "scene-1", name: "A", order: 0, stage: { characters: cast } }] }, {}, "scene-x");
	for (const c of [read.document.characters[0], read.document.stage.characters[0], read.document.scenes[0].stage.characters[0]]) {
		assert.equal(c.motionTake.specId, specIdOf(spec));
		assert.equal(c.motionTake.takeId, "t1");
		assert.equal(typeof c.motionTake.spec, "string");
	}
	assert.ok(chars(read.document) < 3000, `${chars(read.document)}`);
});
check("a cast row answers the take the motion owner holds now, not the one the scene last saved (a fresh install read null)", () => {
	const raw = { schema: "cozyclay.raw-track.v1", frames: 176, rot: "A".repeat(250_000) }; // a raw take's spec carries its encoded track
	// and the motion writer's scene and spec it was compiled from (motion.v4.install lowvis), which the motion tool reads by itself
	const lowvis = { name: "agent-20261123-000000-abcd", scene: { frames: 176, characters: [{ id: "a", at: [0, 0], heading: 0 }], props: [] }, spec: { a: Array.from({ length: 400 }, (_, i) => [i, "pose", { R: [0.1, 0.2, 0.3], over: 8 }]) } };
	const rawSource = { ...source, spec: { schema: "cozyclay.motion-spec.v1", fps: 24, frames: 176, label: "push", raw, lowvis } };
	const live = [{ ...row("char-a"), take: { ...take, source: rawSource }, fullTake: { ...take, source: rawSource } }, { ...row("char-b"), take: null, fullTake: null }];
	const cast = [{ id: "char-a", motionTake: null }, { id: "char-b", motionTake: { ...source, takeId: "old" } }];
	const read = readElementDocument({ characters: cast, motion: live }, { ids: ["char-a", "char-b"] }, "scene-1");
	assert.equal(read.omitted, undefined, JSON.stringify(read.omitted));
	const [a, b] = read.document.characters;
	assert.equal(a.motionTake.specId, specIdOf(rawSource.spec));
	assert.equal(a.motionTake.takeId, "t1");
	assert.equal(a.motionTake.spec.frames, 176);
	assert.match(a.motionTake.spec.raw, /^left out \(the encoded track of 176 frames, \d+ characters\)$/);
	assert.equal(a.motionTake.spec.lowvis, "left out (the scene and spec of motion agent-20261123-000000-abcd, kept with this take for the motion tool)");
	assert.equal(typeof read.document.motion[0].take.source.spec.lowvis, "string");
	assert.equal(b.motionTake, null, "a take the motion layer cleared is gone from the cast row too");
	assert.match(read.document.motion[0].take.source.spec.raw, /^left out/);
	assert.ok(chars(read.document) < 6000, `${chars(read.document)}`);
});
check("a read of several kinds keeps under its budget and names the kinds it left out; one kind alone answers whole", () => {
	const objects = Array.from({ length: 900 }, (_, i) => ({ id: `cube-${i}`, name: `Part ${i} of a long truck body`, renderer: "cube", x: i, y: 0, z: 0, rot: 0, scaleX: 1, scaleY: 1, scaleZ: 1 }));
	assert.ok(chars(objects) > 90_000);
	const both = readElementDocument({ motion, objects }, {}, "scene-1");
	assert.deepEqual(Object.keys(both.document), ["motion"]);
	assert.ok(both.omitted.objects > 90_000, JSON.stringify(both.omitted));
	assert.match(both.note, /select a kind alone, name ids, or page objects/);
	const alone = readElementDocument({ motion, objects }, { select: ["objects"] }, "scene-1");
	assert.equal(alone.document.objects.length, 900);
	assert.equal(alone.omitted, undefined);
});
check("motion.compile { base } finds the installed take's spec after the spec store forgot it (a reload)", () => {
	const takes = new Map(), owner = { replace: (cid, t) => takes.set(cid, t), motionFor: cid => takes.get(cid) ?? null };
	const ports = { state: () => ({ characters: [CHARACTER], objects: SCENE_OBJECTS, frameCount: 800 }), storeDomain: name => (name === "motion" ? owner : null) };
	const stand = { schema: "cozyclay.motion-spec.v1", fps: 24, frames: 24, use: [{ skill: "standIdle", args: { at: [0, 0], heading: 0 }, f0: 0 }] };
	const installed = createStudioAppActions(ports).run("motion.compile", { characterId: CHARACTER.id, spec: stand, install: true }).output;
	const reloaded = createStudioAppActions(ports);
	const again = reloaded.run("motion.compile", { characterId: CHARACTER.id, base: installed.specId, patch: [{ op: "replace", path: "/frames", value: 30 }], install: false }).output;
	assert.equal(again.frames, 30);
	assert.notEqual(again.specId, installed.specId);
	assert.throws(() => reloaded.run("motion.compile", { characterId: CHARACTER.id, base: "spec-000000000000", install: false }), /is not known/);
});
check("one tool result is cut past its limit, with how to ask for less", () => {
	const small = { ok: true, value: "x".repeat(100) };
	assert.equal(resultText(small), JSON.stringify(small));
	const text = resultText({ document: { motion: "y".repeat(470_000) } });
	assert.ok(text.length < RESULT_CHARS + 400, `${text.length}`);
	assert.match(text, /\[cut: this result is 47\d{4} characters, over the 100000-character limit/);
	assert.match(text, /name ids, select kinds, page with cursor, or read it inside a script/);
});
console.log("verify-document-read-budget: all checks passed");
