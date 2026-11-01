// The native fill's chained timings (fill-native.js picks them): "retime" (the model picks each gap's length and the later keys move)
// and "playground" (one continuous chain like the upstream runtime: middle keys are guides, only the last key is reached).
import { toCozyPoint } from "./soma.js";
import { encodePoses, decodeMotion, MIN_TOKENS } from "./model-io.js";
import { frameChannels, unwrapSeries } from "./forward.js";
import { isFillKey, shortHash } from "./fill-src.js";
import { classifySpans, densityNotes } from "./fill-density.js";
import { carryHands } from "./fill-carry.js";
import { despikeAngles } from "./fill-despike.js";
import { holdStance } from "./fill-stance.js";
import { STEP, poseAt, pinHands, sparseKeys, merge, passThrough, safeGap } from "./fill.js";
import { MIN_GAP, TOL_SCALE, lerp, correctMotion, denseChannels, saneChannels } from "./fill-native-core.js";

/** Moves every key at or after frame `from` by `delta` frames (the take's length too). */
function shiftKeys(spec, keys, from, delta) {
	const moved = keys.map(k => (k.f >= from ? { ...k, f: k.f + delta } : k));
	const frames = Number.isFinite(spec.frames) ? spec.frames + delta : spec.frames;
	return { spec: { ...spec, frames, keys: moved }, keys: moved };
}

/**
 * timing "retime": the model picks each gap's length (any 6-16 tokens, upstream's own choice) and the authored keys after the gap
 * move to where the model arrives. Poses stay as authored; only their frames change. Reported per gap as { from, to }.
 */
export async function fillRetime(spec, { sk, compile, run }) {
	let keys = spec.keys.filter(k => !isFillKey(k));
	const report = [], skipped = [], warnings = [];
	// the Smart Primitive default range (6-14 tokens, 0.6-1.6 s); a gap over one call gets a pass-through pose first (fill.js)
	const ALL = Array.from({ length: 14 - MIN_TOKENS + 1 }, (_, i) => MIN_TOKENS + i);
	({ spec } = passThrough({ ...spec, keys }, compile));
	keys = spec.keys;
	for (let i = 1; ; i++) {
		const afs = [...new Set(keys.filter(k => !isFillKey(k)).map(k => k.f))].sort((a, b) => a - b);
		if (i >= afs.length) break;
		const fa = afs[i - 1], authored = keys.filter(k => !isFillKey(k));
		let fb = afs[i];
		let r = compile({ ...spec, keys }), base = compile({ ...spec, keys: authored });
		// a gap under one shortest call (14 frames) is dense keying: it stays the compiler's and keeps its frames
		if (fb - fa < MIN_GAP) { skipped.push({ f: [fa, fb], reason: "short" }); continue; }
		if (safeGap(authored, r.out.baked, fa, fb) === "hold") { skipped.push({ f: [fa, fb], reason: "hold" }); report.push({ f: [fa, fb], skipped: "hold" }); continue; }
		const next = afs[i + 1], holdAfter = next !== undefined && safeGap(authored, base.out.baked, fb, next) === "hold";
		const nTarget = next === undefined || holdAfter ? 1 : 4;
		const cache = new Map(), baseCache = new Map();
		const poses = [...[3, 2, 1, 0].map(n => poseAt(sk, r.out.frames, cache, fa - n * STEP)), ...Array.from({ length: nTarget }, (_, n) => poseAt(sk, base.out.frames, baseCache, fb + n * STEP))];
		const { feed, align } = encodePoses(poses, ALL);
		const t0 = performance.now(), res = await run(feed), ms = performance.now() - t0;
		const len = Math.max(2, Math.round((res.tokens * 4 - 6) * STEP)), delta = len - (fb - fa);
		if (delta !== 0) {
			({ spec, keys } = shiftKeys(spec, keys, fb, delta));
			fb += delta;
			r = compile({ ...spec, keys }); base = compile({ ...spec, keys: keys.filter(k => !isFillKey(k)) });
			warnings.push(`gap f${fa}-f${fb}: ${fb - fa - delta} -> ${fb - fa} frames (model's length); later keys moved ${delta > 0 ? "+" : ""}${delta}`);
		}
		const motion = correctMotion(decodeMotion(res.out, res.tokens, align), poses[3], poses[4]);
		const auth = keys.filter(k => !isFillKey(k));
		const end = shortHash(auth.filter(k => k.f === fa || k.f === fb).map(k => [k.f, k.set]));
		const dense = carryHands(pinHands(holdStance(despikeAngles(denseChannels(motion, fa, fb, r.out.baked, base.out.baked), r.out.baked, fa), fa, fb, auth), fa, fb, auth, r.out.frames, sk), fa, fb, spec, auth, r.out.baked);
		const fill = sparseKeys(dense, fa, end, TOL_SCALE);
		keys = merge(keys, fill);
		report.push({ f: [fa, fb], frames: fb - fa, authoredFrames: fb - fa - delta, tokens: res.tokens, targets: nTarget, keys: fill.length, ms: Math.round(ms) });
	}
	const last = Math.max(...keys.map(k => k.f));
	if (Number.isFinite(spec.frames) && spec.frames < last + 1) spec = { ...spec, frames: last + 1 };
	const baked = compile({ ...spec, keys }).out.baked, frames = baked.root?.length ?? (Number.isFinite(spec.frames) ? spec.frames : 0);
	const { kind, spans } = classifySpans({ ...spec, keys }, baked, frames), notes = densityNotes(keys, kind, spans, baked);
	return { spec: { ...spec, keys }, mode: "native-retime", gaps: report, calls: report.filter(g => !g.skipped).length, spans,
		retimed: report.filter(g => g.authoredFrames !== undefined && g.authoredFrames !== g.frames).map(g => ({ gap: g.f, authored: g.authoredFrames, model: g.frames })),
		...(notes.length ? { notes } : {}), ...(skipped.length ? { skipped } : {}), ...(warnings.length ? { warnings } : {}) };
}

