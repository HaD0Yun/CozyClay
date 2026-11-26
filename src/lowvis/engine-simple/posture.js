// Posture transitions: stand <-> sit on a seat, stand <-> kneel, kneel -> lie on the back. Each returns the body
// states of its frames and the new state; `st.lastB` is the posture an "idle" then holds. legs (legs.js): which leg
// leads and by what share of the frames the other follows.
import { INDEX as J, OFFSET, REST } from "../rig17.js";
import { add, len, mix, mixV, mul, qConj, qMul, qRotate, qSlerp, qX, qY, qZ, smooth, sub, clamp } from "./math.js";
import { STAND_Y, footPose, hang, standB } from "./gait.js";
import { ROLL_MOST, legsAt, rollAt, settled } from "./legs.js";

const THIGH = s => [s * 0.1, 0.05, 0.27]; // hand on the thigh, pelvis frame
export const SEAT_UP = 0.13;              // Hips joint height over the seat top

function sitB(st, seat, g, gy, bend, h, dy = 0, roll = 0) {
	const B = standB(st), sn = Math.sin(st.yaw), cs = Math.cos(st.yaw);
	B.p = [B.p[0] - sn * seat.back * g, mix(STAND_Y, seat.y + SEAT_UP, gy) + dy, B.p[2] - cs * seat.back * g];
	B.q = qMul(qY(st.yaw), qMul(qZ(roll), qX(0.45 * bend))); B.lean = 0.55 * bend;
	B.hands = [1, -1].map(s => mixV(hang(s), THIGH(s), h));
	return B;
}

/** Sit on a seat behind the figure: lean forward, hips go back and down, settle upright. seat = { y, back }. */
export function sit(st, N, seat, legs) {
	const frames = Array.from({ length: N }, (_, i) => {
		const u = (i + 1) / N;
		return sitB(st, seat, smooth(u / 0.8), smooth((u - 0.1) / 0.72), 0.6 * Math.sin(Math.PI * clamp(u / 0.92)),
			smooth((u - 0.3) / 0.6), u > 0.82 ? -0.012 * Math.sin(Math.PI * (u - 0.82) / 0.18) : 0, legs ? rollAt(u, legs, true) : 0);
	});
	return { frames, st: { ...st, seat, lastB: frames.at(-1), knelt: undefined } };
}

/** Stand up from the seat: lean forward first (anticipation), then rise over the feet. From a kneel: the kneel played
 *  back (kneelFrames), the leg that leads rising first. Else the posture holds. */
export function stand(st, N, legs, ground) {
	const own = settled(st); // legs.js: it stands up between its feet, where feet stepped while it sat or knelt
	if (st.knelt) {
		const back = kneelFrames({ ...own, lastB: undefined, knelt: undefined }, N, ground, { lead: 1 - legs.lead, D: legs.D });
		const frames = back.map((_, i) => back[N - 2 - i] ?? standB(own)), E = back.at(-1), L = st.lastB, off = (a, b) => len(sub(a, b)) > 1e-9;
		// held in another pose than that kneel ends in (a foot stepped while it knelt): it leaves that pose over 12 frames
		if (L && (off(L.p, E.p) || L.feet.some((f, j) => off(f.a, E.feet[j].a)))) frames.forEach((B, i) => {
			const w = 1 - smooth((i + 1) / Math.min(N, 12)), turned = (q, from, to) => qSlerp(q, qMul(qMul(to, qConj(from)), q), w);
			if (w > 0) frames[i] = { ...B, p: add(B.p, mul(sub(L.p, E.p), w)), q: turned(B.q, E.q, L.q), feet: B.feet.map((f, j) => ({ ...f, a: add(f.a, mul(sub(L.feet[j].a, E.feet[j].a), w)), q: turned(f.q, E.feet[j].q, L.feet[j].q) })) };
		});
		return { frames, st: { p: own.p, yaw: st.yaw, feet: st.feet } };
	}
	if (!st.seat) return null;
	const frames = Array.from({ length: N }, (_, i) => {
		const u = (i + 1) / N, g = 1 - smooth((u - 0.25) / 0.7);
		const B = sitB(own, st.seat, g, 1 - smooth((u - 0.28) / 0.65), 0.65 * Math.sin(Math.PI * clamp(u / 0.9) ** 0.7), 1 - smooth((u - 0.2) / 0.6), 0, legs ? rollAt(u, legs, false) : 0);
		if (own !== st) { B.p[0] += (st.p[0] - own.p[0]) * g; B.p[2] += (st.p[1] - own.p[1]) * g; } // from where it sat
		return B;
	});
	return { frames, st: { p: own.p, yaw: st.yaw, feet: st.feet } };
}

const HIPW = 2 * Math.abs(OFFSET[J.LeftUpLeg][0]); // between the hip joints
const pitchOf = q => { const v = qRotate(q, [0, 0, 1]); return Math.atan2(-v[1], Math.hypot(v[0], v[2])); }; // toes down > 0

/** Kneel: the toes of each leg that goes down stay where they are and its knee goes forward and down to the floor, the
 *  leading leg first (legs.js); a foot ahead of where the other knee comes down stays flat, its knee up. With one knee
 *  down ahead of the other the hips come down as far as both thighs reach. From a kneel it goes on from that kneel to
 *  the one its feet now give. ground(x, z) is the floor height. */
