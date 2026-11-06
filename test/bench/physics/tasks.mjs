// The ten task conditions of the physical motion bench (docs/qa/physics-bench.md, PR 3; plan 2.2), on top of the
// shared definitions (checks.mjs). Each task answers [{ name, pass, value }]; value is the measured number or a note.
// Starting values, diagnostic only.
import { DEF, PALMS, STAND_HIPS, airborneSpans, balanceFails, capsuleDepth, dist, elbowAngle, footDown, gravityCheck, sd, sk, slide, spans, standing } from "./checks.mjs";

const I = sk.index, G = DEF.g, FPS = 24;
const r3 = v => (Number.isFinite(v) ? Math.round(v * 1000) / 1000 : v);
const c = (name, pass, value) => ({ name, pass: Boolean(pass), value: typeof value === "number" ? r3(value) : value });
const hips = (m, f) => m.frames[f].s.P[I.Hips];
const near = (m, f, name, id) => { const s = m.frames[f].surfaces.find(x => x.id === id); return s ? sd(m.frames[f].L[name], s) : Infinity; };
const first = (m, pred, from = 0) => { for (let f = from; f < m.F; f++) if (pred(f)) return f; return -1; };
const range = (a, b) => Array.from({ length: Math.max(0, b - a + 1) }, (_, i) => a + i);
const moved = (m, id, f, tol = 0.01) => dist(m.frames[f].surfaces.find(s => s.id === id).c, m.frames[0].surfaces.find(s => s.id === id).c) > tol;
const endStanding = m => c("standing at the end", standing(m, m.F - 1), r3(hips(m, m.F - 1)[1]));
const hSpeed = (m, f) => { const a = hips(m, Math.max(0, f - 1)), b = hips(m, Math.min(m.F - 1, f + 1)); return Math.hypot(b[0] - a[0], b[2] - a[2]) * FPS / (Math.min(m.F - 1, f + 1) - Math.max(0, f - 1) || 1); };
const touches = (m, f, names, where) => names.some(n => m.frames[f].touch[n] === where);
const FEET = ["heel_l", "ball_l", "toe_tip_l", "heel_r", "ball_r", "toe_tip_r"];

function muscleUp(m) {
	const tips = ["palm_l", "palm_r", ...["thumb", "index", "middle", "ring", "pinky"].flatMap(t => [`${t}_tip_l`, `${t}_tip_r`])];
	const deepest = Math.min(...range(0, m.F - 1).flatMap(f => tips.map(t => near(m, f, t, "bar"))));
	const inside = c("hands never 1 cm inside the bar", deepest >= -0.01, deepest);
	const grip = first(m, f => PALMS.every(p => near(m, f, p, "bar") <= 0.04));
	if (grip < 0) return [c("both hands reach the bar", false, "never"), inside];
	const out = [c("both hands reach the bar", true, grip), inside];
	out.push(c("hands stay on the bar to the end", range(grip, m.F - 1).every(f => PALMS.every(p => near(m, f, p, "bar") <= 0.04)), grip));
	const along = Math.max(...PALMS.map(p => { const xs = range(grip, m.F - 1).map(f => m.frames[f].L[p][0]); return Math.max(...xs) - Math.min(...xs); }));
	out.push(c("grip slides 3 cm or less along the bar", along <= 0.03, along));
	out.push(c("feet never touch the floor after hanging", !range(grip, m.F - 1).some(f => touches(m, f, FEET, "floor")), null));
	const jumps = airborneSpans(m).filter(([, b]) => b < grip).map(sp => gravityCheck(m, sp));
	out.push(c("the jump to the bar passes the gravity check", jumps.length > 0 && jumps.every(j => j.pass), jumps.length ? Math.max(...jumps.map(j => j.error)) : "no airborne span"));
	const bar = m.frames[m.F - 1].surfaces.find(s => s.id === "bar").c[1], f = m.F - 1;
	const shoulders = Math.min(m.frames[f].s.P[I.LeftArm][1], m.frames[f].s.P[I.RightArm][1]) - bar;
	out.push(c("shoulders 0.25 m above the bar at the end", shoulders >= 0.25, shoulders));
	out.push(c("elbows straight (160° or more) at the end", Math.min(elbowAngle(m, f, "l"), elbowAngle(m, f, "r")) >= 160, Math.min(elbowAngle(m, f, "l"), elbowAngle(m, f, "r"))));
	return out;
}

