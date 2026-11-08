// C6. Repair: apply the QA patches (qa/patch.js) that make the motion better, round by round.
// Each round takes the top 3 groups that carry a patch and tries them one at a time, each with
// the patch the latest compile gives that group. When none is kept, the top 2 groups just past
// their limit with no patch, or a missed goal, get a small local search (repair-tune.js: the
// responsible skill's args, the key pair of a speed spike, or for a goal where the body stands
// and how it leans); the best candidate is the round's change. A change is kept only when
// qa/verdict.js compareQa calls it better (the summed severity drops, no goal that held fails, no
// more problems, and what got worse costs at most half of what got better), else it is undone, so
// the result is never worse than the spec as sent. A failure local to an arm (its reach, wrist,
// elbow, a hand or forearm into something) is tried without moving the body first: a patch or a
// candidate that moves the root (a stance, a walk's length, the root keys) comes only when nothing
// else is kept, and the applied entry says so (movedBody). A patch tried and not kept is not tried
// again, so the groups after it get their turn. A round that keeps nothing ends the repair. The
// compiler is deterministic and the candidates come in a fixed order, so the repair is too; no new
// compile starts after 20 s. A group whose hint has candidate patches (g.candidates, qa/patch.js: the
// faces of a box a second hand can take, load.js) gets them all compiled, at most CANDIDATES, and the
// one with the lowest summed severity stands for its patch: a hint compiles nothing, so only here
// can the cheapest be found.
// A repair that applied nothing tells the next one (#1116): opts.unless is the groups the character's last such repair faced
// (repair.faced, by groupKey: code and part), and a spec whose own groups are the same is not repaired at all; repair.skipped
// says why. The 2026-11-07 wall climb: every logged repair applied nothing and spent the 20 s cap, 25-31 s a compile; replayed,
// the compile it skips in r1 and in r2 (each run's last) took 23.0 -> 8.1 s and 36.6 -> 18.4 s, the same take. An explicit repair
// always runs (motion3.js).
import { applyPatch } from "./json-patch.js";
import { groupKey } from "./qa/severity.js";
import { tuneCandidates } from "./repair-tune.js";
import { compareQa } from "./qa/verdict.js";

const TRIES = 3, TUNE_GROUPS = 2, LIMIT_MS = 20000, CANDIDATES = 4;
const groupsOf = r => r?.qa?.groups ?? [];
const totalOf = r => groupsOf(r).reduce((sum, g) => sum + (g.severity ?? 0), 0);
const failedOf = r => (r?.qa?.goals ?? []).filter(g => !g.ok).length;
const groupIn = (r, key) => groupsOf(r).find(g => groupKey(g) === key);
/** qa/verdict.js: lower summed severity, no goal lost, no more problems, no trade of one failure for worse ones. */
const better = (r, than) => compareQa(r?.qa, than?.qa).better;

const ARM_PART = /^(hand|farm|uarm)_[lr]\b|^(Left|Right)(Arm|ForeArm|Hand)/;
/** A failure of one arm: its reach, wrist or elbow, or a hand, forearm or upper arm into something. */
const armLocal = g => (g.kind === "REACH" && /^arm_miss_[lr]$/.test(g.subject)) || ["WRIST", "ELBOW"].includes(g.kind)
	|| (["BODY", "FACE", "COLLIDE", "POP", "ACC", "SPEED", "FLIP"].includes(g.kind) && ARM_PART.test(g.subject));
/** A patch that moves where the body stands: a stance, a walk's length or end, a root key. */
const movesBody = patch => patch.some(o => /^\/use\/\d+\/args(\/(at|step|firstStep|to))?$/.test(o.path) && (o.path.endsWith("/args") ? ["at", "step", "firstStep", "to"].some(k => o.value?.[k] !== undefined) : true)
	|| /^\/keys\/\d+\/set\/root$/.test(o.path) || (o.path === "/keys/-" && o.value?.set?.root !== undefined));
const MOVED = "the body moved: no change that keeps it in place fixed this arm's failure";
/** True when two lists of group keys hold the same keys, as many times each. */
const sameKeys = (a, b) => a.length === b.length && JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
const skippedSay = n => `skipped: the last repair of this character applied nothing to these same ${n} problem group${n === 1 ? "" : "s"} (code and part); send repair: { rounds } to run it anyway`;

/**
 * repairSpec(spec, { rounds, limitMs, unless }, compile) -> { spec, result, repair }
 * @param {object} spec  the agent's spec (patches address it)
 * @param {{ rounds?: number, limitMs?: number, unless?: string[] }} opts  rounds 1..8 (default 4); limitMs, the wall-clock stop
 *   (default 20 s); unless, the groupKeys a repair of this character that applied nothing faced: the same groups skip the repair
 * @param {(spec: object) => object} compile  spec -> pipeline.js compileSpec result (qa.groups[i].patch)
 * @returns {{ spec: object, result: object, repair: { rounds: number, compiles: number,
 *   applied: { kind: string, subject: string, patch: object[], severity: number[], movedBody?: string }[], rejected: number,
 *   faced: string[], skipped?: string } }}  faced: the groupKeys of the spec as sent (the first compile)
 */