export function kneel(st, N, ground, legs) {
	const frames = kneelFrames(st, N, ground, legs);
	return { frames, st: { ...st, lastB: frames.at(-1), knelt: { lead: legs.lead } } };
}

function kneelFrames(st, N, ground, legs) {
	const PITCH = 1.35, l1 = len(OFFSET[J.LeftLeg]), l2 = len(OFFSET[J.LeftFoot]), sn = Math.sin(st.yaw), cs = Math.cos(st.yaw);
	const knees = st.feet.map(f => {
		const a = footPose(f.g, 0, f.yaw, PITCH).a, y = ground(a[0] + sn * 0.42, a[2] + cs * 0.42) + 0.07;
		const hz = Math.sqrt(Math.max(0, l2 * l2 - (a[1] - y) ** 2));
		return [a[0] + sn * hz, y, a[2] + cs * hz];
	});
	// a foot that stands ahead of where the other leg's knee comes down keeps its sole on the floor and its knee up (the
	// two knees down that far apart would fold the front one past what a knee folds; nearer, a knee over a flat foot
	// would lie on the floor ahead of it)
	const ahead = (a, b) => (a[0] - b[0]) * sn + (a.at(-1) - b.at(-1)) * cs, up = [0, 1].map(i => ahead(st.feet[i].g, knees[1 - i]) > 0);
	// the hips over the knee that goes down (over both their middle), across the feet as both feet stand
	const d = up.indexOf(true), k = d < 0 ? mixV(knees[0], knees[1], 0.5) : (() => {
		const kd = knees[1 - d], m = mixV(knees[0], knees[1], 0.5), across = (m[0] - kd[0]) * cs - (m[2] - kd[2]) * sn;
		return [kd[0] + across * cs, kd[1], kd[2] - across * sn];
	})();
	// as high over the knees as the thighs reach: straight up, less where one knee is down ahead of the other
	const apart = d < 0 ? Math.abs(ahead(knees[0], knees[1])) / 2 : 0, high = apart > 1e-6 ? Math.sqrt(Math.max(0, (l1 * 0.99) ** 2 - apart ** 2)) : l1 * 0.99;
	const B0 = st.knelt && st.lastB ? st.lastB : standB(st), pK = [k[0] + sn * 0.016, k[1] + high - OFFSET[J.LeftUpLeg][1], k[2] + cs * 0.016];
	const from = B0.feet.map(f => pitchOf(f.q));
	return Array.from({ length: N }, (_, i) => {
		const u = (i + 1) / N, e = legsAt(u, legs), lead = e[legs.lead], mid = (e[0] + e[1]) / 2, bend = 0.4 * Math.sin(Math.PI * u);
		// each side of the pelvis goes down with its own leg, the roll that makes held to ROLL_MOST
		const r = Math.max(0, Math.min(ROLL_MOST, Math.atan((B0.p[1] - pK[1]) * (lead - e[1 - legs.lead]) / HIPW))), roll = (legs.lead === 0 ? -1 : 1) * r;
		return { // the hips go down as the leading leg does (its side first), and forward as the two legs do on average
			...B0, p: [mix(B0.p[0], pK[0], mid), mix(B0.p[1], pK[1], lead) + HIPW / 2 * Math.sin(r), mix(B0.p[2], pK[2], mid)], q: qMul(qY(st.yaw), qMul(qZ(roll), qX(0.4 * bend))), lean: 0.6 * bend,
			feet: st.feet.map((f, j) => ({ ...footPose(f.g, 0, f.yaw, mix(from[j], up[j] ? 0 : PITCH, smooth(clamp((u - (j === legs.lead ? 0 : legs.D)) / (1 - legs.D)) / 0.85))), planted: true })),
		};
	});
}

/** From the current posture, lie on the back with the pelvis over `at` [x, z], head toward heading `head` (rad). */
export function lie(st, N, { at, head, floor }) {
	const B0 = st.lastB ?? standB(st), q1 = qMul(qY(head + Math.PI), qX(-Math.PI / 2)), p1 = [at[0], floor + 0.115, at[1]];
	const inv = qConj(B0.q), feet0 = B0.feet.map(f => ({ a: qRotate(inv, sub(f.a, B0.p)), q: qMul(inv, f.q) }));
	const feet1 = [J.LeftFoot, J.RightFoot].map(j => sub(REST[j], REST[J.Hips]));
	const frames = Array.from({ length: N }, (_, i) => {
		const u = (i + 1) / N, e = smooth(u), q = qSlerp(B0.q, q1, e), bump = Math.sin(Math.PI * u);
		const p = [mix(B0.p[0], p1[0], e), mix(B0.p[1], p1[1], smooth(u / 0.7)), mix(B0.p[2], p1[2], e)];
		return {
			p, q, yaw: B0.yaw, lean: 0.3 * bump, twist: 0,
			feet: feet0.map((f, k) => ({ a: add(p, qRotate(q, mixV(f.a, feet1[k], e))), q: qMul(q, qSlerp(f.q, [0, 0, 0, 1], e)), planted: false, floor: mix(0, floor, e) })),
			hands: [1, -1].map(s => add(mixV(hang(s), [s * 0.26, -0.1, 0], e), [0, 0.15 * bump, 0.25 * bump])),
		};
	});
	return { frames, st: { ...st, p: at, lastB: frames.at(-1), knelt: undefined, owed: undefined } };
}
