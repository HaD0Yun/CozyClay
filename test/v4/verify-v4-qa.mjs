#!/usr/bin/env node
// v4 qa: runMotionQa as information only, the ballistic-landing fix, air rows against g, spec-free hand
// checks and the qa tool. Fixtures are raw tracks (local quats from toLocal, read back with fk) turned
// into Out by takeOut plus empty diag/c, the way the v4 track store builds it.
import { skeletonFor } from "../../src/motion3/rigs/index.js";
import { restState, rotateSubtree, toLocal, fk } from "../../src/motion3/compiler/skeleton.js";
import { axisRot } from "../../src/motion3/compiler/math.js";
import { takeOut } from "../../src/motion3/physics-frames.js";
import { runMotionQa } from "../../src/motion3/qa/index.js";
import { ballisticImpacts } from "../../src/motion-v4/qa/impact.js";
import { airAccel } from "../../src/motion-v4/qa/air.js";
import { handChecks } from "../../src/motion-v4/qa/hands.js";
import { runV4Qa } from "../../src/motion-v4/qa/run.js";
import { createQaTool } from "../../bin/agent/v4/qa-tool.mjs";

let failures = 0;
function expect(name, condition, detail = "") {
	console.log(`${condition ? "PASS" : "FAIL"} ${name}${condition ? "" : ` — ${detail}`}`);
	if (!condition) failures += 1;
}

const sk = skeletonFor("y-bot-tpose"), B = sk.names.length, I = sk.index;
const REST = toLocal(sk, restState(sk));
const base = { rot: 0, rotX: 0, rotZ: 0, path: null, attach: null, hidden: false, color: "#9e9e9e", footprint: { width: 1, depth: 1 }, height: 1, supportY: 1 };
/** A box record from its x, y, z ranges (base pivot at the bottom centre). */
const crate = (id, [x0, x1], [y0, y1], [z0, z1]) => ({ ...base, id, name: id, renderer: "cube", x: (x0 + x1) / 2, y: y0, z: (z0 + z1) / 2,
	scaleX: x1 - x0, scaleY: y1 - y0, scaleZ: z1 - z0, parent: null });

/** A pose per frame -> Out. A pose is { quats, hips } (local quats, world hips). */
function outOf(poses, records = []) {
	const F = poses.length, rot = new Float32Array(F * B * 4), hips = new Float32Array(F * 3);
	poses.forEach((p, f) => { p.quats.forEach((q, b) => rot.set(q, (f * B + b) * 4)); hips.set(p.hips, f * 3); });
	const take = { schema: "cozyclay.take.v3", fps: 24, frameCount: F, rig: "y-bot-tpose", bones: sk.names.slice(), rot, hips, objects: {},
		placement: { position: [0, 0, 0], yaw: 0 }, spec: { schema: "cozyclay.motion-spec.v1", fps: 24, frames: F } };
	const out = takeOut(take, records);
	for (const fr of out.frames) { fr.diag = {}; fr.c = {}; }
	return out;
}
/** The rest pose with the hips dy metres up. */
const raised = dy => ({ quats: REST.quats, hips: [REST.hips[0], REST.hips[1] + dy, REST.hips[2]] });
/** The rest pose with bone `bone`'s subtree turned `deg` about world axis `axis` at its joint. */
function turned(bone, axis, deg) {
	const s = restState(sk);
	rotateSubtree(sk, s, I[bone], s.P[I[bone]].slice(), axisRot(axis, deg));
	return toLocal(sk, s);
}
/** A fall from h metres at k g that stops in one frame on the floor, then `still` frames standing. */
const fall = (h, k, still) => {
	const poses = [];
	for (let f = 0; ; f++) {
		const dy = h - 0.5 * k * 9.81 * (f / 24) ** 2;
		poses.push(raised(Math.max(0, dy)));
		if (dy <= 0) break;
	}
	return [...poses, ...Array.from({ length: still }, () => raised(0))];
};
const hasKind = (groups, kind) => groups.some(g => g.kind === kind);

// 1. An exact free fall from 1.2 m that stops in one frame on the floor.
{
	const out = outOf(fall(1.2, 1, 20));
	const old = runMotionQa(sk, out, out.ctx.spec, { explain: false });
	expect("free fall: runMotionQa reports a POP group (the bug)", hasKind(old.groups, "POP"), JSON.stringify(old.groups.map(g => g.kind)));
	const pops = old.groups.filter(g => g.kind === "POP");
	const data = runV4Qa(out);
	expect("free fall: runV4Qa has no POP group", !hasKind(data.groups, "POP"), JSON.stringify(data.groups.map(g => g.subject)));
	expect("free fall: the POP frames moved to impacts", data.impacts.length === pops.reduce((s, g) => s + g.count, 0) && data.impacts.some(r => r.joint === "Hips"),
		JSON.stringify(data.impacts));
	const hip = data.impacts.find(r => r.joint === "Hips");
	expect("free fall: impact run is the air run f0-f11 at 1 g", hip && hip.run[0] === 0 && hip.run[1] === 11 && Math.abs(hip.gRatio - 1) < 0.01, JSON.stringify(hip));
	expect("free fall: no air row (1 g)", airAccel(out).length === 0, JSON.stringify(airAccel(out)));
	expect("free fall: no ok, gate or blocking field", !("ok" in data) && !("blocking" in data) && !("gate" in data) && data.groups.every(g => !("blocking" in g)), Object.keys(data).join());
	expect("free fall: QaData shape", ["total", "groups", "impacts", "air", "hands", "ms"].every(k => k in data) && typeof data.ms === "number", Object.keys(data).join());
	const split = ballisticImpacts(out, old.groups);
	expect("ballisticImpacts: returns { groups, impacts }", Array.isArray(split.groups) && split.impacts.length === data.impacts.length, JSON.stringify(Object.keys(split)));
}