const EARLY = 8; // the Smart Primitives' Entry/Exit "transition early by" (frames at 30 fps)
/**
 * timing "playground": the upstream runtime's way (NVlabs/motionbricks app/runtime, the HF playground). One continuous chain from the
 * first authored key: every middle key is a guide (4 target poses with its velocity, the step hands over EARLY frames before it
 * arrives, no end correction), only the last key is reached exactly (1 pose: a stop). The model picks each step's length (6-14 tokens),
 * the next context is the last 4 poses actually played, and the played motion is kept densely as it came out (no foot lock, no hand
 * pins). Middle authored keys are not keys of the result (they were guides): they come back in `guides`. The compile that installs it
 * runs without repair, thinning or retime (fix: false).
 */
export async function fillPlayground(spec, { sk, compile, run }) {
	const authored = spec.keys.filter(k => !isFillKey(k)), afs = [...new Set(authored.map(k => k.f))].sort((a, b) => a - b);
	if (afs.length < 2) return { spec, mode: "native-playground", gaps: [], calls: 0, spans: [] };
	const base = compile({ ...spec, keys: authored }), cache = new Map();
	const RANGE = Array.from({ length: 14 - MIN_TOKENS + 1 }, (_, i) => MIN_TOKENS + i);
	let ctx = [3, 2, 1, 0].map(n => poseAt(sk, base.out.frames, cache, afs[0] - n * STEP));
	const played = [{ ...ctx[3], contacts: [1, 1, 1, 1] }], report = [], guides = [];
	for (let i = 1; i < afs.length; i++) {
		const fb = afs[i], last = i === afs.length - 1;
		const hold = !last && safeGap(authored, base.out.baked, fb, afs[i + 1]) === "hold";
		const nTarget = last || hold ? 1 : 4;
		const targets = Array.from({ length: nTarget }, (_, n) => poseAt(sk, base.out.frames, cache, fb + n * STEP));
		const { feed, align } = encodePoses([...ctx, ...targets], RANGE);
		const t0 = performance.now(), res = await run(feed), ms = performance.now() - t0;
		const motion = correctMotion(decodeMotion(res.out, res.tokens, align), ctx[3], targets[0]); // the engines always correct both ends (correct_generated_diff); a guide is a guide because playback hands over early
		const early = last ? 0 : Math.min(EARLY, motion.length - 4), seg = motion.slice(1, motion.length - early);
		played.push(...seg);
		ctx = played.slice(-4);
		while (ctx.length < 4) ctx.unshift(ctx[0]);
		report.push({ key: fb, tokens: res.tokens, targets: nTarget, played: seg.length, early, ms: Math.round(ms) });
		guides.push({ authored: fb, reachedAt: null, modelFrame: played.length - 1 });
	}
	// 30 fps played frames -> spec frames from the first key, channels per spec frame, kept densely
	const f0 = afs[0], M = played.length, F = Math.round((M - 1) * STEP);
	const gen = played.map(m => frameChannels(m.P.map(toCozyPoint))), dense = [];
	for (let f = 0; f <= F; f++) {
		const x = Math.min(M - 1, f / STEP), i = Math.min(Math.floor(x), M - 2), u = x - i;
		dense.push(Object.fromEntries(Object.keys(gen[0]).map(k => [k, lerp(gen[i][k], gen[i + 1][k], u)])));
	}
	unwrapSeries(dense, Object.fromEntries(Object.entries(base.out.baked).map(([k, v]) => [k, v[f0]])));
	dense.forEach(saneChannels);
	const lastF = f0 + F, lastSet = Object.assign({}, ...authored.filter(k => k.f === afs.at(-1)).map(k => k.set));
	const fill = sparseKeys(dense, f0, shortHash([f0, lastF]), 0.15);
	const keys = merge([...authored.filter(k => k.f === f0), { f: lastF, set: lastSet }], fill);
	for (const g of guides) g.reachedAt = f0 + Math.round(g.modelFrame * STEP);
	const out = { ...spec, keys, fix: false, frames: Number.isFinite(spec.frames) ? Math.max(spec.frames, lastF + 1) : spec.frames };
	const baked = compile(out).out.baked, frames = baked.root?.length ?? lastF + 1;
	const { spans } = classifySpans(out, baked, frames);
	return { spec: out, mode: "native-playground", gaps: report, calls: report.length, spans, guides: guides.map(({ authored: a, reachedAt }) => ({ authored: a, at: reachedAt })),
		warnings: guides.slice(0, -1).map(g => `guide f${g.authored} passed at ~f${g.reachedAt} (not a key in the result)`).concat([`last key f${afs.at(-1)} -> f${lastF}`]) };
}

/** Same contract as fill.js fillSpec ({ spec, gaps, calls, spans, ... }), the native policy. */
