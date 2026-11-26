// A line (engine-simple/line.js): the same input gives the same clip bytes; the clip carries it in a form clip.js
// validates; it lies on the floor, hangs between two points and is pulled straight (and told taut) when they are further
// apart than its length; a hand holds it; the tool tells its spans (line-told.js); the sheets draw it; the Studio makes
// one object per segment and tells it back as one line. Every scene here is made up for this check.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildClip } from "../../src/lowvis/engine-simple/engine.js";
import { serializeClip, validateClip } from "../../src/lowvis/clip.js";
import { createCompileTool } from "../../src/lowvis/pi/compile-tool.mjs";
import { lineSegments, studioLines } from "../../src/lowvis/studio/line-objects.js";
import { installClip } from "../../src/lowvis/studio/install.js";
import { beforeOf } from "../../bin/agent/motion-run.mjs";
import { INDEX as J } from "../../src/lowvis/rig17.js";

const post = (id, x) => ({ id, size: [0.15, 1.2, 0.15], at: [x, 0.6, 0] });
const scene = (length, gap) => ({ frames: 48, characters: [{ id: "p", at: [0, -2], heading: 0 }], props: [post("a", -gap / 2), post("b", gap / 2), { id: "r", line: { length, thick: 0.03 }, at: [0, 1.2, 0] }] });
const ties = length => ({ r: [[0, "tie", { at: 0, to: { on: "a", at: [0, 0.6, 0] } }], [0, "tie", { at: length, to: { on: "b", at: [0, 0.6, 0] } }]] });
const pointsOf = (clip, f) => { const l = clip.lines[0], n = l.segments + 1; return Array.from({ length: n }, (_, i) => l.points.slice((f * n + i) * 3, (f * n + i) * 3 + 3)); };
const lengthOf = pts => pts.slice(1).reduce((s, p, i) => s + Math.hypot(p[0] - pts[i][0], p[1] - pts[i][1], p[2] - pts[i][2]), 0);

