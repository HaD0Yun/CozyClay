// Deterministic auto-fixes the compiler applies after the first solve (spec.fix). Each fix edits
// the baked channels or the per-frame IK offsets and re-solves only the frames it touched, so QA
// still measures the final frames; every fix reports what it changed (counts, worst amount).
//
// spec.fix = { reach: true, slide: true, penetration: 0.02, self: true, retime: true, person: true } (false = all off; retime on by default
// since deep research 4: POP -1.58 +- 0.58 frames, kept only when QA is no worse)
//   reach        wrist targets past the arm's reach go onto it through a soft knee (no snap);
//                ankle targets past the leg's reach lower the hips just enough, eased in and out; a hand
//                on a pinned target (a world or a scene object's anchor) that the straight arm misses brings
//                the body to it: lean, hip shift, lower hips, the feet kept (reach-body.js, fixed.reachBody)
//   slide        a sole under the floor lifts its ankle onto it (ground.js); a planted heel or ball
//                that drifts less than 1 cm stays put, and a foot turning on its planted ball (heel
//                up) or heel pivots about it whatever the drift; a flat planted foot (heel and ball
//                down) keeps its heading until one of them lifts (turn.js)
//   penetration  hands pushed out of scene boxes along the box normal when the depth past the
//                allowance is at most this many metres (true = 0.02), eased in and out
//   self         arms out of the rest of the body on its fitted skin: the elbow turns about the
//                shoulder-wrist line, the hand is pushed out along the skin (self.js)
//   retime       speed spikes get more frames, borrowed from the neighbouring keys
//   stance       a standIdle stance whose legs, feet or hips are in a scene body slides out of it, the least
//                distance (skills/stance.js; applied when the skills expand, reported in observations.placed)
//   person       arms out of the other characters (scene.people, their installed takes; QA PERSON): the wrist
//                target moves out by the depth, back the side the hand came from, eased in and out (person.js)
//   grasp        a holding hand's fingers close on what it holds and the object rests in the hand (#816);
//                false keeps the preset grip and the grab-frame offset
import { lowerHips, armReach } from "./reach.js";
import { reachBody } from "./reach-body.js";
import { lockFeet } from "./slide.js";
import { holdTurns } from "./turn.js";
import { liftSoles } from "./ground.js";
import { clearFeet } from "./clear.js";
import { otherHandHold } from "./other-hand.js";
import { pushOut } from "./push.js";
import { retime } from "./retime.js";
import { selfClear } from "./self.js";
import { personOut } from "./person.js";

const FIX_KEYS = ["reach", "slide", "clear", "penetration", "self", "retime", "stance", "grasp", "person"];
export { FIX_KEYS };

export function fixOptions(fix) {
	if (fix === false) return { reach: false, slide: false, clear: false, penetration: 0, self: false, retime: false, stance: false, grasp: false, person: false };
	const f = fix ?? {};
	const pen = f.penetration === true ? 0.02 : Math.min(0.05, Math.max(0, Number(f.penetration) || 0));
	return { reach: f.reach !== false, slide: f.slide !== false, clear: f.clear !== false, penetration: pen, self: f.self !== false, retime: f.retime !== false, stance: f.stance !== false, grasp: f.grasp !== false, person: f.person !== false };
}

/** The slide report with the flat feet whose turn waited (turn.js): turns { frames, max deg }. */
const withTurns = (turns, slide) => (turns ? { ...(slide ?? { frames: 0, how: "planted heel/ball held in place" }), turns, how: `${slide?.how ?? "planted heel/ball held in place"}; a flat planted foot keeps its heading until it lifts` } : slide);
const mergeReach = (a, b) => (a && b ? { frames: Math.max(a.frames, b.frames), eased: Math.max(a.eased, b.eased), max: Math.max(a.max, b.max), how: a.how } : a ?? b);

/** Runs the enabled fixes in order (retime first: it moves keys) and returns their reports. */
export function applyFixes(out, fix, engine, { whole = true } = {}) {
	const fixed = {}, put = (name, report) => { if (report) fixed[name] = report; };
	if (fix.retime && whole) put("retime", retime(out, engine));
	if (fix.slide) put("ground", liftSoles(out, engine));
	if (fix.reach) put("reachLegs", lowerHips(out, engine));
	if (fix.reach) put("reachBody", reachBody(out, engine));
	if (fix.slide) put("slide", withTurns(holdTurns(out, engine), lockFeet(out, engine)));
	if (fix.clear) put("clear", clearFeet(out, engine));
	// a pivot can hold a foot past the leg's reach: the hips go down for those frames too
	if (fix.reach && fixed.slide?.pivots) put("reachLegs", mergeReach(fixed.reachLegs, lowerHips(out, engine)));
	if (fix.grasp) put("otherHand", otherHandHold(out, engine));
	if (fix.penetration > 0) put("penetration", pushOut(out, engine, fix.penetration));
	if (fix.self) put("self", selfClear(out, engine));
	if (fix.person) put("person", personOut(out, engine));
	if (fix.reach) put("reachArms", armReach(out));
	return fixed;
}
