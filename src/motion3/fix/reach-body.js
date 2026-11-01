// Reach by the body (spec.fix.reach): a hand on a pinned target (a world anchor, or an anchor on a scene object no
// hand carries, at half weight or more, or its own hand_l/r coordinates on IK) that the straight arm misses by more than QA's reach limit brings the body to
// it instead of leaving REACH to the agent. Over each run of such frames the body leans toward the target (spine_pitch
// forward, only for a target ahead and not above the shoulder), the hips shift toward it and, for a low target, go
// down: one amount t in (0, 1] of LEAN deg, SHIFT m and DROP m, the least that brings the hand within GOOD m at the
// run's worst frame (one the hand is fully on) with the elbow still bent (the target within BENT of the arm's reach),
// eased in and out over EASE frames and following the weights that take the hand there (armw and the anchor's). The feet stay on their keyed targets (the
// legs' IK takes the hips; fix.slide holds them after), so a contact keyed elsewhere does not move: a t is refused
// when it puts a leg past its reach, takes the other hand, on its own target, further off it, or puts the body deeper
// into the scene's bodies (QA's capsules against the boxes there: a lean into the machine the hand reaches into). The
// whole move is undone when it adds a one-frame pop (QA's own detector) where it eases in or out, or when the misses
// over the run do not drop. A run goes on for up to EASE frames while the hand stays short (it takes the object from
// there). One pass, each run once, a run's amount scaled down by what an earlier run already added at its worst frame
// (both hands on one box), so it cannot cascade. Reported as fixed.reachBody: per run the side, frames, lean (deg),
// shift [x, z] (m), drop (m) and the worst miss where the hand is fully on, before -> after (the larger of a fit's
// effector to the target and the wrist's). Sessions: REACH arm_miss_l 66 times, the agent moving the root by hand.
import { sub, len, norm, dot } from "../compiler/math.js";
import { SIDES } from "../compiler/pose.js";
import { resolveAnchor, armReach } from "../compiler/anchors.js";
import { round4 } from "./ease.js";
import { CAPSULES, segPoints, sdBox } from "../qa/geometry.js";
import { QA_LIMITS } from "../qa/checks.js";
import { popChecks } from "../qa/style.js";

const GOOD = 0.01, BENT = 0.97, LEAN = 25, SHIFT = 0.08, DROP = 0.15, EASE = 10, GAP = 2, SLACK = 0.002, TRIES = [0.25, 0.5, 0.75, 1];
const smooth = x => x * x * (3 - 2 * x);

// a hand keyed by hand_l/r world coordinates is pinned too (no anchor weight): deep research 8, a plant keyed that way
// 0.76-0.89 m from the shoulder stayed 0.2-0.3 m short while the same plant on an anchor brought the body to it
const COORDS = "#hand";
const coordsOf = (c, k) => (Array.isArray(c[`hand_${k}`]) && c[`hand_${k}`].length === 3 && c[`hand_${k}`].every(Number.isFinite) ? c[`hand_${k}`] : null);

/** The anchor that leads hand k at frame f when it is pinned (world, or a scene object no hand carries), COORDS for a
 * hand on its keyed coordinates (no anchor weight on that hand at all), else null. */
function pinned(ctx, c, k, f) {
	if (!(c[`armw_${k}`] >= 0.5)) return null;
	let best = null, sum = 0;
	for (const [ch, w] of Object.entries(c)) {
		const m = /^w_(.+)_([lr])$/.exec(ch);
		if (m && m[2] === k && w > 0) sum += w;
		if (m && m[2] === k && w >= 0.5 && (!best || w > best.w)) best = { w, name: m[1] };
	}
	const a = best && ctx.spec.anchors?.[best.name];
	if (a) return a.kind === "world" || (a.kind === "object" && !ctx.objectHand?.(a.object, f)) ? best.name : null;
	return sum <= 1e-6 && coordsOf(c, k) ? COORDS : null;
}

