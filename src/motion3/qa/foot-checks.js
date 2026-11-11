// COLLIDE for the feet: the foot's skin against the scene bodies, as "foot_<k> x <id>". The shin capsule ends at
// the ankle and GROUND reads the floor only, so a swinging toe went 9.6 cm into a stair riser with QA clean
// (session e7edb718). The probes are points on the fitted skin of the foot and toe bones (body.js grids: the
// cells within half a step of the skin, one per SPACING m cube, carried by their bone); a rig without a fitted
// body uses the sole points. A foot on a body's top is a step, not a collision: a probe the top face is nearest
// to may sit up to the ground's allowance in it (QA_LIMITS.groundAllow, as GROUND gives the floor); through a
// side face the usual allowance holds. A part-wise allow entry ({ part: "foot", object }) sets both.
import { add, apply, dist, dot, scale } from "../compiler/math.js";
import { bodyFor } from "../body.js";
import { sdBox, boxNormal, solePoints } from "./geometry.js";

const UP = [0, 1, 0], TOP = 0.7, SPACING = 0.025;
// per skeleton (a rig registered again under its id is a new skeleton: rigs/index.js registerRig), then per side
const skins = new WeakMap();

/** Skin points of a foot in its bones' bind frames: [[bone index, local point], ...] (null for a rig without a fitted body). */
function footSkin(sk, side) {
	if (!skins.has(sk)) skins.set(sk, new Map());
	const mine = skins.get(sk);
	if (mine.has(side)) return mine.get(side);
	const body = bodyFor(sk), out = body ? [] : null;
	for (const g of body?.grids ?? []) {
		if (g.b !== sk.index[`${side}Foot`] && g.b !== sk.index[`${side}ToeBase`]) continue;
		const [nx, ny, nz] = g.dims, seen = new Set();
		for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) for (let k = 0; k < nz; k++) {
			if (Math.abs(g.data[(i * ny + j) * nz + k] / 1000) > body.step / 2) continue;
			const q = [g.min[0] + i * body.step, g.min[1] + j * body.step, g.min[2] + k * body.step], cell = q.map(v => Math.floor(v / SPACING)).join();
			if (!seen.has(cell)) { seen.add(cell); out.push([g.b, q]); }
		}
	}
	mine.set(side, out);
	return out;
}

/** The foot's collision probes at state s: world points on its skin (the sole points without a fitted body). */
export function footProbes(sk, s, side) {
	const skin = footSkin(sk, side);
	if (!skin?.length) {
		const sp = solePoints(sk, s, side), mid = (a, b) => scale(add(a, b), 0.5);
		return [sp.heel, mid(sp.heel, sp.ball), sp.ball, mid(sp.ball, sp.tip), sp.tip];
	}
	return skin.map(([b, q]) => add(s.P[b], apply(s.R[b], q)));
}

/**
 * How deep a foot's probes go into a box, through its top and through its sides: { top, side } in metres
 * (-Infinity: not in), each with the probe that goes deepest that way ({ topAt, sideAt }).
 */
export function footDepths(probes, box) {
	const out = { top: -Infinity, side: -Infinity, topAt: null, sideAt: null };
	for (const p of probes) {
		const d = -sdBox(p, box);
		if (d <= 0) continue;
		const way = dot(boxNormal(p, box), UP) > TOP ? "top" : "side";
		if (d > out[way]) { out[way] = d; out[`${way}At`] = p; }
	}
	return out;
}

/**
 * Push COLLIDE "foot_<k> x <id>" for each foot in each body at frame f. spheres: [id, box, centre, radius] of
 * the bodies (checks.js); allowed(part, id) the spec's allow depth or null.
 */
export function footChecks(sk, s, f, spheres, L, allowed, push) {
	for (const [side, k] of [["Left", "l"], ["Right", "r"]]) {
		const probes = footProbes(sk, s, side), part = `foot_${k}`;
		for (const [id, box, c, rb] of spheres) {
			if (probes.every(p => dist(p, c) > rb)) continue;
			const d = footDepths(probes, box), own = allowed(part, id), sideLim = own ?? L.allow, topLim = own ?? L.groundAllow;
			if (d.side > sideLim) push("COLLIDE", `${part} x ${id}`, f, d.side, sideLim);
			else if (d.top > topLim) push("COLLIDE", `${part} x ${id}`, f, d.top, topLim);
		}
	}
}
