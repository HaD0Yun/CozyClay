#!/usr/bin/env node
// An object a joint carries changes its place over frames, and whoever shapes it is told what carries it.
//   1. ride with at (engine-simple/ride.js): after frame 0 it goes to its place on the carrier from where it was, over
//      its over (default 12, or the frames to the prop's next key or since its key before when fewer; 0 or 1: at once),
//      for every kind of change; keys a frame apart are each on their place on their frame; frame 0 and no at as before.
//   2. the ride row (pi/measure.mjs): the fastest frame of that way, told over 5 cm or 20 deg.
//   3. contact rows (studio/contacts.js, carried.js): a joint that carries a prop names its drawn part, that part's size
//      and the box it spans in the prop's frame, read off the look's solids at the body's scale; gap rows of that part.
// Every scene and spec here is made up for this check.
import assert from "node:assert/strict";
import { buildClip } from "../../src/lowvis/engine-simple/engine.js";
import { INDEX as J } from "../../src/lowvis/rig17.js";
import { measure } from "../../src/lowvis/pi/measure.mjs";
import { serializeClip } from "../../src/lowvis/clip.js";
import { contactLine, contactsOf, gapLine, gapsOf, probesOf } from "../../src/lowvis/studio/contacts.js";
import { LOOK_SOLIDS } from "../../src/lowvis/looks/solids.js";

const qc = q => [-q[0], -q[1], -q[2], q[3]], qm = (a, b) => [a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1], a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0], a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3], a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2]];
const qr = (q, v) => qm(qm(q, [...v, 0]), qc(q)).slice(0, 3), dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const angle = (a, b) => (2 * Math.acos(Math.min(1, Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]))) * 180) / Math.PI;
const F = 90, scene = (s, extra = []) => ({ frames: F, characters: [{ id: "a", at: [0, 0], heading: 0, scale: s }, { id: "b", at: [0.9, 0], heading: 270, scale: s }], props: [{ id: "x", size: [0.2, 0.06, 0.2], at: [0.3, 0.9, 0.3], moves: true }, ...extra] });
const build = (spec, sc) => { const { clip, aux } = buildClip(structuredClone({ ...spec, demo: "worn" }), structuredClone(sc)); return { clip: JSON.parse(serializeClip(clip)), aux }; };
const slice = (a, n, k) => Array.from(a.slice(k * n, k * n + n));
/** Prop x's place and turn on a carrier ({ who, joint } or { prop }) on frame f. */
const onCarrier = (clip, car, f) => {
	const p = clip.props.find(q => q.id === "x"), c = car.prop ? clip.props.find(q => q.id === car.prop) : clip.characters.find(q => q.id === car.who);
	const pose = car.prop ? { c: slice(c.pos, 3, c.pos.length > 3 ? f : 0), q: slice(c.quat, 4, c.quat.length > 4 ? f : 0) } : { c: slice(c.pos, 3, f * 17 + J[car.joint]), q: slice(c.quat, 4, f * 17 + J[car.joint]) };
	return { c: qr(qc(pose.q), slice(p.pos, 3, f).map((v, i) => v - pose.c[i])), q: qm(qc(pose.q), slice(p.quat, 4, f)) };
};
const steps = (clip, car, a, b) => Array.from({ length: b - a + 1 }, (_, i) => { const x = onCarrier(clip, car, a + i - 1), y = onCarrier(clip, car, a + i); return { d: dist(x.c, y.c), t: angle(x.q, y.q) }; });

