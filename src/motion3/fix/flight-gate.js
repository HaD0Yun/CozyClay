// What a flight fix may not do (#1124 Proof: no new penetration or REACH, no goal lost). fix.ballistic and fix.spin run
// last, so nothing repairs what they cause: a hop keyed over a hurdle higher than its frames can carry it comes down on the
// hurdle once its centre of mass rides the parabola (0.55 m in 12 frames over a 0.5 m hurdle: QA 0 keyed, COLLIDE foot and
// shin 4.8 cm on the arc). Each move is read against the frames before the flight fixes, with QA's own checks (qa/checks.js
// worldChecks, object-checks.js, people-checks.js, goals.js) and the spec's allowances. A frame is worse when a part goes
// into something deeper than it went before, by more than TOL; a take is worse when a goal the frames before met is missed
// (as pipeline.js keptRetime keeps retime only when no goal is lost: a hop keyed to put its hips 1.45 m over a mark at its
// apex met it at 1.528 m and missed it at 1.335 m on the arc). The fix then gives the flight its frames back and says so
// (fixed.ballistic.skipped, fixed.spin.left). Being physically right does not excuse it: the agent gets the frames the
// flight needs instead. Only the flight's own frames are read (a fix re-solves no other): the other characters on them
// (a view of out over a..b), the carried objects over the take (object-pose.js caches their poses on out and its frames).
import { worldChecks, QA_LIMITS } from "../qa/checks.js";
import { objectChecks } from "../qa/object-checks.js";
import { peopleChecks } from "../qa/people-checks.js";
import { goalChecks } from "../qa/goals.js";
import { round4 } from "./ease.js";

/** Metres: deeper than the frames before by less than this is the same depth. */
const TOL = 0.001;
const KINDS = new Set(["COLLIDE", "REACH", "PERSON"]);

/** Map(`${frame} ${subject}` -> { msg, value (m) }) over frames a..b (indexes of out.frames). */
function reading(out, a, b) {
	const { sk, spec = {} } = out.ctx, checks = spec.checks ?? {}, L = { ...QA_LIMITS, ...checks.limits }, at = new Map();
	const push = (kind, msg, f, value) => {
		const key = `${f} ${msg}`;
		if (!(at.get(key)?.value >= value)) at.set(key, { msg, value });
	};
	for (let f = a; f <= b; f++) worldChecks(sk, out.frames[f], f, out.objectsAt(f), L, checks.allow, push);
	// peopleChecks reads frames, f0 and the scene alone: the window is a view (its frame i is a + i of out)
	const people = peopleChecks(sk, { ctx: out.ctx, f0: (out.f0 ?? 0) + a, frames: out.frames.slice(a, b + 1) }, checks).map(i => ({ ...i, frame: i.frame + a }));
	for (const i of [...objectChecks(sk, out, spec), ...people]) if (KINDS.has(i.kind) && i.frame >= a && i.frame <= b) push(i.kind, i.msg, i.frame, i.value);
	return at;
}

/** The names of the spec's goals out meets now. */
const metGoals = out => new Set(out.ctx.spec?.goals?.length ? goalChecks(out, out.ctx.spec.goals).results.filter(r => r.ok).map(r => r.name) : []);

/** What a gate's hit says: "enter <subjects> by <depth> m" and/or "lose goal <names>". */
export const hitSays = hit => [...(hit.into.length ? [`enter ${hit.into.join(", ")} by ${hit.depth} m`] : []), ...(hit.lost?.length ? [`lose goal ${hit.lost.join(", ")}`] : [])].join(" and ");

/**
 * Reads flights `runs` now, as they are before any flight fix. -> gate(a, b) for run [a, b] after a move: null, or
 * { into: [subjects], depth (m, the deepest), lost?: [goal names] } for what the move entered and the goals it lost.
 */
export function flightGate(out, runs) {
	const keyed = new Map(runs.map(([a, b]) => [a, reading(out, a, b)])), met = metGoals(out);
	return (a, b) => {
		const was = keyed.get(a), into = new Set();
		let depth = 0;
		for (const [key, { msg, value }] of reading(out, a, b)) {
			if (value <= (was.get(key)?.value ?? 0) + TOL) continue;
			into.add(msg);
			depth = Math.max(depth, value);
		}
		const now = met.size ? metGoals(out) : met, lost = [...met].filter(name => !now.has(name));
		return into.size || lost.length ? { into: [...into], depth: round4(depth), ...(lost.length ? { lost } : {}) } : null;
	};
}
