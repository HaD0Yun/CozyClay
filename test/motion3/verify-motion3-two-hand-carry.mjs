#!/usr/bin/env node
// A box carried in both hands (A/B T2, 2026-11-03): the Agent pane put the left hand on the box by an object anchor
// with w_ keys and no fit, so only the wrist went to the point and the hand kept its own turn; the GOAL hint moved
// the point 10.8 cm into the 30 cm box, and after 15 compiles the left hand was still 0.147 m off it. Now:
//   - the hint for a hand on a bare object anchor names reachGrip on that anchor, and drops a move that would put the
//     point inside the body (qa/hints-contact.js)
//   - the documented carry holds the box the way a person does (docs/motion3-agent-guide.md): each palm on its lower
//     side face, the fingers under the bottom edge (fingers hook), the box against the chest through the walk. The
//     first recipe (2026-11-04) passed QA with the palms 2.2 cm off the faces and one hand's fingers 3.3 cm in the
//     box: the grasp checks skipped a palm grasp, whose relaxed fingers do not count as closed. A palm grasp now
//     closes the fingers flat on the face, so qa/grasp-checks.js judges it.
//   - the hands let go of the box on the shelf without a bounce and without passing through the box or the shelf;
//     reachGrip keeps an arm's IK weight through its release when the spec's own keys take the arm again right after
//   - grasp "support" holds the same box with no hand numbers in the spec: the compiler picks each hand's side face,
//     puts the palm low on it from the box's size and the rig's hand, the fingers round the bottom edge as far as the
//     wrist turns comfortably, presses the sides while the box rests on the table, rolls the hold round the edge on the
//     lift onto the shelf and takes the fingers out from under before it lands (sockets.js, compiler/anchors.js supportAt)
//   - a support hold slides the palm down the face at the lift without a jump, and before a box lands from hanging arms
//     (a floor set-down) raises it until the straight fingers stand clear of the floor (fixtures/support-floor.json)
import { readFileSync } from "node:fs";
import { compileSpec } from "../../src/motion3/pipeline.js";
import { motionScene } from "../../src/motion3/scene.js";
import { skeletonFor } from "../../src/motion3/rigs/index.js";
import { objectPoseAt } from "../../src/motion3/object-pose.js";
import { sdBox, CAPSULES, segPoints } from "../../src/motion3/qa/geometry.js";
import { palmAxes, palmPoint } from "../../src/motion3/compiler/limbs.js";
import { GRASP_POINTS } from "../../src/motion3/compiler/vocab.js";

let failures = 0;
function expect(name, condition, detail = "") {
	console.log(`${condition ? "PASS" : "FAIL"} ${name}${condition ? "" : ` - ${detail}`}`);
	if (!condition) failures += 1;
}

const { objects, agent, reference } = JSON.parse(readFileSync(new URL("./fixtures/ab-t2-box.json", import.meta.url), "utf8"));
const sk = skeletonFor("x-bot-tpose"), scene = motionScene(objects), I = sk.index;
const BOX = "cube-3", half = scene.objects[BOX].half, CARRY = [180, 280]; // the walk with the box, after the turn on the spot starts

