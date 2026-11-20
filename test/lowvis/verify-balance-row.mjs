#!/usr/bin/env node
// The balance row (src/lowvis/pi/balance.mjs, the studio variant's flag "balance") says only what the clip shows. Over
// random bodies at rest and in motion (lean, bow, twist, hipTurn, hip, a lifted foot, kneel, sit on a prop and with a
// height, hands and an elbow on a static prop; scales 0.5 to 2; blends and holds of every length), random bodies that
// stay in place while a pose of theirs repeats (every repeatable pose word, sizes and periods, on two feet, one foot,
// kneeling, sitting, lying, a hand on a prop that does or does not move, a prop held), bodies that really move (gaits,
// a lunge, back and side steps, a change of posture, a fast swing, a tilt in progress) and fixed cases (a hand on a prop
// that moves, on another body, a held prop, tilts, two bodies listed both ways), every told line is read as the writer
// reads it and each of its numbers is computed again here from the clip and the build's aux, by this file's own
// arithmetic: the centre of mass from the segment shares, the rest frames from the ankles' and the centre of mass's
// steps and the frames on which the engine's body layer moves the pelvis or a foot, the supports from the planted feet,
// the soles that are down and the spec's words, the distance outside them by the support function of the points (the
// most p lies past them over 720 directions, then 400 about the best), the side from the pelvis's axes. A body this
// file finds over the limit on a frame at rest is told; one it does not, is not. Scenes and specs are made here.
// LOWVIS_BALANCE_N=<random cases> runs more (default 40), LOWVIS_BALANCE_SEED=<n> other ones.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serializeClip } from "../../src/lowvis/clip.js";
import { buildClip } from "../../src/lowvis/engine-simple/engine.js";
import { buildBodySized } from "../../src/lowvis/engine-simple/size.js";
import { createCompileTool } from "../../src/lowvis/pi/compile-tool.mjs";
import { systemPrompt } from "../../src/lowvis/pi/prompt.mjs";
import { INDEX as J, JOINT_COUNT, REST, TIPS, qRotate } from "../../src/lowvis/rig17.js";

