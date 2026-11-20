#!/usr/bin/env node
// The inside rows of the motion tool (inside.mjs, measure.mjs, compile-tool.mjs) on scenes made here (inside-cases.mjs):
// bodies of both looks and of scales 0.5 to 2 standing in, walking through, beside and into props, thin and turned
// ones, sitting and lying on a prop and then walking through it, a foot put on a box, props keyed, launched, held,
// carried and placed, riding on a prop and on a joint, a hollow prop, the same scenes listed the other way.
// 1. The pairs told are exactly the case's own.
// 2. Every number of a told line is computed again here from the clip by arithmetic of this test's own: the corners of
//    each drawn solid (the look's boxes moved by the clip's joints) and of each prop, and the overlap of their
//    projections over the face normals and edge crosses of the two boxes and 26 more directions (a ball by its centre
//    and radius). The depth on the worst frame, the frame, the frames over the limit, the first and the last, and the
//    limit (20 mm times the scale; two props 20 mm) agree with the line the writer reads.
// 3. A pair not told is no deeper than its limit on every frame the case does not name as a touch.
// 4. The flag switched off by name tells no inside line; the rows are still measured. A hollow attribute that is not
//    true or false is refused.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCompileTool } from "../../src/lowvis/pi/compile-tool.mjs";
import { blockSolids } from "../../src/lowvis/looks/block.js";
import { cubeSolids } from "../../src/lowvis/looks/cube.js";
import { INDEX as J, JOINT_COUNT } from "../../src/lowvis/rig17.js";
import { CASES } from "./inside-cases.mjs";

const SOLIDS = { block: blockSolids(), cube: cubeSolids() }, HANDS = new Set([J.LeftHand, J.RightHand]);
const rot = (q, v) => { // v + 2w (q x v) + 2 q x (q x v)
	const [x, y, z, w] = q, c1 = [y * v[2] - z * v[1], z * v[0] - x * v[2], x * v[1] - y * v[0]], c2 = [y * c1[2] - z * c1[1], z * c1[0] - x * c1[2], x * c1[1] - y * c1[0]];
	return [v[0] + 2 * (w * c1[0] + c2[0]), v[1] + 2 * (w * c1[1] + c2[1]), v[2] + 2 * (w * c1[2] + c2[2])];
};
const corners = (c, q, h) => [-1, 1].flatMap(i => [-1, 1].flatMap(j => [-1, 1].map(k => { const d = rot(q, [i * h[0], j * h[1], k * h[2]]); return [c[0] + d[0], c[1] + d[1], c[2] + d[2]]; })));
const unit = v => { const l = Math.hypot(...v); return l > 1e-6 ? v.map(x => x / l) : null; };
const GRID = [-1, 0, 1].flatMap(a => [-1, 0, 1].flatMap(b => [-1, 0, 1].map(c => [a, b, c]))).filter(v => v.some(Boolean)).map(unit);
/** A solid as corners (a box) or { c, r } (a ball), with its own face axes. */
const span = (s, u) => { if (s.r != null) { const m = s.c[0] * u[0] + s.c[1] * u[1] + s.c[2] * u[2]; return [m - s.r, m + s.r]; } const p = s.pts.map(v => v[0] * u[0] + v[1] * u[1] + v[2] * u[2]); return [Math.min(...p), Math.max(...p)]; };
function depth(a, b) {
	const dirs = [...GRID, ...(a.ax ?? []), ...(b.ax ?? [])];
	for (const u of a.ax ?? []) for (const v of b.ax ?? []) { const n = unit([u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]]); if (n) dirs.push(n); }
	const ball = a.r != null ? a : b.r != null ? b : null, box = ball === a ? b : a;
	if (ball && box.pts) { // the direction from the ball's centre to the nearest point of the box
		const l = rot([-box.q[0], -box.q[1], -box.q[2], box.q[3]], ball.c.map((v, k) => v - box.c[k])), n = l.map((v, k) => Math.max(-box.h[k], Math.min(box.h[k], v))), d = unit(rot(box.q, l.map((v, k) => v - n[k])));
		if (d) dirs.push(d);
	}
	if (a.r != null && b.r != null) return a.r + b.r - Math.hypot(...a.c.map((v, k) => v - b.c[k]));
	let best = Infinity;
	for (const u of dirs) { const [a0, a1] = span(a, u), [b0, b1] = span(b, u); best = Math.min(best, a1 - b0, b1 - a0); }
	return best;
}
const propSolid = (p, f) => {
	const i = p.pos.length === 3 ? 0 : f, c = p.pos.slice(i * 3, i * 3 + 3), q = p.quat.slice(i * 4, i * 4 + 4);
	return p.shape === "sphere" ? { c, r: p.size[0] / 2 } : { c, q, h: p.size.map(v => v / 2), pts: corners(c, q, p.size.map(v => v / 2)), ax: [[1, 0, 0], [0, 1, 0], [0, 0, 1]].map(v => rot(q, v)) };
};
const bodySolids = (ch, f, look) => SOLIDS[look].filter(o => !HANDS.has(o.joint)).map(o => {
	const s = ch.scale ?? 1, i = f * JOINT_COUNT + o.joint, q = ch.quat.slice(i * 4, i * 4 + 4), d = rot(q, o.c), c = [0, 1, 2].map(k => ch.pos[i * 3 + k] + d[k] * s), h = o.h.map(v => v * s);
	return { joint: o.joint, c, q, h, pts: corners(c, q, h), ax: [[1, 0, 0], [0, 1, 0], [0, 0, 1]].map(v => rot(q, v)) };
});
const skipped = (c, pair, f, joint) => [...(c.skip?.[pair] ?? []), ...(c.skip?.[pair.split(">").reverse().join(">")] ?? [])].some(([a, b, joints]) => f >= a && f < b && (!joints || joints.some(n => J[n] === joint)));

