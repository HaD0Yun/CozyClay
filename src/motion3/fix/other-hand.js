// The second hand on a carried object (fix.grasp): an object rides the hand that carries it (objects.<id>.prop), so a box
// held on its sides by both hands follows the carrying palm while the other hand follows its own keys, and the two part:
// on a turn or a step down the free hand went 10 cm into the box (stairs + box bench, 2026-10-31, QA COLLIDE hand_l x box).
// When the other hand is on IK and within REACH of the object a few frames after the grab, its wrist is held where the
// carrying wrist sits, mirrored across the object's middle plane (the face opposite the carrying palm), in the object's frame
// on every carried frame: a two-hand hold. It eases in over EASE frames from the grab and stays to the release.
import { add, apply, scale, sub, T } from "../compiler/math.js";
import { sdBox, segPoints } from "../qa/geometry.js";
import { rootPoseAt, spanOf } from "../object-pose.js";
import { round4 } from "./ease.js";

const EASE = 4, REACH = 0.1, HAND = { l: "LeftHand", r: "RightHand" }, MARGIN = 0.004, PASSES = 3;
// the other hand's capsules (qa/geometry.js CAPSULES): its fingers and forearm stay out of the box it holds
const PARTS = S => [[`${S}Hand`, `${S}HandMiddle3`, 0.022], [`${S}ForeArm`, `${S}Hand`, 0.033]];
const smooth = t => t * t * (3 - 2 * t);

export function otherHandHold(out, engine) {
	const { sk, spec } = out.ctx, f0 = out.f0 ?? 0, n = out.frames.length, touched = new Set(), held = [];
	for (const [id, o] of Object.entries(spec?.objects ?? {})) {
		const k = spec.props?.[o?.prop]?.hand, other = k === "l" ? "r" : k === "r" ? "l" : null;
		const ch = out.baked[`hand_${other}`], weight = out.baked[`armw_${other}`], part = out.ctx.scene?.objects?.[id];
		if (!other || o.grab === undefined || !ch || !part?.half) continue;
		const [grab, release] = spanOf(out, o), at = Math.min(grab + EASE, f0 + n - 1), pose = rootPoseAt(out, id, at), s = out.frames[at - f0]?.s;
		if (!pose || !s || !((weight?.[at] ?? 0) >= 0.5)) continue;
		const local = p => apply(T(pose.R), sub(p, pose.pos));
		const mine = local(s.P[sk.index[HAND[k]]]), theirs = local(s.P[sk.index[HAND[other]]]);
		// the other hand is holding only when it is near the box at the grab (a free hand swinging by is left alone)
		const out_ = Math.max(...[0, 1, 2].map(i => Math.abs(theirs[i] - (i === 1 ? part.half[1] : 0)) - part.half[i]));
		if (out_ > REACH) continue;
		const axis = [0, 2].reduce((m, i) => (Math.abs(mine[i]) > Math.abs(mine[m]) ? i : m), 0), want = mine.slice();
		want[axis] = -mine[axis];
		held.push({ id, other, axis, sign: Math.sign(want[axis]) || 1, half: part.half });
		for (let f = Math.max(grab, f0); f <= Math.min(release, f0 + n - 1); f++) {
			const p = rootPoseAt(out, id, f);
			if (!p || !((weight?.[f] ?? 0) >= 0.5)) continue;
			const target = add(p.pos, apply(p.R, want)), w = smooth(Math.min(1, (f - grab + 1) / EASE));
			ch[f] = ch[f].map((v, i) => round4(v + (target[i] - v) * w));
			touched.add(f);
		}
	}
	if (!touched.size) return null;
	engine.solve([...touched]);
	// the wrist sits mirrored, but the fingers may point into the box: move the wrist out through the face until they clear it
	for (let pass = 0; pass < PASSES; pass++) {
		const moved = [];
		for (const { id, other, axis, sign, half } of held) {
			const ch = out.baked[`hand_${other}`], S = HAND[other].replace("Hand", "");
			for (const f of touched) {
				const p = rootPoseAt(out, id, f), s = out.frames[f - f0]?.s;
				if (!p || !s) continue;
				const box = { pos: p.pos, R: p.R, half };
				const depth = Math.max(0, ...PARTS(S).flatMap(([a, b, r]) => segPoints(s.P[sk.index[a]], s.P[sk.index[b]], 5).map(q => r - sdBox(q, box))));
				if (depth <= MARGIN / 2) continue;
				const n = [0, 0, 0];
				n[axis] = sign;
				ch[f] = add(ch[f], scale(apply(p.R, n), depth + MARGIN)).map(round4);
				moved.push(f);
			}
		}
		if (!moved.length) break;
		engine.solve(moved);
	}
	return { frames: touched.size, how: "the other hand held on the carried object, opposite the carrying palm, its fingers out of it" };
}