export function repairSpec(spec, opts, compile) {
	const want = Math.min(8, Math.max(1, Math.round(Number(opts?.rounds ?? 4)) || 4)), t0 = performance.now();
	const late = () => performance.now() - t0 >= (opts?.limitMs > 0 ? opts.limitMs : LIMIT_MS);
	let current = spec, result = compile(spec), compiles = 1, rejected = 0, rounds = 0;
	const faced = groupsOf(result).map(groupKey);
	if (faced.length && Array.isArray(opts?.unless) && sameKeys(faced, opts.unless)) {
		// the hints' patches are the ones that repair tried and refused: none is compiled again (compile-job.js checkHints) or
		// offered, the hint's words stay (replay of wall climb r1's last compile: with them checked the skip saved 1.5 s of 28.9)
		for (const g of groupsOf(result)) delete g.patch;
		return { spec, result, repair: { rounds, compiles, applied: [], rejected, faced, skipped: skippedSay(faced.length) } };
	}
	const refused = new Set();
	const applied = [];
	/** Compiles current + patch; null (counted as rejected) when the patch or the spec fails. */
	const attempt = patch => {
		try {
			const next = applyPatch(current, patch);
			compiles += 1;
			return { next, r: compile(next) };
		} catch {
			rejected += 1;
			return null;
		}
	};
	/** g's patch compiled, or of its candidates ranked by summed severity the first that better() keeps ({ next, r, patch });
	 * with none kept, the cheapest (the caller refuses it); null when none compiles. A cheaper face that breaks a goal
	 * that held does not hide a dearer one that is kept. */
	const cheapest = g => {
		const tried = [];
		for (const patch of (g.candidates ?? [g.patch]).slice(0, CANDIDATES)) {
			if (tried.length && late()) break;
			const t = attempt(patch);
			if (!t) continue;
			tried.push({ ...t, patch });
			if (totalOf(t.r) === 0 && !failedOf(t.r) && better(t.r, result)) break;
		}
		tried.sort((a, b) => totalOf(a.r) - totalOf(b.r));
		const pick = tried.find(t => better(t.r, result)) ?? tried[0] ?? null;
		rejected += tried.filter(t => t !== pick).length;
		return pick;
	};
	const keep = (g, key, patch, { next, r }) => {
		const moved = armLocal(g) && movesBody(patch);
		applied.push({ kind: g.kind, subject: g.subject, patch, severity: [g.severity, groupIn(r, key)?.severity ?? 0], ...(moved ? { movedBody: MOVED } : {}) });
		current = next; result = r;
	};
	/** The best of the patches for group g; true when one is kept. */
	const best = (g, patches) => {
		let top = null;
		for (const patch of patches) {
			if (late()) break;
			const t = attempt(patch);
			if (!t) continue;
			if (better(t.r, top?.r ?? result)) { if (top) rejected += 1; top = { ...t, patch }; } else rejected += 1;
			if (top && totalOf(top.r) === 0 && !failedOf(top.r)) break;
		}
		if (top) keep(g, groupKey(g), top.patch, top);
		return Boolean(top);
	};
	/** The tune candidates for group g (repair-tune.js); an arm's failure tries those that keep the body in place first. */
	const tune = g => {
		const all = tuneCandidates(g, current);
		if (!armLocal(g)) return best(g, all);
		return best(g, all.filter(p => !movesBody(p))) || best(g, all.filter(movesBody));
	};
	while (rounds < want && !late()) {
		// a patch already tried and not kept is not tried again: the groups after it get their turn
		const keys = groupsOf(result).filter(g => g.patch && !refused.has(JSON.stringify(g.patch))).slice(0, TRIES).map(groupKey);
		const near = groupsOf(result).filter(g => tuneCandidates(g, current).length).slice(0, TUNE_GROUPS).map(groupKey);
		if (!keys.length && !near.length) break;
		rounds += 1;
		let kept = 0;
		const deferred = [];
		for (const key of keys) {
			const g = groupIn(result, key);
			if (!g?.patch || late()) continue;
			// an arm's failure whose patch moves the body waits until nothing else is kept this round
			if (armLocal(g) && movesBody(g.patch)) { deferred.push(key); continue; }
			const t = cheapest(g);
			if (t && better(t.r, result)) { keep(g, key, t.patch, t); kept += 1; } else { refused.add(JSON.stringify(g.patch)); if (t) rejected += 1; }
		}
		for (const key of kept ? [] : near) {
			const g = groupIn(result, key);
			if (g && !late() && tune(g)) { kept += 1; break; }
		}
		for (const key of kept ? [] : deferred) {
			const g = groupIn(result, key);
			if (!g?.patch || late()) continue;
			const t = cheapest(g);
			if (t && better(t.r, result)) { keep(g, key, t.patch, t); kept += 1; break; } else { refused.add(JSON.stringify(g.patch)); if (t) rejected += 1; }
		}
		if (!kept) break;
	}
	return { spec: current, result, repair: { rounds, compiles, applied, rejected, faced } };
}
