#!/usr/bin/env node
// The inside rows of the motion tool (inside.mjs, measure.mjs, compile-tool.mjs) on scenes made here (inside-cases.mjs):
// bodies of both looks and of scales 0.5 to 2 standing in, walking through, beside and into props, thin and turned
// ones, sitting and lying on a prop and then walking through it, a foot put on a box, props keyed, launched, held,
// carried and placed, riding on a prop and on a joint, a hollow prop, the same scenes listed the other way.
// 1. The pairs told are exactly the case's own.
// 2. Every number of a told line is computed again here from the clip by arithmetic of this test's own: the corners of
//    each mesh the look's own figure draws (the hull of its vertices, moved by the clip's joints) and of each prop, and
//    the overlap of their projections over the face normals of both, the crosses of their edges, 26 more directions and,
//    with a ball, the directions to the corners (a ball by its centre and radius). The depth on the worst frame, the
//    frame, the frames over the limit, the first and the last, and the limit (25 mm times the scale; two props 25 mm)
//    agree with the line the writer reads. A body is left out with a prop on the frames the engine's own state (the
//    build's aux.holders, built again here) names it among that prop's holders.
// 3. A pair not told is no deeper than its limit on every frame the case does not name as a touch, or is deeper on
//    fewer frames than last a tenth of a second at the clip's rate, none of them the clip's first or last; a told pair
//    is deeper on that many at least, or on the clip's first or last frame.
// 4. The flag switched off by name tells no inside line; the rows are still measured. A hollow attribute that is not
//    true or false is refused.
// 5. The least count follows the clip's rate and is a count over the whole clip: clips written here by hand, a box in
//    a wall on chosen frames, at 10 to 60 frames a second.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// three by path, the same files the package name resolves to, so a copy of this test elsewhere still finds them
import * as THREE from "../../node_modules/three/build/three.module.js";
import { ConvexHull } from "../../node_modules/three/examples/jsm/math/ConvexHull.js";
import { createCompileTool } from "../../src/lowvis/pi/compile-tool.mjs";
import { insideRows } from "../../src/lowvis/pi/inside.mjs";
import { buildClip } from "../../src/lowvis/engine-simple/engine.js";
import { serializeClip } from "../../src/lowvis/clip.js";
import { block } from "../../src/lowvis/looks/block.js";
import { cube } from "../../src/lowvis/looks/cube.js";
import { INDEX as J, JOINT_COUNT } from "../../src/lowvis/rig17.js";
import { CASES } from "./inside-cases.mjs";

const HANDS = new Set([J.LeftHand, J.RightHand]);
/** The meshes the look's own figure hangs on each joint (hands out), each as the hull of its vertices: corners from the
 *  joint, face normals, and the directions of its edges (a line between two triangles of one face left out). */
