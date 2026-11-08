// Balance table of the v4 measure tool, every `step` frames:
//   com         mass-weighted centre of mass (qa/com.js centerOfMass)
//   support     the kinds of support points on the ground: feet (sole points), hands (palms),
//               knees, hips (buttocks); a point supports when its skin is at most 0.02 m above the
//               ground under it (qa/ground.js groundY: the floor or a box top); "air" when none does
//   margin      supportMargin of the COM's ground projection against the support points (com.js):
//               > 0 inside the polygon, < 0 outside, null in the air
//   xcom        extrapolated COM (Hof): com + v / omega, v the COM's horizontal speed (central
//               difference), omega = sqrt(9.8 / (com.y - ground under the COM)); xcomMargin its margin
// outside: runs of rows whose margin is below 0.
import { centerOfMass, bodyCentre, supportMargin } from "../../motion3/qa/com.js";
import { groundY } from "../../motion3/qa/ground.js";
import { contactEnds } from "./probes.js";

const SUPPORT = 0.02, G = 9.8, MIN_HEIGHT = 0.05;
const round = (v, d) => (v === null ? null : Math.round(v * 10 ** d) / 10 ** d);

/** COM of frame index i, clamped to the take. */
function comAt(out, i, memo) {
	const j = Math.max(0, Math.min(out.frames.length - 1, i));
	if (!memo.has(j)) memo.set(j, centerOfMass(out.ctx.sk, out.frames[j].s) ?? bodyCentre(out.ctx.sk, out.frames[j].s));
	return memo.get(j);
}

/** Support points [x, z] of frame i and the kinds they come from. */
function supportAt(out, i) {
	const points = [], kinds = new Set();
	for (const e of contactEnds(out.ctx.sk, out.frames[i].s)) {
		if (!e.kind) continue;
		for (const p of e.pts) {
			if (p[1] - e.r - groundY(out, i, p) > SUPPORT) continue;
			points.push([p[0], p[2]]);
			kinds.add(e.kind);
		}
	}
	return { points, kinds: [...kinds] };
}

/**
 * balanceRows(out, { from, to, step }) -> { rows, outside }
 * rows: { f, com: [x, y, z], support: string[], margin, xcom: [x, z], xcomMargin } (m)
 * outside: [{ from, to, worstMargin }]
 */
export function balanceRows(out, { from = 0, to = out.frames.length - 1, step = 1 } = {}) {
	const memo = new Map(), rows = [], outside = [], fps = out.fps ?? 24;
	let run = null;
	for (let f = from; f <= to; f += step) {
		const com = comAt(out, f, memo), a = comAt(out, f - 1, memo), b = comAt(out, f + 1, memo);
		const span = Math.min(out.frames.length - 1, f + 1) - Math.max(0, f - 1) || 1;
		const v = [(b[0] - a[0]) * fps / span, (b[2] - a[2]) * fps / span];
		const omega = Math.sqrt(G / Math.max(MIN_HEIGHT, com[1] - groundY(out, f, com)));
		const xcom = [com[0] + v[0] / omega, com[2] + v[1] / omega];
		const { points, kinds } = supportAt(out, f);
		const margin = points.length ? supportMargin([com[0], com[2]], points).margin : null;
		const xcomMargin = points.length ? supportMargin(xcom, points).margin : null;
		rows.push({ f, com: com.map(x => round(x, 3)), support: points.length ? kinds : ["air"], margin: round(margin, 3), xcom: xcom.map(x => round(x, 3)), xcomMargin: round(xcomMargin, 3) });
		if (margin !== null && margin < 0) {
			if (run && run.to === f - step) { run.to = f; run.worstMargin = Math.min(run.worstMargin, margin); }
			else outside.push(run = { from: f, to: f, worstMargin: margin });
		}
	}
	for (const r of outside) r.worstMargin = round(r.worstMargin, 3);
	return { rows, outside };
}