function handstand(m) {
	const up = f => { const fr = m.frames[f]; return fr.L.head_top[1] <= fr.L.hips[1] - 0.4 && Math.min(fr.L.toe_tip_l[1], fr.L.toe_tip_r[1]) >= fr.L.head_top[1] + 1.0; };
	const best = spans(m.F, up).sort((a, b) => b[1] - b[0] - (a[1] - a[0]))[0];
	const n = best ? best[1] - best[0] + 1 : 0, out = [c("upside down for 72 frames", n >= 72, n)];
	if (best) {
		const hand = k => k.startsWith("palm_") || /^(thumb|index|middle|ring|pinky)_tip_/.test(k), others = Object.keys(m.frames[0].L).filter(k => !hand(k));
		out.push(c("only the hands touch the floor then", range(...best).every(f => !touches(m, f, others, "floor")), null));
		out.push(c("hands slide 2 cm or less", slide(m, PALMS, ...best).slide <= DEF.slide, slide(m, PALMS, ...best).slide));
		out.push(c("balanced over the hands", balanceFails(m, range(...best)).length === 0, balanceFails(m, range(...best)).length));
	}
	out.push(endStanding(m));
	return out;
}

function forwardRolls(m) {
	let total = 0, prev = null;
	const turns = [];
	for (let f = 0; f < m.F; f++) {
		const P = m.frames[f].s.P, v = [P[I.Spine2][1] - P[I.Hips][1], P[I.Spine2][2] - P[I.Hips][2]], a = Math.atan2(v[1], v[0]);
		if (prev !== null) { let d = a - prev; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; total += d; }
		prev = a;
		turns.push((total * 180) / Math.PI);
	}
	const deg = turns.at(-1), out = [c("trunk turns forward 720° (±60)", Math.abs(deg - 720) <= 60, deg)];
	for (const k of [0, 1]) {
		const fs = range(0, m.F - 1).filter(f => turns[f] >= 360 * k && turns[f] < 360 * (k + 1) && turns[f] > 30 + 360 * k);
		const air = fs.filter(f => Object.values(m.frames[f].touch).every(t => t === null)).length;
		out.push(c(`roll ${k + 1}: airborne 4 frames or fewer`, fs.length > 0 && air <= 4, air));
		out.push(c(`roll ${k + 1}: the spine touches the floor`, fs.some(f => touches(m, f, ["spine_1", "spine_2", "spine_3", "buttocks"], "floor")), null));
		out.push(c(`roll ${k + 1}: head top on the floor 3 frames or fewer`, fs.filter(f => m.frames[f].touch.head_top === "floor").length <= 3, fs.filter(f => m.frames[f].touch.head_top === "floor").length));
	}
	const ahead = hips(m, m.F - 1)[2] - hips(m, 0)[2];
	return [...out, endStanding(m), c("ends 1.5 m further along +Z", ahead >= 1.5, ahead)];
}

function armyCrawl(m) {
	const under = range(0, m.F - 1).filter(f => hips(m, f)[2] >= 1.0 && hips(m, f)[2] <= 4.0);
	const touchNet = under.filter(f => capsuleDepth(m, f, ["net"]).depth > 0 || Object.values(m.frames[f].touch).includes("net")).length;
	const onsets = names => { let n = 0; for (const f of under) if (touches(m, f, names, "floor") && !touches(m, f - 1, names, "floor")) n++; return n; };
	return [
		c("never touches the net while under it", under.length > 0 && touchNet === 0, under.length ? touchNet : "never under the net"),
		c("elbows plant 4 times or more under the net", onsets(["elbow_l", "elbow_r"]) >= 4, onsets(["elbow_l", "elbow_r"])),
		c("knees plant 4 times or more under the net", onsets(["knee_l", "knee_r"]) >= 4, onsets(["knee_l", "knee_r"])),
		c("planted elbows and knees slide 2 cm or less", slide(m, ["elbow_l", "elbow_r", "knee_l", "knee_r"]).slide <= DEF.slide, slide(m, ["elbow_l", "elbow_r", "knee_l", "knee_r"]).slide),
		c("hips come out past z = 4.3", hips(m, m.F - 1)[2] > 4.3, hips(m, m.F - 1)[2]),
	];
}