// 2. A one-frame hand jump while standing still keeps its POP.
{
	const jump = turned("LeftArm", [0, 0, 1], 20);
	const out = outOf(Array.from({ length: 40 }, (_, f) => (f === 20 ? jump : raised(0))));
	const data = runV4Qa(out);
	const pop = data.groups.find(g => g.kind === "POP" && g.subject.startsWith("LeftHand"));
	expect("hand jump: the LeftHand POP group stays", Boolean(pop) && pop.first >= 20 && pop.last <= 22, JSON.stringify(data.groups));
	expect("hand jump: no impacts", data.impacts.length === 0, JSON.stringify(data.impacts));
}

// 3. A fall at 4 g gives an air row near 4 g, and its landing stays a POP.
{
	const out = outOf(fall(2, 4, 20));
	const data = runV4Qa(out);
	expect("4 g fall: one air row near 4 g", data.air.length === 1 && Math.abs(data.air[0].g - 4) < 0.05, JSON.stringify(data.air));
	expect("4 g fall: landing POP not moved", hasKind(data.groups, "POP") && data.impacts.length === 0, JSON.stringify(data.impacts));
	const slow = outOf(fall(1.2, 0.5, 10));
	expect("0.5 g fall: an air row near 0.5 g", airAccel(slow).length === 1 && Math.abs(airAccel(slow)[0].g - 0.5) < 0.03, JSON.stringify(airAccel(slow)));
}

// 4. Hands: the left palm on a box top in the T-pose (the thumb hangs down, so the box stops short of it).
const rest = fk(sk, REST.quats, REST.hips);
const wrist = rest.P[I.LeftHand], palmY = (rest.P[I.LeftHand][1] + rest.P[I.LeftHandMiddle1][1]) / 2;
const top = palmY - 0.016, xs = [wrist[0] + 0.005, wrist[0] + 0.3], zs = [-0.13, 0];
const handOut = (pose, records, frames = 10) => outOf(Array.from({ length: frames }, (_, f) => (typeof pose === "function" ? pose(f) : pose)), records);
{
	const flat = handChecks(handOut(raised(0), [crate("crate", xs, [top - 0.3, top], zs)]));
	expect("flat palm on a box top: no hand group", flat.length === 0, JSON.stringify(flat));
	const tilted = handChecks(handOut(turned("LeftHand", [1, 0, 0], -60), [crate("crate", xs, [top - 0.3, top], zs)]));
	expect("palm tilted 60 deg: PALM_TILT", hasKind(tilted, "PALM_TILT"), JSON.stringify(tilted));
	const tilt = tilted.find(g => g.kind === "PALM_TILT");
	expect("palm tilted 60 deg: worst near 60, no WRIST_LIMIT", tilt && Math.abs(tilt.worst - 60) < 3 && !hasKind(tilted, "WRIST_LIMIT"), JSON.stringify(tilted));
	const tipY = rest.P[I.LeftHandMiddle4][1], mid1 = rest.P[I.LeftHandMiddle1][0];
	const pen = handChecks(handOut(raised(0), [crate("crate", [mid1, mid1 + 0.3], [tipY - 0.3, tipY + 0.03], zs)]));
	expect("fingers 3 cm inside the box: HAND_PEN", hasKind(pen, "HAND_PEN") && pen.find(g => g.kind === "HAND_PEN").subject.includes("crate"), JSON.stringify(pen));
	const flexed = handChecks(handOut(turned("LeftHand", [0, 0, 1], 90), []));
	expect("wrist flexed 90 deg: WRIST_LIMIT", hasKind(flexed, "WRIST_LIMIT") && Math.abs(flexed.find(g => g.kind === "WRIST_LIMIT").worst - 90) < 1, JSON.stringify(flexed));
	const twisted = handChecks(handOut(turned("LeftHand", [1, 0, 0], 60), []));
	expect("wrist twisted 60 deg (inside 85): no WRIST_LIMIT", !hasKind(twisted, "WRIST_LIMIT"), JSON.stringify(twisted));
	const slide = handChecks(handOut(f => ({ quats: REST.quats, hips: [REST.hips[0] + 0.005 * f, REST.hips[1], REST.hips[2]] }), [crate("crate", xs, [top - 0.3, top], zs)]));
	expect("palm sliding 4.5 cm on a still box: HAND_SLIDE", hasKind(slide, "HAND_SLIDE") && Math.abs(slide.find(g => g.kind === "HAND_SLIDE").worst - 0.045) < 0.002, JSON.stringify(slide));
	const floorPen = handChecks(handOut(raised(-1.45), []));
	expect("hand under the floor: HAND_PEN against floor", floorPen.some(g => g.kind === "HAND_PEN" && g.subject.includes("floor")), JSON.stringify(floorPen.map(g => g.subject)));
	const off = runV4Qa(handOut(turned("LeftHand", [0, 0, 1], 90), []), { hands: false });
	expect("hands false: no hand groups", off.hands.length === 0);
}

