// Key thinning (variant J, deep research 14-15): an installing compile removes authored keys of the free spans one frame at a
// time, recompiling each time, and keeps a removal only when the QA groups and problems do not go up. Asked in the prompt, sparse
// free spans raised QA 1.9 -> 8.0 groups; removed under QA they went 38.4 -> 30.1 keys with no QA change. Never removed: the first
// and last keyed frame, the first and last key of each free span (its boundary), both keys of a hold (a key equal to a neighbour
// within the pause tolerance: holds carry the pauses), the move-onset key (the first whose pose differs from the first pose: without
// it the move-start delay fell 0.70 -> 0.33 s, deep research 15), the frames the agent patched this round, and the keys while a
// prop carries an object (objects.<id> grab..release: QA does not measure where the carry goes, so a lift could go), fast keys under 14 frames apart and hinge keys. Fill keys stay.
// Candidates go lowest motion contribution first: the RMS over the take of 10 joints between the compile with and without the key.
// LIMIT_MS at most. Answer: { spec, result, thinned: { removed: [f], kept, before, after, ms } } or null when none went.
import { classifySpans } from "./bricks/fill-density.js";
import { isFillKey } from "./bricks/fill-src.js";
import { qaProblems } from "../qa-label.js";

const LIMIT_MS = 10000, POS = 0.01, POLE = 0.05, ANGLE = 1, SNAP = 14, SNAP_SPEED = 1.5, TARGETS = ["root", "foot_l", "foot_r", "hand_l", "hand_r"];
const dist = (a, b) => Math.hypot(...a.map((v, i) => v - b[i]));

/** Two keys' sets read as the same pose (within the pause tolerance: 1 cm, 5 cm on a pole, 1 deg). */
function samePose(a, b) {
	const chs = Object.keys(a.set ?? {}).filter(ch => ch in (b.set ?? {}));
	return chs.length > 0 && chs.every(ch => {
		const x = a.set[ch], y = b.set[ch];
		if (Array.isArray(x) && Array.isArray(y)) return dist(x, y) <= (/^(knee|elbow)_/.test(ch) ? POLE : POS);
		return Number.isFinite(x) && Number.isFinite(y) ? Math.abs(x - y) <= ANGLE : JSON.stringify(x) === JSON.stringify(y);
	});
}

const BONES = ["Hips", "Head", "LeftHand", "RightHand", "LeftFoot", "RightFoot", "LeftLeg", "RightLeg", "LeftForeArm", "RightForeArm"];

/** RMS distance (m) of the BONES between two compiles, frame by frame. */
function rms(sk, a, b) {
	const ix = BONES.map(n => sk.index[n]).filter(i => i !== undefined), n = Math.min(a.out.frames.length, b.out.frames.length);
	let sum = 0, count = 0;
	for (let f = 0; f < n; f++) for (const i of ix) { const p = a.out.frames[f].s.P[i], q = b.out.frames[f].s.P[i]; sum += (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2 + (p[2] - q[2]) ** 2; count++; }
	return Math.sqrt(sum / Math.max(1, count));
}

const worse = (r, best) => r.qa.groups.length > best.qa.groups.length || qaProblems(r.qa) > qaProblems(best.qa);

/** spec (the compiled one), result (its compile), compile(spec) -> result; opts.protect: frames the agent patched. */
export function thinSpec(spec, result, compile, { protect = [], limitMs = LIMIT_MS } = {}) {
	const t0 = performance.now(), keys = spec.keys ?? [], baked = result.out?.baked;
	if (!baked) return null;
	const authored = [...new Set(keys.filter(k => !isFillKey(k)).map(k => k.f))].sort((a, b) => a - b);
	if (authored.length < 4) return null;
	const frames = result.out.frameCount ?? result.out.frames.length, { kind, spans } = classifySpans(spec, baked, frames);
	const carries = Object.values(spec.objects ?? {}).filter(o => o?.prop).map(o => [Number.isFinite(o.grab) ? o.grab : 0, Number.isFinite(o.release) ? o.release : frames - 1]);
	const carried = f => carries.some(([a, b]) => f >= a && f <= b);
	const kept = new Set([authored[0], authored.at(-1), ...protect]);
	for (const s of spans.filter(s => s.kind === "free")) {
		const inside = authored.filter(f => f >= s.f0 && f <= s.f1);
		if (inside.length) { kept.add(inside[0]); kept.add(inside.at(-1)); }
	}
	const at = f => keys.filter(k => k.f === f && !isFillKey(k)), same = (f, g) => at(f).some(a => at(g).some(b => samePose(a, b)));
	authored.forEach((f, i) => { if ([authored[i - 1], authored[i + 1]].some(g => g !== undefined && same(f, g))) kept.add(f); });
	// a fast move is the author's timing, and QA reads no weight in it: two keys closer than the fill's shortest gap whose foot, hand
	// or root target moves over SNAP_SPEED (a kick's snap and impact, 5-6 frames apart) and keys that drive a hinge stay (a kick lost its four keys and the door its slam with QA unchanged)
	const hinges = Object.values(spec.objects ?? {}).map(o => o?.channel).filter(Boolean);
	const target = (f, ch) => at(f).map(k => k.set?.[ch]).find(Array.isArray);
	const fast = (f, g) => g - f < SNAP && TARGETS.some(ch => { const a = target(f, ch), b = target(g, ch); return a && b && dist(a, b) / (g - f) * 24 > SNAP_SPEED; });
	authored.forEach((f, i) => { if (fast(f, authored[i + 1])) { kept.add(f); kept.add(authored[i + 1]); } if (at(f).some(k => hinges.some(ch => k.set?.[ch] !== undefined))) kept.add(f); });
	const onset = authored.find(f => f !== authored[0] && !same(f, authored[0]));
	if (onset !== undefined) kept.add(onset);
	// each candidate's contribution: the compile without it against this one (its QA is the first removal's when it goes first)
	const sk = result.out.ctx?.sk, without = new Map();
	for (const f of authored.filter((f, i) => kind[f] === "free" && !carried(f) && !kept.has(f) && i > 0 && i < authored.length - 1)) {
		if (performance.now() - t0 > limitMs) break;
		const trial = { ...spec, keys: keys.filter(k => k.f !== f || isFillKey(k)) };
		try { const r = compile(trial); without.set(f, { trial, r, cost: sk ? rms(sk, result, r) : 0 }); } catch { /* a removal that does not compile stays */ }
	}
	let current = spec, best = result;
	const removed = [];
	for (const [f, w] of [...without].sort((a, b) => a[1].cost - b[1].cost)) {
		if (performance.now() - t0 > limitMs) break;
		const trial = removed.length ? { ...current, keys: current.keys.filter(k => k.f !== f || isFillKey(k)) } : w.trial;
		let r;
		try { r = removed.length ? compile(trial) : w.r; } catch { continue; }
		if (worse(r, best)) continue;
		current = trial; best = r; removed.push(f);
	}
	if (!removed.length) return null;
	return { spec: current, result: best, thinned: { removed: removed.sort((a, b) => a - b), kept: authored.length - removed.length, before: authored.length, after: authored.length - removed.length, ms: Math.round(performance.now() - t0) } };
}
