// Hints for contact-type issues: a body part inside a box, the floor, the head, the torso or the
// other limb. Each answers a world move (direction x amount) for whatever drives that part.
import { add, sub, scale, norm, dot, len, clamp, apply, ry, T } from "../compiler/math.js";
import { bonePoint } from "../compiler/skeleton.js";
import { CAPSULES, segPoints, sdBox, boxNormal, headDepth, segDist, ankleY } from "./geometry.js";
import { balanceAt, offsetWords } from "./com.js";
import { vec, m3 } from "./fmt.js";
import { kneeFoldHint, kneeWhy } from "./hints-knee.js";
import { objectFrame } from "../compiler/anchors.js";
import { bodyFor, bodyNormal, limbDepth } from "../body.js";
import { footProbes, footDepths } from "./foot-checks.js";
import { personCapsules } from "./people-checks.js";

const MARGIN = 0.003;
/** The most a foot hint lifts a foot over a body it went into through a side (a stair riser); higher, it backs out. */
const LIFT_MAX = 0.25;
const sideOf = name => (/(^|_)l$|^Left/.test(name) ? "l" : /(^|_)r$|^Right/.test(name) ? "r" : null);

/** fix (qa/patch.js) moving anchor `name` of hand k by a world delta at f: its own point, in the frame that point is written in. */
function anchorFix(X, name, f, delta, k) {
	const a = X.spec.anchors?.[name], path = field => `/anchors/${name}/${field}`;
	if (a?.kind === "world") return { path: path("p"), delta };
	if (a?.kind === "body") return { path: path("p"), delta: apply(ry(-(X.fr(f).c.yaw ?? 0)), delta) };
	if (["bone", "segment", "prop", "person"].includes(a?.kind)) return { path: path("offset"), delta };
	if (a?.kind !== "object") return undefined;
	// local is in the object's axes where that hand's target read it (anchors.js objectFrame)
	const fr = X.fr(f), o = objectFrame(X.out.ctx, a, name, { ...fr, diag: { ...fr.diag, frame: f } }, k);
	return { path: path("local"), delta: apply(T(o.R), delta) };
}

/** cause + hint (+ fix, qa/patch.js) for moving a body part (capsule name, prop_<name>, hand_<k>) by `delta` at frame f. */
export function moveHint(X, part, f, delta, why = "") {
	const prop = /^prop_(.+)$/.exec(part);
	const k = prop ? X.spec.props?.[prop[1]]?.hand : sideOf(part);
	let label, cause, fix, shown = delta;
	if (/^(hand|farm|uarm)_/.test(part) || prop) {
		const d = X.hand(k, f);
		label = d.label;
		fix = d.anchor ? anchorFix(X, d.anchor, f, delta, k) : d.ch === `hand_${k}` ? { channel: d.ch, f, delta } : undefined;
		// an object anchor moves its point on the object (local, in the object's axes), never the object
		const on = d.anchor && X.spec.anchors[d.anchor]?.kind === "object" ? X.spec.anchors[d.anchor].object : null;
		if (on && fix) { label = `anchors.${d.anchor}.local (a point on ${on}, in ${on}'s axes; ${on} stays)`; shown = fix.delta; }
		cause = d.anchor ? `anchor ${d.anchor}${d.fit !== null ? ` (fits[${d.fit}])` : ""} via ${X.cause(d.ch, f)}` : X.cause(d.ch, f);
	} else if (/^(shin|foot|sole)_/.test(part)) { label = `foot_${k}`; cause = X.cause(label, f); fix = { channel: label, f, delta }; }
	// a body held since its key (it breathes and sways there, compiler/idle.js): move what placed it (patch.js hold)
	else { label = "root"; cause = X.cause("root", f); fix = { channel: "root", f, delta, ...(/^root held since /.test(cause) ? { hold: true } : {}) }; }
	// a key the walk generator wrote: the agent changes the walk, not the key
	const walk = / (walk|walkTo) /.test(` ${cause}`) && /step|start|end/.test(cause);
	if (walk && !/^anchor/.test(label)) return { cause, hint: `walk path: ${label} needs ${vec(delta)} m at f${f}${why}; change that walk's heading/turnDistance/step (or give one a { range: [lo, hi] })` };
	return { cause, hint: `${label}: move ${vec(shown)} m at f${f}${why}`, fix };
}

const capsule = name => CAPSULES.find(c => c[0] === name);