// 5. 240 frames (stand with the palm on a box, a ballistic jump, stand), timing, filters and the tool.
const JUMP_V = 0.5 * 9.81 * 0.5;
const poses240 = Array.from({ length: 240 }, (_, f) => {
	const t = (f - 100) / 24;
	return raised(f > 100 && f < 112 ? Math.max(0, JUMP_V * t - 0.5 * 9.81 * t * t) : 0);
});
const out240 = outOf(poses240, [crate("crate", xs, [top - 0.3, top], zs)]);
{
	const t0 = performance.now();
	const data = runV4Qa(out240);
	const ms = performance.now() - t0;
	console.log(`240 frames: runV4Qa ${ms.toFixed(0)} ms (data.ms ${data.ms}), ${data.groups.length} groups, ${data.impacts.length} impact rows, ${data.air.length} air rows, ${data.hands.length} hand groups`);
	expect("240 frames run under 2 s", ms < 2000, `${ms} ms`);
	expect("240 frames: the landing at f113 is an impact after air f101-f111", data.impacts.some(r => r.frame === 113 && r.run[0] === 101 && r.run[1] === 111), JSON.stringify(data.impacts.slice(0, 3)));
	expect("240 frames: the takeoff POP stays", data.groups.some(g => g.kind === "POP" && g.first <= 101 && g.last >= 100), JSON.stringify(data.groups.map(g => [g.kind, g.first, g.last])));
	const early = runV4Qa(out240, { from: 0, to: 50 });
	expect("range f0-f50: no POP, no impacts", !hasKind(early.groups, "POP") && early.impacts.length === 0, JSON.stringify(early.groups));
	const onlyPop = runV4Qa(out240, { kinds: ["POP"] });
	expect("kinds [POP]: only POP groups, impacts kept, no air or hands", onlyPop.groups.every(g => g.kind === "POP") && onlyPop.impacts.length > 0 && onlyPop.hands.length === 0 && onlyPop.air.length === 0);
}
{
	const tool = createQaTool({ track: { out: async () => out240 } });
	expect("tool: name qa, schema as the design", tool.name === "qa" && JSON.stringify(Object.keys(tool.inputSchema.properties)) === JSON.stringify(["from", "to", "kinds", "maxGroups", "hands"])
		&& tool.inputSchema.additionalProperties === false && tool.inputSchema.required.length === 0 && tool.inputSchema.properties.maxGroups.maximum === 50);
	expect("tool: description quotes the bench record and fits 2,000 chars", tool.description.startsWith("The old engine's QA. On the bench it agreed with the owner on 1 of 10 tasks and went the other way on 5. Read it as hints and check what it says with measure and render.")
		&& tool.description.length <= 2000, `${tool.description.length} chars`);
	const res = await tool.run({}, { from: "model" });
	console.log(res.text.split("\n").slice(0, 6).map(l => `  | ${l}`).join("\n"));
	expect("tool: text starts with 'QA (information only'", res.text.startsWith("QA (information only; it never blocks)."), res.text.slice(0, 60));
	expect("tool: text <= 4,000 chars and lists the impact", res.text.length <= 4000 && res.text.includes("IMPACT f113"), `${res.text.length} chars`);
	expect("tool: data is QaData, no isError", Array.isArray(res.data.groups) && !res.isError && !("ok" in res.data));
	const capped = await tool.run({ maxGroups: 1 }, { from: "js" });
	expect("tool: maxGroups 1 lists one group and says more", capped.text.includes("more groups") || res.data.groups.length <= 1, capped.text);
	const bad = async (args, word) => { try { await tool.run(args, { from: "js" }); return false; } catch (e) { return e.message.includes(word); } };
	expect("tool: from after to throws", await bad({ from: 60, to: 50 }, "after"));
	expect("tool: from past the take throws", await bad({ from: 400 }, "past the last frame"));
	expect("tool: unknown argument throws", await bad({ frames: [1] }, "unknown argument"));
	expect("tool: bad kinds throws", await bad({ kinds: "POP" }, "kinds"));
	const none = createQaTool({ track: { out: async () => null } });
	let msg = "";
	try { await none.run({}, { from: "model" }); } catch (e) { msg = e.message; }
	expect("tool: no track throws 'No track yet'", msg === "No track yet: call track set first.", msg);
}

if (failures) {
	console.log(`${failures} failure(s)`);
	process.exit(1);
}
console.log("verify-v4-qa: all passed");
