#!/usr/bin/env node
// v4 measure: penetration, contacts, balance, limits and speed tables, the text and the tool, on
// fixtures built as world poses, turned into local quats (toLocal), played back by takeOut (fk) with
// the diag/c lines the track's out() adds. Static scene objects only, so no track component is needed.
import { skeletonFor } from "../../src/motion3/rigs/index.js";
import { restState, toLocal, rotateSubtree } from "../../src/motion3/compiler/skeleton.js";
import { takeOut } from "../../src/motion3/physics-frames.js";
import { axisRot, sub, add, dot, norm } from "../../src/motion3/compiler/math.js";
import { bodyProbes } from "../../src/motion-v4/measure/probes.js";
import { penetrationRows } from "../../src/motion-v4/measure/penetration.js";
import { contactRuns } from "../../src/motion-v4/measure/contacts.js";
import { balanceRows } from "../../src/motion-v4/measure/balance.js";
import { limitRows, speedPeaks } from "../../src/motion-v4/measure/limits.js";
import { measureTake, measureText } from "../../src/motion-v4/measure/index.js";
import { createMeasureTool } from "../../bin/agent/v4/measure-tool.mjs";

let failures = 0;
function expect(name, condition, detail = "") {
	console.log(`${condition ? "PASS" : "FAIL"} ${name}${condition ? "" : ` — ${detail}`}`);
	if (!condition) failures += 1;
}
const near = (a, b, tol) => Math.abs(a - b) <= tol;

const sk = skeletonFor("y-bot-tpose"), I = sk.index, B = sk.names.length;
const base = { rot: 0, rotX: 0, rotZ: 0, path: null, attach: null, hidden: false, color: "#9e9e9e", footprint: { width: 1, depth: 1 }, height: 1, supportY: 1 };
// A box record centred at c with size sz (records sit on their base pivot).
const crate = (id, c, sz) => ({ ...base, id, name: id, renderer: "cube", x: c[0], y: c[1] - sz[1] / 2, z: c[2], scaleX: sz[0], scaleY: sz[1], scaleZ: sz[2], parent: null });

function outOf(states, records = []) {
	const F = states.length, rot = new Float32Array(F * B * 4), hips = new Float32Array(F * 3);
	states.forEach((s, f) => {
		const l = toLocal(sk, s);
		l.quats.forEach((q, b) => rot.set(q, (f * B + b) * 4));
		hips.set(l.hips, f * 3);
	});
	const take = { schema: "cozyclay.take.v3", fps: 24, frameCount: F, rig: "y-bot-tpose", bones: sk.names.slice(), rot, hips, objects: {},
		placement: { position: [0, 0, 0], yaw: 0 }, spec: { schema: "cozyclay.motion-spec.v1", fps: 24, frames: F } };
	const out = takeOut(take, records);
	for (const fr of out.frames) { fr.diag = {}; fr.c = {}; }
	return out;
}
const moved = (s, d) => ({ P: s.P.map(p => add(p, d)), R: s.R });
function turned(s, bone, axis, deg) {
	const b = I[bone];
	rotateSubtree(sk, s, b, s.P[b].slice(), axisRot(axis, deg));
	return s;
}
const frames = (n, make) => Array.from({ length: n }, (_, f) => make(f));
const DEG = 180 / Math.PI;
const foldOf = (s, a, m, e) => Math.acos(dot(norm(sub(s.P[I[m]], s.P[I[a]])), norm(sub(s.P[I[e]], s.P[I[m]])))) * DEG;

// 1. Rest pose standing on the floor.
{
	const out = outOf(frames(24, () => restState(sk)));
	const d = measureTake(out, {}), t = d.tables;
	expect("1 rest: no penetration row", t.penetration.rows.length === 0, JSON.stringify(t.penetration.rows.slice(0, 3)));
	const whole = end => t.contacts.runs.some(r => r.end === end && r.against === "floor" && r.from === 0 && r.to === 23);
	expect("1 rest: heel and ball runs of both feet on the floor for the whole range", ["heel_l", "ball_l", "heel_r", "ball_r"].every(whole),
		JSON.stringify(t.contacts.runs));
	expect("1 rest: planted feet do not slide", t.contacts.runs.every(r => r.slide < 0.001), JSON.stringify(t.contacts.runs));
	expect("1 rest: COM margin > 0 on every row, support feet", t.balance.rows.every(r => r.margin > 0 && r.support.join() === "feet") && t.balance.outside.length === 0,
		JSON.stringify(t.balance.rows[0]));
	expect("1 rest: no limit run", t.limits.runs.length === 0, JSON.stringify(t.limits.runs));
	expect("1 rest: no speed peak", t.speed.peaks.length === 0, JSON.stringify(t.speed.peaks));
	const probes = bodyProbes(sk, out.frames[0].s), skin = bodyProbes(sk, out.frames[0].s, { skin: true });
	expect("1 rest: probes name every part; skin adds points", ["head", "sole_l", "tips_r", "palm_l", "hand_r", "shin_l"].every(p => probes.some(q => q.part === p)) && skin.length > probes.length + 10000,
		`${probes.length} / ${skin.length}`);
}

