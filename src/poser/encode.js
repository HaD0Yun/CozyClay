// From handle effectors to network inputs: which effector lists are allowed, the floor height shift, and encoding.
// An effector is `{ joint, type, target?, rot6d?, aim?, tol? }`: type 0 position (world target, tol metres),
// 1 rotation (global rotation relative to rest as 6D, tol unitless), 2 look-at (world target, joint-local aim).

export const EFFECTOR = Object.freeze({ position: 0, rotation: 1, lookAt: 2 });
const MAX_EFFECTORS = 20;
export const DEFAULT_TOL = 0.005;

// joints that take no effector at all, and joints that take turns but no place
const NO_EFFECTOR = new Set([5, 7, 8, 9, 11, 14, 15, 17, 20, 21, 22, 26]);
const NO_POSITION = new Set([1, 2, 10, 16]);
const HEAD = 6;
// standing heights (metres) used to decide how far to lift a body held in the air
const STAND = { 0: 0.95, 1: 1.15, 2: 1.25, 6: 1.6, 13: 0.8, 19: 0.8, 12: 1.05, 18: 1.05, 22: 0.5, 26: 0.5, 24: 0.08, 28: 0.08, 25: 0.03, 29: 0.03 };

/**
 * Keeps one effector per joint and kind (the tighter tolerance wins) and needs at least one place; 20 at most.
 * Returns `{ ok: true, effectors, positions }` or `{ ok: false, reason, detail }` (the pose must stay unchanged).
 */
export function buildEffectors(list) {
	const kept = new Map();
	for (const effector of list) {
		const { joint, type } = effector;
		const bad = domainProblem(joint, type);
		if (bad) return { ok: false, reason: "effector-domain", detail: bad };
		const key = `${joint}:${type}`, prior = kept.get(key);
		if (!prior || tolOf(effector) < tolOf(prior)) kept.set(key, effector);
	}
	const effectors = [...kept.values()];
	const positions = effectors.filter((e) => e.type === EFFECTOR.position).length;
	if (positions === 0) return { ok: false, reason: "no-position-effector", detail: "a solve needs at least one position handle" };
	if (effectors.length > MAX_EFFECTORS) return { ok: false, reason: "too-many-effectors", detail: `${effectors.length} > ${MAX_EFFECTORS}` };
	return { ok: true, effectors, positions };
}

function domainProblem(joint, type) {
	if (!Number.isInteger(joint) || joint < 0 || joint >= 30) return `joint ${joint} is not a skeleton joint`;
	if (type !== 0 && type !== 1 && type !== 2) return `effector type ${type} is unknown`;
	if (NO_EFFECTOR.has(joint)) return `joint ${joint} never takes an effector`;
	if (type === EFFECTOR.position && NO_POSITION.has(joint)) return `joint ${joint} never takes a position effector`;
	if (type === EFFECTOR.lookAt && joint !== HEAD) return "look-at is only on the head";
	return null;
}

const tolOf = (e) => (e.type === EFFECTOR.lookAt ? 0 : e.tol ?? DEFAULT_TOL);

/**
 * How far targets move down before encoding (and the pose moves back up after): the floor height, or, with
 * `airborne`, more when every placed joint is held over 0.5 m above where it would stand (ignored under 0.1 mm).
 */
export function floorShift(effectors, floorHeight = 0, { airborne = true } = {}) {
	let shift = floorHeight;
	if (airborne) {
		let lowest = Infinity;
		for (const e of effectors) if (e.type === EFFECTOR.position) lowest = Math.min(lowest, e.target[1] - (STAND[e.joint] ?? 0.9));
		const lift = Math.max(floorHeight, lowest - 0.5);
		if (Math.abs(lift) >= 1e-4) shift = lift;
	}
	if (shift === 0) return { shift, effectors };
	const moved = effectors.map((e) => (e.type === EFFECTOR.rotation ? e : { ...e, target: [e.target[0], e.target[1] - shift, e.target[2]] }));
	return { shift, effectors: moved };
}

/** The length code the network reads: how far each bone length is from the mean, in spreads, capped. */
function encodeCond(sk, lengths, out = new Float32Array(29)) {
	for (let k = 0; k < 29; k += 1) {
		const std = sk.boneLengthStd[k];
		const z = std < sk.lengthStdFloor ? 0 : (lengths[k] - sk.boneLengthMean[k]) / std;
		out[k] = Math.max(-sk.lengthZMax, Math.min(sk.lengthZMax, z));
	}
	return out;
}

/** Centre of the query on the floor: mean of placed targets, else of look targets, else the origin. */
function centroidOf(effectors) {
	for (const type of [EFFECTOR.position, EFFECTOR.lookAt]) {
		const rows = effectors.filter((e) => e.type === type);
		if (!rows.length) continue;
		const c = [0, 0, 0];
		for (const e of rows) { c[0] += e.target[0]; c[2] += e.target[2]; }
		return [c[0] / rows.length, 0, c[2] / rows.length];
	}
	return [0, 0, 0];
}

/**
 * Network inputs for one query, plus the same effectors as centred float64 rows for the IK.
 * `rows[e] = { joint, type, target (centred), aim (unit), rot6d, tol }`.
 */
export function encodeQuery(sk, effectors, lengths) {
	const E = effectors.length, c = centroidOf(effectors);
	const val = new Float32Array(7 * E), weights = new Float32Array(E).fill(1);
	const jointId = new BigInt64Array(E), effType = new BigInt64Array(E), rows = [];
	effectors.forEach((e, i) => {
		const row = { joint: e.joint, type: e.type, target: null, aim: null, rot6d: null, tol: 0 };
		let v;
		if (e.type === EFFECTOR.rotation) {
			row.rot6d = e.rot6d.slice(0, 6);
			row.tol = e.tol ?? DEFAULT_TOL;
			v = [...row.rot6d, row.tol];
		} else {
			row.target = [e.target[0] - c[0], e.target[1], e.target[2] - c[2]];
			if (e.type === EFFECTOR.position) {
				row.tol = e.tol ?? DEFAULT_TOL;
				v = [...row.target, 0, 0, 0, row.tol];
			} else {
				const a = e.aim ?? [0, 0, 1], n = Math.max(Math.hypot(a[0], a[1], a[2]), 1e-6);
				row.aim = [a[0] / n, a[1] / n, a[2] / n];
				v = [...row.target, ...row.aim, 0];
			}
		}
		val.set(v, 7 * i);
		jointId[i] = BigInt(e.joint);
		effType[i] = BigInt(e.type);
		rows.push(row);
	});
	return { E, centroid: c, rows, inputs: { val, weights, jointId, effType, cond: encodeCond(sk, lengths) } };
}
