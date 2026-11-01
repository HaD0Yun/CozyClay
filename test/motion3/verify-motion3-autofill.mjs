#!/usr/bin/env node
// motion.compile's automatic MotionBricks fill (src/commands/motion3-fill.js autoFill, the hook motion.compile runs before it
// compiles): key poses on the 24-frame grid come back with src: "fill" keys and output.fill; fill: false and skill specs are
// left alone; a 100-frame gap gets pass-through poses first; no fetcher (a Node compile) changes nothing. The fill itself runs
// the real model through the dev server's route (mcp/motionbricks/service.mjs); without the cached model this file skips.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { autoFill } from "../../src/commands/motion3-fill.js";
import { compileSpec } from "../../src/motion3/pipeline.js";
import { motionScene } from "../../src/motion3/scene.js";
import { skeletonFor } from "../../src/motion3/rigs/index.js";
import { isFillKey } from "../../src/motion3/bricks/fill-src.js";
import { keptFill } from "../../src/motion3/patch-guard.js";
import { SCENE_OBJECTS } from "./fixtures/cup-scene.mjs";

let failures = 0;
function expect(name, condition, detail = "") {
	console.log(`${condition ? "PASS" : "FAIL"} ${name}${condition ? "" : ` — ${detail}`}`);
	if (!condition) failures += 1;
}
const model = process.env.COZYCLAY_MOTIONBRICKS_MODEL ?? join(homedir(), ".cache", "cozyclay", "motionbricks", "mmm_v6_soma_fp16.onnx");
const character = { id: "actor-a", model: "x-bot-tpose" };
const demo = JSON.parse(readFileSync(new URL("../../mcp/motionbricks/demo/sit.json", import.meta.url), "utf8"));
// the fill is off unless the spec asks (fill: true, bench/m2-nofill): every filled spec below carries it
const grid = { ...demo, frames: 49, fill: true, keys: demo.keys.map((k, i) => ({ ...k, f: i * 24 })) };

expect("no fetcher (a Node compile): nothing sent, the spec compiles as written", JSON.stringify(autoFill({}, character, grid)) === JSON.stringify({ spec: grid, fill: null }));
const never = () => { throw new Error("must not fetch"); };
expect("no fill field (the default): nothing sent", (({ fill, ...rest }) => autoFill({ fetch: never }, character, rest).fill === null)(grid));
expect("fill: false: nothing sent", autoFill({ fetch: never }, character, { ...grid, fill: false }).fill === null);
const skill = autoFill({ fetch: never }, character, { ...grid, use: [{ skill: "walkTo", f0: 0, args: { to: [0, 1] } }] });
expect("a spec with use is not filled and says so", /use or generators is not filled/.test(skill.fill?.note ?? ""), JSON.stringify(skill.fill));
const down = await autoFill({ fetch: async () => { throw new TypeError("fetch failed"); } }, character, grid);
expect("no dev server: compiles as written with a note, never an error", down.spec === grid && /did not run/.test(down.fill?.note ?? ""), JSON.stringify(down.fill));

