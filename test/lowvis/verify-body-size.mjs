#!/usr/bin/env node
// A body's size and colour in the motion writer's world (src/lowvis/engine-simple/size.js, clip.js, src/lowvis/pi).
//  1. said: a character's scale and tint reach the clip, the tool's text and the sheet
//  2. nothing said: the manual, the tool schema and the tool's result are those of before (fixtures taken from the
//     tree before a body had a scale: the manual's hashes, the schema's length); the engine's own fingerprints are in
//     verify-prop-turn.mjs
//  3. the size is true in the motion: a scene and a body both scaled give the same motion scaled; in one world a
//     smaller and a larger body stand on the floor, step, sit and reach the same box each at its own size; what a
//     body cannot do at its size is told
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildClip } from "../../src/lowvis/engine-simple/engine.js";
import { checkClip } from "../../src/lowvis/engine-simple/checks.js";
import { SOLE, TOE } from "../../src/lowvis/engine-simple/solve.js";
import { serializeClip, validateClip } from "../../src/lowvis/clip.js";
import { INDEX as J, JOINT_COUNT, REST, TIPS, qRotate } from "../../src/lowvis/rig17.js";
import { createCompileTool } from "../../src/lowvis/pi/compile-tool.mjs";
import { runScene } from "../../src/lowvis/pi/harness.mjs";
import { BODY_SCALE, OFF, systemPrompt } from "../../src/lowvis/pi/prompt.mjs";
import { drawSheet } from "../../src/lowvis/pi/render.mjs";
import { elementByPath } from "../../src/studio-elements.js";

const TMP = mkdtempSync(join(tmpdir(), "lowvis-body-"));
const hash = text => createHash("sha256").update(text).digest("hex").slice(0, 16);
const parsedOf = built => JSON.parse(serializeClip(built.clip));
const at = (c, f, j) => { const i = (f * JOINT_COUNT + j) * 3; return [c.pos[i], c.pos[i + 1], c.pos[i + 2]]; };
const tool = (name, options = {}) => createCompileTool({ name, outDir: join(TMP, name), clipFile: join(TMP, `${name}.json`), variant: "studio", ...options });
const masked = text => text.replace(/build [\d.]+ ms/, "build N ms");

