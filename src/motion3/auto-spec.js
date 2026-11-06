// What the agent may leave to the compiler before a spec is corrected and validated (#1078): it writes judgment, the
// compiler writes the numbers that follow from it. Pure and idempotent: a spec that uses none of it comes back as is.
//
//   tempo (#1082)   a key may give `after: "fast" | "normal" | "slow" | <frames>` instead of f: its frame is the previous key's
//                   plus a gap sized from how far its channels move (DESIGN speeds below), fast 0.6x, slow 1.6x the time
//   names           a key may carry `name`; any frame field written "@name" or "@name+3" / "@name-2" (object keys, use f0,
//                   check spans, goals) reads that key's frame, so object keys follow keys placed by tempo
//   frames          left out = "auto"
//   root [x, z]     (#1079) the hips' height is the compiler's: the standing height, lowered by the reach fixes (fix/reach.js
//                   for the legs, fix/reach-body.js for the hands) where the feet or a low target need it
//   look            (#1081) a key's `set.look` ("object:<id>", "anchor:<name>", [x, y, z] or null) moves to spec.look, which
//                   the compiler turns into head angles per frame (compiler/auto.js)
// authoredOf (#1083): what the agent wrote, before skills expand: keys, keyed values, values per channel family.

const DESIGN = { root: 0.9, foot: 1.1, hand: 1.2, deg: 110, other: 0.5 }; // m/s, m/s, m/s, deg/s, s for a key with no measured move
const TEMPO = { fast: 0.6, normal: 1, slow: 1.6 }, MIN_GAP = 4, MAX_GAP = 96;
const NAME_REF = /^@([A-Za-z][\w-]*)\s*(?:([+-])\s*(\d+))?$/;
const isNum = v => typeof v === "number" && Number.isFinite(v);
const dist = (a, b) => Math.hypot(...a.map((x, i) => x - (b[i] ?? 0)));

/** Seconds a key's move takes at normal tempo: the slowest of its channels against the state the keys before left. */
function moveSeconds(set, state) {
	let t = 0, any = false;
	for (const [ch, v] of Object.entries(set ?? {})) {
		const was = state.get(ch);
		if (was === undefined) continue;
		const fam = ch.replace(/_[lr]$/, "");
		if (Array.isArray(v) && Array.isArray(was)) {
			const a = v.length === 2 ? [v[0], v[1]] : [v[0], v[2]], b = was.length === 2 ? [was[0], was[1]] : [was[0], was[2]];
			const d = fam === "root" ? dist(a, b) : dist(v, was), speed = DESIGN[fam] ?? DESIGN.hand;
			if (!["root", "foot", "hand"].includes(fam)) continue;
			t = Math.max(t, d / speed); any = true;
		} else if (isNum(v) && isNum(was) && !/^(w_|armw_|arm_)/.test(ch)) { t = Math.max(t, Math.abs(v - was) / DESIGN.deg); any = true; }
	}
	return any ? t : DESIGN.other;
}

function resolveTempo(keys, fps) {
	if (!Array.isArray(keys) || !keys.some(k => k && typeof k === "object" && (k.after !== undefined || (k.f === undefined && k.set)))) return { keys, names: namesOf(keys) };
	const state = new Map(), names = new Map(), out = [];
	let prev = null;
	for (const key of keys) {
		if (!key || typeof key !== "object") { out.push(key); continue; }
		const { after, name, ...rest } = key;
		let f = rest.f;
		if (!Number.isInteger(f)) {
			const gap = isNum(after) ? Math.round(after) : Math.round(moveSeconds(rest.set, state) * (TEMPO[after] ?? 1) * fps);
			f = prev === null ? (isNum(after) ? Math.round(after) : 0) : prev + Math.min(MAX_GAP, Math.max(MIN_GAP, gap));
		}
		if (typeof name === "string") names.set(name, f);
		for (const [ch, v] of Object.entries(rest.set ?? {})) state.set(ch, v);
		prev = Math.max(prev ?? 0, f);
		out.push({ ...rest, f });
	}
	return { keys: out, names };
}

function namesOf(keys) {
	const names = new Map();
	for (const k of Array.isArray(keys) ? keys : []) if (k && typeof k.name === "string" && Number.isInteger(k.f)) names.set(k.name, k.f);
	return names;
}

/** Every "@name[+-n]" string in the spec (outside key values) as the frame it names. */
function replaceNames(value, names, inSet = false) {
	if (typeof value === "string" && !inSet) {
		const m = NAME_REF.exec(value);
		if (m && names.has(m[1])) return names.get(m[1]) + (m[2] ? (m[2] === "-" ? -1 : 1) * Number(m[3]) : 0);
		return value;
	}
	if (Array.isArray(value)) return value.map(v => replaceNames(v, names, inSet));
	if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, replaceNames(v, names, inSet || k === "set")]));
	return value;
}

const lookOf = v => v === null || typeof v === "string" || (Array.isArray(v) && v.length === 3 && v.every(isNum));

/** spec -> spec with tempo, names, frames, root [x, z] and look resolved (the same object when it used none of them). */
export function autoSpec(spec, sk) {
	if (!spec || typeof spec !== "object" || Array.isArray(spec)) return spec;
	const keys = spec.keys;
	const usesKeys = Array.isArray(keys) && keys.some(k => k && typeof k === "object" && (k.after !== undefined || k.name !== undefined || (k.f === undefined && k.set)
		|| (Array.isArray(k.set?.root) && k.set.root.length === 2) || (k.set && "look" in k.set)));
	if (!usesKeys && spec.frames !== undefined) return spec;
	let s = { ...spec };
	if (s.frames === undefined) s.frames = "auto";
	if (!usesKeys) return s;
	const { keys: timed, names } = resolveTempo(keys, s.fps ?? 24);
	const standY = sk?.restWorldPos?.[sk.index?.Hips]?.[1] ?? 1.0, look = [...(Array.isArray(s.look) ? s.look : [])];
	s.keys = timed.map(k => {
		if (!k || typeof k !== "object" || !k.set) return k;
		const { name, ...rest } = k, set = { ...rest.set };
		if (Array.isArray(set.root) && set.root.length === 2 && set.root.every(isNum)) set.root = [set.root[0], standY, set.root[1]];
		if ("look" in set) { if (lookOf(set.look)) look.push({ f: rest.f, at: set.look }); delete set.look; }
		return { ...rest, set };
	}).filter(k => !(k && k.set && !Object.keys(k.set).length && !k.step));
	if (look.length) s.look = look.sort((a, b) => a.f - b.f);
	if (names.size) s = { ...replaceNames(s, names), keys: s.keys };
	return s;
}

/** What the agent wrote (#1083): { keys, values, byChannel } over spec.keys before skills expand, families without the side. */
export function authoredOf(spec) {
	const byChannel = {};
	let values = 0;
	const keys = Array.isArray(spec?.keys) ? spec.keys : [];
	for (const k of keys) for (const ch of Object.keys(k?.set ?? {})) {
		const fam = ch.replace(/_[lr]$/, "").replace(/^w_.+$/, "w_<anchor>");
		byChannel[fam] = (byChannel[fam] ?? 0) + 1; values++;
	}
	return { keys: keys.length, values, byChannel };
}