// 2. The whole body 10 cm lower, legs unchanged.
{
	const out = outOf(frames(6, () => moved(restState(sk), [0, -0.1, 0])));
	const p = penetrationRows(out, {}), worst = part => p.worstByPart.find(w => w.part === part && w.against === "floor");
	const sole = [worst("sole_l"), worst("sole_r")], shin = [worst("shin_l"), worst("shin_r")];
	console.log(`  sink: sole ${sole.map(w => w?.depth).join(", ")} m, shin ${shin.map(w => w?.depth).join(", ")} m`);
	expect("2 sink: sole floor depth 0.10 +- 0.01 m on both feet", sole.every(w => w && near(w.depth, 0.1, 0.01)), JSON.stringify(sole));
	// The shin probes end at the ankle (0.105 m up at rest) with radius 0.05, so the shin reads 0.10 - 0.055 = 0.045 m.
	expect("2 sink: shin floor rows, depth 0.045 +- 0.01 m (radius 0.05 at the ankle)", shin.every(w => w && near(w.depth, 0.045, 0.01) && w.frames === 6), JSON.stringify(shin));
	expect("2 sink: worst surface is the floor", p.worstBySurface[0]?.against === "floor" && p.worstBySurface.length === 1, JSON.stringify(p.worstBySurface));
	const skin = measureTake(out, { skin: true, from: 0, to: 1, what: ["penetration"] }), sw = skin.tables.penetration.worstByPart.find(w => w.part === "foot_l");
	console.log(`  skin (2 frames): ${skin.ms} ms, foot_l ${sw?.depth} m`);
	expect("2 sink: skin points read the foot skin under the floor", sw && sw.depth > 0.08 && sw.depth < 0.12, JSON.stringify(sw));
}

// 3. The right arm swung forward into a box.
{
	const swing = s => turned(s, "RightArm", [0, 1, 0], 90);
	const hand = swing(restState(sk)).P[I.RightHand];
	const records = [crate("crate", hand, [0.2, 0.2, 0.2])];
	const out = outOf([restState(sk), restState(sk), swing(restState(sk)), swing(restState(sk))], records);
	const { rows } = penetrationRows(out, {});
	const hit = rows.filter(r => r.against === "crate");
	expect("3 arm in box: hand_r or farm_r rows name the box", hit.some(r => r.part === "hand_r") && hit.some(r => r.part === "farm_r") && hit.every(r => r.f >= 2),
		JSON.stringify(hit.map(r => [r.f, r.part, r.depth])));
	const only = penetrationRows(out, { against: new Set(["crate"]), parts: new Set(["farm_r"]) }).rows;
	expect("3 arm in box: parts and against filter the rows", only.length === 2 && only.every(r => r.part === "farm_r" && r.against === "crate"), JSON.stringify(only));
	const c = contactRuns(out, {}).runs.find(r => r.end === "palm_r" && r.against === "crate");
	expect("3 arm in box: palm_r contact run with the box from f2, gap below 0", c && c.from === 2 && c.to === 3 && c.minGap < 0, JSON.stringify(c));
}