// --- 2. the manual and the schema: with nothing said about bodies they are those of before ---
{
	// sha256 (16 hex) of every variant's system prompt at the commit before this change; studio: with the body step off
	const BEFORE = { base: "ad7da48a7d38ba4f", lean: "ed66ee00e280670b", patch: "5f6fb9cb9fb09b36", reach: "c2336e02e54d6806", noassist: "5f6fb9cb9fb09b36", repeat: "ea7cb302a6343b37", kept: "ea7cb302a6343b37", tilt: "315a82f58f56ecf6", studio: "4f001578b8a61907" };
	// Words that came later are taken out before the hash: the repeat count of a spike (verify-repeat-count.mjs) and
	// the SPEC lines on the body layer's `over` (verify-body-start.mjs), and the SPEC words for aim per axis, own-body
	// and elbow targets, a level carry and ride, put back to the old lines (verify-hands-words.mjs). The cut texts are disjoint.
	const noCount = text => text.replace("; a spike (a value past the check's own limit) that was a spike before also says for how many compiles in a row it has been one (a call that only looks, with the scene and spec unchanged, does not count).", ".").replace(" (a spike says 3 compiles in a row)", "");
	const withoutOver = text => text.replace(/\n {4}sit \/ stand \/ kneel \/ lie \{over\}:[^]*?as at the end of the change\./, "");
	const withoutHands = text => text
		.replace(/aim:\[x,y,z\]\|\{x\?,y\?,z\?:\[x,y,z\], world\?:true\}\|"off", elbowL\|elbowR: target, fast:true, over, ease\}\n[^]*?as near the forearm as it can/, `aim:[x,y,z]|"off", fast:true, over, ease}     aim = where the long axis of the prop in the hand points, body frame`)
		.replace(/\n {19}\| \{joint:name[^]*?and the arm's length allow/, "")
		.replace(/ from this frame, level, turning with the line\n +between them;/, " from this frame;")
		.replace(/\n {4}ride \{on:propId\}[^]*?from the let-go\)/, "");
	// and the reach rows that later named elbows and came to the studio variant too (verify-reach-studio.mjs)
	const reachWas = "\n- hand off its target, foot off its target: how far a wrist or an ankle is from the point its action gave it, on the frames after that action's blend has ended; the note";
	const withoutReach = (text, variant) => text.replace(/\n- hand, foot, elbow off its target: [^]*?told when over 10 mm; the note[^]*?moved away\./, all => (variant === "studio" ? "" : all.replace(/^[^]*?; the note/, reachWas)));
	// and the SPEC words for a prop held by several hands and a place on a prop or on another body (verify-share-hands.mjs),
	// put back to the old lines; their hand target forms go with the own-body block above
	const withoutShare = text => text
		.replace(/ \(a push\);\n[^]*?roll:true = it keeps the hand's velocity, drops to/, ` (a push)\n    hold {prop, hand:"R"|"L"}        the prop is fixed in one hand (its long z axis along the thumb side)\n    release {prop, roll?}            the prop stays where it is; roll:true = it keeps the hand's velocity, drops to`)
		.replace(` | {joint, at?, of?, pitch:deg}\n      (a place on a body as for a hand) | "plant"`, ` | "plant"`);
	// and the reasons the reach rows later gave (verify-reach-why.mjs), put back to the old sentences
	const withoutWhy = text => text.replace(/ names the side, the action, on how many frames it is over 10 mm off, and what holds the limb[^]*?nothing the engine knows accounts for\./, " names the side, the action and on how many frames it is over 10 mm off. A few frames: it arrives late. Many: it is out of reach or the body has moved away.");
	// and the SPEC words for a wrist an elbow target turns (its arm turns with it, its key's fast), put back to the old lines
	const withoutTurned = text => text.replace(/; a wrist with no target of its own goes with it:[^]*?so the elbow points at the target/, "").replace(/ unless fast\n *\(a wrist an elbow key turns: unless that key or its hand's key says fast\)\./, " unless fast.");
	// and the SPEC words on a written step count and its longest step (verify-counted-walk.mjs), put back to the old lines
	const withoutSteps = text => text.replace("    With `steps` (the feet's plants; the last one brings the feet together): `stepFrames` = frames per step (default:\n    at most 13, then it stands), `ease` = how the pelvis covers the distance (\"in\" = it speeds up, so each step is\n    longer than the one before; default: a steady speed with a speed-up and a slow-down of half a second each, a\n    little more than that when steps are slower than 13 frames, so the steps between are the same length). Steps\n    longer than the gait's longest at that pace (a walk 0.75 m ahead or back, 0.44 m to the side; a run 1.2 m; a\n    push 0.4 m; times the body's scale) become the fewest steps that fit; the travel line says what was walked.",
		"    With `steps`: `stepFrames` = frames per step (default: at most 13, then it stands), `ease` = how the pelvis\n    covers the distance (\"in\" = it speeds up, so each step is longer than the one before; default: a steady speed\n    with a speed-up and a slow-down of at most half a second each, so the steps between are the same length).");
	for (const [variant, was] of Object.entries(BEFORE)) assert.equal(hash(withoutReach(withoutHands(withoutShare(withoutOver(noCount(withoutWhy(withoutTurned(withoutSteps(systemPrompt(variant, variant === "studio" ? ["body"] : [])))))))), variant)), was, `${variant}: the manual without the body step is the one of before, byte for byte`);
	assert.ok(OFF.includes("body"), "the body step can be switched off by name");
	const studio = systemPrompt("studio"), limits = elementByPath("character.scale");
	assert.deepEqual(BODY_SCALE, { min: limits.min, max: limits.max }, "the sizes a body may have are the Studio's limits of a character's scale");
	assert.ok(studio.includes("characters: [{ id, at: [x, z], heading, scale?, tint? }]"), "the scene's characters may have a scale and a tint");
	assert.ok(studio.includes(`from ${limits.min} to ${limits.max}`) && studio.includes('"#rrggbb"'), "the manual gives the range and the colour form");
	assert.ok(!systemPrompt("studio", ["body"]).includes("tint"), "with the step off the manual has no word of it");
	// the tool's parameters: 1695 characters (description and schema) before; a character's scale and tint add to them
	const chars = async off => (await runScene({ name: "body-schema", request: "x", variant: "studio", off, env: {}, outDir: join(TMP, "schema") })).prompt.toolChars;
	assert.equal(await chars(["body"]), 1695, "with the step off the tool's schema is the one of before");
	assert.ok(await chars([]) > 1695, "with it a character has the two fields");
	console.log("ok manual: every variant without the body step is byte for byte the manual of before; with it the scene has scale and tint");
}

// --- 3. similarity: the scene, the spec's lengths and the bodies scaled together give the same motion scaled ---
const SIM = {
	scene: s => ({ frames: 160, characters: [{ id: "a", at: [0, -1.2 * s], heading: 0, ...(s === 1 ? {} : { scale: s }) }, { id: "b", at: [1.5 * s, 0.6 * s], heading: 180, ...(s === 1 ? {} : { scale: s }) }],
		props: [{ id: "box", size: [0.4 * s, 0.3 * s, 0.4 * s], at: [0, 0.15 * s, 0], moves: true }, { id: "seat", size: [0.5 * s, 0.45 * s, 0.5 * s], at: [1.5 * s, 0.225 * s, 1.1 * s] }, { id: "stick", size: [0.04 * s, 0.04 * s, 0.6 * s], at: [1.9 * s, 0.9 * s, 0.6 * s], moves: true }] }),
	spec: s => ({ demo: "x",
		a: [[0, "walk", { to: [0, -0.6 * s] }], [40, "pose", { hands: { prop: "box" }, bow: 30, over: 14 }], [58, "carry", { prop: "box", at: [0, 1.0 * s, 0.4 * s], over: 14 }], [80, "walk", { to: [-1 * s, 0.5 * s], heading: 90 }], [130, "place", { prop: "box", at: [-0.5 * s, 0.15 * s, 0.5 * s], over: 14 }], [150, "pose", { hands: "rest", look: "b" }]],
		b: [[0, "idle"], [4, "hold", { prop: "stick", hand: "R" }], [10, "pose", { R: [-0.25 * s, 0.3 * s, 0.35 * s], look: "a", over: 10 }], [30, "sit", { on: "seat" }], [90, "stand"], [120, "pose", { footL: { at: [0.15 * s, 0.3 * s, 0.3 * s], pitch: 20 }, over: 10 }], [140, "pose", { footL: "plant", over: 8 }]] }),
};
{
	const unit = buildClip(SIM.spec(1), SIM.scene(1)).clip;
	for (const s of [0.5, 1.6]) {
		const sized = buildClip(SIM.spec(s), SIM.scene(s)).clip;
		let worst = 0;
		unit.characters.forEach((c, i) => c.pos.forEach((v, k) => { worst = Math.max(worst, Math.abs(v * s - sized.characters[i].pos[k]) / s); }));
		unit.props.forEach((p, i) => p.pos.forEach((v, k) => { worst = Math.max(worst, Math.abs(v * s - sized.props[i].pos[k]) / s); }));
		assert.ok(worst < 1e-5, `scale ${s}: every joint and prop is ${s} times the unit scene's (worst ${worst.toExponential(2)} m per metre)`);
		assert.deepEqual(sized.characters.map(c => c.scale), [s, s], "the clip's characters carry the scale");
		const valid = validateClip(parsedOf({ clip: sized }));
		assert.ok(valid.ok, `scale ${s}: the clip is valid at its own bone lengths (${valid.errors.join("; ")})`);
	}
	assert.deepEqual(Object.keys(unit.characters[0]), ["id", "pos", "quat"], "an unsized character has no scale or tint field");
	console.log("ok similarity: a scene and its bodies at 0.5 and 1.6 give the unit motion times the scale (walk, carry, place, hold, sit, stand, a foot key, a look)");
}

