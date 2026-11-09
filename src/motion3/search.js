// Open parameters: any number in a spec (generator params, key channel values or vector
// components, anchor offsets, skill args) may be written as { range: [lo, hi] } (or
// { search: [lo, hi] }, + int: true). motion.compile then searches the values deterministically:
// the midpoint first, a grid (one parameter) or a Halton set (several), then a shrinking pattern
// search around the best, at most spec.search.budget (default 32, max 64) compiles, stopping at
// the first value with QA 0. Each trial compiles only the frames the parameters can change.
import { compileMotion } from "./compiler/compile.js";
import { bakeChannels, flowOptions } from "./compiler/channels.js";
import { expandGenerators } from "./compiler/walk.js";
import { runMotionQa } from "./qa/index.js";
import { airRuns } from "./qa/style.js";
import { weightOf } from "./qa/severity.js";

const INT_FIELDS = new Set(["f", "f0", "steps", "period", "swing", "until", "reach", "hold", "release"]);
const isOpen = v => v && typeof v === "object" && !Array.isArray(v) && (v.range ?? v.search) !== undefined && Object.keys(v).every(k => ["range", "search", "int"].includes(k));
const pathText = path => path.reduce((s, p) => (typeof p === "number" ? `${s}[${p}]` : s ? `${s}.${p}` : p), "");

/** Every { range } in the spec: [{ path, lo, hi, int }]. */
export function findParams(spec) {
	const out = [];
	const walk = (v, path) => {
		if (isOpen(v)) {
			const r = v.range ?? v.search;
			if (!(Array.isArray(r) && r.length === 2 && r.every(Number.isFinite) && r[0] < r[1])) throw new Error(`MOTION_SPEC_INVALID: ${pathText(path)} range must be [lo, hi] with lo < hi, got ${JSON.stringify(r)}`);
			out.push({ path, lo: r[0], hi: r[1], int: v.int ?? INT_FIELDS.has(path[path.length - 1]) });
			return;
		}
		if (Array.isArray(v)) v.forEach((x, i) => walk(x, [...path, i]));
		else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, [...path, k]);
	};
	for (const [k, v] of Object.entries(spec ?? {})) if (!["schema", "fps", "frames", "search"].includes(k)) walk(v, [k]);
	return out;
}

const snap = (p, x) => { const v = Math.min(p.hi, Math.max(p.lo, x)); return p.int ? Math.round(v) : Math.round(v * 1e4) / 1e4; };

function resolveParams(spec, params, values) {
	const s = structuredClone(spec);
	params.forEach((p, i) => { let o = s; for (const k of p.path.slice(0, -1)) o = o[k]; o[p.path[p.path.length - 1]] = values[i]; });
	return s;
}

/** QA groups -> one number: the sum of their severities (qa/severity.js, unrounded). */
const costOf = qa => qa.groups.reduce((c, g) => c + weightOf(g), 0);

/** Frames a parameter can change (baked channels differ between its ends), or null for all. */
function dirtyWindow(spec, params, mid, prepare, sk) {
	const expand = values => prepare(resolveParams(spec, params, values));
	const base = expand(mid), parts = s => JSON.stringify({ ...s, keys: undefined, generators: undefined });
	const bake = s => bakeChannels(expandGenerators(s, sk), s.frames, flowOptions(s.flow));
	const b0 = bake(base);
	let a = Infinity, b = -Infinity;
	for (let i = 0; i < params.length; i++) for (const end of [params[i].lo, params[i].hi]) {
		const s = expand(mid.map((v, j) => (j === i ? snap(params[i], end) : v)));
		if (parts(s) !== parts(base)) return null;
		const b1 = bake(s);
		for (const ch of new Set([...Object.keys(b0), ...Object.keys(b1)])) {
			const x = b0[ch], y = b1[ch];
			for (let f = 0; f < spec.frames; f++) if (JSON.stringify(x?.[f]) !== JSON.stringify(y?.[f])) { a = Math.min(a, f); b = Math.max(b, f); }
		}
	}
	return a > b ? null : [Math.max(0, a - 8), Math.min(spec.frames - 1, b + 8)];
}

