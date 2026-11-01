// Swinging feet out of scene bodies (fix.clear, after the planted feet are held): a moving foot whose skin goes into a box
// (QA COLLIDE "foot_<k> x <id>", the same probes and depths, qa/foot-checks.js) moves its ankle target out: up over the box
// (a toe that catches a stair edge steps over it), or back out through the side it entered when the box is too tall to clear.
// A still foot only comes back up onto a top it sank into; one in a side is the stance's (fix.stance moves a standing pose
// out of a body; with it off QA reports the foot). MotionBricks fills and straight key-to-key curves both cut stair edges: the model does not see
// the scene (paper Sec. 8.1) and a curve between two treads runs through the riser (stairs + box bench, 2026-10-31: COLLIDE
// foot x Step_* in every take). The move eases in and out over EASE frames and a few passes settle what a move uncovers.
import { add, scale } from "../compiler/math.js";
import { footProbes, footDepths } from "../qa/foot-checks.js";
import { boxNormal } from "../qa/geometry.js";
import { QA_LIMITS } from "../qa/checks.js";
import { SIDES } from "../compiler/pose.js";
import { easeAround, round4 } from "./ease.js";

const EASE = 3, MAX_LIFT = 0.3, SWING = 0.008, MARGIN = 0.006, PASSES = 3, FOOT = 0.3;

/** The ankle move (world [x, y, z]) that takes one foot out of one box at one frame, or null. */
function moveOut(probes, box, swinging) {
	const d = footDepths(probes, box), side = d.side > QA_LIMITS.allow, top = d.top > QA_LIMITS.groundAllow;
	if (!side && !top) return null;
	const upright = Math.abs(box.R[1][1]) > 0.99, topY = box.pos[1] + 2 * box.half[1];
	const low = Math.min(...probes.filter(p => p[1] < topY).map(p => p[1]));
	const lift = upright && Number.isFinite(low) ? topY - low + MARGIN : Infinity;
	if (top && !side) return [0, d.top + MARGIN, 0];
	if ((swinging || lift <= d.side * 2) && lift <= MAX_LIFT) return [0, lift, 0];
	const n = boxNormal(d.sideAt, box), h = Math.hypot(n[0], n[2]) || 1;
	return [n[0] / h * (d.side + MARGIN), 0, n[2] / h * (d.side + MARGIN)];
}

/** The lift that puts a still foot sunk into a box's top back on it, or null (a foot in a side is left to the stance and QA). */
function sunk(probes, box) {
	const d = footDepths(probes, box);
	return d.top > QA_LIMITS.groundAllow && !(d.side > QA_LIMITS.allow) ? [0, d.top + MARGIN, 0] : null;
}

function pass(out, engine, skip) {
	const { sk } = out.ctx, n = out.frames.length, touched = new Set();
	let worst = 0;
	for (const [k, S] of Object.entries(SIDES)) {
		const ch = out.baked[`foot_${k}`];
		if (!ch) continue;
		const ankle = sk.index[`${S}Foot`];
		const moves = out.frames.map(({ s }, i) => {
			const f = out.f0 + i, prev = ch[Math.max(out.f0, f - 1)], next = ch[Math.min(out.f0 + n - 1, f + 1)];
			const swinging = Math.hypot(next[0] - prev[0], next[2] - prev[2]) / 2 > SWING || Math.abs(next[1] - prev[1]) / 2 > SWING;
			const a = s.P[ankle];
			let best = null, probes = null;
			for (const [id, box] of Object.entries(out.objectsAt?.(i) ?? {})) {
				if (!box.half || box.ignore || box.carried || skip.has(id)) continue;
				// a box whose bounding sphere is farther than a foot's length from the ankle cannot hold it
				const c = [box.pos[0] + box.R[0][1] * box.half[1], box.pos[1] + box.R[1][1] * box.half[1], box.pos[2] + box.R[2][1] * box.half[1]];
				if (Math.hypot(a[0] - c[0], a[1] - c[1], a[2] - c[2]) > Math.hypot(...box.half) + FOOT) continue;
				probes ??= footProbes(sk, s, S);
				// a still foot only comes up onto a top it sank into (as fix.ground lifts it onto the floor); sides are the stance's
				const m = swinging ? moveOut(probes, box, true) : sunk(probes, box);
				if (m && (!best || Math.hypot(...m) > Math.hypot(...best))) best = m;
			}
			return best;
		});
		const size = moves.map(m => (m ? Math.hypot(...m) : 0));
		if (!size.some(v => v > 0)) continue;
		const eased = easeAround(size, EASE);
		for (let i = 0; i < n; i++) {
			if (!(eased[i] > 0)) continue;
			let j = i;
			for (let r = 0; r <= EASE + 1 && !moves[j]; r++) j = moves[i - r] ? i - r : moves[i + r] ? i + r : j;
			const m = moves[j];
			if (!m) continue;
			const f = out.f0 + i, v = scale(m, eased[i] / Math.hypot(...m));
			ch[f] = add(ch[f], v).map(round4);
			worst = Math.max(worst, size[i]);
			touched.add(f);
		}
	}
	if (touched.size) engine.solve([...touched]);
	return { touched, worst };
}

export function clearFeet(out, engine) {
	const skip = new Set(Object.entries(out.ctx.spec?.objects ?? {}).filter(([, o]) => o?.prop).map(([id]) => id)), all = new Set();
	let worst = 0;
	for (let p = 0; p < PASSES; p++) {
		const r = pass(out, engine, skip);
		if (!r.touched.size) break;
		r.touched.forEach(f => all.add(f));
		worst = Math.max(worst, r.worst);
	}
	return all.size ? { frames: all.size, max: round4(worst), how: "swinging feet moved out of scene bodies: over the box, or back out of a tall one" } : null;
}
