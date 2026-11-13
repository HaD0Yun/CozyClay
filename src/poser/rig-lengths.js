// Two sets of bone lengths per character: measured (its own proportions, used when writing bones) and network (the
// measured set resized and pulled into the range the network knows; everything before writing uses these).
// Entry k is joint k + 1.
import { dot, mulVec, norm, sub } from "./mat3.js";

const DEG = Math.PI / 180;

export function measuredLengths(sk, { boneOf, head, s, C, toSkeleton }) {
	const len = new Array(29).fill(null);
	for (let i = 1; i < 30; i += 1) {
		if (boneOf[i] < 0) continue;
		const span = [i];
		let p = sk.parents[i];
		while (p >= 0 && boneOf[p] < 0) { span.unshift(p); p = sk.parents[p]; }
		if (p < 0) continue;
		const off = sub(head(i), head(p));
		let dist = norm(off) * s;
		if (span.length === 1 && dist > 0) {
			const rigDir = toSkeleton(mulVec([0, 0, 0], 0, C, 9 * p, off, 0));
			const canon = [0, 1, 2].map((a) => sk.restJoints[3 * i + a] - sk.restJoints[3 * p + a]), cn = norm(canon);
			const angle = Math.acos(Math.max(-1, Math.min(1, dot(rigDir, canon) / (norm(rigDir) * cn))));
			if (angle > DEG) dist = Math.max(dot(rigDir, canon) / cn, dist / 3);
		}
		const total = span.reduce((sum, k) => sum + sk.boneLengthMean[k - 1], 0);
		for (const k of span) len[k - 1] = (dist * sk.boneLengthMean[k - 1]) / total;
	}
	const ratios = len.flatMap((v, k) => (v == null ? [] : [v / sk.boneLengthMean[k]])).sort((a, b) => a - b);
	const ratio = ratios.length ? ratios[Math.floor(ratios.length / 2)] : 1;
	return Float64Array.from(len, (v, k) => v ?? sk.boneLengthMean[k] * ratio);
}

/**
 * The uniform factor that brings a body into the size range the network knows. Size is the summed bone length against
 * the summed means; bodies within ±2.5 summed spreads keep factor 1, a child-sized or giant body gets the factor that
 * puts it on the nearest edge. It is then solved at that ordinary size and scaled back, so its proportions are kept.
 */
function bodySize(sk, lengths) {
	let total = 0, mean = 0, spread = 0;
	for (let k = 0; k < 29; k += 1) {
		if (sk.boneLengthStd[k] < sk.lengthStdFloor) continue;
		total += lengths[k]; mean += sk.boneLengthMean[k]; spread += sk.boneLengthStd[k];
	}
	const ratio = total / mean, lo = 1 - (2.5 * spread) / mean, hi = 1 + (2.5 * spread) / mean;
	if (!(ratio > 0)) return 1;
	return ratio > hi ? ratio / hi : ratio < lo ? ratio / lo : 1;
}

/**
 * Network lengths and the body size they were divided by: `{ lengths, size }`. A matching rig keeps its own
 * proportions; others get span groups shared out by the mean proportions and each length clamped to its range.
 */
export function networkLengths(sk, measured, groups, { matching = false } = {}) {
	const out = Float64Array.from(measured);
	if (!matching) for (const group of groups) {
		const total = group.reduce((sum, j) => sum + measured[j - 1], 0), mean = group.reduce((sum, j) => sum + sk.boneLengthMean[j - 1], 0);
		for (const j of group) out[j - 1] = (total * sk.boneLengthMean[j - 1]) / mean;
	}
	const size = bodySize(sk, out);
	for (let k = 0; k < 29; k += 1) {
		out[k] /= size;
		const std = sk.boneLengthStd[k];
		if (!matching && std >= sk.lengthStdFloor) out[k] = Math.max(sk.boneLengthMean[k] - 2.5 * std, Math.min(sk.boneLengthMean[k] + 2.5 * std, out[k]));
	}
	return { lengths: out, size };
}