/** How deep the body is in the scene at frame f (the sum over QA's capsules), m; the reaching hand against the object it reaches for is left out. */
function depthIn(out, f, k, object) {
	const { s } = out.frames[f - out.f0], I = out.ctx.sk.index, scene = out.ctx.scene?.objects ?? {};
	const boxes = Object.entries(out.objectsAt(f - out.f0) ?? {}).filter(([, b]) => b.half && !b.ignore);
	const target = id => object !== undefined && (id === object || scene[id]?.ancestors?.includes(object));
	let sum = 0;
	for (const [part, a, b, r] of CAPSULES) {
		if (I[a] === undefined || I[b] === undefined) continue;
		const pts = segPoints(s.P[I[a]], s.P[I[b]], 5);
		for (const [id, box] of boxes) if (!(part === `hand_${k}` && target(id))) sum += Math.max(0, r - Math.min(...pts.map(p => sdBox(p, box))));
	}
	return sum;
}

/** QA's one-frame pops (qa/style.js popChecks) over a run of frames: their summed excess past the floor. */
function popsIn(sk, frames, L) {
	let sum = 0;
	popChecks(sk, { frames }, L, (kind, msg, f, value, limit) => { sum += value - limit; });
	return sum;
}

/** The point a fit's effector names: a prop point, or the joints' middle. */
function effector(sk, s, diag, eff) {
	if (eff?.prop) return diag.props?.[eff.prop]?.[eff.point] ?? null;
	const js = eff?.joints ?? ["RightHandIndex2", "RightHandMiddle2"], ps = js.map(j => s.P[sk.index[j]]).filter(Boolean);
	return ps.length ? ps.reduce((m, p) => m.map((x, i) => x + p[i] / ps.length), [0, 0, 0]) : null;
}

/** Runs [a, b] (absolute frames) where hand k misses a pinned target by more than limit (gaps of GAP frames merge). */
function runsOf(out, k, limit) {
	const runs = [];
	out.frames.forEach((fr, i) => {
		const f = out.f0 + i;
		if (!(fr.diag[`arm_miss_${k}`] > limit) || fr.diag[`arm_fold_${k}`] || !pinned(out.ctx, fr.c, k, f)) return;
		const last = runs.at(-1);
		if (last && f - last[1] <= GAP + 1) last[1] = f; else runs.push([f, f]);
	});
	// the hand is still short right after (it takes the object from there): the run goes on, up to EASE frames more
	const short = f => f >= out.f0 && f < out.f0 + out.frames.length && out.frames[f - out.f0].diag[`arm_miss_${k}`] > limit && !out.frames[f - out.f0].diag[`arm_fold_${k}`];
	for (const r of runs) for (let i = 0; i < EASE && short(r[1] + 1); i++) r[1] += 1;
	return runs;
}