// 4. The body slides 5 cm over 10 frames with the feet on the floor; then it stands on a box top.
{
	const x = f => 0.005 * Math.max(0, Math.min(10, f - 4));
	const out = outOf(frames(20, f => moved(restState(sk), [x(f), 0, 0])));
	const runs = contactRuns(out, {}).runs, heel = runs.find(r => r.end === "heel_l" && r.against === "floor");
	console.log(`  slide: heel_l ${heel?.slide} m over f${heel?.from}-f${heel?.to}`);
	expect("4 slide: heel_l run whole range, slide 0.05 +- 0.005 m", heel && heel.from === 0 && heel.to === 19 && near(heel.slide, 0.05, 0.005), JSON.stringify(heel));
	const top = outOf(frames(4, () => moved(restState(sk), [0, 0.3, 0])), [crate("step", [0, 0.15, 0], [0.6, 0.3, 0.6])]);
	const on = contactRuns(top, {}).runs, b = balanceRows(top, {});
	expect("4 box top: heel runs against the box, none against the floor", on.some(r => r.end === "heel_l" && r.against === "step") && !on.some(r => r.against === "floor"), JSON.stringify(on));
	expect("4 box top: balance stands on the box (feet, margin > 0)", b.rows.every(r => r.support.join() === "feet" && r.margin > 0), JSON.stringify(b.rows[0]));
	const air = balanceRows(outOf(frames(3, () => moved(restState(sk), [0, 0.5, 0]))), {});
	expect("4 air: no support, margin null", air.rows.every(r => r.support.join() === "air" && r.margin === null), JSON.stringify(air.rows[0]));
	const lean = balanceRows(outOf(frames(5, f => turned(restState(sk), "Spine", [1, 0, 0], f < 2 ? 0 : -60))), {});
	expect("4 lean back 60: COM outside the feet on f2-f4", lean.outside.length === 1 && lean.outside[0].from === 2 && lean.outside[0].to === 4 && lean.outside[0].worstMargin < 0,
		JSON.stringify(lean.outside));
	// A platform that carries the body 5 cm: the slide is read in the platform's frame, so ~0.
	const ride = outOf(frames(20, f => moved(restState(sk), [x(f), 0.3, 0])), [crate("plat", [0, 0.15, 0], [0.6, 0.3, 0.6])]);
	const plat = ride.objectsAt(0).plat, boxes = frames(20, f => ({ plat: { ...plat, pos: [plat.pos[0] + x(f), plat.pos[1], plat.pos[2]] } }));
	const rideRuns = contactRuns({ ...ride, objectsAt: f => boxes[f] }, {}).runs, rh = rideRuns.find(r => r.end === "heel_l" && r.against === "plat");
	expect("4 moving platform: heel_l on it the whole range, slide in its frame ~0", rh && rh.from === 0 && rh.to === 19 && rh.slide < 0.001, JSON.stringify(rh));
}

// 5. Joint limits: knee folded to 170 degrees, bent backward, elbow both ways, wrist, neck.
{
	const knee = restState(sk);
	let deg = 170;
	for (let k = 0; k < 3; k++) { const s = turned(restState(sk), "LeftLeg", [1, 0, 0], deg); deg += 170 - foldOf(s, "LeftUpLeg", "LeftLeg", "LeftFoot"); }
	turned(knee, "LeftLeg", [1, 0, 0], deg);
	const fold = foldOf(knee, "LeftUpLeg", "LeftLeg", "LeftFoot");
	const runs = limitRows(outOf([restState(sk), knee, knee, restState(sk)]), {}).runs, k = runs.find(r => r.joint === "knee_l");
	console.log(`  knee: fold ${fold.toFixed(2)} deg, run ${JSON.stringify(k)}`);
	expect("5 knee 170: knee_l run f1-f2, past near 10", k && k.from === 1 && k.to === 2 && near(k.past, 10, 0.5) && k.limit === 160, JSON.stringify(runs));
	expect("5 knee 170: no backward-knee run", !runs.some(r => r.joint === "knee_l_back"), JSON.stringify(runs));
	const back = limitRows(outOf([turned(restState(sk), "LeftLeg", [1, 0, 0], -20)]), {}).runs.find(r => r.joint === "knee_l_back");
	expect("5 knee bent backward 20: knee_l_back run, past near 15", back && near(back.past, 15, 3), JSON.stringify(back));
	// The left elbow's hinge at rest is world -Y: a turn about it swings the forearm forward (+Z).
	const fwd = limitRows(outOf([turned(restState(sk), "LeftForeArm", [0, -1, 0], 90)]), {}).runs;
	expect("5 elbow bent forward 90: no elbow run", !fwd.some(r => r.joint.startsWith("elbow_l")), JSON.stringify(fwd));
	const elbowBack = limitRows(outOf([turned(restState(sk), "LeftForeArm", [0, -1, 0], -30)]), {}).runs.find(r => r.joint === "elbow_l_back");
	expect("5 elbow bent backward 30: elbow_l_back run, past near 25", elbowBack && near(elbowBack.past, 25, 3), JSON.stringify(elbowBack));
	// The right side mirrors it: the right elbow's hinge is world +Y, the knees' +X.
	const right = s => limitRows(outOf([s]), {}).runs.map(r => r.joint).join();
	const rFwd = right(turned(turned(restState(sk), "RightForeArm", [0, 1, 0], 90), "RightLeg", [1, 0, 0], 90));
	const rBack = right(turned(turned(restState(sk), "RightForeArm", [0, 1, 0], -30), "RightLeg", [1, 0, 0], -20));
	expect("5 right side: normal bends pass, backward bends are flagged", rFwd === "" && rBack.split(",").sort().join() === "elbow_r_back,knee_r_back", `${rFwd} | ${rBack}`);
	const rest = restState(sk);
	const l = norm(sub(rest.P[I.LeftHandIndex1], rest.P[I.LeftHandPinky1]));
	const wrist = limitRows(outOf([turned(restState(sk), "LeftHand", l, 90)]), {}).runs.find(r => r.joint === "wrist_l_flex");
	expect("5 wrist turned 90 about the palm's side axis: wrist_l_flex run past near 20", wrist && near(Math.abs(wrist.angle), 90, 8) && near(wrist.past, 20, 8), JSON.stringify(wrist));
	const neck = limitRows(outOf([turned(restState(sk), "Neck", [1, 0, 0], 70)]), {}).runs.find(r => r.joint === "neck");
	expect("5 neck bent 70: neck run", neck && neck.angle > 60, JSON.stringify(neck));
}