// --- 3. one world, a smaller and a larger body: each stands, steps, sits and reaches the box at its own size ---
// The box (on a stand) and the seat are the same for both; each body stands where its own arms and legs put it
// (0.3 m x scale from the box, 0.33 m x scale in front of the seat) and holds the box 0.2 m x scale over its hips.
const WORLD = scale => ({
	scene: { frames: 300, characters: [{ id: "a", at: [0, -1], heading: 0, scale }], props: [{ id: "stand", size: [0.3, 0.4, 0.3], at: [0, 0.2, 0.5] }, { id: "box", size: [0.3, 0.2, 0.3], at: [0, 0.5, 0.5], moves: true }, { id: "seat", size: [0.6, 0.3, 0.6], at: [1.2, 0.15, 0.9] }] },
	spec: { demo: "x", a: [[0, "walk", { to: [0, 0.5 - 0.15 - 0.3 * scale] }], [100, "pose", { hands: { prop: "box" }, bow: 20, over: 14 }], [125, "carry", { prop: "box", at: [0, 0.2 * scale, 0.35 * scale], over: 14 }], [150, "walk", { to: [1.2, 0.9 + 0.3 + 0.33 * scale], heading: 180 }], [250, "sit", { on: "seat" }]] },
});
{
	const out = {}, one = WORLD(1), unit = buildClip(one.spec, one.scene), ankle = checkClip(parsedOf(unit), unit.aux).jointLow; // the unit body's lowest joint: its standing ankle
	for (const scale of [0.6, 1.5]) {
		const w = WORLD(scale), built = buildClip(w.spec, w.scene), clip = parsedOf(built), c = clip.characters[0], checks = checkClip(clip, built.aux);
		assert.ok(validateClip(clip).ok, `scale ${scale}: valid`);
		// stands: the Hips joint and the head as high as the body is large, both soles on the floor
		assert.ok(Math.abs(at(c, 0, J.Head)[1] - REST[J.Head][1] * scale) < 0.03 * scale, `scale ${scale}: the head stands ${(REST[J.Head][1] * scale).toFixed(2)} m high (${at(c, 0, J.Head)[1].toFixed(3)})`);
		for (const foot of [J.LeftFoot, J.RightFoot]) {
			const q = c.quat.slice(foot * 4, foot * 4 + 4), low = Math.min(...[TOE, SOLE].map(o => at(c, 0, foot)[1] + qRotate(q, o)[1] * scale));
			assert.ok(Math.abs(low) < 0.002, `scale ${scale}: a standing foot's sole is on the floor (${(low * 1000).toFixed(2)} mm)`);
		}
		// over the whole clip: no foot under the floor, the lowest joint is an ankle at its height at this size, a planted foot does not slide
		assert.ok(checks.footLow > -0.002, `scale ${scale}: no foot under the floor (lowest foot point ${(checks.footLow * 1000).toFixed(2)} mm)`);
		assert.ok(Math.abs(checks.jointLow - ankle * scale) < 0.002, `scale ${scale}: the lowest joint is the ankle, ${(ankle * scale * 1000).toFixed(0)} mm over the floor (${(checks.jointLow * 1000).toFixed(1)})`);
		assert.ok(checks.slideStep < 0.002, `scale ${scale}: a planted foot stays (${(checks.slideStep * 1000).toFixed(2)} mm a frame)`);
		// reaches its object: both hands arrive on the box, and while it carries it the wrists are a hand's pad (30 mm x scale) from its surface
		const off = built.aux.reach.a[124].slice(0, 2).map(hand => hand?.d);
		assert.ok(off.every(d => d < 0.005), `scale ${scale}: both hands arrive on the box (${off.map(d => (d * 1000).toFixed(1)).join(" and ")} mm off)`);
		assert.ok(checks.carryFrames > 100 && Math.abs(checks.carryMax - 0.03 * scale) < 0.012 && checks.carryMin > 0, `scale ${scale}: both wrists on the box (${(checks.carryMin * 1000).toFixed(1)}..${(checks.carryMax * 1000).toFixed(1)} mm, the pad is ${30 * scale} mm)`);
		// sits: the Hips joint 0.13 m x scale over the seat's top
		const seated = at(c, 299, J.Hips)[1] - 0.3;
		assert.ok(Math.abs(seated - 0.13 * scale) < 0.02, `scale ${scale}: sits on the seat (Hips ${(seated * 1000).toFixed(0)} mm over its top, ${130 * scale} at this size)`);
		out[scale] = { steps: built.aux.contacts.a.reduce((n, feet, f, all) => n + (f > 0 && f < 100 ? feet.filter((on, side) => on && !all[f - 1][side]).length : 0), 0) };
	}
	assert.ok(out[0.6].steps > out[1.5].steps, `the same stretch of floor takes the smaller body more steps (${out[0.6].steps} against ${out[1.5].steps})`);
	console.log(`ok one world: bodies at 0.6 and 1.5 stand on the floor, carry the box with their wrists on it and sit on the seat, each at its size (${out[0.6].steps} and ${out[1.5].steps} steps to the box)`);
}