const N = +(process.env.LOWVIS_BALANCE_N ?? 40), TMP = mkdtempSync(join(tmpdir(), "lowvis-balance-"));
let seed = +(process.env.LOWVIS_BALANCE_SEED ?? 20261120);
const rnd = () => { seed = (seed + 0x6D2B79F5) >>> 0; let t = seed; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const pick = a => a[Math.floor(rnd() * a.length)], range = (a, b) => a + (b - a) * rnd();
// the limits the manual states (mm at scale 1, frames)
const STILL = 0.002, DRIFT = 0.0038, FRAMES = 12, OUT = 0.03, FOOT = 0.09, HEEL = 0.06, NEAR = 0.1, ON = 0.01;
// shares of the body's mass: [share, a, b, t] with a point a + (b - a) t; "tip:<joint>" is that joint's tip, "mid" the hip joints' middle
const SHARE = [[0.081, "Head", "tip:Head", 0.5], [0.216, "Spine2", "Neck", 0.5], [0.139, "Spine", "Spine2", 0.5], [0.142, "Hips", "mid", 0.5]];
for (const s of ["Left", "Right"]) SHARE.push([0.028, `${s}Arm`, `${s}ForeArm`, 0.436], [0.016, `${s}ForeArm`, `${s}Hand`, 0.43], [0.006, `${s}Hand`, `tip:${s}Hand`, 0.4], [0.1, `${s}UpLeg`, `${s}Leg`, 0.433], [0.0465, `${s}Leg`, `${s}Foot`, 0.433], [0.0145, `${s}Foot`, `tip:${s}Foot`, 0.5]);
assert.ok(Math.abs(SHARE.reduce((n, x) => n + x[0], 0) - 1) < 1e-9, "the shares add up to the whole body");

/** Everything this file recomputes for one body: [{ who, d, f, frames: [..], side, names, held }] of the bodies over the limit. */
function expected(clip, aux, spec, def) {
	const F = clip.frameCount, out = [];
	const statics = clip.props.filter(p => p.pos.length === 3), movers = clip.props.filter(p => p.pos.length > 3), moving = movers.map(p => p.id), ids = clip.characters.map(c => c.id);
	const inv = (q, v) => qRotate([-q[0], -q[1], -q[2], q[3]], v);
	const boxGap = (p, x, f = 0) => { const i = p.pos.length === 3 ? 0 : f, l = inv(p.quat.slice(i * 4, i * 4 + 4), [0, 1, 2].map(k => x[k] - p.pos[i * 3 + k])).map((v, k) => Math.abs(v) - p.size[k] / 2), o = l.map(v => Math.max(v, 0)); return Math.sqrt(o[0] ** 2 + o[1] ** 2 + o[2] ** 2) + Math.min(0, Math.max(...l)); };
	const over = (p, x) => { const l = inv(p.quat, [x[0] - p.pos[0], 0, x[2] - p.pos[2]]); return Math.abs(l[0]) <= p.size[0] / 2 && Math.abs(l[2]) <= p.size[2] / 2; };
	const surf = (x, s) => x[1] <= NEAR * s ? "the floor" : statics.find(p => boxGap(p, x) <= NEAR * s)?.id ?? null;
	for (const c of clip.characters) {
		const s = c.scale ?? 1, P = (f, j) => [0, 1, 2].map(k => c.pos[(f * JOINT_COUNT + j) * 3 + k]), Q = (f, j) => [0, 1, 2, 3].map(k => c.quat[(f * JOINT_COUNT + j) * 4 + k]);
		const pt = (f, n) => { if (n === "mid") { const a = P(f, J.LeftUpLeg), b = P(f, J.RightUpLeg); return [0, 1, 2].map(k => (a[k] + b[k]) / 2); } if (n.startsWith("tip:")) { const j = n.slice(4), o = qRotate(Q(f, J[j]), TIPS[j].map((v, k) => (v - REST[J[j]][k]) * s)); return P(f, J[j]).map((v, k) => v + o[k]); } return P(f, J[n]); };
		const centre = f => { let x = 0, z = 0; for (const [w, a, b, t] of SHARE) { const A = pt(f, a), B = pt(f, b); x += w * (A[0] * (1 - t) + B[0] * t); z += w * (A[2] * (1 - t) + B[2] * t); } return [x, z]; };
		// the sole: from HEEL behind the point under the ankle to the toe tip, FOOT wide; the corners that are down, the lowest first
		const soles = (f, i) => { const j = i ? J.RightFoot : J.LeftFoot, tip = TIPS[i ? "RightFoot" : "LeftFoot"].map((v, k) => v - REST[j][k]), heel = [0, -REST[J.LeftFoot][1], -HEEL], all = [];
			for (const o of [tip, heel]) for (const w of [-FOOT / 2, FOOT / 2]) { const d = qRotate(Q(f, j), [(o[0] + w) * s, o[1] * s, o[2] * s]); all.push(P(f, j).map((v, k) => v + d[k])); }
			const low = Math.min(...all.map(p => p[1])); return all.filter(p => p[1] - low <= 0.02 * s).sort((a, b) => a[1] - b[1]); };
		const acts = (spec[c.id] ?? []).slice().sort((a, b) => a[0] - b[0]), body = new Set(["idle", "walk", "run", "push", "turn", "sit", "stand", "kneel", "lie"]);
		const tiltAt = f => { const tk = acts.filter(a => a[1] === "pose" && a[2]?.tilt !== undefined).findLast(a => a[0] <= f); if (!tk) return false; const t = tk[2].tilt ?? []; return [t[0] ?? 0, t[1] ?? 0, ...(tk[2].shift ?? [])].some(v => Number(v) !== 0 && !Number.isNaN(Number(v))) || f < tk[0] + (tk[2].over ?? 12); };
		// the engine's body layer (before poses and tilt): `moved[f]` when it moves the pelvis's place or turn or a foot from
		// frame f - 1 to f (a step, a turn, a change of posture). A sit, kneel or lie counts on a frame when it is the body
		// action that was running at the last such move before it
		const one = def.characters.find(x => x.id === c.id), props = Object.fromEntries(def.props.map(p => [p.id, { id: p.id, size: p.size, c: p.at, turn: 0 }]));
		const layer = buildBodySized(one, acts, F, { props, ground: () => 0 }, s);
		const where = B => [B.p[0], B.p[2], ...B.q, ...B.feet.flatMap(ft => [ft.a[0], ft.a[2], ...ft.q])];
		const moved = layer.map((B, f) => f > 0 && where(B).some((v, k) => Math.abs(v - where(layer[f - 1])[k]) > 1e-9));
		const bodyActs = acts.filter(a => body.has(a[1])), postureOf = [];
		for (let f = 0, last = 0; f < F; f++) {
			if (moved[f]) last = f;
			const running = bodyActs.filter(a => a[0] <= last).at(-1);
			postureOf[f] = running && ["sit", "kneel", "lie"].includes(running[1]) ? running : null;
		}
		const quietAt = f => {
			for (const g of [f - 1, f + 1]) { // to each neighbouring frame: the ankles, and the centre of mass across the floor
				if (g < 0 || g >= F) continue;
				for (const j of [J.LeftFoot, J.RightFoot]) if (Math.hypot(...P(f, j).map((v, k) => v - P(g, j)[k])) > STILL * s) return false;
				const a = centre(f), b = centre(g); if (Math.hypot(a[0] - b[0], a[1] - b[1]) > DRIFT * Math.sqrt(s)) return false;
			}
			if (moved[f] || moved[f + 1]) return false; // a step or a change of posture on this frame or a neighbouring one
			return !tiltAt(f);
		};
		const quiet = Array.from({ length: F }, (_, f) => quietAt(f)), rest = [];
		for (let f = 0; f < F; f++) { let a = f; while (a > 0 && quiet[a - 1]) a--; let b = f; while (b < F - 1 && quiet[b + 1]) b++; rest.push(quiet[f] && b - a + 1 >= FRAMES); }
		let best = null; const frames = [], byFrame = {};
		for (let f = 0; f < F; f++) {
			if (!rest[f]) continue;
			const posture = postureOf[f] ?? null;
			const pts = [], names = []; let vouch = true;
			// a foot the engine holds planted, or whose sole's lowest corner is within ON of the floor or of a prop that does not move
			[0, 1].forEach(i => {
				const down = soles(f, i), low = down[0], on = low[1] <= ON * s ? "the floor" : statics.find(p => boxGap(p, low) <= ON * s)?.id;
				if (aux.contacts[c.id][f][i]) { pts.push(...down); names.push(`${"LR"[i]} foot planted`); }
				else if (on) { pts.push(...down); names.push(`${"LR"[i]} foot on ${on}`); }
				else if (movers.some(p => boxGap(p, low, f) <= ON * s)) vouch = false;
			});
			const seat = posture?.[2]?.on && clip.props.find(p => p.id === posture[2].on);
			if (seat && moving.includes(seat.id)) vouch = false;
			if (posture?.[1] === "sit") { const l = []; for (const j of [J.LeftUpLeg, J.RightUpLeg]) { const h = P(f, j), k = P(f, j + 1); l.push(h, h.map((v, n) => (v + k[n]) / 2)); } const on = l.filter(x => !seat || over(seat, x)); if (on.length) { pts.push(...on); names.push(seat ? `the seat on ${seat.id}` : "the seat"); } }
			if (posture?.[1] === "kneel") for (const [i, j] of [[0, J.LeftLeg], [1, J.RightLeg]]) if (surf(P(f, j), s)) { pts.push(P(f, j)); names.push(`${"LR"[i]} knee`); }
			if (posture?.[1] === "lie") { const on = Array.from({ length: JOINT_COUNT }, (_, j) => P(f, j)).filter(x => !seat || over(seat, x)); if (on.length) { pts.push(...on); names.push(seat ? `lying on ${seat.id}` : "lying"); } }
			const FIELD = [["L", "hands"], ["R", "hands"], ["footL"], ["footR"], ["elbowL"], ["elbowR"]], NAME = ["L hand", "R hand", "L foot", "R foot", "L elbow", "R elbow"], JOINT = [J.LeftHand, J.RightHand, null, null, J.LeftForeArm, J.RightForeArm];
			for (let i = 0; i < 6; i++) {
				const e = aux.reach[c.id][f]?.[i];
				if (!e || e.d > ON) continue;
				const key = acts.findLast(a => a[0] === e.key && a[1] === "pose" && FIELD[i].some(n => a[2][n] !== undefined)); if (!key) continue;
				const t = FIELD[i].map(n => key[2][n]).find(v => v !== undefined); if (!t || typeof t !== "object") continue;
				const id = Array.isArray(t) ? null : t.on ?? t.prop ?? t.meet ?? t.chest ?? t.of;
				if (id != null && (moving.includes(id) || (ids.includes(id) && id !== c.id))) vouch = false;
				if (!vouch || JOINT[i] == null || (!Array.isArray(t) && t.joint && (!t.of || t.of === c.id))) continue; // a foot is counted by its sole, above
				const on = surf(e.t, s); if (!on) continue;
				pts.push(P(f, JOINT[i])); names.push(`${NAME[i]} on its target on ${on}`);
			}
			if (!vouch || !pts.length) continue;
			// the distance outside the points' hull: the largest u.p - max(u.q) over directions u (the support function)
			const m = centre(f), sup = a => { const u = [Math.cos(a), Math.sin(a)]; return u[0] * m[0] + u[1] * m[1] - Math.max(...pts.map(p => u[0] * p[0] + u[1] * p[2])); };
			let d = -Infinity, ang = 0;
			for (let k = 0; k < 720; k++) { const v = sup(2 * Math.PI * k / 720); if (v > d) { d = v; ang = 2 * Math.PI * k / 720; } }
			for (let k = -200, a0 = ang; k <= 200; k++) { const a = a0 + k * Math.PI / 360 / 200, v = sup(a); if (v > d) { d = v; ang = a; } } // then 0.0025 deg steps about the best
			const dir = [Math.cos(ang), Math.sin(ang)];
			if (d <= OUT * s) continue;
			frames.push(f); byFrame[f] = d;
			if (!best || d > best.d) best = { d, f, dir, names };
		}
		if (!best) continue;
		// the side: left from the hip joints; across them front and back, for a body that lies on its back its head and feet
		// (the pelvis's own up axis, which then lies in the floor plane: the words follow where that axis points)
		const l = P(best.f, J.LeftUpLeg), r = P(best.f, J.RightUpLeg), left = [l[0] - r[0], l[2] - r[2]], n = Math.hypot(...left), fwd = [-left[1] / n, left[0] / n];
		const lies = postureOf[best.f]?.[1] === "lie", up = qRotate(Q(best.f, J.Hips), [0, 1, 0]), headFwd = up[0] * fwd[0] + up[2] * fwd[1] > 0;
		const ang = Math.atan2(best.dir[0] * left[0] / n + best.dir[1] * left[1] / n, best.dir[0] * fwd[0] + best.dir[1] * fwd[1]) * 180 / Math.PI;
		const held = clip.props.filter(p => String(aux.holders[p.id]?.[best.f] ?? "").split("+").some(h => h.split(":")[0] === c.id)).map(p => p.id);
		out.push({ who: c.id, ...best, frames, byFrame, ang, words: lies ? (headFwd ? ["head", "feet"] : ["feet", "head"]) : ["front", "back"], held, s });
	}
	return out;
}

const ROW = /^- at rest: centre of mass outside its supports: ([\d.]+) mm @f(\d+) (\S+) \(toward its ([a-z ]+?); over (\d+) mm on (\d+) frames? at rest \(([^)]*)\); supports at f(\d+): (.*?)(?:; it holds (.*), not weighed and not a support)?\)( \[.*\])?$/;
// the side words: the first axis's ends alone, the second's alone, or both ("front left"; with head or feet "head and left")
const sideOf = (a, [ap, am]) => { const m = Math.abs(a), b = a > 0 ? "left" : "right", x = m < 90 ? ap : am, both = ap === "front" ? `${x} ${b}` : `${x} and ${b}`; return m <= 22.5 ? [ap] : m >= 157.5 ? [am] : m < 67.5 || m > 112.5 ? [both] : [b]; };
const near = (a, lo, hi) => Math.abs(a - lo) < 0.6 || Math.abs(a - hi) < 0.6; // a side at a sector edge may round either way
let told = 0, quietBodies = 0, checked = 0, n = 0;
/** One case: compile with the tool and with buildClip, recompute, compare. */
function check(name, scene, spec, { off = [], expectTold } = {}) {
	const tool = createCompileTool({ name: `b${n}`, outDir: join(TMP, `b${n}`), clipFile: join(TMP, `b${n}.json`), variant: "studio", off });
	const r = tool.call({ scene, spec }); n++;
	assert.equal(r.status, "ok", `${name}: ${r.text}`);
	const lines = r.text.split("\n").filter(l => l.startsWith("- at rest:"));
	if (off.includes("balance")) { assert.equal(lines.length, 0, `${name}: the flag off tells nothing`); return; }
	const def = { ...scene, characters: scene.characters.map(c => ({ ...c })) }, { clip, aux } = buildClip(structuredClone({ ...spec, demo: "x" }), def), parsed = JSON.parse(serializeClip(clip));
	assert.deepEqual(JSON.parse(readFileSync(join(TMP, `b${n - 1}.json`), "utf8")).characters.map(c => c.pos), parsed.characters.map(c => c.pos), `${name}: the tool compiled the same clip`);
	const want = expected(parsed, aux, spec, def);
	if (expectTold !== undefined) assert.equal(want.length > 0, expectTold, `${name}: this file finds ${want.length ? "" : "no "}body over the limit`);
	assert.equal(lines.length, want.length, `${name}: one line per body this file finds over the limit (${want.map(w => w.who)}):\n${lines.join("\n")}`);
	for (const w of want) {
		const line = lines.find(l => l.includes(` ${w.who} (toward`)), m = ROW.exec(line ?? "");
		assert.ok(m, `${name}: the line of ${w.who} reads as the manual says:\n${line}`);
		const [, mm, f, , side, limit, count, spans, sf, names, held] = m;
		assert.ok(Math.abs(+mm - w.d * 1000) < 0.15, `${name}: ${mm} mm against ${(w.d * 1000).toFixed(2)} mm recomputed`);
		assert.ok(+f === w.f || w.d - (w.byFrame[+f] ?? -1) < 1e-4, `${name}: worst frame f${f} against f${w.f} (a tie within 0.1 mm may be either)`);
		assert.equal(+sf, +f, `${name}: the supports are those of the worst frame`);
		assert.equal(+limit, Math.round(OUT * w.s * 1000), `${name}: the limit is 30 mm times the scale`);
		assert.equal(+count, w.frames.length, `${name}: ${count} frames against ${w.frames.length}`);
		const runs = w.frames.reduce((o, x) => { if (o.at(-1)?.[1] === x - 1) o.at(-1)[1] = x; else o.push([x, x]); return o; }, []).map(([a, b]) => (a === b ? `f${a}` : `f${a}-${b}`));
		assert.equal(spans, runs.slice(0, 4).join(", ") + (runs.length > 4 ? ", ..." : ""), `${name}: the spans`);
		assert.ok(sideOf(w.ang, w.words).includes(side) || [22.5, 67.5, 112.5, 157.5].some(e => near(Math.abs(w.ang), e, e)), `${name}: toward its ${side}, recomputed ${w.ang.toFixed(1)} deg from its front`);
		assert.equal(names, w.names.join(", "), `${name}: the supports named`);
		assert.equal(held ?? "", w.held.join(" and "), `${name}: the props it holds`);
		checked++;
	}
	told += want.length; quietBodies += scene.characters.length - want.length;
	return want;
}

