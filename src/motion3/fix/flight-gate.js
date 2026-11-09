// What a flight fix may not do (#1124 Proof: no new penetration or REACH). fix.ballistic and fix.spin run last, so nothing
// repairs what they cause: a hop keyed over a hurdle higher than its frames can carry it comes down on the hurdle once its
// centre of mass rides the parabola (0.55 m in 12 frames over a 0.5 m hurdle: QA 0 keyed, COLLIDE foot and shin 4.8 cm on
// the arc). Each move is read against the frames before the flight fixes, with QA's own checks (qa/checks.js worldChecks,
// object-checks.js, people-checks.js) and the spec's allowances. A frame is worse when a part goes into something deeper
// than it went before, by more than TOL; the fix then gives the flight its frames back and says so (fixed.ballistic.skipped,
// fixed.spin.left). Being physically right does not excuse it: the agent gets the frames the flight needs instead.
import { worldChecks, QA_LIMITS } from "../qa/checks.js";
import { objectChecks } from "../qa/object-checks.js";
import { peopleChecks } from "../qa/people-checks.js";
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
	for (const i of [...objectChecks(sk, out, spec), ...peopleChecks(sk, out, checks)]) if (KINDS.has(i.kind) && i.frame >= a && i.frame <= b) push(i.kind, i.msg, i.frame, i.value);
	return at;
}

/**
 * Reads flights `runs` now, as they are before any flight fix. -> gate(a, b) for run [a, b] after a move: null, or
 * { into: [subjects], depth (m, the deepest) } for what the move entered.
 */
export function flightGate(out, runs) {
	const keyed = new Map(runs.map(([a, b]) => [a, reading(out, a, b)]));
	return (a, b) => {
		const was = keyed.get(a), into = new Set();
		let depth = 0;
		for (const [key, { msg, value }] of reading(out, a, b)) {
			if (value <= (was.get(key)?.value ?? 0) + TOL) continue;
			into.add(msg);
			depth = Math.max(depth, value);
		}
		return into.size ? { into: [...into], depth: round4(depth) } : null;
	};
}
