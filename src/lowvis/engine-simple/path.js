// The ground path of a travel (gait.js): a smooth curve through the legs' ends.
import { clamp, mix } from "./math.js";

const dist2 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const mix2 = (a, b, t) => [mix(a[0], b[0], t), mix(a[1], b[1], t)];
const yawTo = (a, b) => Math.atan2(b[0] - a[0], b[1] - a[1]);

/** Smooth path through points with unit tangents; at(d) and yaw(d) by arc length. */
export function buildPath(pts, dirs) {
	const P = [pts[0]], cum = [0], segEnd = [];
	for (let i = 0; i + 1 < pts.length; i++) {
		const A = pts[i], B = pts[i + 1], c = dist2(A, B);
		for (let k = 1; k <= 32; k++) {
			const u = k / 32, h00 = 2 * u ** 3 - 3 * u * u + 1, h10 = u ** 3 - 2 * u * u + u, h01 = 3 * u * u - 2 * u ** 3, h11 = u ** 3 - u * u;
			const p = [0, 1].map(a => h00 * A[a] + h10 * c * dirs[i][a] + h01 * B[a] + h11 * c * dirs[i + 1][a]);
			cum.push(cum.at(-1) + dist2(P.at(-1), p)); P.push(p);
		}
		segEnd.push(cum.at(-1));
	}
	const total = cum.at(-1);
	const at = d => {
		d = clamp(d, 0, total);
		let i = 1;
		while (i < cum.length - 1 && cum[i] < d) i++;
		const span = cum[i] - cum[i - 1];
		return mix2(P[i - 1], P[i], span > 1e-9 ? (d - cum[i - 1]) / span : 0);
	};
	return { at, segEnd, yaw: d => yawTo(at(d - 0.04), at(d + 0.04)) };
}