// same bytes twice; valid; a scene with no line has no lines field
{
	const a = serializeClip(buildClip({ ...ties(4), demo: "x" }, scene(4, 3)).clip), b = serializeClip(buildClip({ ...ties(4), demo: "x" }, scene(4, 3)).clip), clip = JSON.parse(a);
	assert.equal(a, b, "the same scene and spec give the same clip bytes");
	assert.ok(validateClip(clip).ok, validateClip(clip).errors.join("; "));
	assert.equal(clip.lines.length, 1); assert.equal(clip.lines[0].segments, 40);
	const none = JSON.parse(serializeClip(buildClip({ demo: "x" }, { ...scene(4, 3), props: scene(4, 3).props.slice(0, 2) }).clip));
	assert.ok(!("lines" in none), "no line, no lines field");
	// slack between two posts 3 m apart: it keeps its length (2 %) and hangs under the tops
	const pts = pointsOf(clip, 47), L = lengthOf(pts);
	assert.ok(Math.abs(L - 4) < 0.08, `slack: length ${L.toFixed(3)} within 2 % of 4`);
	assert.ok(Math.min(...pts.map(p => p[1])) < 0.5 && Math.min(...pts.map(p => p[1])) >= 0.015 - 1e-4, "it sags, not under the floor");
	const bad = JSON.parse(a); bad.lines[0].points.pop();
	assert.ok(!validateClip(bad).ok, "a line with points missing is not valid");
}
// taut: 2.5 m between posts 3 m apart is drawn longer, and the tool says so with the numbers of the clip
{
	const out = mkdtempSync(join(tmpdir(), "line-")), tool = createCompileTool({ name: "line", outDir: out, clipFile: join(out, "clip.json"), variant: "studio" });
	const r = tool.call({ scene: scene(2.5, 3), spec: ties(2.5) });
	assert.equal(r.status, "ok", r.error);
	const told = r.text.split("\n").find(l => l.includes("between a and b"));
	const m = /taut on (\d+) of (\d+) frames, the two points up to ([\d.]+) m further apart than the ([\d.]+) m/.exec(told ?? "");
	assert.ok(m, `the span is told taut: ${told}`);
	assert.equal(+m[3], 0.5); assert.equal(+m[4], 2.5); assert.equal(+m[1], 48);
	// the sheets draw it: the overview differs from the same scene with the line taken out
	const t2 = createCompileTool({ name: "line2", outDir: out, clipFile: join(out, "clip2.json"), variant: "studio" }), r2 = t2.call({ scene: { ...scene(2.5, 3), props: scene(2.5, 3).props.slice(0, 2) }, spec: {} });
	assert.notEqual(r.images[0].data, r2.images[0].data, "the sheet draws the line");
}
// lying: no fastening, it falls and lies on the floor along its length; held: a hand's point follows the wrist
{
	const lying = buildClip({ demo: "x" }, { frames: 24, characters: [{ id: "p", at: [0, -2], heading: 0 }], props: [{ id: "r", line: { length: 2, thick: 0.02 }, at: [0, 0.5, 0] }] }).clip;
	const pts = pointsOf(lying, 23);
	assert.ok(pts.every(p => Math.abs(p[1] - 0.01) < 0.002), "it lies on the floor");
	const held = buildClip({ demo: "x", p: [[0, "hold", { prop: "r", hand: "R" }], [6, "walk", { to: [1.5, 0] }]] }, { frames: 60, characters: [{ id: "p", at: [0, 0], heading: 90 }], props: [{ id: "r", line: { length: 2, thick: 0.02 }, at: [-0.8, 0.4, 0.1] }] }).clip;
	const w = f => held.characters[0].pos.slice((f * 17 + J.RightHand) * 3, (f * 17 + J.RightHand) * 3 + 3), near = f => Math.min(...pointsOf(held, f).map(p => Math.hypot(p[0] - w(f)[0], p[1] - w(f)[1], p[2] - w(f)[2])));
	assert.ok(near(59) < 1e-3, `the held point is at the wrist (${near(59)})`);
	assert.deepEqual(held.lines[0].by[59], ["p"], "by: the character that holds it");
}
// the Studio: one box per segment, told back as one line
{
	const clip = JSON.parse(serializeClip(buildClip({ ...ties(4), demo: "x" }, scene(4, 3)).clip)), segs = lineSegments(clip.lines[0], clip.frameCount);
	assert.equal(segs.length, 40); assert.ok(segs.every(s => s.pos.length === 48 * 3 && s.quat.length === 48 * 4));
	const rows = segs.map((s, k) => ({ id: `o${k}`, name: s.id, x: s.pos[0], y: s.pos[1], z: s.pos[2], footprint: { width: s.size[0], depth: s.size[2] }, height: s.size[1] })), back = studioLines([...rows, { id: "x", name: "box" }], new Map([["r", scene(4, 3).props[2]]]));
	assert.deepEqual(back.props.map(p => [p.id, p.line]), [["r", { length: 4, thick: 0.03 }]]); assert.equal(back.ids.r.ids.length, 40); assert.equal(back.rows.size, 40);
	// a line no take plays any more is still one line, read off its boxes; a set with a segment missing is not
	const alone = studioLines(rows, new Map());
	assert.deepEqual(alone.props.map(p => [p.id, p.line]), [["r", { length: 4, thick: 0.03 }]], "whole set, no take: one line with the length and thickness of its boxes");
	assert.equal(studioLines(rows.filter((_, k) => k !== 7), new Map()).props.length, 0, "a set with a segment missing is not told as a line");
	// the install moves the segments a listed line has when they fit this line, else takes them out and makes them anew
	const steps = [], run = async (action, args) => { steps.push(action); return { affectedIds: [`n${steps.length}`], args }; }, count = a => steps.filter(s => s === a).length;
	const same = await installClip(clip, run, { existing: { characters: {}, props: {}, lines: back.ids } });
	assert.ok(same.ok); assert.deepEqual(same.lines.r, back.ids.r.ids, "the same line again: its segments are moved, none made"); assert.equal(count("object.remove"), 0);
	steps.length = 0;
	const thicker = await installClip({ ...clip, lines: [{ ...clip.lines[0], thick: 0.06 }] }, run, { existing: { characters: {}, props: {}, lines: back.ids } });
	assert.ok(thicker.ok); assert.equal(count("object.remove"), 1, "another thickness with as many segments: the old boxes go"); assert.ok(thicker.lines.r.every(id => !back.ids.r.ids.includes(id)), "and new ones are made");
}
// laid from what frame 0 fastens: a scene place that runs through the posts it is tied to gives the hang of one that
// does not (not caught on their far sides and drawn longer); straight up and down it opens into a loop
{
	const hang = at => { const s = scene(4, 3); s.props[2].at = at; const clip = JSON.parse(serializeClip(buildClip({ ...ties(4), demo: "x" }, s).clip)), pts = pointsOf(clip, 47); return { L: lengthOf(pts), low: Math.min(...pts.map(p => p[1])) }; };
	const over = hang([0, 1.2, 0]), through = hang([0, 1.0, 0]), far = hang([3, 0.02, 2]);
	for (const [name, h] of [["through the posts", through], ["far away", far]]) { assert.ok(Math.abs(h.L - 4) < 0.08, `${name}: length ${h.L.toFixed(3)} within 2 % of 4`); assert.ok(Math.abs(h.low - over.low) < 0.02, `${name}: lowest point ${h.low.toFixed(3)} as ${over.low.toFixed(3)}`); }
	const up = JSON.parse(serializeClip(buildClip({ demo: "x", r: [[0, "tie", { at: 0, to: { world: [0, 2, 0] } }], [0, "tie", { at: 2, to: { world: [0, 1.2, 0] } }]] }, { frames: 24, characters: [{ id: "p", at: [0, -2], heading: 0 }], props: [{ id: "r", line: { length: 2, thick: 0.03 }, at: [0, 1, 0] }] }).clip));
	assert.ok(Math.abs(lengthOf(pointsOf(up, 23)) - 2) < 0.04, "two points one over the other: the slack between them keeps its length");
}
// a look at a line is a look at its middle (a valid clip), and the request of a motion that has a line does not call
// the line changed
{
	const looked = buildClip({ demo: "x", p: [[4, "pose", { look: "r" }]] }, { frames: 24, characters: [{ id: "p", at: [0, 0], heading: 0 }], props: [{ id: "r", line: { length: 2, thick: 0.02 }, at: [0.8, 0.5, 0.8] }] }).clip;
	assert.ok(validateClip(JSON.parse(serializeClip(looked))).ok, "a look at a line gives a valid clip");
	const kept = { scene: { frames: 48, characters: [{ id: "p", at: [0, 0], heading: 0 }], props: [post("a", 1), { id: "r", line: { length: 3, thick: 0.04 }, at: [0, 1, 0] }] }, spec: {} };
	const studio = { scene: { characters: [{ id: "p", at: [0, 0], heading: 0 }], props: [post("a", 1), { id: "r", line: { length: 3, thick: 0.04 }, at: [0.4, 0.3, 0.1] }] } };
	assert.deepEqual(beforeOf(kept, studio).differs, [], "a line the Studio tells back is not a prop that changed size or place");
}
console.log("verify-line: same bytes, valid, slack keeps its length, taut told with the clip's numbers, lies, held, drawn, Studio segments told back as one line and moved again only when they fit, laid from its fastenings, looked at");