// --- 1. said values reach the clip, the tool's text and the sheet ---
const SAID = { frames: 60, characters: [{ id: "a", at: [-0.8, 0], heading: 0, scale: 1.4, tint: "#3b6ea5" }, { id: "b", at: [0.8, 0], heading: 0, scale: 0.7, tint: "#d98c2b" }], props: [] };
const PLAIN = { ...SAID, characters: SAID.characters.map(({ scale: _s, tint: _t, ...c }) => c) }, IDLE = { a: [[0, "idle"]], b: [[0, "idle"]] };
{
	const motion = tool("said"), r = motion.call({ scene: SAID, spec: IDLE });
	assert.equal(r.status, "ok", r.text);
	const clip = JSON.parse(readFileSync(motion.clipFile, "utf8")), head = TIPS.Head[1];
	assert.deepEqual(clip.characters.map(c => [c.id, c.scale, c.tint]), [["a", 1.4, "#3b6ea5"], ["b", 0.7, "#d98c2b"]], "the clip's characters carry what was said");
	assert.ok(r.text.includes(`bodies (as built and drawn): a: scale 1.4 = ${(head * 1.4).toFixed(2)} m tall, tint #3b6ea5; b: scale 0.7 = ${(head * 0.7).toFixed(2)} m tall, tint #d98c2b`), r.text);
	assert.deepEqual(motion.state.last.scene.characters.map(c => [c.scale, c.tint]), [[1.4, "#3b6ea5"], [0.7, "#d98c2b"]], "the kept scene has them, for the next request");
	assert.doesNotMatch(motion.call({ spec: { ...IDLE, a: [[0, "idle"], [20, "pose", { lean: 5 }]] } }).text, /^bodies/m, "the bodies line is said again only when it changes");
	// the sheet: each body in its tint, and as tall in the picture as it is large (front view, both at the same depth)
	// a face's shade multiplies the three channels alike, so a tint is found by the ratios of its channels
	const isBlue = (red, green, blue) => blue > 40 && red / blue > 0.3 && red / blue < 0.42 && green / blue > 0.6 && green / blue < 0.73; // #3b6ea5
	const isOrange = (red, green, blue) => red > 60 && green / red > 0.58 && green / red < 0.71 && blue / red > 0.14 && blue / red < 0.26; // #d98c2b
	const sheet = drawSheet(clip, { frames: [0], view: "front" }), rows = { blue: [], orange: [] };
	for (let y = 0; y < sheet.height; y++) for (let x = 0; x < sheet.width; x++) {
		const i = (y * sheet.width + x) * 4, rgb = [sheet.rgba[i], sheet.rgba[i + 1], sheet.rgba[i + 2]];
		if (isBlue(...rgb)) rows.blue.push(y);
		if (isOrange(...rgb)) rows.orange.push(y);
	}
	const tall = list => Math.max(...list) - Math.min(...list);
	assert.ok(rows.blue.length > 500 && rows.orange.length > 100, `both tints are in the sheet (${rows.blue.length} and ${rows.orange.length} pixels)`);
	assert.ok(Math.abs(tall(rows.blue) / tall(rows.orange) - 2) < 0.25, `the body at 1.4 is twice as tall in the sheet as the one at 0.7 (${tall(rows.blue)} and ${tall(rows.orange)} px)`);
	const plain = drawSheet(parsedOf(buildClip({ ...IDLE, demo: "x" }, PLAIN)), { frames: [0], view: "front" });
	let tinted = 0;
	for (let i = 0; i < plain.rgba.length; i += 4) if (isBlue(plain.rgba[i], plain.rgba[i + 1], plain.rgba[i + 2]) || isOrange(plain.rgba[i], plain.rgba[i + 1], plain.rgba[i + 2])) tinted++;
	assert.equal(tinted, 0, "an untinted clip has neither colour");
	console.log(`ok said: scale and tint are in the clip, the bodies line and the sheet (${tall(rows.blue)} px and ${tall(rows.orange)} px tall)`);
}

