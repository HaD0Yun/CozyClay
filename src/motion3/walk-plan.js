// walkTo { to, arrive }: the engine picks the cadence instead of the agent sweeping period and step by
// hand. A use[i] walkTo with arrive (the frame the walk should end by, feet together: f0 + 16 + steps *
// period + 18) and none of steps, period, step, swing gets them planned here, before the skills expand:
//   candidates  every steps n and period p (frames per step) whose walk ends by arrive, the strides
//               covering the distance from where the feet are at f0 to `to` (the first stride ~0.8 of
//               the others, as walkTo's defaults), a stride at most STRIDE_MAX, the foot in the air
//               SWING of the period;
//   order       a person's walk ratio first (stride x cadence: stride m * period frames ~ WALK_RATIO, the
//               default 0.5 m every 20 frames), then using the time given (a walk that ends long before
//               arrive stands still the rest), and no stroll slower than SLOW m/s;
//   checked     each candidate is compiled on a probe spec (the keys and skills up to the walk, the walk,
//               nothing after it; no goals, checks or moving objects) and the first with no POP, REACH,
//               SLIDE, FLOAT, FLIP or KNEE issue between f0 and its end wins (at most TRIALS compiles): the
//               best on-time ones, then the top few again with a longer swing, a longer first stride or a
//               lower lift (a quick walk often needs one of them), then the late ones, earliest first;
//               a spec that carries an object (spec.objects with keys or a prop) checks only the first
//               CARRY_TRIALS: the probe leaves the object out, so the hands on it miss, pop or flip on
//               every candidate and the issues past the best on-time ones say little (bench box, M2:
//               22 probes, 33-57 s of one compile on the Mac, ~1.6x that on the box).
// When no walk ends by arrive (the distance is too far for the frames), the earliest clean one is
// taken and the note says the speed the request needs and the frame it ends. The spec keeps arrive (a
// recompile plans the same walk again, cached); observations.planned reads what was chosen.
import { expandUse } from "./skills/index.js";
import { stateAt } from "./compiler/walk.js";

const WALK_RATIO = 9.7, STRIDE_MIN = 0.25, STRIDE_MAX = 0.75, SWING = 0.88, SLOW = 0.5, TRIALS = 22, CARRY_TRIALS = 6, LATE = 4, FPS = 24;
const PERIODS = Array.from({ length: 16 }, (_, i) => 9 + i);
const PLANNED = ["steps", "period", "step", "swing"];
const WALK_KINDS = new Set(["POP", "REACH", "SLIDE", "FLOAT", "FLIP", "KNEE"]);
const cache = new Map();
const r2 = x => Math.round(x * 100) / 100;
/** An object the body carries: keyed along a path or gripped as a prop (a door on its pivot is not). */
const carries = spec => Object.values(spec?.objects ?? {}).some(o => (Array.isArray(o?.keys) && o.keys.length > 0) || Boolean(o?.prop));

/** The walkTo uses that plan their cadence: [{ i, u }]. */
const toPlan = spec => (Array.isArray(spec?.use) ? spec.use : []).map((u, i) => ({ i, u }))
	.filter(({ u }) => u?.skill === "walkTo" && Number.isInteger(u.args?.arrive) && Array.isArray(u.args?.to) && !PLANNED.some(k => u.args[k] !== undefined)
		&& Object.values(u.args).every(v => !(v && typeof v === "object" && !Array.isArray(v))));

/** The strides of an n-step walk over d m: { first, step } or null when no stride fits. */
function strides(d, n) {
	if (n === 2) return d >= STRIDE_MIN && d <= STRIDE_MAX ? { first: d, step: d } : null;
	const first = Math.min(0.62, Math.max(0.3, (0.8 * d) / (n - 2 + 0.8))), step = (d - first) / (n - 2);
	return step >= STRIDE_MIN && step <= STRIDE_MAX ? { first, step } : null;
}

/** Candidates for a walk of d m from f0, best first: on time (ending by arrive) by their score, then late ones by their end. */
function candidates(d, f0, arrive) {
	const all = [];
	for (const period of PERIODS) for (let n = 2; n <= 40; n++) {
		const s = strides(d, n);
		if (!s) continue;
		const end = f0 + 16 + n * period + 18, v = (s.step * FPS) / period;
		const ratio = Math.abs(Math.log((s.step * period) / WALK_RATIO)), idle = Math.max(0, arrive - end) / Math.max(1, arrive - f0);
		all.push({ args: { steps: n, period, swing: Math.round(SWING * period), step: r2(s.step), firstStep: r2(s.first) }, end, v, late: end > arrive,
			score: ratio + 1.5 * idle + Math.max(0, SLOW - v) * 4 });
	}
	const onTime = all.filter(c => !c.late).sort((a, b) => a.score - b.score), late = all.filter(c => c.late).sort((a, b) => a.end - b.end || a.score - b.score);
	return { onTime, late };
}

/** A quick walk's other shapes: a longer swing, with a longer first stride, a lower lift, or both. */
function variants(c, d) {
	const { steps: n, period } = c.args, swing = Math.round(0.8 * period), long = n > 2 && c.args.firstStep < 0.62 ? { firstStep: 0.62, step: r2((d - 0.62) / (n - 2)) } : null;
	return [{}, long, { lift: 0.06 }, long && { ...long, lift: 0.06 }].filter(Boolean).map(x => ({ ...c, args: { ...c.args, swing, ...x } }))
		.filter(v => v.args.step >= STRIDE_MIN && v.args.step <= STRIDE_MAX);
}

