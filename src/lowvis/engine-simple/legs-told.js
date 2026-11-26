// What each leg of a posture change came out as, measured on the clip (legs.js, spec-layers.js aux.legs): which knee
// came to the floor and on which frame, and how far a foot that `feet` set down ended from where it was asked.
import { ANKLE_HEIGHT, INDEX as J, JOINT_COUNT, REST, TIPS, qRotate } from "../rig17.js";

const TOE = TIPS.LeftFoot.map((v, k) => v - REST[J.LeftFoot][k]); // ankle -> toe tip at rest (the toe tip is straight ahead of the ankle's ground point)

/** Times the body's scale: a knee joint under KNEE m over the floor under the body is at the floor (resting there it is
 *  0.06 m up); a foot told off its spot is over OFF m from it. */
const LEGS = Object.freeze({ knee: 0.1, off: 0.03 });
const SIDE = { L: 0, R: 1 }, KNEE = [J.LeftLeg, J.RightLeg], ANKLE = [J.LeftFoot, J.RightFoot], NAME = ["left", "right"];

/** The legs block of the tool's text: one line per kneel and per change with `feet`; none without one. */
export function legLines(clip, aux) {
	const out = [];
	for (const e of aux.legs ?? []) {
		if (e.verb !== "kneel" && !e.feet) continue;
		const c = clip.characters.find(x => x.id === e.who), s = c.scale ?? 1, F = clip.frameCount;
		const P = (f, j) => Array.from(c.pos.slice((f * JOINT_COUNT + j) * 3, (f * JOINT_COUNT + j) * 3 + 3));
		const Q = (f, j) => Array.from(c.quat.slice((f * JOINT_COUNT + j) * 4, (f * JOINT_COUNT + j) * 4 + 4)), toe = (f, j) => qRotate(Q(f, j), TOE).map((v, n) => P(f, j)[n] + v * s);
		const f1 = Math.min(F - 1, e.f1), low = (f, i) => Math.min(toe(f, ANKLE[i])[1], P(f, ANKLE[i])[1] - ANKLE_HEIGHT * s); // the lowest point of that leg's foot: the floor it is on
		const parts = [];
		if (e.verb === "kneel" && e.f1 > e.f) parts.push(...[0, 1].map(i => { let at = null; for (let f = e.f; f <= f1 && at == null; f++) if (P(f, KNEE[i])[1] - low(f, i) < LEGS.knee * s) at = f; return at == null ? `${NAME[i]} knee not at the floor by f${f1}` : `${NAME[i]} knee at the floor from f${at}`; }));
		for (const [k, g] of Object.entries(e.feet ?? {})) { // from the toe tip, which stays where it is as the foot rolls onto it; on a prop that carries the body: where the body layer set it
			const j = ANKLE[SIDE[k]], fw = qRotate(Q(f1, j), [0, 0, 1]), l = Math.hypot(fw[0], fw[2]) || 1, t = toe(f1, j);
			const at = e.on == null ? [t[0] - fw[0] / l * TOE[2] * s, t[2] - fw[2] / l * TOE[2] * s] : e.set[k], d = Math.hypot(at[0] - g[0], at[1] - g[1]);
			if (d > LEGS.off * s) parts.push(`${NAME[SIDE[k]]} foot ${Math.round(d * 1000)} mm from where feet set it`);
		}
		if (e.cut) parts.push(`its steps and change want more frames than its action has: played faster, in those`);
		if (parts.length) out.push(`- ${e.who} ${e.verb} f${e.f}-${e.f1}${e.lead == null ? "" : ` (${NAME[e.lead]} leg leads, the other ${e.lag} frame${e.lag === 1 ? "" : "s"} later)`}: ${parts.join("; ")}`);
	}
	return out.length ? ["legs (each kneel and each change with feet, from the clip; a knee is at the floor under 0.1 m, times the body's scale, over its foot's lowest point):", ...out] : [];
}