let n = 0, lines = 0, pairs = 0;
for (const c of CASES) {
	const look = c.figure ?? "block", dir = join(tmpdir(), `lowvis-inside-${process.pid}-${n++}`);
	const tool = createCompileTool({ name: `inside-${n}`, outDir: dir, clipFile: join(dir, "clip.json"), variant: "studio", figure: look });
	const r = tool.call({ scene: c.scene, spec: c.spec });
	assert.equal(r.status, "ok", `${c.name}: ${r.error}`);
	const clip = JSON.parse(readFileSync(tool.clipFile, "utf8")), F = clip.frameCount, rows = r.rows.filter(x => x.key.startsWith("inside:"));
	assert.deepEqual(rows.map(x => x.key.slice(7)).sort(), c.told.slice().sort(), `${c.name}: the pairs told`);
	const hollow = new Set(c.scene.props.filter(p => p.hollow).map(p => p.id));
	// every body with every prop, every moving prop with every other prop
	const all = [...clip.characters.flatMap(ch => clip.props.map(p => ({ pair: `${ch.id}>${p.id}`, ch, p }))), ...clip.props.filter(m => m.pos.length > 3).flatMap((m, i, movers) => clip.props.filter(p => p !== m && !movers.slice(0, i).includes(p)).map(p => ({ pair: `${m.id}>${p.id}`, m, p })))]; // two moving props once, either named first
	for (const e of all) {
		if (hollow.has(e.p.id) || (e.m && hollow.has(e.m.id))) continue;
		const lim = 1000 * (e.ch ? 0.02 * (e.ch.scale ?? 1) : 0.02);
		let worst = { d: -Infinity }, frames = 0, first = null, last = null;
		for (let f = 0; f < F; f++) {
			const b = propSolid(e.p, f);
			const ds = e.ch ? bodySolids(e.ch, f, look).filter(o => !skipped(c, e.pair, f, o.joint)).map(o => 1000 * depth(o, b)) : skipped(c, e.pair, f, null) ? [] : [1000 * depth(propSolid(e.m, f), b)];
			const d = Math.max(-Infinity, ...ds);
			if (d > lim) { frames++; first ??= f; last = f; }
			if (d > worst.d) worst = { d, f };
		}
		const flip = e.m && `${e.p.id}>${e.m.id}`, row = rows.find(x => x.key === `inside:${e.pair}` || x.key === `inside:${flip}`);
		if (!row) { assert.ok(worst.d <= lim + 0.01, `${c.name}: ${e.pair} not told but ${worst.d.toFixed(1)} mm deep at f${worst.f} (limit ${lim})`); continue; }
		pairs++;
		// the line as the writer reads it
		const [x, y] = row.key.slice(7).split(">"), line = r.text.split("\n").find(l => l.startsWith(`- ${e.ch ? `${e.ch.id}'s body` : x} inside ${y}:`));
		assert.ok(line, `${c.name}: no line for ${e.pair}`);
		const m = /: ([\d.]+) mm @f(\d+).*deeper than ([\d.]+) mm on (\d+) frames?, from f(\d+) to f(\d+)\)/.exec(line);
		assert.ok(m, `${c.name}: line not read: ${line}`);
		const [value, frame, limit, count, from, to] = m.slice(1).map(Number);
		assert.ok(Math.abs(value - worst.d) <= 0.11, `${c.name}: ${e.pair} depth ${value} against ${worst.d.toFixed(2)} mm`);
		assert.ok(frame === worst.f || Math.abs(worst.d - value) <= 0.11, `${c.name}: ${e.pair} worst frame ${frame} against ${worst.f}`);
		assert.ok(Math.abs(limit - lim) <= 0.051, `${c.name}: ${e.pair} limit ${limit} against ${lim}`);
		assert.deepEqual([count, from, to], [frames, first, last], `${c.name}: ${e.pair} frames`);
		if (c.endsBy?.[e.pair] != null) assert.ok(to < c.endsBy[e.pair], `${c.name}: ${e.pair} still inside at f${to}`);
		lines++;
	}
}
// the flag off by name: no inside line, the rows still measured; hollow must be true or false
{
	const c = CASES[0], dir = join(tmpdir(), `lowvis-inside-${process.pid}-off`);
	const off = createCompileTool({ name: "inside-off", outDir: dir, clipFile: join(dir, "clip.json"), variant: "studio", off: ["inside"], figure: "block" }).call({ scene: c.scene, spec: c.spec });
	assert.ok(off.rows.some(x => x.key.startsWith("inside:")) && !/inside crate:/.test(off.text), "the flag off tells no inside line");
	const bad = createCompileTool({ name: "inside-bad", outDir: dir, clipFile: join(dir, "clip.json"), variant: "studio" }).call({ scene: { ...c.scene, props: [{ ...c.scene.props[0], hollow: "yes" }] }, spec: c.spec });
	assert.equal(bad.status, "rejected");
	assert.match(bad.text, /hollow: want true or false/);
}
console.log(`verify-inside: ${CASES.length} cases, ${pairs} told pairs, ${lines} lines recomputed, every other pair under its limit`);