try {
	assert.match(systemPrompt("studio"), /- at rest: centre of mass outside its supports: .*told when over 30 mm times its scale/, "the manual states the limit");
	assert.doesNotMatch(systemPrompt("studio", ["balance"]), /centre of mass outside/, "the flag switched off by name takes the line away");
	const table = { id: "table", size: [1.2, 0.75, 0.7], at: [0, 0.375, 0.75] }, bench = { id: "bench", size: [1.4, 0.45, 0.4], at: [0, 0.225, -0.45] };
	const cart = { id: "cart", size: [0.8, 0.8, 0.6], at: [0, 0.4, 0.75], moves: true }, bag = { id: "bag", size: [0.3, 0.4, 0.2], at: [0.35, 0.2, 0.2], moves: true };
	const solo = (spec, props = [], s = 1, frames = 120) => [{ frames, characters: [{ id: "a", at: [0, 0], heading: 30, ...(s === 1 ? {} : { scale: s }) }], props }, { a: spec }];
	check("standing straight", ...solo([[0, "idle"]]), { expectTold: false });
	check("hips 0.3 m to the left", ...solo([[0, "pose", { hip: [0.3, 0, 0], over: 0 }]]), { expectTold: true });
	check("hips 0.3 m to the left, flag off", ...solo([[0, "pose", { hip: [0.3, 0, 0], over: 0 }]]), { off: ["balance"] });
	// the hips snap back over the feet at frame k: frame k - 1 moves to its neighbour, so frames 0 to k - 2 are still
	for (const k of [12, 13, 14]) check(`still for ${k - 1} frames`, ...solo([[0, "pose", { hip: [0.3, 0, 0], over: 0 }], [k, "pose", { hip: [0, 0, 0], over: 0 }]]), { expectTold: k >= 13 });
	// a slow move of the hips that keeps them outside: at rest all along (it was not while the pose blended, before)
	check("hips drifting slowly outside", ...solo([[0, "pose", { hip: [0.3, 0, 0], over: 0 }], [11, "pose", { hip: [0.3, 0, 0.05], over: 100 }]]), { expectTold: true });
	check("hands on a cart that moves", ...solo([[0, "pose", { hands: { on: "cart", at: [0.2, 0.4, -0.2] }, bow: 70, hip: [0, 0, 0.2], over: 20 }]], [cart]), { expectTold: false });
	check("a bag held, leaning", ...solo([[0, "hold", { prop: "bag", hand: "R" }], [10, "pose", { hip: [0, 0, 0.3], over: 20 }]], [bag]), { expectTold: true });
	check("sit on a cart that moves", ...solo([[0, "sit", { on: "cart", over: 20 }]], [{ ...cart, at: [0, 0.4, -0.5] }]), { expectTold: false });
	check("tilted and held", ...solo([[0, "pose", { tilt: [30, 0], about: "feet", over: 0 }]]), { expectTold: false });
	check("tilt in progress", ...solo([[0, "pose", { tilt: [30, 0], about: "feet", over: 119 }]]), { expectTold: false });
	check("walking", ...solo([[0, "walk", { to: [0, 3] }]]), { expectTold: false });
	check("lie on the bench", ...solo([[0, "lie", { on: "bench", head: 90, over: 30 }]], [bench]));
	const box = { id: "box", size: [0.4, 0.4, 0.2], at: [0, 0.2, -0.6] };
	check("lie on a small box, arms past the head", ...solo([[0, "lie", { on: "box", head: 0, over: 30 }], [30, "pose", { L: { world: [0.2, 0.5, 0.5] }, R: { world: [-0.2, 0.5, 0.5] }, over: 10 }]], [box], 1, 100), { expectTold: true });
	check("sit, then a turn that takes no step", ...solo([[0, "sit", { on: "bench", over: 30 }], [50, "turn", { heading: 30 }]], [bench], 1, 100), { expectTold: false });
	check("kneel, bow, a stand that changes nothing", ...solo([[0, "kneel", { over: 20 }], [0, "pose", { bow: 70, over: 20 }], [50, "stand"]], [], 1, 100), { expectTold: true });
	check("a stand at the start, hips left", ...solo([[0, "stand"], [0, "pose", { hip: [0.3, 0, 0], over: 0 }]]), { expectTold: true });
	check("sit, lie, stand, hips left", ...solo([[0, "sit", { height: 0.45, over: 20 }], [30, "lie", { at: [0, -0.8], over: 30 }], [70, "stand", { over: 30 }], [100, "pose", { hip: [0.3, 0, 0], over: 0 }]], [], 1, 160));
	check("a foot the floor stops short", ...solo([[0, "pose", { footL: [0.1, 0, 0.45], hip: [0, 0, 0.2], over: 20 }]]));
	check("a foot aimed at the floor past the leg's reach", ...solo([[0, "pose", { footR: [-0.1, -0.1, 0.8], hip: [0.25, 0, 0], over: 0 }]], [], 1.2), { expectTold: true });
	check("sit, a turn that takes no step, a foot lifted", ...solo([[0, "sit", { on: "bench", over: 20 }], [40, "turn", { heading: 30 }], [55, "pose", { footR: [-0.1, 0.3, 0.4], over: 10 }]], [bench], 1, 130), { expectTold: false });
	check("kneel, then a walk under a tilt, tilt back, hips left", ...solo([[0, "kneel", { over: 20 }], [25, "pose", { tilt: [8, 0], over: 6 }], [35, "walk", { to: [1, 1.5] }], [110, "idle"], [115, "pose", { tilt: [0, 0], over: 6 }], [125, "pose", { hip: [0.3, 0, 0], over: 10 }]], [], 1, 190), { expectTold: true });
	check("a foot down on its toe tip", ...solo([[0, "pose", { footL: { at: [0.1, 0, 0.3], pitch: 35 }, over: 0 }]]), { expectTold: false });
	check("a sit, two walks one frame apart, hips left", ...solo([[0, "sit", { height: 0.45, over: 20 }], [30, "walk", { to: [0, 0.6] }], [31, "walk", { to: [0, 1.2] }], [32, "idle"], [50, "pose", { hip: [0.3, 0, 0], over: 10 }]]), { expectTold: true });
	check("leaning back over the heels", ...solo([[0, "pose", { bow: -40, over: 0 }]]), { expectTold: false });
	check("a gait of 200 frames a step", ...solo([[0, "walk", { to: [0.4, 0.7], steps: 2, stepFrames: 200 }]], [], 1, 460), { expectTold: false });
	for (const tilt of [30, { pitch: 30 }, "30"]) check(`tilt of another form: ${JSON.stringify(tilt)}`, ...solo([[0, "pose", { tilt, over: 0 }]], [], 1, 60));
	check("elbow on a table",...solo([[0, "pose", { elbowR: { on: "table", at: [-0.2, 0.4, -0.2] }, bow: 70, over: 20 }]], [table]));
	const two = order => { const cs = [{ id: "a", at: [0, 0], heading: 0 }, { id: "b", at: [0, 0.7], heading: 180, scale: 1.3 }]; return [{ frames: 100, characters: order ? cs : cs.slice().reverse(), props: [] }, { a: [[0, "pose", { hip: [0.3, 0, 0], over: 0 }]], b: [[0, "pose", { R: { joint: "Spine2", of: "a" }, bow: 50, hip: [0, 0, 0.25], over: 20 }]] }]; };
	check("two bodies", ...two(true)); check("two bodies listed the other way", ...two(false));
	for (let i = 0; i < N; i++) {
		const s = pick([0.5, 0.81, 1, 1.4, 2]), frames = Math.round(range(40, 140)), spec = [], props = [];
		const posture = pick(["stand", "stand", "kneel", "sit", "height"]);
		if (posture === "kneel") spec.push([0, "kneel", { over: Math.round(range(8, 24)) }]);
		if (posture === "sit") { props.push({ ...bench, size: bench.size.map(v => v * s), at: bench.at.map(v => v * s) }); spec.push([0, "sit", { on: "bench", over: Math.round(range(8, 24)) }]); }
		if (posture === "height") spec.push([0, "sit", { height: 0.45 * s, over: Math.round(range(8, 24)) }]);
		const at = Math.round(range(0, 30)), pose = { over: pick([0, 6, 12, 30]) };
		if (rnd() < 0.5) pose.lean = Math.round(range(-40, 60));
		if (rnd() < 0.5) pose.bow = Math.round(range(0, 90));
		if (rnd() < 0.3) pose.twist = Math.round(range(-90, 90));
		if (rnd() < 0.3) pose.hipTurn = Math.round(range(-60, 60));
		if (rnd() < 0.5 && posture === "stand") pose.hip = [range(-0.3, 0.3) * s, range(-0.2, 0) * s, range(-0.3, 0.3) * s];
		if (rnd() < 0.3 && posture === "stand") pose[pick(["footL", "footR"])] = [range(-0.2, 0.2) * s, range(0.1, 0.4) * s, range(-0.3, 0.4) * s];
		if (rnd() < 0.3) { props.push({ ...table, size: table.size.map(v => v * s), at: table.at.map(v => v * s) }); pose.hands = { on: "table", at: [range(-0.4, 0.4) * s, 0.375 * s, -0.2 * s] }; }
		spec.push([at, "pose", pose]);
		if (rnd() < 0.4) spec.push([Math.min(frames - 1, at + Math.round(range(5, 60))), "pose", { hip: [0, 0, 0], lean: 0, bow: 0, over: Math.round(range(4, 40)) }]);
		check(`random ${i} (${posture}, scale ${s}): ${JSON.stringify(spec)}`, ...solo(spec, props, s, frames));
	}
	// bodies that really move are not counted while they move: a told frame comes after the last one on which the Hips joint moves 2 mm
	for (const [name, spec] of [["a walk", [[0, "walk", { to: [0, 3] }]]], ["a run", [[0, "run", { to: [0, 4] }]]], ["a push gait", [[0, "push", { to: [0.5, 2] }]]], ["a lunge", [[0, "walk", { to: [0, 0.6], steps: 1 }]]],
		["back steps", [[0, "walk", { to: [0, -1.2], facing: 30 }]]], ["side steps", [[0, "walk", { to: [1, 0], facing: 30 }]]], ["a kneel and a stand", [[0, "kneel", { over: 50 }], [60, "stand", { over: 50 }]]],
		["the hips swung far and fast", [[0, "pose", { hip: [0.3, 0, 0], over: 4 }], [4, "pose", { hip: [-0.3, 0, 0], over: 4 }], [0, "repeat", { len: 8, times: 20 }]]], ["a tilt in progress, slow", [[0, "pose", { tilt: [40, 0], about: "feet", over: 119 }]]]])
	{
		const want = check(name, ...solo(spec, [], 1, 120)), c = JSON.parse(readFileSync(join(TMP, `b${n - 1}.json`), "utf8")).characters[0], H = f => [0, 1, 2].map(k => c.pos[(f * JOINT_COUNT + J.Hips) * 3 + k]);
		const last = Array.from({ length: 120 }, (_, f) => f).findLast(f => f > 0 && Math.hypot(...H(f).map((v, k) => v - H(f - 1)[k])) > STILL);
		assert.ok(want.every(w => w.frames.every(f => f > last)), `${name}: told only after it last moves (f${last}): ${want.map(w => w.frames)}`);
	}
	// bodies that stay in place while a pose repeats (every pose word that can repeat, sizes and periods, leaning 0 to 40
	// degrees, on two feet, one foot, kneeling, sitting, lying; a hand on a prop that does not move, on one that moves, a prop held)
	let inPlace = 0;
	for (let i = 0; i < N; i++) {
		const s = pick([0.5, 0.81, 1, 1.4, 2]), frames = Math.round(range(80, 200)), posture = pick(["stand", "foot", "kneel", "sit", "height", "lie"]), spec = [], props = [];
		if (posture === "kneel") spec.push([0, "kneel", { over: 0 }]);
		if (posture === "sit") { props.push({ ...bench, size: bench.size.map(v => v * s), at: bench.at.map(v => v * s) }); spec.push([0, "sit", { on: "bench", over: 0 }]); }
		if (posture === "height" || posture === "lie") spec.push([0, posture === "lie" ? "lie" : "sit", posture === "lie" ? { at: [0, -0.8 * s], over: 0 } : { height: 0.45 * s, over: 0 }]);
		const pose = { [pick(["bow", "lean"])]: Math.round(range(-40, 40)), over: pick([0, 12, 24]) };
		if (rnd() < 0.5 && posture !== "lie") pose.hip = [range(-0.3, 0.3) * s, 0, range(-0.2, 0.2) * s];
		if (posture === "foot") pose[pick(["footL", "footR"])] = [range(-0.2, 0.2) * s, range(0.1, 0.3) * s, range(-0.2, 0.3) * s];
		const support = pick(["none", "none", "table", "cart", "bag"]);
		if (support === "table" || support === "cart") { props.push(support === "table" ? { ...table, size: table.size.map(v => v * s), at: table.at.map(v => v * s) } : cart); pose.R = { on: support, at: [range(-0.3, 0.3) * s, 0.375 * s, -0.2 * s] }; }
		if (support === "bag") { props.push(bag); spec.push([0, "hold", { prop: "bag", hand: "L" }]); }
		spec.push([0, "pose", pose]);
		const word = pick(["bow", "lean", "twist", "hipTurn", "hip", "look", "nod", "arm"]), amp = range(0.1, 1), len = pick([6, 12, 24, 48, 96]), from = 30;
		const a = { bow: { bow: 20 * amp }, lean: { lean: 20 * amp }, twist: { twist: 40 * amp }, hipTurn: { hipTurn: 30 * amp }, hip: { hip: [0, -0.06 * amp * s, 0] }, look: { look: [3 * amp, 1.6, 3] }, nod: { nod: 1 }, arm: { L: [0.3, 0.2 * amp, 0.25] } }[word];
		spec.push([from, "pose", { ...a, over: len / 2 }], [from + len / 2, "pose", { ...Object.fromEntries(Object.keys(a).map(k => [k, k === "hip" ? pose.hip ?? [0, 0, 0] : k === "look" ? "fwd" : k === "L" ? "rest" : k === "nod" ? 0 : pose[k] ?? 0])), over: len / 2 }], [from, "repeat", { len, times: 20 }]);
		const want = check(`in place ${i} (${posture}, ${support}, ${word} ${amp.toFixed(2)} every ${len}, scale ${s}): ${JSON.stringify(spec)}`, ...solo(spec, props, s, frames));
		inPlace += want.some(w => w.frames.some(f => f > from + len)); // told on a frame after the repetition began
	}
	console.log(`ok: ${inPlace} of ${N} bodies that stay in place while a pose repeats are told on a frame after it began`);
	assert.ok(inPlace >= N / 20,"the row tells some bodies while a pose of theirs repeats");
	assert.ok(told >= 5 && quietBodies >= 5, `the cases tell some bodies and leave some (${told} told, ${quietBodies} not)`);
	console.log(`ok: ${checked} told lines checked number by number, ${quietBodies} bodies not told and not over the limit here`);
} finally {
	rmSync(TMP, { recursive: true, force: true });
}
console.log("PASS verify-balance-row");
