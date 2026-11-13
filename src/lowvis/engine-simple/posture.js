// Posture transitions: stand <-> sit on a seat, stand -> kneel, kneel -> lie on the back. Each returns the body
// states of its frames and the new state; `st.lastB` is the posture an "idle" then holds.
import { INDEX as J, OFFSET, REST } from "../rig17.js";
import { add, len, mix, mixV, qConj, qMul, qRotate, qSlerp, qX, qY, smooth, sub, clamp } from "./math.js";
import { STAND_Y, footPose, hang, standB } from "./gait.js";

const THIGH = s => [s * 0.1, 0.05, 0.27]; // hand on the thigh, pelvis frame
const SEAT_UP = 0.13;                     // Hips joint height over the seat top

function sitB(st, seat, g, gy, bend, h, dy = 0) {
	const B = standB(st), sn = Math.sin(st.yaw), cs = Math.cos(st.yaw);
	B.p = [B.p[0] - sn * seat.back * g, mix(STAND_Y, seat.y + SEAT_UP, gy) + dy, B.p[2] - cs * seat.back * g];
	B.q = qMul(qY(st.yaw), qX(0.45 * bend)); B.lean = 0.55 * bend;
	B.hands = [1, -1].map(s => mixV(hang(s), THIGH(s), h));
	return B;
}

/** Sit on a seat behind the figure: lean forward, hips go back and down, settle upright. seat = { y, back }. */
export function sit(st, N, seat) {
	const frames = Array.from({ length: N }, (_, i) => {
		const u = (i + 1) / N;
		return sitB(st, seat, smooth(u / 0.8), smooth((u - 0.1) / 0.72), 0.6 * Math.sin(Math.PI * clamp(u / 0.92)),
			smooth((u - 0.3) / 0.6), u > 0.82 ? -0.012 * Math.sin(Math.PI * (u - 0.82) / 0.18) : 0);
	});
	return { frames, st: { ...st, seat, lastB: frames.at(-1) } };
}

/** Stand up from the seat: lean forward first (anticipation), then rise over the feet. */
export function stand(st, N) {
	const frames = Array.from({ length: N }, (_, i) => {
		const u = (i + 1) / N;
		return sitB(st, st.seat, 1 - smooth((u - 0.25) / 0.7), 1 - smooth((u - 0.28) / 0.65),
			0.65 * Math.sin(Math.PI * clamp(u / 0.9) ** 0.7), 1 - smooth((u - 0.2) / 0.6));
	});
	return { frames, st: { p: st.p, yaw: st.yaw, feet: st.feet } };
}

/** Kneel on both knees: the toes stay where they are, the knees go forward and down. ground(x, z) is the floor height. */
export function kneel(st, N, ground) {
	const PITCH = 1.35, l1 = len(OFFSET[J.LeftLeg]), l2 = len(OFFSET[J.LeftFoot]), sn = Math.sin(st.yaw), cs = Math.cos(st.yaw);
	const knees = st.feet.map(f => {
		const a = footPose(f.g, 0, f.yaw, PITCH).a, y = ground(a[0] + sn * 0.42, a[2] + cs * 0.42) + 0.07;
		const hz = Math.sqrt(Math.max(0, l2 * l2 - (a[1] - y) ** 2));
		return [a[0] + sn * hz, y, a[2] + cs * hz];
	});
	const k = mixV(knees[0], knees[1], 0.5), B0 = standB(st);
	const pK = [k[0] + sn * 0.016, k[1] + l1 * 0.99 - OFFSET[J.LeftUpLeg][1], k[2] + cs * 0.016];
	const frames = Array.from({ length: N }, (_, i) => {
		const u = (i + 1) / N, e = smooth(u), bend = 0.4 * Math.sin(Math.PI * u);
		return {
			...B0, p: mixV(B0.p, pK, e), q: qMul(qY(st.yaw), qX(0.4 * bend)), lean: 0.6 * bend,
			feet: st.feet.map(f => ({ ...footPose(f.g, 0, f.yaw, PITCH * smooth(u / 0.85)), planted: true })),
		};
	});
	return { frames, st: { ...st, lastB: frames.at(-1) } };
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
	return { frames, st: { ...st, p: at, lastB: frames.at(-1) } };
}
