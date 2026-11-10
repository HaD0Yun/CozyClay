// What fix.self (fix/self.js, fix/self-repair.js) did about an arm in the body, for the BODY and FACE hints
// (hints-contact.js): repaired here and this much stays, left here (with why), or off for the take. The repair names its
// spans and what it left with absolute frames (fixed.self.spans[].at, fixed.self.left[].at "f<a>-f<b>", side l/r), as
// QA's groups do (g.first..g.last).
import { m3 } from "./fmt.js";

/** Whether "f<a>-f<b>" overlaps frames first..last. */
const overlaps = (at, first, last) => { const [, a, b] = /f(\d+)-f(\d+)/.exec(at ?? "") ?? []; return a !== undefined && +a <= last && +b >= first; };

/** "; fix.self ..." for group g of arm part `part` ("hand_r", "farm_l", "uarm_r"), or "" when the repair has nothing to say. */
export function selfNote(X, g, part) {
	const side = /_([lr])$/.exec(part ?? "")?.[1];
	if (!side || !/^(hand|farm|uarm)_/.test(part)) return "";
	if (X.spec?.fix === false || X.spec?.fix?.self === false) return "; fix.self is off for this take: turn it on to move the arm out with its IK";
	const self = X.out?.fixed?.self, left = self?.left?.find(l => l.side === side && overlaps(l.at, g.first, g.last));
	if (left) return `; fix.self left ${left.at} (${left.why})`;
	const span = self?.spans?.find(s => overlaps(s.at, g.first, g.last));
	return span ? `; fix.self moved the arm out over ${span.at} (deepest ${m3(span.depth[0])} -> ${m3(span.depth[1])} m) and this stays` : "";
}