/**
 * Issues in the walk's own frames (the kinds a cadence causes) of a compiled probe: a count. An arm's REACH is not one:
 * the probe has no moving objects, so a hand gripping a carried box misses it every frame whatever the cadence, no
 * candidate walked clean and every compile paid all TRIALS probes (bench box, M2: ~25 s of a 34 s compile on the Mac,
 * 80 s on the box, three compiles past the hub's 240 s).
 */
const walkIssues = (qa, f0, end) => qa.groups.filter(g => WALK_KINDS.has(g.kind) && !(g.kind === "REACH" && /^arm_/.test(g.subject ?? ""))
	&& g.last >= f0 && g.first <= end).reduce((n, g) => n + g.count, 0);

/**
 * planWalks(spec, { sk, scene, trial }) -> [{ i, args, note }] for every walkTo with arrive (applyWalkPlans puts
 * the args in). trial(spec) -> QA of a compile of that spec (pipeline.js), or throws.
 */
export function planWalks(spec, { sk, scene, trial }) {
	const plans = [], trials = carries(spec) ? CARRY_TRIALS : TRIALS;
	for (const { i, u } of toPlan(spec)) {
		const key = JSON.stringify([spec.keys, spec.use.slice(0, i + 1), spec.anchors, spec.props, spec.fits, spec.fix, scene?.objects ?? null, trials]);
		if (cache.has(key)) { plans.push(cache.get(key)); continue; }
		const before = spec.use.slice(0, i).filter(x => x.f0 < u.f0);
		let state, ends = [];
		try {
			const { spec: exp, used } = expandUse({ ...spec, frames: 20000, use: before }, { sk, scene, lenient: true });
			state = stateAt(exp.keys ?? [], u.f0); ends = used.map(x => x.end ?? 0);
		} catch { state = null; }
		if (!state?.foot_l || !state?.foot_r) continue;
		const c0 = [(state.foot_l[0] + state.foot_r[0]) / 2, (state.foot_l[2] + state.foot_r[2]) / 2], to = u.args.to, d = Math.hypot(to[0] - c0[0], to[to.length - 1] - c0[1]);
		const { onTime, late } = candidates(d, u.f0, u.args.arrive);
		const probe = c => {
			const frames = Math.max(c.end, ...ends) + 1;
			return { schema: spec.schema, fps: spec.fps ?? FPS, frames, keys: (spec.keys ?? []).filter(k => k.f < frames), use: [...before, { ...u, args: { ...u.args, ...c.args } }],
				...(spec.anchors ? { anchors: spec.anchors } : {}), ...(spec.props ? { props: spec.props } : {}), ...(spec.fits ? { fits: spec.fits } : {}), ...(spec.fix !== undefined ? { fix: spec.fix } : {}) };
		};
		let chosen = null, tried = 0, best = null, onTried = 0;
		const order = [...onTime.slice(0, 6), ...onTime.slice(0, 3).flatMap(c => variants(c, d))].slice(0, TRIALS - LATE);
		for (const c of [...order, ...late.slice(0, TRIALS - order.length)].slice(0, trials)) {
			let issues;
			try { issues = walkIssues(trial(probe(c)), u.f0, c.end); } catch { issues = Infinity; }
			tried++; onTried += c.late ? 0 : 1;
			if (!best || issues < best.issues) best = { c, issues };
			if (issues === 0) { chosen = c; break; }
		}
		chosen ??= best?.issues < Infinity ? best.c : onTime[0] ?? late[0];
		if (!chosen) continue;
		const a = chosen.args, A = u.args.arrive;
		const what = `use[${i}] walkTo arrive f${A}: steps ${a.steps}, period ${a.period}, swing ${a.swing}, step ${a.step} m, firstStep ${a.firstStep} m${a.lift ? `, lift ${a.lift} m` : ""} (${r2(chosen.v)} m/s), ends f${chosen.end}`;
		const why = onTime.length ? `the ${onTried} walks tried that end by f${A} pop or miss a foot`
			: `even the quickest walk over ${r2(d)} m (a step every ${PERIODS[0]} frames, strides up to ${STRIDE_MAX} m, 34 frames to start and stop) ends f${late[0]?.end}`;
		const late1 = chosen.late ? `; f${A} is too soon: ${why}; give arrive >= f${chosen.end} or a shorter distance` : "";
		const dirty = best && best.c === chosen && best.issues > 0 ? `; no candidate walked clean (${best.issues} issues in its frames)` : "";
		const plan = { i, args: a, end: chosen.end, note: `${what}${late1}${dirty} (${tried} checked)` };
		if (cache.size >= 64) cache.delete(cache.keys().next().value);
		cache.set(key, plan);
		plans.push(plan);
	}
	return plans;
}

/** The spec with every planned walk's args filled in (arrive leaves them: walkTo ignores it); the spec itself when there is none. */
export function applyWalkPlans(spec, plans) {
	if (!plans.length) return spec;
	const use = spec.use.map((u, i) => { const p = plans.find(x => x.i === i); return p && u?.skill === "walkTo" ? { ...u, args: { ...u.args, ...p.args } } : u; });
	return { ...spec, use };
}
