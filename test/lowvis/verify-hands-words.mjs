#!/usr/bin/env node
// The upper-layer and prop-layer words for hands and held props (src/lowvis/engine-simple/own-body.js, ride.js):
//  1. aim {y: [0, 1, 0]}: a prop held in one hand keeps its own up while the hand puts it down; the plain aim it
//     replaces lets it turn with the wrist. aim {.., world: true} is a world direction, without it the body frame.
//  2. ride {on}: a prop keeps its place on a carried prop; a hand that takes it ends the ride for good.
//  3. {joint, at}: a hand target on the own body follows that joint as the body sits, stands and walks.
//  4. pose elbowL / elbowR: the elbow bends toward its target; the distance left is told in a reach row.
// Every scene here is made up for this test.
import assert from "node:assert/strict";
import { buildClip } from "../../src/lowvis/engine-simple/engine.js";
import { checkClip } from "../../src/lowvis/engine-simple/checks.js";
import { serializeClip } from "../../src/lowvis/clip.js";
import { INDEX as J, JOINT_COUNT, qRotate } from "../../src/lowvis/rig17.js";
import { measure } from "../../src/lowvis/pi/measure.mjs";

const build = (spec, scene) => { const b = buildClip(structuredClone({ demo: "x", ...spec }), scene); return { ...b, parsed: JSON.parse(serializeClip(b.clip)) }; };
const joint = (clip, id, f, j) => { const c = clip.characters.find(ch => ch.id === id), i = (f * JOINT_COUNT + j) * 3; return [c.pos[i], c.pos[i + 1], c.pos[i + 2]]; };
const jointQ = (clip, id, f, j) => { const c = clip.characters.find(ch => ch.id === id), i = (f * JOINT_COUNT + j) * 4; return [c.quat[i], c.quat[i + 1], c.quat[i + 2], c.quat[i + 3]]; };
const prop = (clip, id, f) => { const p = clip.props.find(q => q.id === id), i = p.pos.length === 3 ? 0 : f; return { c: Array.from(p.pos.slice(i * 3, i * 3 + 3)), q: Array.from(p.quat.slice(i * 4, i * 4 + 4)) }; };
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const deg = r => r * 180 / Math.PI;
const tiltOf = q => deg(Math.acos(Math.min(1, qRotate(q, [0, 1, 0])[1]))); // angle of the prop's own y from world up
const mm = v => (v * 1000).toFixed(1);

