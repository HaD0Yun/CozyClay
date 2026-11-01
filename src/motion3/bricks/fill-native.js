// Opt-in native MotionBricks fill (COZYCLAY_MB_MODE=native on the dev server, mcp/motionbricks/service.mjs): the gaps between authored
// key poses are generated the way the upstream runtime (NVlabs/motionbricks docs/runtime_api.md, docs/inbetweener.md) and the HF
// playground drive the model, instead of fill.js's arrive-and-stop policy:
//   - targets: 4 poses (with velocity) at a key the motion passes through, 1 pose (a stop) only at the last key or before a hold.
//   - endpoint correction like the engines: root position and rotation spread linearly, local joint rotations only over 0.3 s at
//     each end (quadratic fade), plus the runtime's 7-tap root filter; dense output keys (tolerance x0.35).
//   - timing: "exact" keeps the authored key frames (the model's own length is asked for too and reported as a hint), "free" uses
//     the model's length time-warped, "retime" and "playground" are in fill-native-chain.js.
//   - gate (default true) leaves fill.js's "unsafe" gaps to the compiler; gate: false generates every gap 14+ frames. No QA drop.
import { encodePoses, decodeMotion } from "./model-io.js";
import { isFillKey, shortHash, editedFill } from "./fill-src.js";
import { spanReason } from "./fill-spans.js";
import { classifySpans, densityNotes } from "./fill-density.js";
import { STEP, poseAt, fillGaps, pinHands, sparseKeys, merge, passThrough, safeGap, gapQa, gapCheck } from "./fill.js";
import { MIN_GAP, TOL_SCALE, correctMotion, denseChannels, gapTokens, groundSoles, relaxPops } from "./fill-native-core.js";
import { fillRetime, fillPlayground } from "./fill-native-chain.js";
import { carryHands } from "./fill-carry.js";
import { despikeAngles } from "./fill-despike.js";
import { holdStance } from "./fill-stance.js";

