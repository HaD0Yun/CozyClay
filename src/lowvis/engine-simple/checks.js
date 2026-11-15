// Self-checks measured from a finished (parsed) clip. `aux` is buildClip's per-frame flags: which feet the engine
// calls planted and who holds each prop. Positions and rotations come from the clip only.
import { INDEX as J, JOINT_COUNT } from "../rig17.js";
import { qConj, qRotate } from "./math.js";
import { SOLE, TOE } from "./solve.js";

const FEET = [J.LeftFoot, J.RightFoot], HANDS = [J.LeftHand, J.RightHand];

export function checkClip(clip, aux) {
	const F = clip.frameCount, r = { slide: 0, slideStep: 0, footLow: Infinity, jointLow: Infinity, carryMin: null, carryMax: null, carryFrames: 0, freeTravel: 0, bodyToBox: null, gripDrift: null, gripTurn: null, cuts: [], headTurn: 0, elbow: 0, wrist: 0, releases: [], launches: [] };
	const propAt = (p, f) => { const i = p.pos.length === 3 ? 0 : f; return { c: p.pos.slice(i * 3, i * 3 + 3), q: p.quat.slice(i * 4, i * 4 + 4) }; };
	// a world point over (or under) a static prop's footprint, in the prop's own frame
	const over = (pt, s) => { const l = qRotate(qConj(s.quat.slice(0, 4)), [pt[0] - s.pos[0], 0, pt[2] - s.pos[2]]); return Math.abs(l[0]) <= s.size[0] / 2 && Math.abs(l[2]) <= s.size[2] / 2; };
	// signed distance from a world point to a prop's box at frame f (negative = inside)
	const toBox = (pt, p, f) => { const { c, q } = propAt(p, f), l = qRotate(qConj(q), [pt[0] - c[0], pt[1] - c[1], pt[2] - c[2]]).map((v, k) => Math.abs(v) - p.size[k] / 2); return Math.hypot(...l.map(v => Math.max(v, 0))) + Math.min(0, Math.max(...l)); };
	const at = (c, f, j) => { const i = (f * JOINT_COUNT + j) * 3; return [c.pos[i], c.pos[i + 1], c.pos[i + 2]]; };
	const rot = (c, f, j) => { const i = (f * JOINT_COUNT + j) * 4; return [c.quat[i], c.quat[i + 1], c.quat[i + 2], c.quat[i + 3]]; };
	const contact = (c, f, j) => [TOE, SOLE].map(o => { const a = at(c, f, j), d = qRotate(rot(c, f, j), o); return [a[0] + d[0], a[1] + d[1], a[2] + d[2]]; });
	for (const c of clip.characters) for (let f = 1; f < F; f++) { // fastest head turn (deg per frame) and elbow / wrist move (m per frame)
		const q = rot(c, f, J.Head), p = rot(c, f - 1, J.Head), sp = j => Math.hypot(...at(c, f, j).map((v, k) => v - at(c, f - 1, j)[k]));
		r.headTurn = Math.max(r.headTurn, 2 * Math.acos(Math.min(1, Math.abs(q[0] * p[0] + q[1] * p[1] + q[2] * p[2] + q[3] * p[3]))) * 180 / Math.PI);
		r.elbow = Math.max(r.elbow, sp(J.LeftForeArm), sp(J.RightForeArm)); r.wrist = Math.max(r.wrist, sp(J.LeftHand), sp(J.RightHand));
	}
	// a prop released into a roll: the jump of its position (against constant velocity) and of its speed at the release
	// frame, and its height over the static prop under it (the lane) while it rolls
	for (const e of aux.releases) {
		const p = clip.props.find(q => q.id === e.prop), c = f => propAt(p, f).c, d = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
		const a = c(e.f - 2), b = c(e.f - 1), n = c(e.f), out = { prop: e.prop, f: e.f, posJump: Math.hypot(n[0] - 2 * b[0] + a[0], n[1] - 2 * b[1] + a[1], n[2] - 2 * b[2] + a[2]), speedJump: Math.abs(d(n, b) - d(b, a)), speed: d(n, b), low: Infinity, high: -Infinity, off: 0 };
		for (let f = e.f; f < F; f++) {
			if (!aux.rolling[e.prop][f]) continue;
			const pc = c(f), under = clip.props.filter(s => s.pos.length === 3 && over(pc, s) && s.pos[1] + s.size[1] / 2 < 0.3);
			if (!under.length) out.off++;
			const h = pc[1] - p.size[1] / 2 - Math.max(0, ...under.map(s => s.pos[1] + s.size[1] / 2));
			out.low = Math.min(out.low, h); out.high = Math.max(out.high, h);
		}
		r.releases.push(out);
	}
	// a launched prop (a ball of radius size[1] / 2): how far it moved up to its launch frame, how far the nearest foot
	// (ankle-toe and heel-toe lines) is from its surface on that frame, its height over the floor, its clearance to
	// every standing static prop (sampled along each frame's move, negative = inside) and the last frame it moves
	for (const e of aux.launches ?? []) {
		const p = clip.props.find(q => q.id === e.prop), c = f => propAt(p, f).c, d = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]), rad = p.size[1] / 2;
		const seg = (pt, a, b) => { const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], t = Math.min(1, Math.max(0, ((pt[0] - a[0]) * ab[0] + (pt[1] - a[1]) * ab[1] + (pt[2] - a[2]) * ab[2]) / (ab[0] ** 2 + ab[1] ** 2 + ab[2] ** 2))); return d(pt, [a[0] + ab[0] * t, a[1] + ab[1] * t, a[2] + ab[2] * t]); };
		const out = { prop: e.prop, f: e.f, before: 0, touch: null, speed: e.f + 1 < F ? d(c(e.f + 1), c(e.f)) : 0, low: Infinity, high: -Infinity, wall: null, stop: e.f, rest: c(F - 1) };
		for (let f = 0; f <= e.f; f++) out.before = Math.max(out.before, d(c(f), c(0)));
		for (const ch of clip.characters) FEET.forEach((j, side) => {
			const [toe, sole] = contact(ch, e.f, j), dist = Math.min(seg(c(e.f), at(ch, e.f, j), toe), seg(c(e.f), sole, toe)) - rad;
			if (!out.touch || dist < out.touch.dist) out.touch = { who: ch.id, foot: side ? "R" : "L", dist };
		});
		const walls = clip.props.filter(s => s.pos.length === 3 && s.pos[1] + s.size[1] / 2 > 0.3);
		for (let f = 0; f < F; f++) {
			out.low = Math.min(out.low, c(f)[1] - rad); out.high = Math.max(out.high, c(f)[1] - rad);
			if (!f) continue;
			const a = c(f - 1), b = c(f);
			if (d(a, b) > 1e-6) out.stop = f;
			for (const s of walls) for (let n = 0; n <= 16; n++) out.wall = Math.min(out.wall ?? Infinity, toBox(a.map((v, k) => v + (b[k] - v) * n / 16), s, 0) - rad);
		}
		r.launches.push(out);
	}
	for (const c of clip.characters) {
		for (let f = 0; f < F; f++) for (let j = 0; j < JOINT_COUNT; j++) r.jointLow = Math.min(r.jointLow, c.pos[(f * JOINT_COUNT + j) * 3 + 1]);
		FEET.forEach((j, side) => {
			let sum = 0, prev = null;
			for (let f = 0; f < F; f++) {
				const pts = contact(c, f, j);
				r.footLow = Math.min(r.footLow, pts[0][1], pts[1][1]);
				if (!aux.contacts[c.id][f][side]) { sum = 0; prev = null; continue; }
				// a planted foot may roll on its toe or its heel: the slide of a frame is the smaller of the two moves
				if (prev) { const step = Math.min(...pts.map((p, k) => Math.hypot(p[0] - prev[k][0], p[1] - prev[k][1], p[2] - prev[k][2]))); sum += step; r.slideStep = Math.max(r.slideStep, step); r.slide = Math.max(r.slide, sum); }
				prev = pts;
			}
		});
	}
	for (const p of clip.props) {
		if (p.pos.length === 3) continue;
		for (let f = 0; f < F; f++) {
			const c = clip.characters.find(ch => ch.id === aux.holders[p.id][f]);
			if (!c || aux.grips[p.id][f]) continue;
			r.carryFrames++;
			const centre = p.pos.slice(f * 3, f * 3 + 3), q = qConj(p.quat.slice(f * 4, f * 4 + 4));
			for (const j of HANDS) { // signed distance from the wrist joint to the box surface (negative = inside)
				const h = at(c, f, j), l = qRotate(q, [h[0] - centre[0], h[1] - centre[1], h[2] - centre[2]]).map((v, k) => Math.abs(v) - p.size[k] / 2);
				const d = Math.hypot(...l.map(v => Math.max(v, 0))) + Math.min(0, Math.max(...l));
				r.carryMin = Math.min(r.carryMin ?? d, d); r.carryMax = Math.max(r.carryMax ?? d, d);
			}
		}
	}
	for (const p of clip.props) {
		if (p.pos.length === 3) continue;
		// travel of a prop that nothing holds and no key moves: must be 0
		for (let f = 1; f < F; f++) if (!aux.holders[p.id][f] && !aux.holders[p.id][f - 1] && !aux.keyed[p.id][f]) r.freeTravel += Math.hypot(p.pos[f * 3] - p.pos[f * 3 - 3], p.pos[f * 3 + 1] - p.pos[f * 3 - 2], p.pos[f * 3 + 2] - p.pos[f * 3 - 1]);
		// a pushed prop: clearance of every joint but the hands, over the whole clip
		if (aux.slid[p.id]) for (const c of clip.characters) for (let f = 0; f < F; f++) for (let j = 0; j < JOINT_COUNT; j++) if (!HANDS.includes(j)) r.bodyToBox = Math.min(r.bodyToBox ?? Infinity, toBox(at(c, f, j), p, f));
		// a prop fixed in one hand: drift of its centre and of its rotation in the hand's frame
		let ref = null;
		for (let f = 0; f < F; f++) {
			const g = aux.grips[p.id][f], c = g && clip.characters.find(ch => ch.id === g.c);
			if (!c) continue;
			const j = HANDS[g.hand], hq = qConj(rot(c, f, j)), { c: pc, q: pq } = propAt(p, f), h = at(c, f, j);
			const off = qRotate(hq, [pc[0] - h[0], pc[1] - h[1], pc[2] - h[2]]), axis = qRotate(hq, qRotate(pq, [0, 0, 1]));
			ref ??= { off, axis };
			r.gripDrift = Math.max(r.gripDrift ?? 0, Math.hypot(off[0] - ref.off[0], off[1] - ref.off[1], off[2] - ref.off[2]));
			r.gripTurn = Math.max(r.gripTurn ?? 0, Math.asin(Math.min(1, Math.hypot(axis[1] * ref.axis[2] - axis[2] * ref.axis[1], axis[2] * ref.axis[0] - axis[0] * ref.axis[2], axis[0] * ref.axis[1] - axis[1] * ref.axis[0]))));
		}
	}
	// when a keyed prop starts to move (the trunk at the cut frame): distance from each hand-held prop's long axis to it
	for (const k of aux.keyStarts) for (const p of clip.props) {
		if (!aux.grips[p.id]?.[k.f]) continue;
		const target = clip.props.find(t => t.id === k.prop), { c, q } = propAt(p, k.f);
		let d = Infinity;
		for (let n = 0; n <= 40; n++) { const o = qRotate(q, [0, 0, (n / 40 - 0.5) * p.size[2]]); d = Math.min(d, toBox([c[0] + o[0], c[1] + o[1], c[2] + o[2]], target, k.f)); }
		r.cuts.push({ f: k.f, blade: p.id, target: k.prop, dist: d });
	}
	return r;
}