function wallClimb(m) {
	const holds = m.frames[0].surfaces.filter(s => s.id.startsWith("hold-")).map(s => s.id), limbs = ["palm_l", "palm_r", ["ball_l", "toe_tip_l"], ["ball_r", "toe_tip_r"]].map(x => [].concat(x));
	const onHold = (f, names) => names.some(n => holds.includes(m.frames[f].touch[n]));
	const top = f => m.frames[f].surfaces.find(s => s.id === "wall"), topY = top(0).c[1] + top(0).half[1];
	const done = first(m, f => ["l", "r"].every(k => footDown(m.frames[f], k, "wall")) && Math.min(m.frames[f].L.heel_l[1], m.frames[f].L.heel_r[1]) >= topY - 0.05);
	const start = first(m, f => !touches(m, f, FEET, "floor"));
	const on = start < 0 ? [] : range(start, done < 0 ? m.F - 1 : done - 1);
	const counts = on.map(f => limbs.filter(l => onHold(f, l)).length);
	const share = counts.length ? counts.filter(n => n >= 3).length / counts.length : 0;
	const badHand = on.filter(f => PALMS.some(p => m.frames[f].touch[p] === "wall" && Math.min(...holds.map(h => near(m, f, p, h))) > 0.04)).length;
	return [
		c("3 of 4 limbs on holds in 80% of the climb", on.length > 0 && share >= 0.8, share),
		c("never fewer than 2 limbs on holds", on.length > 0 && Math.min(...counts) >= 2, counts.length ? Math.min(...counts) : null),
		c("a hand on the wall is within 4 cm of a hold", badHand === 0, badHand),
		c("hands and feet on holds slide 2 cm or less", slide(m, ["palm_l", "palm_r", "ball_l", "ball_r", "toe_tip_l", "toe_tip_r"], Math.max(0, start), on.at(-1) ?? 0).slide <= DEF.slide, slide(m, ["palm_l", "palm_r", "ball_l", "ball_r", "toe_tip_l", "toe_tip_r"], Math.max(0, start), on.at(-1) ?? 0).slide),
		c("no penetration into the wall or holds", range(0, m.F - 1).every(f => capsuleDepth(m, f, ["wall", ...holds]).depth <= DEF.penetration), Math.max(...range(0, m.F - 1).map(f => capsuleDepth(m, f, ["wall", ...holds]).depth))),
		c("both feet stand on top at the end", done >= 0 && ["l", "r"].every(k => footDown(m.frames[m.F - 1], k, "wall")), done),
	];
}

function tripRun(m) {
	const fall = first(m, f => hips(m, f)[1] < STAND_HIPS - 0.25), trip = first(m, f => touches(m, f, ["toe_tip_l", "toe_tip_r", "ball_l", "ball_r"], "root"));
	const runFrames = range(0, (fall < 0 ? m.F : fall) - 1).filter(f => hSpeed(m, f) >= 2.5);
	const runSpan = spans(m.F, f => runFrames.includes(f), 12).find(([a, b]) => airborneSpans(m).some(([x, y]) => x >= a && y <= b));
	let acc = 0;
	if (fall > 0) for (let f = fall; f < Math.min(m.F - 1, fall + 24); f++) acc = Math.max(acc, -(hips(m, f + 1)[1] - 2 * hips(m, f)[1] + hips(m, f - 1)[1]) * FPS * FPS);
	const hand = first(m, f => touches(m, f, PALMS, "floor"), Math.max(0, fall)), face = first(m, f => touches(m, f, ["chest", "head_top"], "floor"), Math.max(0, fall));
	return [
		c("runs: 2.5 m/s for 12 frames with an airborne span", Boolean(runSpan), runFrames.length),
		c("the fall starts after a foot touches the root", trip >= 0 && fall > trip, `touch ${trip}, fall ${fall}`),
		c("hips fall no faster than 1.1 g", fall > 0 && acc <= 1.1 * G, acc / G),
		c("hands reach the floor before the chest or head", hand >= 0 && (face < 0 || hand < face), `hands ${hand}, chest/head ${face}`),
		endStanding(m),
	];
}