// --- 1. every kind of change, bodies of scale 0.5, 1 and 3 ---
for (const s of [0.5, 1, 3]) {
	const AT = [0, 0.25 * s, 0], TO = [0, 0.1 * s, 0.2 * s];
	const kinds = {
		"ride to ride on one joint": { spec: { x: [[0, "ride", { joint: "Head", of: "a", at: AT }], [40, "ride", { joint: "Head", of: "a", at: TO, axis: [1, 0, 0], deg: -60 }]] }, car: { who: "a", joint: "Head" }, f: 40 },
		"to another joint": { spec: { x: [[0, "ride", { joint: "Head", of: "a", at: AT }], [40, "ride", { joint: "Spine2", of: "a", at: [0, 0, -0.2 * s] }]] }, car: { who: "a", joint: "Spine2" }, f: 40 },
		"to another body, which walks": { spec: { b: [[30, "walk", { to: [0.9, 1] }]], x: [[0, "ride", { joint: "Head", of: "a", at: AT }], [40, "ride", { joint: "Head", of: "b", at: AT }]] }, car: { who: "b", joint: "Head" }, f: 40 },
		"to a prop a key moves": { spec: { cart: [[0, "move", { to: [1.5, 0.2, 1.5], over: 80 }]], x: [[0, "ride", { joint: "Head", of: "a", at: AT }], [40, "ride", { on: "cart", at: [0, 0.3, 0] }]] }, car: { prop: "cart" }, f: 40, extra: [{ id: "cart", size: [0.6, 0.4, 0.8], at: [1, 0.2, 0], moves: true }] },
		"to a joint that turns fast": { spec: { a: [[38, "turn", { heading: 180 }]], x: [[0, "ride", { joint: "Head", of: "a", at: AT }], [40, "ride", { joint: "RightHand", of: "a", at: [0, -0.05 * s, 0.05 * s] }]] }, car: { who: "a", joint: "RightHand" }, f: 40 },
	};
	for (const [name, k] of Object.entries(kinds)) {
		const sc = scene(s, k.extra), { clip, aux } = build(k.spec, sc), ride = aux.rides.find(r => r.f === k.f), want = k.spec.x.find(a => a[0] === k.f)[2].at;
		assert.equal(ride.over, 12, `${name}: by default over 12 frames`);
		const far = dist(onCarrier(clip, k.car, k.f - 1).c, want), list = steps(clip, k.car, k.f, k.f + 11), top = Math.max(...list.map(x => x.d));
		assert.ok(top <= (1.5 * far) / 12 + 1e-3 && list[0].d < far / 12, `${name} (scale ${s}): no frame moves more than the eased twelfth of the way, ${(top * 1000).toFixed(1)} mm of ${(far * 1000).toFixed(0)} mm`);
		assert.ok(dist(onCarrier(clip, k.car, k.f + 11).c, want) < 1e-3, `${name}: at its place on frame f + 11`);
		// over 0 asks for it at once: the whole way on its first frame, as before; over 1 the same
		for (const over of [0, 1]) {
			const now = build({ ...k.spec, x: k.spec.x.map(a => (a[0] === k.f ? [a[0], a[1], { ...a[2], over }] : a)) }, sc);
			assert.ok(dist(onCarrier(now.clip, k.car, k.f).c, want) < 1e-3, `${name}: over ${over} puts it there on its frame`);
		}
	}
	console.log(`ok scale ${s}: ride to ride, to another joint, body and prop, to a joint that turns fast: over 12 frames by default, at once with over 0 or 1`);
}