// --- 1. aim per axis ---
{
	const scene = { frames: 120, characters: [{ id: "a", at: [0, 0], heading: 0 }],
		props: [{ id: "table", size: [0.8, 0.75, 0.6], at: [0, 0.375, 0.95] }, { id: "cup", size: [0.12, 0.1, 0.12], at: [-0.2, 1.1, 0.3], moves: true }] };
	const spec = aim => ({ a: [
		[0, "hold", { prop: "cup", hand: "R" }], [0, "pose", { R: [-0.2, 0.15, 0.3], ...(aim ? { aim } : {}), over: 0 }],
		[20, "walk", { to: [0, 0.3] }], [50, "pose", { R: { world: [-0.1, 0.82, 0.9] }, bow: 35, over: 26 }],
		[80, "release", { prop: "cup" }], [84, "pose", { R: "rest", bow: 0, over: 20 }]] });
	const worst = b => Math.max(...Array.from({ length: 80 }, (_, f) => tiltOf(prop(b.parsed, "cup", f).q)));
	const level = build(spec({ y: [0, 1, 0] }), scene), loose = build(spec(null), scene), plain = build(spec([0, 0, 1]), scene);
	const lw = worst(level), ow = worst(loose), pw = worst(plain), check = checkClip(level.parsed, level.aux);
	assert.ok(lw < 1, `aim {y}: the cup's own up stays within 1 deg of world up while the hand puts it down (worst ${lw.toFixed(2)} deg)`);
	assert.ok(ow > 20 && pw > 20, `without it the cup turns with the wrist (worst ${ow.toFixed(0)} deg; plain aim [0,0,1] ${pw.toFixed(0)} deg)`);
	assert.ok(check.gripDrift < 1e-4 && check.gripTurn < 1e-4, `the cup stays fixed in the hand: the hand turns, not the cup (${check.gripDrift}, ${check.gripTurn})`);
	const down = prop(level.parsed, "cup", 100), top = prop(level.parsed, "cup", 79).c[1];
	assert.ok(Math.abs(down.c[1] - top) < 1e-6 && tiltOf(down.q) < 1, `let go it stays level where the hand left it, ${mm(down.c[1] - top)} mm off that place`);
	console.log(`ok aim {y}: worst tilt ${lw.toFixed(2)} deg against ${ow.toFixed(0)} deg without aim and ${pw.toFixed(0)} deg with aim [0,0,1]; grip drift ${check.gripDrift.toExponential(1)} m`);

	// world: true is the world, the default is the body frame (heading 90: the body's forward is world +X)
	const side = { ...scene, characters: [{ id: "a", at: [0, 0], heading: 90 }] };
	const one = aim => build({ a: [[0, "hold", { prop: "cup", hand: "R" }], [0, "pose", { R: [-0.2, 0.15, 0.3], aim, over: 0 }]] }, side);
	const z = b => qRotate(prop(b.parsed, "cup", 10).q, [0, 0, 1]);
	const body = z(one({ z: [0, 0, 1], y: [0, 1, 0] })), world = z(one({ z: [0, 0, 1], y: [0, 1, 0], world: true }));
	assert.ok(body[0] > 0.99 && world[2] > 0.99, `{z: [0,0,1]} points along the body's forward (${body.map(v => v.toFixed(2))}); with world: true along world +Z (${world.map(v => v.toFixed(2))})`);
	assert.throws(() => one({ up: [0, 1, 0] }), /aim wants/, "an aim with no axis is refused by name");
	console.log("ok aim world: the body frame by default, the world with world: true; an aim without an axis is refused");
}

// --- 2. ride ---
{
	const scene = { frames: 160, characters: [{ id: "a", at: [0, 0], heading: 0 }, { id: "b", at: [1.6, 1.6], heading: 180 }],
		props: [{ id: "table", size: [0.8, 0.75, 0.6], at: [0, 0.375, 0.95] }, { id: "tray", size: [0.5, 0.03, 0.35], at: [0, 0.765, 0.8], moves: true },
			{ id: "cup", size: [0.12, 0.1, 0.12], at: [0.05, 0.83, 0.8], moves: true }] };
	const spec = ride => ({
		a: [[0, "walk", { to: [0, 0.4] }], [24, "pose", { hands: { prop: "tray" }, bow: 20, over: 14 }], [40, "carry", { prop: "tray", at: [0, 1.0, 0.4], over: 14 }],
			[44, "pose", { bow: 0, over: 14 }], [60, "walk", { to: [1.6, 0.8], heading: 0 }]],
		b: [[100, "pose", { R: { prop: "cup" }, over: 14 }], [114, "hold", { prop: "cup", hand: "R" }], [118, "pose", { R: [-0.2, 0.1, 0.3], over: 14 }], [134, "release", { prop: "cup" }]],
		...(ride ? { cup: [[0, "ride", { on: "tray" }]] } : {}),
	});
	const r = build(spec(true), scene), n = build(spec(false), scene);
	const rel = f => { const t = prop(r.parsed, "tray", f), c = prop(r.parsed, "cup", f); return qRotate([-t.q[0], -t.q[1], -t.q[2], t.q[3]], c.c.map((v, k) => v - t.c[k])); };
	let drift = 0;
	for (let f = 0; f < 114; f++) drift = Math.max(drift, dist(rel(f), rel(0)));
	const moved = dist(prop(r.parsed, "tray", 113).c, prop(r.parsed, "tray", 0).c);
	assert.ok(moved > 1 && drift < 1e-4, `the cup keeps its place on the tray (drift ${drift} m) while the tray is carried ${moved.toFixed(2)} m`);
	assert.ok(dist(prop(n.parsed, "cup", 113).c, prop(n.parsed, "cup", 0).c) < 1e-4, "without ride the cup stays on the table");
	const held = dist(prop(r.parsed, "cup", 130).c, joint(r.parsed, "b", 130, J.RightHand)), check = checkClip(r.parsed, r.aux);
	assert.ok(held < 0.15, `b's hand takes it off the tray (${mm(held)} mm from the wrist)`);
	assert.ok(check.freeTravel < 1e-4 && dist(prop(r.parsed, "cup", 159).c, prop(r.parsed, "cup", 135).c) < 1e-4, "let go, it stays where it is: the ride ended when the hand took it");
	assert.throws(() => build({ cup: [[0, "ride", { on: "table" }]] }, { ...scene, props: scene.props.map(p => (p.id === "cup" ? { ...p, moves: false } : p)) }), /no moves: true/, "a prop that does not move cannot ride");
	assert.throws(() => build({ cup: [[0, "ride", { on: "shelf" }]] }, scene), /ride wants/, "an unknown carrier is refused by name");
	console.log(`ok ride: the cup rides ${moved.toFixed(2)} m on the carried tray with ${drift.toExponential(1)} m drift; a hand takes it off and the ride ends`);
}