function roofFallBack(m) {
	const lastOff = first(m, f => !touches(m, f, FEET, "building") && hips(m, f)[2] < -1.4);
	const back = hips(m, 0)[2] - Math.min(...range(0, Math.max(0, lastOff)).map(f => hips(m, f)[2]));
	const facing = range(0, Math.max(0, lastOff)).every(f => { const R = m.frames[f].s.R[I.Hips], fz = [R[0][2], R[2][2]]; return (Math.atan2(fz[0], fz[1]) * 180) / Math.PI <= 30 && (Math.atan2(fz[0], fz[1]) * 180) / Math.PI >= -30; });
	const land = first(m, f => Object.values(m.frames[f].touch).some(t => t === "floor"), Math.max(0, lastOff));
	const fall = lastOff >= 0 && land > lastOff + 2 ? gravityCheck(m, [lastOff, land - 1]) : null;
	return [
		c("walks backward 1.0 m facing +Z (±30°)", back >= 1.0 && facing, back),
		c("planted feet slide 2 cm or less", slide(m, FEET, 0, Math.max(0, lastOff)).slide <= DEF.slide, slide(m, FEET, 0, Math.max(0, lastOff)).slide),
		c("the fall passes the gravity check", Boolean(fall?.pass), fall ? `error ${r3(fall.error)} m, speed change ${r3(fall.speedChange)} m/s` : "no fall"),
		c("no penetration into the building or the ground", range(0, m.F - 1).every(f => capsuleDepth(m, f, ["building", "floor"]).depth <= DEF.penetration), Math.max(...range(0, m.F - 1).map(f => capsuleDepth(m, f, ["building", "floor"]).depth))),
		c("lying after the impact (hips below 0.5 m)", land >= 0 && hips(m, m.F - 1)[1] < 0.5, hips(m, m.F - 1)[1]),
	];
}

function barbell(m) {
	const parts = ["barbell-bar", "barbell-plate-l", "barbell-plate-r"], bar = f => m.frames[f].surfaces.find(s => s.id === "barbell-bar");
	const grip = first(m, f => PALMS.every(p => near(m, f, p, "barbell-bar") <= 0.04)), move = first(m, f => moved(m, "barbell-bar", f));
	const moving = range(0, m.F - 1).filter(f => moved(m, "barbell-bar", f));
	const overhead = spans(m.F, f => bar(f).c[1] >= m.frames[f].L.head_top[1] + 0.15 && Math.min(elbowAngle(m, f, "l"), elbowAngle(m, f, "r")) >= 160).reduce((n, [a, b]) => Math.max(n, b - a + 1), 0);
	const mass = 60, com = f => { const b = m.frames[f].com, p = bar(f).c; return [0, 1, 2].map(i => (DEF.bodyMass * b[i] + mass * p[i]) / (DEF.bodyMass + mass)); };
	const held = moving.filter(f => PALMS.every(p => near(m, f, p, "barbell-bar") <= 0.04));
	const tilt = Math.max(...range(0, m.F - 1).map(f => { const fr = m.frames[f], l = fr.surfaces.find(s => s.id === "barbell-plate-l").c, r = fr.surfaces.find(s => s.id === "barbell-plate-r").c; return Math.abs(l[1] - r[1]); }));
	const rest = m.frames[m.F - 1].surfaces.find(s => s.id === "barbell-plate-l"), restsOnFloor = Math.abs(rest.c[1] - rest.half[1]) <= 0.02;
	return [
		c("the barbell waits for both hands", move < 0 || (grip >= 0 && move >= grip), `grip ${grip}, moves ${move}`),
		c("both hands within 4 cm of the bar while it moves", moving.every(f => PALMS.every(p => near(m, f, p, "barbell-bar") <= 0.04)), moving.length - held.length),
		c("24 frames overhead with straight elbows", overhead >= 24, overhead),
		c("body + barbell COM over the feet while held", balanceFails(m, held, com, FEET).length === 0, balanceFails(m, held, com, FEET).length),
		c("the barbell never enters the body", range(0, m.F - 1).every(f => capsuleDepth(m, f, parts).depth <= 0), Math.max(...range(0, m.F - 1).map(f => capsuleDepth(m, f, parts).depth))),
		c("bar ends level within 5 cm", tilt <= 0.05, tilt),
		c("the barbell rests on the floor at the end", restsOnFloor, rest.c[1] - rest.half[1]),
	];
}