// --- hand to joint, keys a frame apart, frame 0, no at, overlapping changes ---
{
	const sc = scene(1), AT = [0, 0.25, 0];
	// a ride written while a hand holds the prop waits for the let-go and goes from the hand's place
	const hand = build({ a: [[0, "hold", { prop: "x", hand: "R", over: 10 }], [20, "pose", { R: { joint: "Head", at: [-0.12, 0.25, 0.1] }, over: 15 }], [40, "release", { prop: "x" }]], x: [[30, "ride", { joint: "Head", of: "a", at: AT }]] }, sc);
	const ride = hand.aux.rides[0], car = { who: "a", joint: "Head" }, far = dist(onCarrier(hand.clip, car, ride.began - 1).c, AT);
	assert.equal(ride.began, 40, "it began at the let-go");
	assert.ok(far > 0.1 && Math.max(...steps(hand.clip, car, 40, 51).map(x => x.d)) <= (1.5 * far) / 12 + 1e-3 && dist(onCarrier(hand.clip, car, 51).c, AT) < 1e-3, `from the hand to the head over 12 frames (${(far * 1000).toFixed(0)} mm)`);
	// keys a frame apart: each on its place on its own frame, as at once
	const every = Array.from({ length: 12 }, (_, k) => [51 + k, "ride", { joint: "Head", of: "a", at: [0, 0.22 - 0.01 * k, 0.1 + 0.005 * k] }]);
	const dense = build({ x: [[0, "ride", { joint: "Head", of: "a", at: [0, 0.22, 0.1] }], ...every] }, sc);
	for (const [f, , o] of every) assert.ok(dist(onCarrier(dense.clip, car, f).c, o.at) < 1e-4, `a key on every frame: on its place on f${f}`);
	// two keys 3 frames apart: the first goes there in 3, the second in 3 (the frames since the key before)
	const two = build({ x: [[0, "ride", { joint: "Head", of: "a", at: [0, 0.22, 0.1], axis: [1, 0, 0], deg: -60 }], [50, "ride", { joint: "Head", of: "a", at: [0, 0.17, 0.145], axis: [1, 0, 0], deg: -30 }], [53, "ride", { joint: "Head", of: "a", at: [0, 0.1, 0.16] }]] }, sc);
	assert.deepEqual(two.aux.rides.map(r => r.over), [0, 3, 3], "the default keeps the keys' tempo");
	assert.ok(dist(onCarrier(two.clip, car, 52).c, [0, 0.17, 0.145]) < 1e-4 && dist(onCarrier(two.clip, car, 55).c, [0, 0.1, 0.16]) < 1e-4, "each at its place when its frames end");
	// over longer than the gap to the next key: the next one starts from where it is (no jump), at its own over
	const cut = build({ x: [[0, "ride", { joint: "Head", of: "a", at: AT }], [40, "ride", { joint: "Head", of: "a", at: [0, 0.1, 0.2], over: 30 }], [50, "ride", { joint: "Head", of: "a", at: [0.1, 0.2, 0] }]] }, sc);
	const cutSteps = steps(cut.clip, car, 40, 62).map(x => x.d);
	assert.ok(Math.max(...cutSteps) < 0.03 && cutSteps[10] < 0.01, `a change cut by the next key goes on from where it is (${Math.max(...cutSteps).toFixed(3)} m a frame at most)`);
	// frame 0 and no at: as before (no way to go)
	const still = build({ x: [[0, "ride", { joint: "Head", of: "a", at: AT }], [40, "ride", { joint: "Spine2", of: "a" }]] }, sc);
	assert.deepEqual(still.aux.rides.map(r => r.over), [0, 0], "frame 0 and a ride without at take no frames");
	assert.ok(dist(onCarrier(still.clip, car, 0).c, AT) < 1e-4, "on frame 0 it starts on its place");
	console.log("ok hand to joint over 12 frames from the let-go; keys a frame apart each on their frame; keys 3 apart in 3; a cut change goes on; frame 0 and no at at once");
}

// --- 2. the ride row: its fastest frame, over 5 cm or 20 deg ---
{
	const sc = scene(1), spec = over => ({ a: [[0, "walk", { to: [0, 1] }]], x: [[0, "ride", { joint: "Head", of: "a", at: [0, 0.25, 0] }], [30, "ride", { joint: "Spine2", of: "a", at: [0, 0, -0.25], ...(over === undefined ? {} : { over }) }]] });
	const row = over => { const { clip, aux } = build(spec(over), sc); return measure(clip, aux, { spec: spec(over) }).find(r => r.key === "ride:x:30"); };
	const at0 = row(0), at12 = row(undefined), at30 = row(30);
	assert.ok(at0 && at0.value > 500 && at0.frame === 30 && at0.short === "ride jump" && / over 0 frames$/.test(at0.note), `over 0: the whole way on its frame (${at0?.value} ${at0?.note})`);
	assert.ok(at12 && at12.value > 50 && at12.value < (1.5 * at0.value) / 12 + 5 && at12.frame > 30 && / over 12 frames$/.test(at12.note), `over 12: its fastest frame (${at12?.value} @f${at12?.frame})`);
	assert.equal(at30, undefined, "over 30: no frame over 5 cm or 20 deg, no row");
	console.log(`ok the ride row: over 0 ${at0.value.toFixed(0)} mm at f30; over 12 ${at12.value.toFixed(0)} mm at f${at12.frame}; over 30 no row`);
}