/** Deepest point of a capsule in a box at frame f and the box's outward normal there. */
function deepest(X, f, part, box) {
	const [, a, b] = capsule(part), { s } = X.fr(f);
	const pts = segPoints(s.P[X.I[a]], s.P[X.I[b]]), ds = pts.map(p => sdBox(p, box)), m = Math.min(...ds);
	return { p: pts[ds.indexOf(m)], n: boxNormal(pts[ds.indexOf(m)], box), d: m };
}

function boxHint(X, g, part, id, need) {
	const f = g.worstFrame, box = X.out.objectsAt(X.rel(f))[id];
	if (!box || !capsule(part)) return null;
	const { n } = deepest(X, f, part, box);
	return moveHint(X, part, f, scale(n, need), ` (out of ${id})`);
}

/**
 * A foot in a box (foot-checks.js): through a side face (a toe swung into a stair's riser) the foot rises over the
 * box's top by what its deepest probe lacks, with the way straight out of that side as the other choice; through
 * the top face (a sole sunk in a step) it comes out along that face.
 */
function footHint(X, g, part, id) {
	const f = g.worstFrame, box = X.out.objectsAt(X.rel(f))[id];
	if (!box) return null;
	const probes = footProbes(X.sk, X.fr(f).s, part.endsWith("_l") ? "Left" : "Right"), d = footDepths(probes, box), need = g.worst - g.limit + MARGIN;
	if (!(d.side > 0)) return d.topAt ? moveHint(X, part, f, scale(boxNormal(d.topAt, box), need), ` (out of ${id}'s top)`) : null;
	const under = p => 2 * box.half[1] - apply(T(box.R), sub(p, box.pos))[1];
	const rise = Math.max(...probes.filter(p => sdBox(p, box) < 0).map(under)) + MARGIN, out = scale(boxNormal(d.sideAt, box), need);
	// a step's riser is cleared by lifting the swing; a panel the foot kicks or a wall is left the way the foot came
	if (rise > LIFT_MAX) return moveHint(X, part, f, out, ` (out of ${id}'s side)`);
	const r = moveHint(X, part, f, apply(box.R, [0, rise, 0]), ` (over ${id}'s top; its ${g.worst.toFixed(3)} m is through a side)`);
	r.hint += /^walk path/.test(r.hint) ? "; a higher lift raises the swing" : `; or move ${vec(out)} m out of that side`;
	return r;
}

function towardFrom(X, g, part, from, need, what) {
	return moveHint(X, part, g.worstFrame, scale(norm(from), need), ` (away from the ${what})`);
}

/** Probe points of a hand or prop at frame f (as the FACE/BODY checks probe them). */
function probes(X, f, nm) {
	const { s, diag } = X.fr(f), I = X.I;
	if (nm.startsWith("hand_")) { const S = nm.endsWith("l") ? "Left" : "Right"; return segPoints(s.P[I[`${S}Hand`]], s.P[I[`${S}HandMiddle3`]], 5); }
	return Object.entries(diag.props?.[nm.slice(5)] ?? {}).filter(([k, p]) => Array.isArray(p) && k !== "origin").map(([, p]) => p);
}

/** The most a hand's reachGrip world anchor rises over a scene box's top it went into (#819: past ~3.5 cm the fingers miss the thing). */
const GRIP_LIFT = 0.035;
/** A hand whose reachGrip world anchor sits too low over a scene box's top: that anchor rises by what the hit lacks. */
function gripLift(X, g, part, id, need) {
	const f = g.worstFrame, k = sideOf(part), box = X.out.objectsAt(X.rel(f))[id], d = X.hand(k, f);
	const grip = d.anchor && X.keys(d.ch).some(key => / reachGrip$/.test(key.src));
	if (!/^hand_[lr]$/.test(part) || !box || X.spec.objects?.[id] || !grip || X.spec.anchors?.[d.anchor]?.kind !== "world" || !(need > 0 && need <= GRIP_LIFT)) return null;
	return deepest(X, f, part, box).n[1] > 0.5 ? moveHint(X, part, f, [0, need, 0], ` (over ${id}'s top)`) : null;
}