/** Same contract as fill.js fillSpec ({ spec, gaps, calls, spans, ... }), the native policy. */
export async function fillSpecNative(spec, { sk, compile, run }, { at, timing = "exact", gate = true } = {}) {
	const promoted = (spec.keys ?? []).filter(editedFill).length;
	if (timing === "playground" && at === undefined) return fillPlayground({ ...spec, keys: (spec.keys ?? []).map(k => (editedFill(k) ? Object.fromEntries(Object.entries(k).filter(([f]) => f !== "src")) : k)) }, { sk, compile, run });
	if (timing === "retime" && at === undefined) return fillRetime({ ...spec, keys: (spec.keys ?? []).map(k => (editedFill(k) ? Object.fromEntries(Object.entries(k).filter(([f]) => f !== "src")) : k)) }, { sk, compile, run });
	spec = { ...spec, keys: (spec.keys ?? []).map(k => (editedFill(k) ? Object.fromEntries(Object.entries(k).filter(([f]) => f !== "src")) : k)) };
	const passed = passThrough(spec, compile);
	spec = passed.spec;
	const authored = spec.keys.filter(k => !isFillKey(k)), authoredFs = [...new Set(authored.map(k => k.f))].sort((a, b) => a - b);
	const gaps = fillGaps(spec.keys, at, MIN_GAP);
	const ends = gaps.map(([fa, fb]) => shortHash(authored.filter(k => k.f === fa || k.f === fb).map(k => [k.f, k.set])));
	let keys = spec.keys.filter(k => !(isFillKey(k) && gaps.some(([fa, fb]) => k.f > fa && k.f < fb)));
	const report = [], skipped = [], warnings = [];
	// targets come from the authored keys alone: a compile that already holds earlier fill keys can keep a foot planted (foot lock) where
	// the authored key moves it, and that pose would become the model's target
	const base = compile({ ...spec, keys: spec.keys.filter(k => !isFillKey(k)) }), baseCache = new Map();
	for (const [i, [fa, fb]] of gaps.entries()) {
		const r = compile({ ...spec, keys }), cache = new Map();
		const safe = safeGap(authored, r.out.baked, fa, fb);
		const reason = spanReason(spec, authored, r.out.baked, fa, fb) ?? (safe === "hold" || (gate && safe) ? safe : null);
		if (reason) { skipped.push({ f: [fa, fb], reason }); report.push({ f: [fa, fb], skipped: reason }); continue; }
		const check = gapCheck(r.out.baked, fa, fb, true);
		if (check.far) warnings.push(check.far.replace(/^FILL_GAP_TOO_FAR: /, "fast leg (generated anyway): "));
		// a key the motion passes through gets 4 target poses (its velocity toward the next key); the last key or one before a hold is a stop
		const next = authoredFs[authoredFs.indexOf(fb) + 1];
		const holdAfter = next !== undefined && safeGap(authored, r.out.baked, fb, next) === "hold";
		const nTarget = next === undefined || holdAfter ? 1 : 4;
		const poses = [...[3, 2, 1, 0].map(n => poseAt(sk, r.out.frames, cache, fa - n * STEP)), ...Array.from({ length: nTarget }, (_, n) => poseAt(sk, base.out.frames, baseCache, fb + n * STEP))];
		// timing "exact" keeps the authored key frames (one token count, upstream's "single count gives exact control"); a second call
		// with a range asks how long the model would take, reported as a timing hint. timing "free" uses the model's own length, time-warped.
		const tok = gapTokens(fa, fb), t0 = performance.now();
		const ask = encodePoses(poses, tok.range), asked = await run(ask.feed);
		const { feed, align } = timing === "free" ? ask : encodePoses(poses, [tok.exact]);
		const res = timing === "free" ? asked : await run(feed), ms = performance.now() - t0;
		const wants = Math.round((asked.tokens * 4 - 6) * STEP);
		if (Math.abs(wants - (fb - fa)) >= 6) warnings.push(`timing f${fa}-f${fb}: ${fb - fa} frames, model wants ~${wants}${wants > fb - fa ? " (rushed)" : " (drags)"}`);
		const motion = correctMotion(decodeMotion(res.out, res.tokens, align), poses[3], poses[4]);
		const dense = carryHands(pinHands(holdStance(despikeAngles(denseChannels(motion, fa, fb, r.out.baked, base.out.baked), r.out.baked, fa), fa, fb, authored), fa, fb, authored, r.out.frames, sk), fa, fb, spec, authored, r.out.baked);
		const grounded = groundSoles(dense, fa, { spec: { ...spec, fix: { ...(spec.fix ?? {}), slide: false } }, keys, compile, sk });
		const relaxed = relaxPops(dense, fa, { spec, keys, compile, sk });
		const fill = sparseKeys(dense, fa, ends[i], TOL_SCALE);
		const qaCurve = gapQa(r.qa, fa, fb);
		keys = merge(keys, fill);
		const qaModel = gapQa(compile({ ...spec, keys }).qa, fa, fb);
		const warp = +(((fb - fa) / STEP + 1) / (res.tokens * 4 - 6)).toFixed(2);
		report.push({ f: [fa, fb], tokens: res.tokens, targets: nTarget, modelWants: wants, ...(warp === 1 ? {} : { warp }), keys: fill.length, ...(grounded ? { grounded } : {}), ...(relaxed ? { relaxed } : {}), qa: [qaCurve.groups, qaModel.groups], ms: Math.round(ms) });
	}
	const baked = compile({ ...spec, keys }).out.baked, frames = baked.root?.length ?? (Number.isFinite(spec.frames) ? spec.frames : 0);
	const { kind, spans } = classifySpans({ ...spec, keys }, baked, frames), notes = densityNotes(keys, kind, spans, baked);
	return { spec: { ...spec, keys }, mode: "native", gaps: report, calls: report.filter(g => !g.skipped).length, spans, ...(notes.length ? { notes } : {}), ...(skipped.length ? { skipped } : {}),
		...(promoted ? { promoted } : {}), ...(passed.added ? { passThrough: passed.added } : {}), ...(warnings.length ? { warnings } : {}) };
}