// the agent's spec: the left wrist on a bare object anchor (boxL, no fit)
const a = compileSpec(agent, { sk, scene });
const left = a.qa.groups.find(g => g.kind === "GOAL" && g.subject.startsWith("left hand on box"));
expect("agent spec: the left hand misses the box (goal left hand on box)", left && left.worst > 0.05, JSON.stringify(left));
expect("agent spec: the hint names reachGrip on boxL for the left hand", /reachGrip \{ anchor: "boxL", side: "l" \}/.test(left?.hint ?? ""), left?.hint);
expect("agent spec: the hint says the anchor has no fit, so only the wrist is on it", /anchor boxL has no fit, so w_boxL_l puts only the left wrist on its point/.test(left?.hint ?? ""), left?.hint);
expect("agent spec: the hint does not move the point into the box", !/: move \[/.test(left?.hint ?? "") && new RegExp(`inside ${BOX}`).test(left?.hint ?? ""), left?.hint);
// its first compiles asked for grasp palm on the same anchors: the hint says the grasp needs a fit
const grasped = structuredClone(agent);
for (const name of ["boxL", "boxR"]) grasped.anchors[name].grasp = "palm";
const gl = compileSpec(grasped, { sk, scene }).qa.groups.find(g => g.kind === "GOAL" && g.subject.startsWith("left hand on box"));
expect("agent spec with grasp palm: the hint says the grasp turns the hand only through a fit and names reachGrip", /grasp palm turns the hand only through a fit/.test(gl?.hint ?? "") && /reachGrip \{ anchor: "boxL", side: "l" \}/.test(gl?.hint ?? ""), gl?.hint);

/** Per carry frame: each hand's palm skin to its face (cm, the palm grasp's point), the palm's turn off that face (deg),
 * its fingertips under the bottom (of 4), its deepest phalanx skin in the box (cm), and the box to the torso (cm). */
function holdOf(r, [from, to]) {
	const o = r.out, f0 = o.f0 ?? 0, torso = CAPSULES.filter(c => c[0].startsWith("torso_")), rows = [];
	for (let f = from; f <= to; f++) {
		const s = o.frames[f - f0].s, P = objectPoseAt(o, BOX, f), box = { ...P, half }, centre = P.pos.map((v, i) => v + P.R[i][1] * half[1]);
		const local = p => [0, 1, 2].map(j => [0, 1, 2].reduce((acc, i) => acc + (p[i] - centre[i]) * P.R[i][j], 0));
		const body = Math.min(...torso.flatMap(([, j0, j1, rad]) => segPoints(s.P[I[j0]], s.P[I[j1]]).map(p => sdBox(p, box) - rad)));
		const row = { body: body * 100 };
		for (const [k, S] of [["l", "Left"], ["r", "Right"]]) {
			const J = n => s.P[I[`${S}Hand${n}`]], { d, l, n } = palmAxes(sk, s, S), palm = k === "l" ? n : n.map(v => -v);
			const mid = J("Index2").map((v, i) => (v + J("Middle2")[i]) / 2), [pd, pl, pn] = GRASP_POINTS.palm;
			const skin = mid.map((v, i) => v + d[i] * pd + l[i] * pl + palm[i] * pn), at = local(skin);
			const side = Math.sign(at[0]), inward = [0, 1, 2].map(i => -side * P.R[i][0]);
			const under = ["Index", "Middle", "Ring", "Pinky"].filter(x => { const q = local(J(`${x}4`)), dy = q[1] + half[1]; return dy > -0.025 && dy < 0.006 && Math.abs(q[0]) < half[0] && Math.abs(q[2]) < half[2]; }).length;
			let pen = 0;
			for (const x of ["Index", "Middle", "Ring", "Pinky", "Thumb"]) for (let i = 1; i <= 3; i++) for (const p of segPoints(J(`${x}${i}`), J(`${x}${i + 1}`), 5)) pen = Math.max(pen, 0.009 - sdBox(p, box));
			row[k] = { up: (at[1] + half[1]) * 100, face: (Math.abs(at[0]) - half[0]) * 100, turn: Math.acos(Math.min(1, palm.reduce((acc, v, i) => acc + v * inward[i], 0))) * 180 / Math.PI, under, pen: pen * 100, onSide: side === (k === "l" ? 1 : -1) };
		}
		rows.push(row);
	}
	return rows;
}
const share = (rows, ok) => rows.filter(ok).length / rows.length, median = xs => [...xs].sort((x, y) => x - y)[Math.floor(xs.length / 2)];

// the documented carry on the same walk
const r = compileSpec(reference, { sk, scene }), rows = holdOf(r, CARRY);
const goals = r.qa.goals ?? [];
expect(`reference: every goal holds (${goals.filter(g => g.ok).length}/${goals.length})`, goals.length === 7 && goals.every(g => g.ok), JSON.stringify(goals.filter(g => !g.ok)));
expect("reference: both hands go on by reachGrip (a fit on boxL and on boxR)", ["l:boxL", "r:boxR"].every(x => (r.expanded.fits ?? []).some(f => `${f.side}:${f.anchor}` === x)), JSON.stringify(r.expanded.fits));
for (const k of ["l", "r"]) {
	const hand = k === "l" ? "left" : "right", hs = rows.map(x => x[k]);
	expect(`reference: the ${hand} palm is on its own side face, within 1 cm, every carry frame`, hs.every(h => h.onSide && Math.abs(h.face) <= 1), JSON.stringify(hs.find(h => !(h.onSide && Math.abs(h.face) <= 1))));
	expect(`reference: the ${hand} palm faces the box square (within 15 deg), every carry frame`, hs.every(h => h.turn <= 15), Math.max(...hs.map(h => h.turn)).toFixed(1));
	expect(`reference: the ${hand} fingers are under the bottom edge (3 of 4 tips, ${Math.round(share(hs, h => h.under >= 3) * 100)}% of carry frames)`, share(hs, h => h.under >= 3) >= 0.7, "");
	expect(`reference: no ${hand} phalanx deeper than 0.5 cm in the box (deepest ${Math.max(...hs.map(h => h.pen)).toFixed(2)} cm)`, hs.every(h => h.pen <= 0.5), "");
}
const gaps = rows.map(x => x.body);
expect(`reference: the box rides against the chest (median gap ${median(gaps).toFixed(1)} cm, closest ${Math.min(...gaps).toFixed(1)} cm)`, median(gaps) <= 3 && Math.min(...gaps) >= -1, "");
expect(`reference: fewer QA problems than the agent's spec (${a.qa.problems} -> ${r.qa.problems})`, r.qa.problems < a.qa.problems, `${a.qa.problems} -> ${r.qa.problems}`);
expect("reference: no hint says a hand's anchor has no fit", !r.qa.groups.some(g => /has no fit/.test(g.hint ?? "")), r.qa.groups.filter(g => /has no fit/.test(g.hint ?? "")).map(g => g.subject).join("; "));
// the hands let go of the box on the shelf: reachGrip's release keys armw 0 at its end for an arm it took from its
// keyed pose (skills/basic.js), so the return keys after it dropped the arms 35 cm, raised them 33 cm at 3.9 m/s and
// dropped them again, a finger 2.5 cm in the shelf (2026-11-05); armw keyed 1 at the release end lets the hands open
// out and back (the return anchors wide and above the shelf, so the turning hand clears the box and the shelf)
const letGo = Math.max(...reference.use.filter(u => u.skill === "reachGrip").map(u => u.f0 + u.args.reach + u.args.hold));
const after = (() => {
	const o = r.out, f0 = o.f0 ?? 0, ids = Object.keys(scene.objects), out = { bounce: {}, pen: { cm: 0 } };
	for (const S of ["Left", "Right"]) {
		const ys = [];
		for (let f = letGo; f < f0 + o.frames.length; f++) ys.push(o.frames[f - f0].s.P[I[`${S}Hand`]][1]);
		let low = ys[0], rise = 0;
		for (const y of ys) { if (y < low) low = y; if (ys[0] - low > 0.1) rise = Math.max(rise, y - low); }
		out.bounce[S] = rise * 100;
	}
	for (let f = letGo; f < f0 + o.frames.length; f++) {
		const s = o.frames[f - f0].s, boxes = ids.map(id => ({ id, ...objectPoseAt(o, id, f), half: scene.objects[id].half }));
		for (const S of ["Left", "Right"]) for (const x of ["Index", "Middle", "Ring", "Pinky", "Thumb"]) for (let i = 1; i <= 3; i++)
			for (const p of segPoints(s.P[I[`${S}Hand${x}${i}`]], s.P[I[`${S}Hand${x}${i + 1}`]], 4)) for (const b of boxes) { const d = (0.009 - sdBox(p, b)) * 100; if (d > out.pen.cm) out.pen = { cm: d, f, id: b.id, at: `${S}${x}${i}` }; }
	}
	return out;
})();
// (a hanging arm swings up to 3 cm through the step back after it)
expect(`reference: once a hand drops 10 cm after letting go (f${letGo}) it does not rise again (left ${after.bounce.Left.toFixed(1)} cm, right ${after.bounce.Right.toFixed(1)} cm)`, Object.values(after.bounce).every(cm => cm <= 5), JSON.stringify(after.bounce));
expect(`reference: after letting go no phalanx goes 1 cm into the box or the shelf (deepest ${after.pen.cm.toFixed(1)} cm)`, after.pen.cm <= 1, JSON.stringify(after.pen));

// the first recipe's return keys (no armw at the release end, the return anchors at [+-0.22, 0.2, 0.22]) bounced 33 cm:
// reachGrip now keeps the arm's IK weight through the release when the spec's own key takes the arm within 12 frames
const firstReturn = structuredClone(reference);
firstReturn.anchors.retL.p = [0.22, 0.2, 0.22];
firstReturn.anchors.retR.p = [-0.22, 0.2, 0.22];
for (const ch of ["armw_l", "armw_r"]) delete firstReturn.keys.find(k => k.f === 370).set[ch];
const fr = compileSpec(firstReturn, { sk, scene }).out, rises = ["Left", "Right"].map(S => {
	const ys = [];
	for (let f = letGo; f < (fr.f0 ?? 0) + fr.frames.length; f++) ys.push(fr.frames[f - (fr.f0 ?? 0)].s.P[I[`${S}Hand`]][1]);
	let low = ys[0], rise = 0;
	for (const y of ys) { if (y < low) low = y; if (ys[0] - low > 0.1) rise = Math.max(rise, y - low); }
	return rise * 100;
});
expect(`the first recipe's return keys no longer bounce after the release (rise ${rises.map(v => v.toFixed(1)).join(" / ")} cm, was 32.9)`, rises.every(cm => cm <= 5), JSON.stringify(rises));

// grasp "support": the same take with no hand numbers, each hand placed by the compiler
const support = structuredClone(reference);
for (const name of ["boxL", "boxR"]) support.anchors[name] = { kind: "object", object: BOX, grasp: "support" };
for (const u of support.use.filter(u => u.skill === "reachGrip")) delete u.args.fingers;
const sr = compileSpec(support, { sk, scene }), sgoals = sr.qa.goals ?? [], walk = holdOf(sr, CARRY), sk2 = sr.qa.groups.map(g => g.kind);
expect(`support: every goal holds (${sgoals.filter(g => g.ok).length}/${sgoals.length})`, sgoals.length === 7 && sgoals.every(g => g.ok), JSON.stringify(sgoals.filter(g => !g.ok)));
for (const k of ["l", "r"]) {
	const hand = k === "l" ? "left" : "right", hs = walk.map(x => x[k]);
	expect(`support: the ${hand} palm on its own side face within 1 cm, square within 15 deg, every walk frame`, hs.every(h => h.onSide && Math.abs(h.face) <= 1 && h.turn <= 15), JSON.stringify(hs.find(h => !(h.onSide && Math.abs(h.face) <= 1 && h.turn <= 15))));
	expect(`support: the ${hand} fingers under the bottom (3 of 4 tips) every walk frame, palm ${Math.min(...hs.map(h => h.up)).toFixed(1)}-${Math.max(...hs.map(h => h.up)).toFixed(1)} cm up`, hs.every(h => h.under >= 3), JSON.stringify(hs.find(h => h.under < 3)));
	expect(`support: no ${hand} phalanx deeper than 0.5 cm in the box on the walk (deepest ${Math.max(...hs.map(h => h.pen)).toFixed(2)} cm)`, hs.every(h => h.pen <= 0.5), "");
}
const lift = holdOf(sr, [300, 348]), liftUnder = share(lift, x => x.l.under >= 3 && x.r.under >= 3);
expect(`support: on the lift onto the shelf both hands keep 3 of 4 tips under the bottom (${Math.round(liftUnder * 100)}% of f300-348; the palm-grasp recipe had 0-1)`, liftUnder >= 0.7, "");
const rest = holdOf(sr, [156, 158]);
expect(`support: while the box rests on the table the palms press the sides, fingers out from under it (palms ${Math.min(...rest.flatMap(x => [x.l.up, x.r.up])).toFixed(1)} cm up or more, tips under ${Math.max(...rest.flatMap(x => [x.l.under, x.r.under]))})`, rest.every(x => x.l.up >= 10 && x.r.up >= 10 && x.l.under === 0 && x.r.under === 0), JSON.stringify(rest));
expect(`support: no wrist at its limit, no elbow flip, no palm off, no hand into the shelf (${[...new Set(sk2)].join(" ")})`, !sk2.some(x => ["WRIST", "FLIP", "PALM_OFF"].includes(x)) && !sr.qa.groups.some(g => g.kind === "COLLIDE" && /x cube-4/.test(g.subject)), sr.qa.groups.filter(g => ["WRIST", "FLIP", "PALM_OFF"].includes(g.kind) || /x cube-4/.test(g.subject)).map(g => `${g.kind} ${g.subject}`).join("; "));
const pens = sr.qa.groups.filter(g => g.kind === "FINGER_PEN");
expect(`support: no finger deeper than 1.2 cm in the box (deepest ${Math.max(0, ...pens.map(g => g.worst * 100)).toFixed(1)} cm)`, pens.every(g => g.worst <= 0.012), pens.map(g => `${g.subject} ${g.worst}`).join("; "));
const pops = sr.qa.groups.filter(g => g.kind === "POP");
expect(`support: no arm jumps more than 10 cm/f^2 in a frame (worst ${Math.max(0, ...pops.map(g => g.worst * 100)).toFixed(1)})`, pops.every(g => g.worst <= 0.1), pops.map(g => `${g.subject} ${g.worst}`).join("; "));
/** The palm point of a support hold (limbs.js palmPoint, off the knuckles) over the bottom of `box` on `out` at f, m. */
const palmUp = (out, box, S, f) => {
	const s = out.frames[f - (out.f0 ?? 0)].s, J = n => s.P[I[`${S}Hand${n}`]], ax = palmAxes(sk, s, S), pp = palmPoint(sk, S, "support"), P = objectPoseAt(out, box, f);
	const p = [0, 1, 2].map(i => (J("Index1")[i] + J("Middle1")[i]) / 2 + ax.d[i] * pp[0] + ax.l[i] * pp[1] + ax.n[i] * pp[2]);
	return [0, 1, 2].reduce((acc, i) => acc + (p[i] - P.pos[i]) * P.R[i][1], 0);
};
// the lift off the table: the palm slides down the face as the bottom clears it, never in a jump (switched to the set-down
// rule at 3 cm clear, the palm target fell from 12.3 to 2.7 cm up the face in a frame and the hand 5.5 cm, f160-161)
const steps = Array.from({ length: 20 }, (_, i) => 150 + i).map(f => Math.max(...["Left", "Right"].map(S => Math.abs(palmUp(sr.out, BOX, S, f + 1) - palmUp(sr.out, BOX, S, f)) * 100)));
expect(`support: at the lift the palm slides down the face by at most 3.5 cm a frame (worst ${Math.max(...steps).toFixed(1)} cm, f150-170)`, Math.max(...steps) <= 3.5, steps.map(v => v.toFixed(1)).join(" "));
console.log(`  support: QA ${sr.qa.problems} problems (${sk2.join(", ")})`);

// a box set down on the floor from a squat (bench S10's box scene, fixtures/support-floor.json): there the hanging hands
// point the fingers straight down the face, and the palm rises before the box lands until their tips stand clear of the
// floor (rising only by the hook's depth, the tips went 1.2 cm into it, f296-300)
const floor = JSON.parse(readFileSync(new URL("./fixtures/support-floor.json", import.meta.url), "utf8"));
const fl = compileSpec(floor.spec, { sk, scene: motionScene(floor.objects) }), fgrip = floor.spec.use.filter(u => u.skill === "reachGrip"), flo = fl.out;
const [ffrom, fto] = [Math.min(...fgrip.map(u => u.f0 + u.args.reach)), Math.max(...fgrip.map(u => u.f0 + u.args.reach + u.args.hold + u.args.release))];
// over the floor, or over the box's bottom where the box itself goes below the floor: the retime that stretches the
// set-down warps the box's keys 4.1 cm under their floor height (f296-297; 0.9 cm without it), which moves the hands with it
const tips = Array.from({ length: fto - ffrom + 1 }, (_, i) => ffrom + i).map(f => {
	const base = Math.min(0, objectPoseAt(flo, floor.box, f).pos[1]), y = Math.min(...["Left", "Right"].flatMap(S => ["Thumb", "Index", "Middle", "Ring", "Pinky"].map(x => flo.frames[f - (flo.f0 ?? 0)].s.P[I[`${S}Hand${x}4`]][1])));
	return { f, over: y - base, base };
});
const lowest = tips.reduce((m, x) => (x.over < m.over ? x : m)), sunk = tips.reduce((m, x) => (x.base < m.base ? x : m));
const fgoals = fl.qa.goals ?? [], landed = tips.filter(x => objectPoseAt(flo, floor.box, x.f).pos[1] < 0.001);
expect(`support, floor set-down: every fingertip joint stays 0.5 cm or more over the floor (or the box's bottom, where lower) from the grip to the let-go (lowest ${(lowest.over * 100).toFixed(1)} cm at f${lowest.f}; box on the floor f${landed[0]?.f}-${landed.at(-1)?.f}, its bottom down to ${(sunk.base * 100).toFixed(1)} cm at f${sunk.f})`,
	lowest.over >= 0.005 && landed.length > 0, "");
expect(`support, floor set-down: every goal holds (${fgoals.filter(g => g.ok).length}/${fgoals.length}), no palm off the box`, fgoals.length > 0 && fgoals.every(g => g.ok) && !fl.qa.groups.some(g => g.kind === "PALM_OFF"), JSON.stringify(fgoals.filter(g => !g.ok)));

// a support hold's let-go clears what the box was set on by itself (compiler/anchors.js letGoOff, skills/basic.js): the
// agents write no return keys, and the hands dropped from the box sides through the shelf (t2s3 5.0 cm at f317, t2s1 1.3)
/** The deepest phalanx skin (cm) of either hand in body `id`, frames [a, b], and where. */
function phalanxIn(out, id, half, [a, b]) {
	let worst = { cm: -Infinity };
	for (let f = a; f <= b; f++) {
		const s = out.frames[f - (out.f0 ?? 0)].s, P = objectPoseAt(out, id, f), box = { ...P, half };
		for (const S of ["Left", "Right"]) for (const x of ["Index", "Middle", "Ring", "Pinky", "Thumb"]) for (let i = 1; i <= 3; i++)
			for (const p of segPoints(s.P[I[`${S}Hand${x}${i}`]], s.P[I[`${S}Hand${x}${i + 1}`]], 5)) { const cm = (0.009 - sdBox(p, box)) * 100; if (cm > worst.cm) worst = { cm, f, at: `${S}${x}${i}` }; }
	}
	return worst;
}
const letGoCases = [];
{
	const t2s3 = JSON.parse(readFileSync(new URL("./fixtures/support-letgo-t2s3.json", import.meta.url), "utf8")), sc = motionScene(t2s3.objects);
	letGoCases.push({ name: "agent run t2s3 (Y Bot)", spec: t2s3.spec, sk: skeletonFor(t2s3.rig), scene: sc, shelf: "cube-3" });
	const noret = structuredClone(support), end = Math.max(...noret.use.filter(u => u.skill === "reachGrip").map(u => u.f0 + u.args.reach + u.args.hold));
	for (const name of Object.keys(noret.anchors)) if (noret.anchors[name].kind === "body") delete noret.anchors[name];
	noret.keys = noret.keys.map(k => ({ ...k, set: Object.fromEntries(Object.entries(k.set).filter(([c]) => !/^w_ret/.test(c) && !(k.f >= end && /^armw_/.test(c)))) })).filter(k => Object.keys(k.set).length);
	letGoCases.push({ name: "the T2 support take without its return keys", spec: noret, sk, scene, shelf: "cube-4" });
}
for (const c of letGoCases) {
	const r = compileSpec(c.spec, { sk: c.sk, scene: c.scene }), grips = c.spec.use.filter(u => u.skill === "reachGrip");
	const end = Math.max(...grips.map(u => u.f0 + u.args.reach + u.args.hold)), rel = Math.max(...grips.map(u => u.f0 + u.args.reach + u.args.hold + (u.args.release ?? 12)));
	const win = [end - 6, Math.min(r.out.frames.length - 1 + (r.out.f0 ?? 0), rel + 20)], w = phalanxIn(r.out, c.shelf, c.scene.objects[c.shelf].half, win);
	const pops = r.qa.groups.filter(g => g.kind === "POP" && g.last >= end && /Hand|ForeArm/.test(g.subject));
	expect(`support, let-go with no return keys (${c.name}): no finger 0.5 cm into the shelf f${win[0]}-${win[1]} (deepest ${w.cm.toFixed(2)} cm ${w.at} f${w.f}), no hand or forearm POP after the hold`, w.cm <= 0.5 && !pops.length, pops.map(g => g.subject).join("; "));
}

// the first recipe's hover is caught now: palms 2.2 cm off the faces, the fingers flat (a palm grasp's own)
const hover = structuredClone(reference);
for (const [name, x] of [["boxL", 0.172], ["boxR", -0.172]]) hover.anchors[name].local = [x, 0.15, 0];
for (const u of hover.use.filter(u => u.skill === "reachGrip")) delete u.args.fingers;
const off = compileSpec(hover, { sk, scene }).qa.groups.filter(g => g.kind === "PALM_OFF");
expect("palms 2.2 cm off the faces, the fingertips on them: the grasp checks report each palm off the box (PALM_OFF)", ["left", "right"].every(s => off.some(g => g.subject === `${s} palm off ${BOX}`)), off.map(g => g.subject).join("; "));
expect("PALM_OFF's hint moves the hand onto the box", off.every(g => /the palm onto cube-3/.test(g.hint ?? "")), off.map(g => g.hint).join(" | "));
expect("the documented carry raises no PALM_OFF", !r.qa.groups.some(g => g.kind === "PALM_OFF"), r.qa.groups.filter(g => g.kind === "PALM_OFF").map(g => `${g.subject} ${g.worst} f${g.worstFrame}`).join("; "));
// a grip on a palm grasp, the anchor 0.8 cm off the face (A/B rerun t2h3): the palm ended 4 cm off with QA 0, the
// palm point read off the finger middles, which the grip curls 2.9 cm toward the palm. The palm grasp's point is the
// palm's own now (limbs.js palmPoint): the grip leaves the palm where the anchor puts it
const grip = structuredClone(reference);
for (const [name, x] of [["boxL", 0.158], ["boxR", -0.158]]) grip.anchors[name].local = [x, 0.15, -0.06];
for (const u of grip.use.filter(u => u.skill === "reachGrip")) u.args.fingers = "grip";
const gripped = compileSpec(grip, { sk, scene }).qa.groups.filter(g => g.kind === "PALM_OFF");
expect("a grip on a palm grasp (t2h3) keeps the palm within 1.2 cm of the face", gripped.every(g => g.worst <= 0.012), gripped.map(g => `${g.subject} ${g.worst}`).join("; "));
// PALM_OFF reports a palm hold however far its palm is: an anchor 4 cm off the face (past the reach check's 3 cm)
const far4 = structuredClone(reference);
for (const [name, x] of [["boxL", 0.19], ["boxR", -0.19]]) far4.anchors[name].local = [x, 0.15, -0.06];
const far = compileSpec(far4, { sk, scene }).qa.groups.filter(g => g.kind === "PALM_OFF");
expect("an anchor 4 cm off the face: PALM_OFF on both hands, over 3 cm", ["left", "right"].every(s => far.some(g => g.subject === `${s} palm off ${BOX}` && g.worst > 0.03)), far.map(g => `${g.subject} ${g.worst}`).join("; "));
console.log(`  agent ${a.qa.problems} problems (left hand ${left?.worst} m off at f${left?.worstFrame}); reference ${r.qa.problems} problems, goals ${goals.filter(g => g.ok).length}/${goals.length}`);

if (failures) { console.error(`${failures} failed`); process.exit(1); }
console.log("all passed");