// 6. The right forearm turned 90 degrees about its own axis in one frame.
{
	const axis = s => sub(s.P[I.RightHand], s.P[I.RightForeArm]);
	const out = outOf(frames(20, f => { const s = restState(sk); return f < 10 ? s : turned(s, "RightForeArm", axis(s), 90); }));
	const { peaks, linear } = speedPeaks(out, {}), p = peaks.find(x => x.bone === "RightForeArm");
	console.log(`  speed: ${JSON.stringify(p)}`);
	expect("6 forearm 90 deg in one frame: peak near 2160 deg/s at f10", p && near(p.speed, 2160, 10) && p.f === 10 && p.from === 10 && p.to === 10 && p.limit === 1200, JSON.stringify(peaks));
	expect("6 forearm: no other bone peaks", peaks.length === 1, JSON.stringify(peaks));
	expect("6 still body: hips and COM speed peaks near 0", linear.hips.speed.every(x => x.v < 1e-6) && linear.com.speed.length > 0 && linear.com.speed.every(x => x.v < 0.01), JSON.stringify(linear));
	const hop = speedPeaks(outOf(frames(12, f => moved(restState(sk), [0, f === 6 ? 0.1 : 0, 0]))), {}).linear.hips;
	expect("6 one-frame hop: hips accel peak at f6 (0.2 m / frame^2 = 115.2 m/s^2)", hop.accel[0]?.f === 6 && near(hop.accel[0].a, 115.2, 0.5), JSON.stringify(hop));
}

// 7. 240 frames, all tables, skin off: speed and the text budget.
{
	const records = [crate("crate", [0.0, 0.5, 0.45], [0.5, 1, 0.3]), crate("bench", [0.8, 0.25, 0], [0.6, 0.5, 0.6])];
	const states = frames(240, f => {
		const t = f / 240, a = 50 * Math.sin(Math.PI * t * 4) ** 2, s = restState(sk);
		for (const S of ["Left", "Right"]) { turned(s, `${S}UpLeg`, [1, 0, 0], -a); turned(s, `${S}Leg`, [1, 0, 0], 2 * a); }
		turned(s, "RightArm", [0, 0, 1], 70 * Math.sin(2 * Math.PI * t * 12));
		turned(s, "LeftForeArm", [0, -1, 0], f % 40 < 20 ? 160 : 0);
		return moved(s, [0.002 * f, -0.12 * a / 50, 0]);
	});
	const out = outOf(states, records);
	const t0 = performance.now(), data = measureTake(out, { skin: false }), ms = performance.now() - t0;
	const text = measureText(data), wide = measureText(data, 200);
	const t = data.tables, counts = `penetration ${t.penetration.rows.length}, contacts ${t.contacts.runs.length}, balance ${t.balance.rows.length}, limits ${t.limits.runs.length}, speed ${t.speed.peaks.length}`;
	console.log(`  240 frames, all tables: ${ms.toFixed(0)} ms (${counts}); text ${text.length} chars, maxRows 200 ${wide.length} chars`);
	expect("7 240 frames all tables under 1.5 s", ms < 1500, `${ms} ms`);
	expect("7 text under 6,000 chars, maxRows 200 too", text.length <= 6000 && wide.length <= 6000, `${text.length} / ${wide.length}`);
	expect("7 text: one header per table and the more line", ["penetration:", "contacts:", "balance:", "limits:", "speed:"].every(h => text.includes(`\n${h}`)) && /\.\.\. \d+ more \(call from js for all rows\)/.test(text), text.slice(0, 400));
	expect("7 every table has rows on this take", t.penetration.rows.length > 20 && t.contacts.runs.length > 0 && t.limits.runs.length > 0 && t.speed.peaks.length > 0, counts);
	const worst = text.split("\n").find(line => /^\d+\t\w+\t\w+\t[\d.]+\t/.test(line));
	expect("7 penetration rows come worst first", worst && worst.split("\t")[3] === Math.max(...t.penetration.rows.map(r => r.depth)).toFixed(3), worst);
	const stepped = measureTake(out, { what: ["balance"], step: 6, from: 12, to: 60 });
	expect("7 step and range: balance every 6 frames from f12", stepped.tables.balance.rows.map(r => r.f).join() === "12,18,24,30,36,42,48,54,60" && Object.keys(stepped.tables).join() === "balance",
		stepped.tables.balance.rows.map(r => r.f).join());
}