export const contactHints = {
	COLLIDE(X, g) {
		const [, part, id] = /^(\S+) x (.+)$/.exec(g.subject) ?? [];
		if (/^foot_[lr]$/.test(part ?? "")) return footHint(X, g, part, id);
		const lift = gripLift(X, g, part, id, g.worst - g.limit + MARGIN);
		if (lift) return lift;
		const r = boxHint(X, g, part, id, g.worst - g.limit + MARGIN);
		if (r && /^(hand|farm)_/.test(part) && !X.spec.fix?.penetration && g.worst - g.limit <= 0.05) {
			r.hint += "; or fix.penetration: 0.02 pushes shallow hand hits out";
			if (X.spec.fix !== false) r.fix = { path: "/fix/penetration", value: 0.02 };
		}
		return r;
	},
	/** PERSON "<part> x person:<id>": the part moves out of the other person's deepest capsule, along the line between their nearest points. */
	PERSON(X, g) {
		const [, part, id] = /^(\S+) x person:(.+)$/.exec(g.subject) ?? [], mine = capsule(part), p0 = X.out?.ctx?.scene?.people?.[id];
		if (!mine || !p0) return null;
		const f = g.worstFrame, { s } = X.fr(f), pts = segPoints(s.P[X.I[mine[1]]], s.P[X.I[mine[2]]]);
		const near = ([other, C, D, q]) => {
			const cd = sub(D, C), dd = Math.max(dot(cd, cd), 1e-12);
			return pts.map(p => { const at = add(C, scale(cd, clamp(dot(sub(p, C), cd) / dd, 0, 1))); return { other, p, q: at, depth: mine[3] + q - len(sub(p, at)) }; })
				.reduce((m, x) => (x.depth > m.depth ? x : m));
		};
		const hit = personCapsules(p0, f).map(near).reduce((m, x) => (x.depth > m.depth ? x : m));
		const away = len(sub(hit.p, hit.q)) > 1e-6 ? norm(sub(hit.p, hit.q)) : norm([hit.p[0] - hit.q[0] || 1, 0, hit.p[2] - hit.q[2]]);
		const r = moveHint(X, part, f, scale(away, g.worst - g.limit + MARGIN), ` (out of ${p0.name}'s ${hit.other})`);
		return { ...r, hint: `${r.hint}; or, for a touch you mean, checks.allow [{ part: "${part}", object: "person:${id}", depth: ${m3(g.worst + MARGIN)} }]` };
	},
	CLEARANCE(X, g) {
		const k = (X.spec.checks?.clearance ?? []).find(c => g.subject.startsWith(`${c.name}:`));
		return k && boxHint(X, g, k.part, k.object, k.min - g.worst + MARGIN);
	},
	GROUND(X, g) {
		const k = g.subject.startsWith("Left") ? "l" : "r", f = g.worstFrame, c = X.fr(f).c, fold = X.fr(f).diag[`leg_fold_${k}`];
		// the knee on its stop left the ankle under its target (compiler/limbs.js): raising the foot folds it further, the root comes up
		if (fold) return kneeFoldHint(X, k, f, kneeWhy("the sole is in the floor because the knee is on its stop: ", fold), c[`foot_${k}`]);
		const pitch = c[`fpitch_${k}`] ? `, or less fpitch_${k} (now ${m3(c[`fpitch_${k}`])} deg; + lifts the heel)` : "";
		return { cause: X.cause(`foot_${k}`, f), hint: `foot_${k}: raise ${m3(g.worst + 0.001)} m at f${f} (foot_* is the ankle; it stands ${ankleY(X.sk)} m above the floor)${pitch}`,
			fix: { channel: `foot_${k}`, f, delta: [0, g.worst + 0.001, 0] } };
	},
	FACE(X, g) {
		const nm = g.subject.replace(/ into head$/, ""), f = g.worstFrame, { s } = X.fr(f);
		const c = bonePoint(s, X.I.Head, X.sk.landmarks.headCentre);
		const p = probes(X, f, nm).reduce((best, q) => (headDepth(X.sk, s, q) > headDepth(X.sk, s, best) ? q : best));
		return towardFrom(X, g, nm, sub(p, c), g.worst - g.limit + MARGIN, "head");
	},
	BODY(X, g) {
		const [, nm, part] = /^(\S+) into (\S+)$/.exec(g.subject) ?? [];
		const cap = capsule(part), f = g.worstFrame, { s } = X.fr(f);
		// an arm on the fitted skin (body-checks.js): the hand target moves out along the skin where it goes deepest;
		// an upper arm or forearm says so, since turning its elbow (elbow_<k>) away from the body may do instead
		const limb = /^(hand|farm|uarm)_([lr])$/.exec(nm ?? ""), body = limb && bodyFor(X.sk);
		if (body) {
			const bone = X.I[`${limb[2] === "l" ? "Left" : "Right"}${{ hand: "Hand", farm: "ForeArm", uarm: "Arm" }[limb[1]]}`], hit = limbDepth(body, X.sk, s, bone);
			const out = hit.p && bodyNormal(body, s, hit.p, body.skip.get(bone));
			if (out) {
				const r = moveHint(X, nm, f, scale(out, g.worst - g.limit + MARGIN), ` (out of the ${part})`);
				if (limb[1] !== "hand") r.hint += `; or turn elbow_${limb[2]} away from the ${part}`;
				return r;
			}
		}
		if (!cap) return null;
		const A = s.P[X.I[cap[1]]], B = s.P[X.I[cap[2]]], ab = sub(B, A);
		const axis = p => add(A, scale(ab, clamp(dot(sub(p, A), ab) / dot(ab, ab), 0, 1)));
		const p = probes(X, f, nm).reduce((best, q) => (len(sub(q, axis(q))) < len(sub(best, axis(best))) ? q : best));
		return towardFrom(X, g, nm, sub(p, axis(p)), g.worst - g.limit + MARGIN, "torso");
	},
	SELF(X, g) {
		const f = g.worstFrame, { s } = X.fr(f), P = s.P, I = X.I;
		if (g.subject === "hands overlap") {
			const d = norm(sub(P[I.LeftHand], P[I.RightHand])), need = (g.worst - g.limit + MARGIN) / 2;
			const r = moveHint(X, "hand_l", f, scale(d, need));
			return { cause: r.cause, hint: `${r.hint}; and ${moveHint(X, "hand_r", f, scale(d, -need)).hint}`, fix: moveHint(X, "hand_l", f, scale(d, 2 * need)).fix };
		}
		const shins = g.subject === "shins touch", min = shins ? 0.1 : 0.135;
		const [a, b] = shins ? ["Leg", "Foot"] : ["UpLeg", "Leg"];
		const gap = segDist(P[I[`Left${a}`]], P[I[`Left${b}`]], P[I[`Right${a}`]], P[I[`Right${b}`]]);
		const d = sub(P[I[`Left${b}`]], P[I[`Right${b}`]]); d[1] = 0;
		const need = (min - gap + MARGIN) / 2, dir = norm(d);
		return { cause: X.cause("foot_l", f), hint: `foot_l: move ${vec(scale(dir, need))} m and foot_r ${vec(scale(dir, -need))} m at f${f} (${shins ? "shins" : "thighs"} ${m3(gap)} m apart, need ${min}). Put a knee pole on every sit key: start at x +-0.06 and widen by 0.02 until SELF clears; if KNEE (bends backward) appears, go back one step; the KNEE hint's pole (x 0) is the baseline`,
			fix: { channel: "foot_l", f, delta: scale(dir, 2 * need) } };
	},
	OBJECT(X, g) {
		const [, id, oid] = /^(\S+) into (.+)$/.exec(g.subject) ?? [];
		const ch = X.spec.objects?.[id]?.channel;
		if (!ch) return null;
		const at = f => X.out.baked[ch]?.[f] ?? 0, clean = g.first > 0 ? at(g.first - 1) : at(0);
		return { cause: X.cause(ch, g.worstFrame), hint: `${ch}: keep it within ${m3(clean)} deg (it reaches ${m3(at(g.worstFrame))} at f${g.worstFrame}, ${m3(g.worst)} m into ${oid}), or move ${oid}`,
			fix: { channel: ch, f: g.worstFrame, value: clean } };
	},
	BALANCE(X, g) {
		const f = g.worstFrame;
		if (g.subject === "no foot on the ground") return { cause: X.cause("root", f), hint: `at f${f} lower foot_l or foot_r onto the ground, the floor or the top of an object under it (the ankle stands ${ankleY(X.sk)} m above it), or declare checks.supports for the seat the hips rest on` };
		// the mass-weighted centre of mass toward the support polygon's nearest point, to within limit - 1 cm of it (com.js)
		const b = balanceAt(X.out, Math.max(0, Math.min(X.out.frames.length - 1, f - (X.out.f0 ?? 0))));
		if (b === "air" || b.margin >= 0) return null;
		const d = -b.margin, keep = Math.min(d, Math.max(0, (g.limit ?? 0.08) - 0.01)), t = (d - keep) / d;
		const delta = [(b.near[0] - b.com[0]) * t, 0, (b.near[1] - b.com[2]) * t];
		return { cause: X.cause("root", f), hint: `root: move ${vec(delta)} m at f${f} (centre of mass ${offsetWords(b)}, toward the nearest edge of the support polygon), or step a foot under it`, fix: { channel: "root", f, delta } };
	},
};
