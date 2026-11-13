// Unnecessary actions of one run, counted from its shot calls with one fixed procedure for every run.
//   call: { n, status: "ok" | "rejected" | "blocked", error?, scene, spec, shown?: [{ frames, view, focus }], lookAsked? }
//   scene and spec are the ones in force for the call (what was sent, merged over what the tool kept).
// (a) redundant: an accepted call whose scene and spec equal an earlier accepted call's and whose sheets show only
//     frames that this scene and spec already showed in the same view and framing.
// (b) mistake: a call that was rejected (bad scene, bad option, unknown verb, an engine error), with its error.
// (c) sweep: three or more calls in a row, each differing from the call before it only in numbers of one and the
//     same action of the spec.
// Not one of the three, and not in the total: `streak`, the longest run of three or more calls in a row that each
// changed actions only inside one stretch of 48 frames that overlaps the stretch of the call before (trial and error
// on one moment of the clip, whether by numbers or by adding and removing actions).
const isObject = v => v !== null && typeof v === "object" && !Array.isArray(v);
const canon = v => Array.isArray(v) ? `[${v.map(canon).join(",")}]` : isObject(v) ? `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canon(v[k])}`).join(",")}}` : JSON.stringify(v ?? null);

/** True when a and b have the same structure and differ at most in numbers. */
function sameButNumbers(a, b) {
	if (typeof a === "number" && typeof b === "number") return true;
	if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => sameButNumbers(v, b[i]));
	if (isObject(a) && isObject(b)) { const ka = Object.keys(a).sort(), kb = Object.keys(b).sort(); return ka.join("\0") === kb.join("\0") && ka.every(k => sameButNumbers(a[k], b[k])); }
	return a === b;
}

/** "<key>[<index>]" of the one action two specs differ in, when that difference is numbers only; else null. */
function numericStep(prev, cur) {
	if (!isObject(prev.spec) || !isObject(cur.spec) || canon(prev.scene) !== canon(cur.scene)) return null;
	const keys = Object.keys(cur.spec).sort();
	if (keys.join("\0") !== Object.keys(prev.spec).sort().join("\0")) return null;
	let hit = null;
	for (const key of keys) {
		const a = prev.spec[key], b = cur.spec[key];
		if (!Array.isArray(a) || !Array.isArray(b)) { if (canon(a) !== canon(b)) return null; continue; }
		if (a.length !== b.length) return null;
		for (let i = 0; i < a.length; i++) {
			if (canon(a[i]) === canon(b[i])) continue;
			if (hit || !sameButNumbers(a[i], b[i])) return null;
			hit = `${key}[${i}]`;
		}
	}
	return hit;
}

/** [first, last] frame of the actions two calls differ in, when the scene is the same and they span at most 48 frames; else null. */
function localChange(prev, cur) {
	if (!isObject(prev.spec) || !isObject(cur.spec) || canon(prev.scene) !== canon(cur.scene)) return null;
	const frames = [];
	for (const key of new Set([...Object.keys(prev.spec), ...Object.keys(cur.spec)])) {
		const a = Array.isArray(prev.spec[key]) ? prev.spec[key] : [], b = Array.isArray(cur.spec[key]) ? cur.spec[key] : [], inA = new Set(a.map(canon)), inB = new Set(b.map(canon));
		for (const x of [...a.filter(v => !inB.has(canon(v))), ...b.filter(v => !inA.has(canon(v)))]) frames.push(Number(x?.[0]));
	}
	if (!frames.length || !frames.every(Number.isFinite)) return null;
	const lo = Math.min(...frames), hi = Math.max(...frames);
	return hi - lo <= 48 ? [lo, hi] : null;
}

export function auditCalls(calls) {
	const redundant = [], mistakes = [], sweeps = [], seen = new Map();
	for (const c of calls) {
		if (c.status === "blocked") continue; // the harness's own safety stop, not the model's mistake
		if (c.status !== "ok") { mistakes.push({ call: c.n, error: String(c.error ?? "rejected").split("\n")[0].slice(0, 300) }); continue; }
		const clip = `${canon(c.scene)}|${canon(c.spec)}`, had = seen.get(clip), sheets = c.shown ?? [], view = s => `${s.view}|${canon(s.focus ?? [])}`;
		if (had && sheets.every(s => s.frames.every(f => had.get(view(s))?.has(f)))) redundant.push({ call: c.n, why: c.lookAsked ? "a look at frames and a view it already had for this scene and spec" : "the same scene and spec as an earlier call" });
		const map = had ?? new Map();
		for (const s of sheets) map.set(view(s), new Set([...(map.get(view(s)) ?? []), ...s.frames]));
		seen.set(clip, map);
	}
	let run = null;
	const close = () => { if (run && run.calls.length >= 3) sweeps.push(run); run = null; };
	for (let i = 1; i < calls.length; i++) {
		const action = numericStep(calls[i - 1], calls[i]);
		if (action && run?.action === action) run.calls.push(calls[i].n);
		else { close(); if (action) run = { action, calls: [calls[i].n] }; }
	}
	close();
	let streak = null, cur = null;
	for (let i = 1; i < calls.length; i++) {
		const w = localChange(calls[i - 1], calls[i]);
		if (w && cur && w[0] <= cur.frames[1] + 12 && w[1] >= cur.frames[0] - 12) cur = { calls: [...cur.calls, calls[i].n], frames: [Math.min(cur.frames[0], w[0]), Math.max(cur.frames[1], w[1])] };
		else cur = w ? { calls: [calls[i].n], frames: w } : null;
		if (cur && cur.calls.length >= 3 && cur.calls.length > (streak?.calls.length ?? 0)) streak = cur;
	}
	return { redundant: redundant.length, mistakes: mistakes.length, sweeps: sweeps.length, total: redundant.length + mistakes.length + sweeps.length, streak: streak?.calls.length ?? 0, list: { redundant, mistakes, sweeps, streak } };
}