// 8. The tool: no track, bad arguments, direct and js calls.
{
	const none = createMeasureTool({ track: { out: async () => null } });
	const noTrack = await none.run({}, { from: "model" }).then(() => "resolved", e => e.message);
	expect("8 tool: no track throws the set-first message", noTrack === "No track yet: call track set first.", noTrack);
	const out = outOf(frames(24, () => moved(restState(sk), [0, -0.05, 0])));
	const tool = createMeasureTool({ track: { out: async () => out } });
	const props = Object.keys(tool.inputSchema.properties).join();
	expect("8 tool: name, schema and description", tool.name === "measure" && tool.inputSchema.additionalProperties === false && props === "from,to,step,what,parts,against,skin,tolerance,maxRows"
		&& tool.description.length <= 2000, `${props} ${tool.description.length}`);
	const r = await tool.run({ what: ["penetration", "contacts"], maxRows: 3 }, { from: "model" });
	expect("8 tool: data has only the asked tables, text has their headers", Object.keys(r.data.tables).join() === "penetration,contacts" && r.text.includes("penetration:") && r.text.includes("contacts:") && !r.isError,
		r.text.slice(0, 300));
	expect("8 tool: maxRows caps the text rows", r.text.split("\n").filter(line => /^\d+\t/.test(line)).length <= 3 && r.text.includes("more (call from js"), r.text);
	const js = await tool.run({ what: ["penetration"] }, { from: "js" });
	expect("8 tool: a js call gets every row", js.data.tables.penetration.rows.length === r.data.tables.penetration.rows.length && js.data.tables.penetration.rows.length > 3, String(js.data.tables.penetration.rows.length));
	const bad = async args => tool.run(args, { from: "js" }).then(() => "resolved", e => e.message);
	const msgs = await Promise.all([bad({ parts: ["nose"] }), bad({ against: ["table"] }), bad({ from: 30 }), bad({ from: 10, to: 5 }), bad({ what: ["bogus"] }), bad({ frm: 1 }), bad({ step: 0 }), bad({ tolerance: 1 }), bad({ maxRows: 0 })]);
	expect("8 tool: bad arguments throw clear messages", /unknown parts nose\. Valid: .*sole_l/.test(msgs[0]) && /unknown against table\. Valid: floor/.test(msgs[1]) && /from must be an integer from 0 to 23/.test(msgs[2])
		&& /from 10 is after to 5/.test(msgs[3]) && /unknown what bogus/.test(msgs[4]) && /unknown argument frm/.test(msgs[5]) && /step must be/.test(msgs[6]) && /tolerance/.test(msgs[7]) && /maxRows/.test(msgs[8]), msgs.join(" | "));
	const clipped = await tool.run({ to: 500, what: ["limits"] }, { from: "js" });
	expect("8 tool: to past the end is clamped", clipped.data.range.join() === "0,23", clipped.data.range.join());
}

if (failures) { console.error(`${failures} v4 measure check(s) failed`); process.exit(1); }
console.log("v4 measure: all checks passed");