// the runtime lives next to the server (mcp/node_modules, installed with --no-save), not in the root package
const onnx = existsSync(new URL("../../mcp/node_modules/onnxruntime-node", import.meta.url));
if (!existsSync(model) || !onnx) console.log(`SKIP the model runs: ${existsSync(model) ? "onnxruntime-node is not installed" : `no model at ${model}`}`);
else {
	process.env.COZYCLAY_MOTIONBRICKS_MODEL = model;
	const { fillRequest } = await import("../../mcp/motionbricks/service.mjs");
	const fetch = async (_url, init) => { try { return new Response(JSON.stringify(await fillRequest(JSON.parse(init.body))), { status: 200 }); } catch (error) { return new Response(JSON.stringify({ error: { code: "INVALID_ARGUMENT", message: error.message } }), { status: 400 }); } };
	const sk = skeletonFor("x-bot-tpose"), scene = motionScene([]);
	const three = await autoFill({ fetch }, character, grid);
	const fillKeys = three.spec.keys.filter(k => isFillKey(k)).length;
	const qa = compileSpec(three.spec, { sk, scene }).qa;
	expect("f0, f24, f48: two gaps filled, src: \"fill\" keys, output.fill", three.fill?.calls === 2 && fillKeys > 0 && three.fill.keys === fillKeys, JSON.stringify(three.fill));
	expect("the filled spec compiles", Array.isArray(qa.groups), "");
	const long = { ...grid, frames: 101, keys: [{ ...grid.keys[0], f: 0 }, { ...grid.keys[2], f: 100 }] };
	const split = await autoFill({ fetch }, character, long);
	expect("a 100-frame gap: 3 pass-through poses, 4 gaps filled", split.fill?.passThrough === 3 && split.fill?.calls === 4 && split.spec.keys.filter(k => k.src === "pass").length === 3, JSON.stringify(split.fill));
	// a small patch on an authored key (patch-guard.js, motion.compile): the fill keys stay as they are, no model call
	const nudged = { ...three.spec, keys: three.spec.keys.map(k => (k.f === 24 && !isFillKey(k) ? { ...k, set: { ...k.set, root: k.set.root.map((v, i) => (i === 0 ? v + 0.02 : v)) } } : k)) };
	expect("a 2 cm patch on the f24 key keeps every fill key", keptFill(three.spec, nudged)?.keys === fillKeys, JSON.stringify(keptFill(three.spec, nudged)));
	// the loop the hint drives: patch a fill key (src kept), compile again: the edit stays, only the two gaps beside it run
	const target = three.spec.keys.find(k => isFillKey(k) && k.f > 0 && k.f < 24 && Object.keys(k.set).length);
	const ch = Object.keys(target.set)[0], edited = Array.isArray(target.set[ch]) ? target.set[ch].map(v => v + 0.03) : target.set[ch] + 3;
	const patched = { ...three.spec, keys: three.spec.keys.map(k => (k === target ? { ...k, set: { ...k.set, [ch]: edited } } : k)) };
	const again = await autoFill({ fetch }, character, patched);
	const kept = again.spec.keys.find(k => k.f === target.f && !isFillKey(k));
	expect("an edited fill key stays (its value, no src) and becomes authored", kept && JSON.stringify(kept.set[ch]) === JSON.stringify(edited) && again.fill.promoted === 1, JSON.stringify({ kept, fill: again.fill }));
	// the edit splits f0-f24 in two; a part under 14 frames stays the compiler's curve, so 1 or 2 calls, all inside f0-f24
	const ran = again.fill.gaps.filter(g => !g.kept && !g.skipped);
	// the split parts are under the 19-frame safe gap now, so they keep the curve: nothing outside f0-f24 runs again
	expect("only the gaps beside it are reconsidered (inside f0-f24); f24-f48 kept its fill", ran.length <= 2 && ran.every(g => g.f[0] >= 0 && g.f[1] <= 24) && again.fill.gaps.some(g => g.kept && g.f[0] === 24), JSON.stringify(again.fill.gaps));
	const hinted = compileSpec(again.spec, { sk, scene }).qa.groups.map(g => g.cause).filter(c => /MotionBricks fill key/.test(c ?? ""));
	// parkour shape: approach f0-f18, hands on the wall f18-f30, flight f30-f42, landing f42-f60: only the first and last gaps fill
	const pose = (f, { root = [0, 1.016, 0], foot = 0.087, hand = 0.9, z = 0 } = {}) => ({ f, set: { ...grid.keys[0].set, root: [root[0], root[1], root[2] + z],
		foot_l: [0.1, foot, z], foot_r: [-0.1, foot, z], hand_l: [0.24, hand, z + 0.1], hand_r: [-0.24, hand, z + 0.1] } });
	const parkour = { ...grid, frames: 61, keys: [pose(0), pose(18, { z: 0.4 }), pose(30, { z: 0.7, foot: 0.45, root: [0, 1.25, 0], hand: 1.0 }), pose(42, { z: 1.4, root: [0, 1.0, 0] }), pose(60, { z: 1.7 })],
		goals: [{ name: "hands on the wall top", near: ["joint:LeftHand", "joint:RightHand"], tol: 0.6, at: [18, 30] }] };
	const vault = await autoFill({ fetch }, character, parkour);
	const filledGaps = vault.fill.gaps.filter(g => !g.skipped && !g.kept).map(g => g.f.join("-"));
	// 12-frame plant and flight gaps are under the 14-frame model minimum here; nothing is skipped for contact or flight any more
	// iteration 2: 18-frame gaps are under the safe 19 and the feet are off the floor around the vault, so the curve stays everywhere
	expect("parkour: no gap is safe for the fill (18-frame approach and landing are unsafe_gap)", filledGaps.length === 0
		&& JSON.stringify(vault.fill.skipped?.map(x => `${x.f.join("-")} ${x.reason}`)) === '["0-18 unsafe_gap","42-60 unsafe_gap"]', JSON.stringify(vault.fill));
	expect("parkour: spans free / contact / flight are reported", ["free", "contact", "flight"].every(k => vault.fill.spans?.some(sp => sp.kind === k)), JSON.stringify(vault.fill.spans));
	// density notes: a free gap of 4, a 16-frame gap across the hand plant, a flight landing with no key near it
	const dense = { ...parkour, frames: 61, keys: [pose(0), pose(4, { z: 0.05 }), pose(18, { z: 0.4 }), pose(34, { z: 0.9, foot: 0.45, root: [0, 1.25, 0], hand: 1.0 }), pose(52, { z: 1.7 })],
		goals: [{ name: "hands on the wall top", near: ["joint:LeftHand", "joint:RightHand"], tol: 0.6, at: [18, 34] }] };
	const noted = await autoFill({ fetch }, character, dense), codes = (noted.fill.notes ?? []).map(n => n.split(" ")[0]);
	expect("density notes: KEYS_TOO_DENSE, CONTACT_UNKEYED and FLIGHT_UNKEYED, each naming keys[n] or frames", ["KEYS_TOO_DENSE", "CONTACT_UNKEYED", "FLIGHT_UNKEYED"].every(c => codes.includes(c))
		&& /keys\[\d+\] f0 and keys\[\d+\] f4/.test(noted.fill.notes.join("\n")), JSON.stringify({ notes: noted.fill.notes, spans: noted.fill.spans }));
	console.log(`  notes: ${noted.fill.notes?.join(" | ")}`);
	// the fill compiles in the editor's scene: a plant anchored on a scene object (the table top) fills with the scene and is
	// refused without it, as before the fix (the Studio then fell back to the compiler's curve)
	const planted = { ...grid, anchors: { top: { kind: "object", object: "cube", local: [0.1, 0.5, 0] } }, keys: grid.keys.map((k, i) => (i === 1 ? { ...k, set: { ...k.set, w_top_r: 1 } } : k)) };
	const withScene = await fillRequest({ spec: planted, model: "x-bot-tpose", auto: true, objects: SCENE_OBJECTS });
	let refused = "";
	try { await fillRequest({ spec: planted, model: "x-bot-tpose", auto: true }); } catch (error) { refused = error.message; }
	expect("scene: a plant on a scene object fills when the editor sends its objects", withScene.calls === 2 && withScene.spec.keys.some(isFillKey), JSON.stringify({ calls: withScene.calls, gaps: withScene.gaps }));
	expect("scene: without the objects the same spec is refused as before (unknown object)", /unknown object|names|not in the scene|cube/i.test(refused), refused);
	// QA gate and foot hold on two agent specs from the 90-run box bench (sit, box carry): the fill never adds SLIDE, and a dropped
	// gap is one whose model keys added QA over the compiler's curve
	const slideOf = qa => qa.groups.filter(g => g.kind === "SLIDE").reduce((n, g) => n + g.count, 0);
	for (const name of ["bench-sit-spec", "bench-box-spec"]) {
		const { spec: benchSpec, objects } = JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"));
		const benchScene = motionScene(objects), plainQa = compileSpec(benchSpec, { sk, scene: benchScene }).qa;
		const gated = await fillRequest({ spec: benchSpec, model: "x-bot-tpose", auto: true, objects });
		const filledQa = compileSpec(gated.spec, { sk, scene: benchScene }).qa;
		expect(`${name}: the fill adds no SLIDE (${slideOf(plainQa)} -> ${slideOf(filledQa)})`, slideOf(filledQa) <= slideOf(plainQa));
		expect(`${name}: every dropped gap had more QA with the model's keys`, (gated.dropped ?? []).every(d => d.qaModel >= d.qaCurve)
			&& (gated.dropped ?? []).every(d => !gated.spec.keys.some(k => isFillKey(k) && k.f > d.f0 && k.f < d.f1)), JSON.stringify(gated.dropped));
		console.log(`  ${name}: fill keys ${gated.spec.keys.filter(isFillKey).length}, dropped ${(gated.dropped ?? []).length}, QA groups ${plainQa.groups.length} -> ${filledQa.groups.length}`);
	}
	// iteration 2 suite check: on three agent specs from the bench the fill adds at most 0.3 QA groups per filled gap
	for (const name of ["bench-sit-spec", "bench-box2-spec", "bench-parkour-spec"]) {
		const { spec: benchSpec, objects } = JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"));
		const benchScene = motionScene(objects), plainGroups = compileSpec(benchSpec, { sk, scene: benchScene }).qa.groups.length;
		const gated = await fillRequest({ spec: benchSpec, model: "x-bot-tpose", auto: true, objects });
		const filledGaps = gated.gaps.filter(g => !g.skipped && !g.kept && !g.dropped).length, added = compileSpec(gated.spec, { sk, scene: benchScene }).qa.groups.length - plainGroups;
		expect(`${name}: the fill adds <= 0.3 QA groups per filled gap (${added} over ${filledGaps} gaps)`, added <= 0.3 * Math.max(1, filledGaps), JSON.stringify({ added, filledGaps, skipped: gated.skipped?.map(x => x.reason) }));
	}
	console.log(`  edit loop: promoted ${again.fill.promoted}, ${again.fill.calls} calls, kept ${again.fill.gaps.filter(g => g.kept).length} gap; fill-key hints: ${hinted.length}`);
	console.log(`  3-key grid: ${three.fill.calls} calls, ${fillKeys} fill keys, QA ${qa.groups.length} groups; 100-frame gap: ${split.fill.passThrough} pass-through, ${split.fill.calls} calls`);
}
if (failures) { console.error(`${failures} failed`); process.exit(1); }
console.log("all passed");