// --- 3 and 4. a place on the own body; elbows ---
const SEAT = { frames: 150, characters: [{ id: "a", at: [0, 0], heading: 0 }], props: [{ id: "chair", size: [0.45, 0.45, 0.45], at: [0, 0.225, -0.35] }] };
{
	// the gap from a wrist to a place on the own body, every frame from `from`, against what the reach row tells
	const gaps = (r, side, j, at, from) => r.aux.reach.a.slice(from).map((row, n) => {
		const f = from + n, q = jointQ(r.parsed, "a", f, j), want = joint(r.parsed, "a", f, j).map((v, i) => v + qRotate(q, at)[i]);
		return { f, gap: dist(joint(r.parsed, "a", f, side ? J.RightHand : J.LeftHand), want), told: row[side]?.d };
	});
	const knee = [0, 0.07, 0.02], top = [0, 0.16, 0.02];
	const sit = gaps(build({ a: [[0, "pose", { L: { joint: "LeftLeg", at: knee }, over: 10 }], [20, "sit", { on: "chair" }], [80, "stand"], [120, "walk", { to: [0, 1.0] }]] }, SEAT), 0, J.LeftLeg, knee, 10);
	const walk = build({ a: [[0, "pose", { R: { joint: "Head", at: top }, over: 10 }], [20, "walk", { to: [0, 2.5] }]] }, { ...SEAT, props: [] }), onHead = gaps(walk, 1, J.Head, top, 16);
	const still = Math.max(...sit.filter(g => g.f >= 60 && g.f < 80).map(g => g.gap)), moving = Math.max(...onHead.map(g => g.gap)), lie = Math.max(...[...sit, ...onHead].map(g => Math.abs(g.gap - g.told)));
	const went = dist(joint(walk.parsed, "a", 149, J.Head), joint(walk.parsed, "a", 10, J.Head));
	assert.ok(still < 0.005, `seated, the left wrist rests on the left knee (worst ${mm(still)} mm)`);
	assert.ok(went > 2 && moving < 0.01, `a hand on the own head stays on it while the body walks ${went.toFixed(2)} m (worst ${mm(moving)} mm)`);
	assert.ok(lie < 1e-4, `on every frame the reach row tells the true gap (worst difference ${mm(lie)} mm; largest gap told while sitting down and standing up ${mm(Math.max(...sit.map(g => g.told)))} mm)`);
	assert.equal(walk.aux.reach.a[0].length, 4, "with no elbow key a reach row has its four limbs, as before");
	assert.throws(() => build({ a: [[0, "pose", { L: { joint: "Knee" } }]] }, SEAT), /unknown joint "Knee"/, "an unknown joint is refused by name");
	console.log(`ok joint: wrist on the knee seated ${mm(still)} mm, on the head through a ${went.toFixed(1)} m walk ${mm(moving)} mm; the reach row is the true gap (sit-down and stand-up up to ${mm(Math.max(...sit.map(g => g.told)))} mm)`);
}
{
	const chin = { joint: "Head", at: [0, -0.07, 0.1] }, knee = { joint: "LeftLeg", at: [0, 0.07, 0] };
	const spec = elbow => ({ a: [[0, "sit", { on: "chair" }], [40, "pose", { bow: 50, lean: 10, L: chin, ...(elbow ? { elbowL: knee } : {}), over: 20 }], [110, "stand"], [110, "pose", { bow: 0, lean: 0, L: "rest", ...(elbow ? { elbowL: "rest" } : {}), over: 20 }]] });
	const w = build(spec(true), SEAT), o = build(spec(false), SEAT);
	const gap = (b, f) => dist(joint(b.parsed, "a", f, J.LeftForeArm), qRotate(jointQ(b.parsed, "a", f, J.LeftLeg), knee.at).map((v, i) => v + joint(b.parsed, "a", f, J.LeftLeg)[i]));
	const wg = gap(w, 90), og = gap(o, 90), told = w.aux.reach.a[90][4];
	assert.ok(wg < og - 0.05, `elbowL bends the elbow toward the knee: ${mm(wg)} mm from it, ${mm(og)} mm without`);
	assert.ok(told && Math.abs(told.d - wg) < 1e-4 && told.key === 40, `the reach row tells the elbow distance (${told && mm(told.d)} mm vs ${mm(wg)} mm, the action at f40)`);
	assert.ok(dist(joint(w.parsed, "a", 90, J.LeftHand), joint(o.parsed, "a", 90, J.LeftHand)) < 0.02, "the wrist keeps its target: only the bend turns");
	assert.equal(w.aux.reach.a[140][4], null, "rest: no elbow target, no row");
	const far = build({ a: [[0, "pose", { elbowR: { world: [-2, 1, 0] }, over: 0 }]] }, SEAT), rows = measure(far.parsed, far.aux).filter(row => row.key === "reach:a:5");
	assert.ok(rows.length === 1 && rows[0].label === "elbow off its target" && rows[0].value > 1000, `an elbow target out of reach is told: ${rows[0]?.label} ${rows[0]?.value.toFixed(0)} mm`);
	console.log(`ok elbow: elbow to knee ${mm(wg)} mm with elbowL, ${mm(og)} mm without; the reach row says ${mm(told.d)} mm; out of reach it is a row of its own`);

	// a body of another size (size.js): the scene, the offsets and the body scaled by 1.5 give the same motion scaled
	const k = 1.5, big = { ...SEAT, characters: [{ ...SEAT.characters[0], scale: k }], props: [{ ...SEAT.props[0], size: SEAT.props[0].size.map(v => v * k), at: SEAT.props[0].at.map(v => v * k) }] };
	const at = o => ({ ...o, at: o.at.map(v => v * k) }), s = build({ a: [[0, "sit", { on: "chair" }], [40, "pose", { bow: 50, lean: 10, L: at(chin), elbowL: at(knee), over: 20 }]] }, big);
	const u = build({ a: [[0, "sit", { on: "chair" }], [40, "pose", { bow: 50, lean: 10, L: chin, elbowL: knee, over: 20 }]] }, SEAT);
	const off = Math.max(...[J.LeftForeArm, J.LeftHand].map(j => dist(joint(s.parsed, "a", 90, j), joint(u.parsed, "a", 90, j).map(v => v * k))));
	assert.ok(off < 1e-3, `at scale 1.5 the elbow and the wrist are those of scale 1 times 1.5 (worst ${mm(off)} mm)`);
	console.log(`ok elbow at scale 1.5: the unit motion times the scale (worst ${mm(off)} mm)`);
}
console.log("PASS verify-hands-words");