// --- 2. nothing said: the tool's result is the one of before; a value left out is the one the character has ---
{
	const on = tool("plain-on").call({ scene: PLAIN, spec: IDLE }), off = tool("plain-off", { off: ["body"] }).call({ scene: PLAIN, spec: IDLE });
	assert.doesNotMatch(on.text, /^bodies/m, "no bodies line");
	assert.equal(masked(on.text), masked(off.text), "with nothing said the tool's text is the one with the step off");
	assert.deepEqual(on.scene, PLAIN);
	const clip = JSON.parse(readFileSync(join(TMP, "plain-on.json"), "utf8")), before = parsedOf(buildClip({ ...IDLE, demo: "plain-on" }, PLAIN));
	assert.deepEqual(clip.characters, before.characters, "and the clip is the engine's plain build");
	assert.deepEqual(Object.keys(clip.characters[0]), ["id", "pos", "quat"]);
	// the step off: a scale in the scene is not read (as before), in the studio variant and in every other one
	for (const options of [{ off: ["body"] }, { variant: "lean" }]) {
		const ignored = tool(`ignored-${options.variant ?? "studio"}`, options), text = ignored.call({ scene: SAID, spec: IDLE }).text;
		assert.doesNotMatch(text, /^bodies/m);
		assert.deepEqual(JSON.parse(readFileSync(ignored.clipFile, "utf8")).characters.map(c => c.pos), before.characters.map(c => c.pos), "without the body step a scale is not read");
	}
	// a character that already has a body (the Studio's): left out it keeps it, said it changes
	const known = tool("known", { bodies: { b: { scale: 0.6, tint: "#445566" } } });
	assert.ok(known.call({ scene: PLAIN, spec: IDLE }).text.includes("bodies (as built and drawn): b: scale 0.6 = "), "a scale left out is the one the character has");
	assert.deepEqual(JSON.parse(readFileSync(known.clipFile, "utf8")).characters.map(c => [c.scale, c.tint]), [[undefined, undefined], [0.6, "#445566"]]);
	const said = known.call({ scene: { ...PLAIN, characters: [PLAIN.characters[0], { ...PLAIN.characters[1], scale: 1 }] } });
	assert.ok(said.text.includes("bodies (as built and drawn): b: scale 1 = "), said.text);
	assert.equal(JSON.parse(readFileSync(known.clipFile, "utf8")).characters[1].scale, undefined, "scale 1 said for it is scale 1");
	console.log("ok nothing said: the tool's text and clip are the plain ones; off, a scale is not read; a value left out is the character's own");
}

