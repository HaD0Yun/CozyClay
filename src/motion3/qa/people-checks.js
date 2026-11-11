// PERSON: the compiled body against the other people in the scene (people.js), capsule against capsule (geometry.js
// CAPSULES on both bodies, at the same timeline frame). "<part> x person:<id>": how deep the part goes into the
// other body (its deepest capsule there; the hint names which), past QA_LIMITS.allow. An intended touch (a push, a hand
// on a shoulder) is allowed like any contact: checks.allow [{ part, object: "person:<id>", depth }].
import { segDist, CAPSULES, capsulesFor } from "./geometry.js";
import { allowance, QA_LIMITS } from "./checks.js";
import { dist } from "../compiler/math.js";

/** Two bodies whose hips are this far apart (m) cannot touch: a body is under 1 m from its hips to any skin. */
export const APART = 2.2;

/** The person's capsule endpoints at timeline frame f: [part, A, B, r] with the joints read from P. */
export function personCapsules(p, f) {
	const at = Math.max(0, Math.min(p.frames - 1, f)) * p.names.length, J = name => { const j = p.names.indexOf(name), i = (at + j) * 3; return [p.P[i], p.P[i + 1], p.P[i + 2]]; };
	return CAPSULES.map(([part, a, b, r]) => [part, J(a), J(b), r]);
}

/** PERSON issues of compile result out (frames indexed in out.frames; reported at their absolute frame by qa/index.js). */
export function peopleChecks(sk, out, checks = {}) {
	const people = Object.entries(out.ctx?.scene?.people ?? {}), issues = [];
	if (!people.length) return issues;
	const I = sk.index, f0 = out.f0 ?? 0, lim = { ...QA_LIMITS, ...checks.limits }.allow;
	out.frames.forEach(({ s }, i) => {
		const f = i + f0, mine = capsulesFor(sk).map(([part, a, b, r]) => [part, s.P[I[a]], s.P[I[b]], r]);
		for (const [id, p] of people) {
			// a saved take keeps only the joints its anchors read (people.js keptPeople): no body to collide with there
			if (!CAPSULES.every(([, a, b]) => p.names.includes(a) && p.names.includes(b))) continue;
			const theirs = personCapsules(p, f), hips = theirs.find(c => c[0] === "hips")[1];
			if (dist(s.P[I.Hips], hips) > APART) continue;
			for (const [part, A, B, r] of mine) {
				const depth = Math.max(...theirs.map(([, C, D, q]) => r + q - segDist(A, B, C, D))), allow = allowance(checks.allow, part, `person:${id}`) ?? lim;
				if (depth > allow) issues.push({ kind: "PERSON", msg: `${part} x person:${id}`, frame: i, value: +depth.toFixed(4), limit: allow });
			}
		}
	});
	return issues;
}