const drawn = figure => figure.object3D.children.flatMap((group, joint) => HANDS.has(joint) ? [] : group.children.filter(m => m.isMesh).map(m => {
	const a = m.geometry.attributes.position.array, pts = [];
	for (let i = 0; i < a.length; i += 3) pts.push(new THREE.Vector3(a[i], a[i + 1], a[i + 2]).add(m.position));
	const hull = new ConvexHull().setFromPoints(pts), normals = new Map(), edges = new Map(), key = v => v.map(x => x.toFixed(9)).join();
	for (const face of hull.faces) {
		normals.set(key(face.normal.toArray()), face.normal.toArray());
		let h = face.edge;
		do { // an edge and its reverse are one direction
			const d = h.head().point.clone().sub(h.tail().point).normalize(), e = (d.x || d.y || d.z) < 0 ? d.negate() : d;
			if (face.normal.dot(h.twin.face.normal) < 1 - 1e-9) edges.set(key(e.toArray()), e.toArray());
			h = h.next;
		} while (h !== face.edge);
	}
	return { joint, pts: [...new Map(pts.map(p => [key(p.toArray()), p.toArray()])).values()], normals: [...normals.values()], edges: [...edges.values()] };
}));
const SOLIDS = { block: drawn(block()), cube: drawn(cube()) };
const rot = (q, v) => { // v + 2w (q x v) + 2 q x (q x v)
	const [x, y, z, w] = q, c1 = [y * v[2] - z * v[1], z * v[0] - x * v[2], x * v[1] - y * v[0]], c2 = [y * c1[2] - z * c1[1], z * c1[0] - x * c1[2], x * c1[1] - y * c1[0]];
	return [v[0] + 2 * (w * c1[0] + c2[0]), v[1] + 2 * (w * c1[1] + c2[1]), v[2] + 2 * (w * c1[2] + c2[2])];
};
const corners = (c, q, h) => [-1, 1].flatMap(i => [-1, 1].flatMap(j => [-1, 1].map(k => { const d = rot(q, [i * h[0], j * h[1], k * h[2]]); return [c[0] + d[0], c[1] + d[1], c[2] + d[2]]; })));
const unit = v => { const l = Math.hypot(...v); return l > 1e-6 ? v.map(x => x / l) : null; };
const GRID = [-1, 0, 1].flatMap(a => [-1, 0, 1].flatMap(b => [-1, 0, 1].map(c => [a, b, c]))).filter(v => v.some(Boolean)).map(unit);
/** A solid as corners (pts) or { c, r } (a ball), with its own face normals (ax) and edge directions (ed). */
const span = (s, u) => { if (s.r != null) { const m = s.c[0] * u[0] + s.c[1] * u[1] + s.c[2] * u[2]; return [m - s.r, m + s.r]; } let lo = Infinity, hi = -Infinity; for (const v of s.pts) { const d = v[0] * u[0] + v[1] * u[1] + v[2] * u[2]; lo = Math.min(lo, d); hi = Math.max(hi, d); } return [lo, hi]; };
function depth(a, b) {
	const dirs = [...GRID, ...(a.ax ?? []), ...(b.ax ?? [])];
	for (const u of a.ed ?? []) for (const v of b.ed ?? []) { const n = unit([u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]]); if (n) dirs.push(n); }
	const ball = a.r != null ? a : b.r != null ? b : null, solid = ball === a ? b : a;
	if (ball && solid.pts) for (const p of solid.pts) { const d = unit(p.map((v, k) => v - ball.c[k])); if (d) dirs.push(d); } // to each corner
	if (ball && solid.box) { // the direction from the ball's centre to the nearest point of a box
		const box = solid, l = rot([-box.q[0], -box.q[1], -box.q[2], box.q[3]], ball.c.map((v, k) => v - box.c[k])), n = l.map((v, k) => Math.max(-box.h[k], Math.min(box.h[k], v))), d = unit(rot(box.q, l.map((v, k) => v - n[k])));
		if (d) dirs.push(d);
	}
	if (a.r != null && b.r != null) return a.r + b.r - Math.hypot(...a.c.map((v, k) => v - b.c[k]));
	let best = Infinity;
	for (const u of dirs) { const [a0, a1] = span(a, u), [b0, b1] = span(b, u); best = Math.min(best, a1 - b0, b1 - a0); }
	return best;
}
const propSolid = (p, f) => {
	const i = p.pos.length === 3 ? 0 : f, c = p.pos.slice(i * 3, i * 3 + 3), q = p.quat.slice(i * 4, i * 4 + 4);
	if (p.shape === "sphere") return { c, r: p.size[0] / 2 };
	const ax = [[1, 0, 0], [0, 1, 0], [0, 0, 1]].map(v => rot(q, v));
	return { box: true, c, q, h: p.size.map(v => v / 2), pts: corners(c, q, p.size.map(v => v / 2)), ax, ed: ax };
};
const bodySolids = (ch, f, look) => SOLIDS[look].map(o => {
	const s = ch.scale ?? 1, i = f * JOINT_COUNT + o.joint, q = ch.quat.slice(i * 4, i * 4 + 4), P = ch.pos.slice(i * 3, i * 3 + 3);
	const pts = o.pts.map(v => { const d = rot(q, v); return [P[0] + d[0] * s, P[1] + d[1] * s, P[2] + d[2] * s]; });
	const c = [0, 1, 2].map(k => pts.reduce((t, p) => t + p[k], 0) / pts.length);
	return { joint: o.joint, pts, c, r2: Math.max(...pts.map(p => Math.hypot(p[0] - c[0], p[1] - c[1], p[2] - c[2]))), ax: o.normals.map(v => rot(q, v)), ed: o.edges.map(v => rot(q, v)) };
});
/** A solid whose ball is clear of the prop's ball is clear of the prop. */
const far = (o, b) => Math.hypot(...o.c.map((v, k) => v - b.c[k])) > o.r2 + (b.r ?? Math.hypot(...b.h));
const skipped = (c, pair, f, joint) => [...(c.skip?.[pair] ?? []), ...(c.skip?.[pair.split(">").reverse().join(">")] ?? [])].some(([a, b, joints]) => f >= a && f < b && (!joints || joints.some(n => J[n] === joint)));