// --- 3. what cannot follow is told ---
{
	const motion = tool("told");
	const big = motion.call({ scene: { ...SAID, characters: [{ ...SAID.characters[0], scale: 5 }, { ...SAID.characters[1], tint: "orange" }] }, spec: IDLE });
	assert.equal(big.status, "rejected");
	assert.ok(big.text.includes("scene.characters[0].scale: want a number from 0.2 to 3, got 5") && big.text.includes('scene.characters[1].tint: want "#rrggbb", got "orange"'), big.text);
	// a box on a shelf 1.3 m high: the body at scale 1 takes it; the one at 0.4 (0.73 m tall) cannot, and its wrists' gap to the box is in the checks
	const reach = scale => {
		const scene = { frames: 80, characters: [{ id: "a", at: [0, 0], heading: 0, scale }], props: [{ id: "shelf", size: [0.4, 1.3, 0.3], at: [0, 0.65, 0.55] }, { id: "box", size: [0.2, 0.2, 0.2], at: [0, 1.4, 0.5] }] };
		const r = tool(`reach-${scale}`).call({ scene, spec: { a: [[0, "idle"], [4, "pose", { hands: { prop: "box" }, over: 14 }], [30, "carry", { prop: "box", over: 10 }]] } });
		return { text: r.text, gap: r.rows.find(row => row.key === "carryGap").value };
	};
	const small = reach(0.4), full = reach(1);
	assert.ok(full.gap < 45, `at scale 1 the hands take the box from the shelf (${full.gap.toFixed(0)} mm from wrist to box)`);
	assert.ok(small.gap > 300 && small.text.includes("carry: widest wrist gap to the prop:"), `at scale 0.4 they cannot and the gap is told (${small.gap.toFixed(0)} mm)`);
	// a sized clip is checked at its own bone lengths: without its scale the same joints are a stretched body
	const sized = parsedOf(buildClip({ ...IDLE, demo: "x" }, SAID));
	assert.ok(validateClip(sized).ok);
	assert.match(validateClip({ ...sized, characters: sized.characters.map(({ scale: _s, ...c }) => c) }).errors.join(), /bone stretch/);
	console.log(`ok told: a scale outside the Studio's limits and a colour that is none are refused by name; a height out of the body's reach shows as a ${small.gap.toFixed(0)} mm gap`);
}
console.log("PASS verify-body-size");