// --- 3. the contact row of a joint that carries a prop: its drawn part, from the look's solids ---
{
	const sc = { frames: 30, characters: [{ id: "a", at: [0, 0], heading: 0, scale: 0.81 }], props: [{ id: "x", size: [0.24, 0.08, 0.26], at: [0, 1.6, 0], moves: true }, { id: "w", size: [0.05, 0.05, 0.05], at: [0.3, 1, 0], moves: true }] };
	const { clip, aux } = build({ x: [[0, "ride", { joint: "Head", of: "a", at: [0, 0.2, 0.012] }]], w: [[0, "ride", { joint: "RightHand", of: "a", at: [0, -0.05, 0] }]] }, sc);
	for (const [look, s] of [["cube", 0.81], [null, 0.81]]) {
		const rows = contactsOf(clip, aux, look), row = rows.get("x").find(r => r.part === "Head"), solids = LOOK_SOLIDS[look ?? "block"]().filter(o => o.joint === J.Head).flatMap(o => o.v);
		const size = [0, 1, 2].map(k => Math.round((Math.max(...solids.map(p => p[k])) - Math.min(...solids.map(p => p[k]))) * s * 100) / 100);
		assert.deepEqual(row.drawn.size, size, `${look ?? "block"}: the drawn head's size at the body's scale`);
		// the head joint is 0.2 m under the prop's centre, 0.16 m under its base pivot: the drawn head spans that point
		assert.ok(row.drawn.hi[1] > -0.16 && row.drawn.lo[1] < -0.16 && row.drawn.turn === 0, `${look ?? "block"}: its span in the prop's frame ${JSON.stringify(row.drawn)}`);
		const line = contactLine("x (o1)", rows.get("x"));
		assert.equal(line, `x (o1), where bodies meet it: a Head f0-29: its drawn part ${size.join(" x ")} m spans [${row.drawn.lo.join(", ")}] to [${row.drawn.hi.join(", ")}]`);
		// the hands have no solids (their drawn shape changes as they hold): the joint's place, as before
		assert.match(contactLine("w (o2)", rows.get("w")), /^w \(o2\), where bodies meet it: a RightHand at \[[^\]]+\] f0-29$/);
		const probes = probesOf(clip, "x", rows.get("x"), look);
		assert.ok(probes.solids.length === 5 && probes.solids.every(p => p.local.length === p.t.length), "five frames of the drawn part sampled, corners and triangles per solid");
		assert.equal(gapLine("x (o1)", gapsOf(rows.get("x"), probes, { parts: [], inside: probes.inside.map(() => [0.2]), seats: [], solids: probes.solids.map(() => -0.042) })), "x (o1), off the drawn look: a Head's drawn part f0-29: 42 mm inside the drawn look");
		assert.equal(gapLine("x (o1)", gapsOf(rows.get("x"), probes, { parts: [], inside: probes.inside.map(() => [0.2]), seats: [], solids: probes.solids.map(() => 0.05) })), "x (o1), off the drawn look: a Head's drawn part f0-29: 50 mm from the drawn look");
		assert.equal(gapLine("x (o1)", gapsOf(rows.get("x"), probes, { parts: [], inside: probes.inside.map(() => [0.2]), seats: [], solids: probes.solids.map(() => 0.01) })), null, "within 0.03 m: not told");
	}
	// a ride with axis and deg: the part is turned against the prop's axes, and says so
	const turned = build({ x: [[0, "ride", { joint: "Head", of: "a", at: [0, 0.2, 0.012], axis: [0, 1, 0], deg: 30 }]] }, sc);
	assert.match(contactLine("x (o1)", contactsOf(turned.clip, turned.aux, "cube").get("x")), /\(turned 30° to these axes\)$/);
	// a ride that goes to its place over 10 frames (the frames since the key before): the joint carries it from the frame it got there
	const moved = build({ x: [[0, "ride", { joint: "Spine2", of: "a", at: [0, 0, -0.2] }], [10, "ride", { joint: "Head", of: "a", at: [0, 0.2, 0.012] }]] }, sc);
	assert.deepEqual(contactsOf(moved.clip, moved.aux, "cube").get("x").map(r => `${r.part} ${r.from}-${r.to}`).sort(), ["Head 19-29", "Spine2 0-9"]);
	console.log("ok contact rows: the carrying joint's drawn part (cube and block looks, from their solids), turned, from the frame it got there; hands as before; gap texts");
}
console.log("PASS verify-worn");