/** The fewest whole frames that last a tenth of a second at a rate. */
const tenth = fps => { let k = 1; while (k / fps < 0.1 - 1e-9) k++; return k; };
let n = 0, lines = 0, pairs = 0, brief = 0, handled = 0, ends = 0;
for (const c of CASES) {
	const look = c.figure ?? "block", dir = join(tmpdir(), `lowvis-inside-${process.pid}-${n++}`);
	const tool = createCompileTool({ name: `inside-${n}`, outDir: dir, clipFile: join(dir, "clip.json"), variant: "studio", figure: look });
	const r = tool.call({ scene: c.scene, spec: c.spec });
	assert.equal(r.status, "ok", `${c.name}: ${r.error}`);
	const clip = JSON.parse(readFileSync(tool.clipFile, "utf8")), F = clip.frameCount, rows = r.rows.filter(x => x.key.startsWith("inside:"));
	assert.deepEqual(rows.map(x => x.key.slice(7)).sort(), c.told.slice().sort(), `${c.name}: the pairs told`);
	// the engine's own state, built again from the scene the tool built (with moves set): who holds each prop on each frame
	const { clip: again, aux } = buildClip(structuredClone({ ...c.spec, demo: "x" }), tool.state.last.scene);
	assert.deepEqual(JSON.parse(serializeClip(again)).characters.map(x => x.pos), clip.characters.map(x => x.pos), `${c.name}: built again the same`);
	const holds = (who, prop, f) => String(aux.holders[prop]?.[f] ?? "").split("+").some(h => h.replace(/:[LR]$/, "") === who);
	const seen = tenth(clip.fps);
	const hollow = new Set(c.scene.props.filter(p => p.hollow).map(p => p.id));
	// every body with every prop, every moving prop with every other prop
	const all = [...clip.characters.flatMap(ch => clip.props.map(p => ({ pair: `${ch.id}>${p.id}`, ch, p }))), ...clip.props.filter(m => m.pos.length > 3).flatMap((m, i, movers) => clip.props.filter(p => p !== m && !movers.slice(0, i).includes(p)).map(p => ({ pair: `${m.id}>${p.id}`, m, p })))]; // two moving props once, either named first
	for (const e of all) {
		if (hollow.has(e.p.id) || (e.m && hollow.has(e.m.id))) continue;
		const lim = 1000 * (e.ch ? 0.025 * (e.ch.scale ?? 1) : 0.025);
		let worst = { d: -Infinity }, frames = 0, first = null, last = null, held = 0;
		for (let f = 0; f < F; f++) {
			const b = propSolid(e.p, f);
			if (e.ch && holds(e.ch.id, e.p.id, f)) { held++; continue; } // it handles the prop on this frame
			const ds = e.ch ? bodySolids(e.ch, f, look).filter(o => !skipped(c, e.pair, f, o.joint) && !far(o, b)).map(o => 1000 * depth(o, b)) : skipped(c, e.pair, f, null) ? [] : [1000 * depth(propSolid(e.m, f), b)];
			const d = Math.max(-Infinity, ...ds);
			if (d > lim) { frames++; first ??= f; last = f; }
			if (d > worst.d) worst = { d, f };
		}
		handled += held > 0;
		const flip = e.m && `${e.p.id}>${e.m.id}`, row = rows.find(x => x.key === `inside:${e.pair}` || x.key === `inside:${flip}`), end = first === 0 || last === F - 1;
		if (!row) {
			assert.ok(worst.d <= lim + 0.01 || (frames < seen && !end), `${c.name}: ${e.pair} not told but ${worst.d.toFixed(1)} mm deep at f${worst.f} (limit ${lim}) on ${frames} frames, f${first} to f${last}`);
			brief += worst.d > lim + 0.01; // past the limit, but on fewer frames than are seen
			continue;
		}
		assert.ok(frames >= seen || end, `${c.name}: ${e.pair} told, past its limit on ${frames} frames, f${first} to f${last}`);
		ends += frames < seen;
		pairs++;
		// the line as the writer reads it
		const [x, y] = row.key.slice(7).split(">"), line = r.text.split("\n").find(l => l.startsWith(`- ${e.ch ? `${e.ch.id}'s body` : x} inside ${y}:`));
		assert.ok(line, `${c.name}: no line for ${e.pair}`);
		const m = /: ([\d.]+) mm @f(\d+).*deeper than ([\d.]+) mm on (\d+) frames?, from f(\d+) to f(\d+)\)/.exec(line);
		assert.ok(m, `${c.name}: line not read: ${line}`);
		const [value, frame, limit, count, from, to] = m.slice(1).map(Number);
		assert.ok(Math.abs(value - worst.d) <= 0.11, `${c.name}: ${e.pair} depth ${value} against ${worst.d.toFixed(2)} mm`);
		assert.equal(frame, worst.f, `${c.name}: ${e.pair} worst frame ${frame} against ${worst.f}`);
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
assert.ok(brief >= 4 && handled >= 4 && ends >= 4, `the cases have pairs past the limit for too few frames (${brief}), such pairs on the clip's first or last frame (${ends}) and bodies that handle a prop (${handled})`);
// the least count at other rates, on clips written by hand: a 0.4 m box 120 mm in a wall on the frames given, clear on the others
{
	const F = 40, wall = { id: "wall", size: [2, 1, 0.4], at: [1.5, 0.5, 2] }, crate = { id: "crate", size: [0.4, 0.4, 0.4], at: [1.5, 0.2, 1], moves: true };
	const rowsOf = (fps, inside) => insideRows({ fps, frameCount: F, characters: [], props: [{ id: "wall", size: wall.size, pos: wall.at, quat: [0, 0, 0, 1] }, { id: "crate", size: crate.size, pos: Array.from({ length: F }, (_, f) => [1.5, 0.2, inside.includes(f) ? 1.72 : 1]).flat(), quat: Array.from({ length: F }, () => [0, 0, 0, 1]).flat() }] }, { holders: {}, rides: [] }, { def: { props: [wall, crate] }, spec: {}, look: "block" });
	const span = (a, k, step = 1) => Array.from({ length: k }, (_, i) => a + i * step);
	for (const fps of [10, 12, 24, 25, 30, 60]) {
		const seen = tenth(fps), row = (frames, why) => { const r = rowsOf(fps, frames); assert.equal(r.length, 1, `${fps} fps, ${why}: told`); assert.deepEqual([r[0].frames, r[0].first, r[0].last, Math.round(r[0].value)], [frames.length, frames[0], frames.at(-1), 120], `${fps} fps, ${why}: its numbers`); };
		row(span(10, seen), "the fewest frames of a tenth of a second in a row");
		row(span(5, seen, 5), "as many frames, five frames apart");
		row([0], "the clip's first frame alone"); row([F - 1], "the clip's last frame alone");
		if (seen > 1) for (const [frames, why] of [[span(10, seen - 1), "one frame fewer in a row"], [span(5, seen - 1, 5), "one frame fewer, five frames apart"], [[1], "the second frame alone"], [[F - 2], "the last but one alone"]]) assert.equal(rowsOf(fps, frames).length, 0, `${fps} fps, ${why}: not told`);
	}
}
console.log(`verify-inside: ${CASES.length} cases, ${pairs} told pairs, ${lines} lines recomputed, ${brief} pairs past the limit on too few frames and not told, ${ends} told on as few that hold the clip's first or last frame, ${handled} body and prop pairs with frames it handles the prop; every other pair under its limit; the least count at 10 to 60 fps`);