export function reachBody(out, engine) {
	const { ctx } = out, { sk } = ctx, I = sk.index, n = out.frameCount, baked = out.baked;
	const limit = ctx.spec.checks?.limits?.reach ?? 0.01, at = f => out.frames[f - out.f0];
	const lo = out.f0, hi = out.f0 + out.frames.length - 1, report = [];
	// what this fix added per frame, so overlapping runs (both hands) stay within one full amount
	const added = { pitch: new Float64Array(n), move: new Float64Array(n) }, made = [];
	for (const k of ["r", "l"]) for (const [a, b] of runsOf(out, k, limit)) {
		// the target is the anchor's point (a fit winds the wrist target past it, so the miss does not say where it is);
		// the run's worst frame is where it is farthest from the shoulder
		const sh = f => at(f).s.P[I[`${SIDES[k]}Arm`]], target = f => { const { s, diag, c } = at(f), name = pinned(ctx, c, k, f); return name === COORDS ? coordsOf(c, k) : name ? resolveAnchor(ctx, name, s, { ...diag, frame: f }, c) : null; };
		// measured where the hand is fully on it (armw and the anchor's weight at 1) when the run has such frames: before, it is still on its way
		const full = f => { const c = at(f).c, name = pinned(ctx, c, k, f); return c[`armw_${k}`] >= 0.99 && (name === COORDS || c[`w_${name}_${k}`] >= 0.99); };
		const span = Array.from({ length: b - a + 1 }, (_, i) => a + i), pick = span.some(full) ? span.filter(full) : span;
		let fw = -1, T = null;
		for (const f of pick) { const q = target(f); if (q && (!T || len(sub(q, sh(f))) > len(sub(T, sh(fw))))) { fw = f; T = q; } }
		if (!T) continue;
		const { s, diag, c } = at(fw), other = k === "l" ? "r" : "l";
		const fit = (ctx.spec.fits ?? []).find(ft => ft.side === k && ft.anchor === pinned(ctx, c, k, fw)), eff = fit && effector(sk, s, diag, fit.effector);
		const miss0 = Math.max(eff ? len(sub(eff, T)) : 0, diag[`arm_miss_${k}`] ?? 0);
		// what the arm reaches with: the straight arm, and the effector's offset from the wrist when a fit names one
		const reach = armReach(sk, k) + (eff ? len(sub(eff, s.P[I[`${SIDES[k]}Hand`]])) : 0);
		const S = sh(fw), yaw = (c.yaw ?? 0) * Math.PI / 180, fwd = [Math.sin(yaw), 0, Math.cos(yaw)];
		const flat = [T[0] - S[0], 0, T[2] - S[2]], hd = len(flat) > 1e-3 ? norm(flat) : fwd;
		const lean = dot(hd, fwd) > 0.3 && T[1] < S[1] + 0.1 ? LEAN : 0, drop = DROP * Math.min(1, Math.max(0, (S[1] - T[1] - 0.2) / 0.4));
		const free = Math.max(0, 1 - Math.max(added.pitch[fw] / LEAN, added.move[fw] / SHIFT));
		if (!free) continue;
		if (!baked.root) { baked.root = Array.from({ length: n }, () => sk.restWorldPos[I.Hips].slice()); made.push("root"); }
		if (!baked.spine_pitch) { baked.spine_pitch = new Array(n).fill(0); made.push("spine_pitch"); }
		const root0 = baked.root.map(r => r.slice()), pitch0 = baked.spine_pitch.slice();
		const set = (f, t) => {
			baked.root[f] = [root0[f][0] + hd[0] * SHIFT * t, root0[f][1] - drop * t, root0[f][2] + hd[2] * SHIFT * t];
			baked.spine_pitch[f] = pitch0[f] + lean * t;
		};
		const legOk = (d, d0) => ["l", "r"].every(q => !((d[`leg_miss_${q}`] ?? 0) > Math.max(d0[`leg_miss_${q}`] ?? 0, 5e-4) + SLACK));
		const otherOk = (d, d0) => !(at(fw).c[`armw_${other}`] > 0.5) || (d[`arm_miss_${other}`] ?? 0) <= (d0[`arm_miss_${other}`] ?? 0) + SLACK;
		const object = ctx.spec.anchors?.[pinned(ctx, c, k, fw)]?.object, saved = at(fw), depth0 = depthIn(out, fw, k, object);
		const trial = t => {
			set(fw, t);
			engine.solve([fw]);
			// enough: the target within BENT of the arm's reach, so the elbow stays a little bent (a straight arm pops as it locks)
			// the miss: a fit's effector to the target (the wrist reaches a soft-clamped target, fix.reach), else the wrist's
			// (and the wrist's own miss too: a fit's target wound past a straight arm is what QA reads as REACH)
			const { s: s1, diag: d } = at(fw), e1 = fit && effector(sk, s1, d, fit.effector), miss = Math.max(e1 ? len(sub(e1, T)) : 0, d[`arm_miss_${k}`] ?? 0);
			const r = { t, miss, ok: legOk(d, diag) && otherOk(d, diag) && depthIn(out, fw, k, object) <= depth0 + SLACK, bent: len(sub(T, sh(fw))) <= BENT * reach };
			baked.root[fw] = root0[fw]; baked.spine_pitch[fw] = pitch0[fw];
			out.frames[fw - out.f0] = saved;
			return r;
		};
		let best = null, prev = 0;
		for (const t of TRIES.map(x => x * free)) {
			const r = trial(t);
			if (!r.ok) break;
			if (!best || r.miss < best.miss) best = r;
			if (r.miss <= GOOD && r.bent) {
				// the least amount that is enough
				let x = prev, y = t;
				for (let it = 0; it < 4; it++) { const m = trial((x + y) / 2); if (m.ok && m.miss <= GOOD && m.bent) { y = m.t; best = m; } else x = m.t; }
				break;
			}
			prev = t;
		}
		if (!best || !(best.miss < miss0 - GOOD)) continue;
		// the body comes as the hand does, by the weights that take it to the target (the reach's own timing: a torso leaning
		// over an arm still hanging swings it into the hips, and one leaning early changes the reach's speed profile)
		const w01 = (ch, f) => Math.min(1, Math.max(0, baked[ch]?.[f] ?? 1)), name = pinned(ctx, c, k, fw);
		const touched = [], weightAt = f => w01(`armw_${k}`, f) * w01(`w_${name}_${k}`, f) * (f >= a && f <= b ? 1 : smooth(1 - (f < a ? a - f : f - b) / (EASE + 1)));
		for (let f = Math.max(lo, a - EASE); f <= Math.min(hi, b + EASE); f++) { set(f, best.t * weightAt(f)); touched.push(f); }
		const before = touched.map(f => at(f)), depthBefore = touched.map(f => depthIn(out, f, k, object));
		engine.solve(touched);
		// kept when QA's reach (the wrist's misses over the run) and the worst miss where the hand is fully on drop, and no leg or other hand lost its target
		const was = f => before[f - touched[0]], gapAt = (fr, f) => { const q = target(f), e = fit && q && effector(sk, fr.s, fr.diag, fit.effector); return Math.max(e ? len(sub(e, q)) : 0, fr.diag[`arm_miss_${k}`] ?? 0); };
		const sumOf = get => span.reduce((m, f) => m + (get(f).diag[`arm_miss_${k}`] ?? 0), 0), worstOf = get => Math.max(...pick.map(f => gapAt(get(f), f)));
		const depths = touched.map(f => depthIn(out, f, k, object)), L = { ...QA_LIMITS, ...ctx.spec.checks?.limits };
		// the frames around the move, as they were and as they are: the move may not add a pop where it eases in or out
		const near = Array.from({ length: Math.min(hi, touched.at(-1) + 3) - Math.max(lo, touched[0] - 3) + 1 }, (_, i) => Math.max(lo, touched[0] - 3) + i);
		const popped = popsIn(sk, near.map(f => at(f)), L) > popsIn(sk, near.map(f => (f >= touched[0] && f <= touched.at(-1) ? before[f - touched[0]] : at(f))), L) + 1e-4;
		const legsHeld = touched.every((f, i) => legOk(at(f).diag, before[i].diag) && otherOk(at(f).diag, before[i].diag) && depths[i] <= depthBefore[i] + SLACK);
		const worst0 = worstOf(was), worst1 = worstOf(at);
		if (!legsHeld || popped || !(sumOf(at) < sumOf(was) - 1e-6) || !(worst1 < worst0 - GOOD / 2)) {
			for (const f of touched) { baked.root[f] = root0[f]; baked.spine_pitch[f] = pitch0[f]; }
			touched.forEach((f, i) => { out.frames[f - out.f0] = before[i]; });
			continue;
		}
		for (const f of touched) { added.pitch[f] += lean * best.t * weightAt(f); added.move[f] += SHIFT * best.t * weightAt(f); }
		report.push({ side: k, frames: [a, b], lean: round4(lean * best.t), shift: [round4(hd[0] * SHIFT * best.t), round4(hd[2] * SHIFT * best.t)], drop: round4(drop * best.t), miss: [round4(worst0), round4(worst1)] });
	}
	// a channel this fix made for a move it undid goes again
	if (!report.length) for (const ch of made) delete baked[ch];
	return report.length ? { runs: report, how: "an out-of-reach hand on a pinned target: the body leaned (spine_pitch deg), shifted its hips (x, z m) and lowered them (m) toward it, eased in and out; the feet kept their targets" } : null;
}