/**
 * The window widened to hold, 8 frames past each end, every air run of 4 frames or more it reaches (style.js airRuns of the
 * middle spec's first solve). A window that cuts a flight compiles another take: the flight fixes leave a run with no
 * takeoff or landing, and QA reads that run against no arc (a back tuck compiled as f26-f43: hips 0.308 m off the whole
 * compile, SPIN at f33). The middle spec's first solve stands for every trial (no fixes: air runs a fix makes are not seen).
 */
function holdFlights(window, exp, { sk, scene }) {
	if (!window) return window;
	const out = compileMotion({ fps: 24, ...exp }, { sk, scene }, { fixes: false }), runs = airRuns(out, exp.checks?.supports ?? []).filter(([p, q]) => q - p >= 3);
	let [a, b] = window, grew = true;
	while (grew) {
		grew = false;
		for (const [p, q] of runs) {
			const na = Math.max(0, Math.min(a, p - 8)), nb = Math.min(exp.frames - 1, Math.max(b, q + 8));
			if (p <= b && q >= a && (na !== a || nb !== b)) { [a, b, grew] = [na, nb, true]; }
		}
	}
	return [a, b];
}

/** Halton point i (1-based) in [0, 1]^k. */
const PRIMES = [2, 3, 5, 7, 11, 13, 17, 19, 23, 29];
const halton = (i, k) => Array.from({ length: k }, (_, d) => { let f = 1, r = 0, n = i; const p = PRIMES[d % PRIMES.length]; while (n > 0) { f /= p; r += f * (n % p); n = Math.floor(n / p); } return r; });

/**
 * prepare(spec) -> expanded + validated plain spec (pipeline.js). Returns the spec with the
 * chosen values and a report { values: { path: value }, evals, cost (0 = clean), window, ms }.
 */
export function searchParams(spec, params, { sk, scene }, prepare) {
	const t0 = performance.now(), budget = Math.max(1, Math.min(64, Math.round(spec.search?.budget ?? 32)));
	const mid = params.map(p => snap(p, (p.lo + p.hi) / 2));
	const window = holdFlights(dirtyWindow(spec, params, mid, prepare, sk), prepare(resolveParams(spec, params, mid)), { sk, scene });
	const cache = new Map();
	let evals = 0, best = null;
	const evaluate = values => {
		const key = values.join(",");
		if (cache.has(key)) return cache.get(key);
		if (evals >= budget) return Infinity;
		evals++;
		let cost;
		try {
			const exp = prepare(resolveParams(spec, params, values));
			cost = costOf(runMotionQa(sk, compileMotion({ fps: 24, ...exp }, { sk, scene }, { window }), exp, { explain: false }));
		} catch (error) {
			if (!/MOTION_SPEC_INVALID/.test(error.message)) throw error;
			cost = 1e9;
		}
		cache.set(key, cost);
		if (!best || cost < best.cost) best = { values, cost };
		return cost;
	};
	const done = () => best?.cost === 0 || evals >= budget;
	const at = u => params.map((p, d) => snap(p, p.lo + (p.hi - p.lo) * u[d]));
	evaluate(mid);
	// coarse pass: a 9-point grid from the middle outward (one parameter) or Halton points
	const coarse = params.length === 1 ? [4, 3, 5, 2, 6, 1, 7, 0, 8].map(i => [i / 8]) : Array.from({ length: Math.min(budget >> 1, 8 * params.length) }, (_, i) => halton(i + 1, params.length));
	for (const u of coarse) { if (done()) break; evaluate(at(u)); }
	// pattern search around the best, halving the step
	let step = params.map(p => (p.hi - p.lo) / 8);
	while (!done() && step.some((s, d) => s > (params[d].int ? 0.5 : (params[d].hi - params[d].lo) * 1e-3))) {
		let moved = false;
		for (let d = 0; d < params.length && !done(); d++) for (const sg of [-1, 1]) {
			const v = best.values.slice(); v[d] = snap(params[d], v[d] + sg * step[d]);
			const before = best.cost;
			evaluate(v);
			if (best.cost < before) moved = true;
		}
		if (!moved) step = step.map(s => s / 2);
	}
	return {
		spec: resolveParams(spec, params, best.values),
		search: { values: Object.fromEntries(params.map((p, i) => [pathText(p.path), best.values[i]])), evals, cost: Math.round(best.cost * 100) / 100, window, ms: Math.round(performance.now() - t0) },
	};
}