function gapJump(m) {
	const takeoff = first(m, f => touches(m, f - 1, FEET, "roof-a") && !touches(m, f, FEET, "roof-a") && airborneSpans(m).some(([a]) => a === f), 1);
	const land = first(m, f => touches(m, f, FEET, "roof-b"));
	const speed = takeoff > 0 ? Math.max(...range(Math.max(0, takeoff - 6), takeoff).map(f => hSpeed(m, f))) : 0;
	const lastFoot = takeoff > 0 ? Math.max(...FEET.filter(n => m.frames[takeoff - 1].touch[n] === "roof-a").map(n => m.frames[takeoff - 1].L[n][2])) : -Infinity;
	const flight = airborneSpans(m).find(([a]) => a === takeoff);
	const g = flight ? gravityCheck(m, flight) : null;
	const after = land >= 0 ? range(land, Math.min(m.F - 1, land + 36)).map(f => hips(m, f)[1]) : [];
	const dip = after.length ? hips(m, land)[1] - Math.min(...after) : 0, rise = after.length && after.at(-1) > Math.min(...after) + 0.05;
	return [
		c("4.0 m/s before takeoff", speed >= 4.0, speed),
		c("last planted foot within 0.5 m of the edge", lastFoot >= 5.5, lastFoot),
		c("the flight passes the gravity check", Boolean(g?.pass), g ? `error ${r3(g.error)} m, speed change ${r3(g.speedChange)} m/s` : "no flight"),
		c("lands on roof B", land >= 0 && land > takeoff, land),
		c("absorbs the landing (hips 0.15 m down, then up)", dip >= 0.15 && rise, dip),
		c("no penetration into the roofs", range(0, m.F - 1).every(f => capsuleDepth(m, f, ["roof-a", "roof-b"]).depth <= DEF.penetration), Math.max(...range(0, m.F - 1).map(f => capsuleDepth(m, f, ["roof-a", "roof-b"]).depth))),
	];
}

function pushCrate(m) {
	const crate = f => m.frames[f].surfaces.find(s => s.id === "crate"), face = f => crate(f).c[2] - crate(f).half[2];
	const onFace = f => PALMS.every(p => Math.abs(m.frames[f].L[p][2] - face(f)) <= 0.03 && near(m, f, p, "crate") <= 0.03);
	const touch = first(m, f => PALMS.every(p => near(m, f, p, "crate") <= 0.03)), move = first(m, f => moved(m, "crate", f));
	const moving = range(1, m.F - 1).filter(f => dist(crate(f).c, crate(f - 1).c) > 0.001);
	const pushing = moving.filter(onFace), share = moving.length ? pushing.length / moving.length : 0;
	const release = pushing.length ? pushing.at(-1) : -1, drift = release >= 0 ? dist(crate(m.F - 1).c, crate(release).c) : 0;
	const lean = f => { const P = m.frames[f].s.P, v = [P[I.Spine2][0] - P[I.Hips][0], P[I.Spine2][1] - P[I.Hips][1], P[I.Spine2][2] - P[I.Hips][2]]; return (Math.acos(v[1] / Math.hypot(...v)) * 180) / Math.PI; };
	const ahead = pushing.filter(f => m.frames[f].com[2] > Math.max(...FEET.filter(n => m.frames[f].touch[n] === "floor").map(n => m.frames[f].L[n][2]), -Infinity) && lean(f) >= 20).length;
	const travel = crate(m.F - 1).c[2] - crate(0).c[2];
	return [
		c("the crate waits for both hands", move < 0 || (touch >= 0 && move >= touch), `touch ${touch}, moves ${move}`),
		c("both hands on the pushed face in 90% of the moving frames", share >= 0.9, share),
		c("the crate stops within 5 cm after the hands let go", drift <= 0.05, drift),
		c("leans into it: COM ahead of the feet, trunk 20° forward", pushing.length > 0 && ahead / pushing.length >= 0.9, pushing.length ? ahead / pushing.length : 0),
		c("the crate moves 3 m (±0.3)", Math.abs(travel - 3) <= 0.3, travel),
		c("planted feet slide 2 cm or less", slide(m, FEET).slide <= DEF.slide, slide(m, FEET).slide),
	];
}

export const TASKS = { 1: muscleUp, 2: handstand, 3: forwardRolls, 4: armyCrawl, 5: wallClimb, 6: tripRun, 7: roofFallBack, 8: barbell, 9: gapJump, 10: pushCrate };
