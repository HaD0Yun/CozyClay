#!/usr/bin/env node
// What an answer tells of the measured rows (src/lowvis/pi/told.mjs), on scenes and specs written here.
//  - A row at the value the engine gives when nothing differs (a wrist at its pad on a carried prop, a prop that lies
//    still in one hand, a blade that touches, a prop let go on its place) is not told in a lean variant and stays in the
//    measured rows; the same row off that value is told; the base variant tells it either way.
//  - A row names its worst instance and lists the others after "also"; a mark compares an instance with itself (the same
//    action, else shared frames), not with whichever was worst before.
//  - An elbow as near its target as its wrist's target lets it is told once, and again when it has moved by over 10 mm.
//  - Past 20 rows the kind with the most rows leaves out its least bad ones, counted in one line.
//  - A launched prop has no row of its own: nothing in a spec says what launches it.
//  - A refused call says which of its scene and spec the tool keeps.
import "./block-figure.mjs"; // the block figure's numbers (figure.js: the launch names the look)
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCompileTool } from "../../src/lowvis/pi/compile-tool.mjs";
import { checkLines, streakOf, toldRows } from "../../src/lowvis/pi/told.mjs";

const dir = mkdtempSync(join(tmpdir(), "lowvis-told-"));
let n = 0;
const make = (variant = "studio", off = ["balance"]) => createCompileTool({ name: `told${++n}`, outDir: join(dir, `out${n}`), clipFile: join(dir, `clip${n}.json`), variant, off });
const one = (more = {}) => ({ id: "a", at: [0, 0], heading: 0, ...more });
const rows = (r, re) => r.text.split("\n").filter(l => re.test(l));
const block = r => r.text.split("\n").filter(l => /^(checks|- (?!\S+ f\d+-\d+ )|and \d+ more row)/.test(l));
try {
	{ // the engine's own values
		const table = { id: "table", size: [0.8, 0.75, 0.6], at: [0, 0.375, 1.2] }, crate = { id: "crate", size: [0.3, 0.3, 0.3], at: [0, 0.9, 1.05], moves: true };
		const carry = more => ({ a: [[0, "walk", { to: [0, 0.6] }], [48, "pose", { hands: { prop: "crate" }, over: 30 }], [84, "carry", { prop: "crate", at: [0, 0.12, 0.27], over: 30 }], ...more] });
		for (const scale of [0.7, 1, 1.3]) {
			const r = make().call({ scene: { frames: 130, characters: [one({ scale })], props: [table, crate] }, spec: carry([]) });
			assert.equal(r.status, "ok", r.text);
			const gap = r.rows.find(x => x.key === "carryGap"), closest = r.rows.find(x => x.key === "carryIn");
			assert.ok(Math.abs(gap.value - 30 * scale) < 0.05 && Math.abs(closest.value - 30 * scale) < 0.05, `scale ${scale}: both wrists one pad off the crate (${gap.value}, ${closest.value})`);
			assert.deepEqual(rows(r, /^- carry: /), [], `scale ${scale}: wrists at the pad are measured and not told:\n${r.text}`);
		}
		const off = make().call({ scene: { frames: 200, characters: [one()], props: [table, crate] }, spec: carry([[130, "pose", { R: [-0.4, 0.2, 0.1], over: 10 }]]) });
		assert.match(rows(off, /^- carry: widest wrist gap to the prop: /)[0], /: \d{3}\.\d mm @f\d+ a \(crate\)$/, "a hand pulled off the carried prop is told");
		assert.equal(rows(off, /^- carry: closest wrist/).length, 0, "its other wrist, at the pad, is not");
		const base = make("base").call({ scene: { frames: 130, characters: [one()], props: [table, crate] }, spec: carry([]) });
		assert.equal(rows(base, /^- carry: /).length, 2, `the base variant tells every number:\n${base.text}`);

		const sword = { id: "sword", size: [0.04, 0.04, 1.0], at: [-0.26, 0.9, 0.4], moves: true };
		const held = make().call({ scene: { frames: 120, characters: [one()], props: [sword] }, spec: { a: [[0, "hold", { prop: "sword", hand: "R" }], [30, "pose", { aim: [0, 0.35, 1], over: 20 }], [70, "walk", { to: [0, 0.6] }]] } });
		assert.ok(held.rows.some(x => x.key === "gripDrift") && held.rows.some(x => x.key === "gripTurn"), "the grip is measured");
		assert.doesNotMatch(held.text, /^checks|^- prop in one hand/m, `a prop that lies still in the hand is no row, and an answer with no difference has no checks:\n${held.text}`);

		const placed = z => make().call({ scene: { frames: 220, characters: [one()], props: [table, crate] }, spec: carry([[130, "place", { prop: "crate", at: [0.2, 0.9, z], over: 20 }], [160, "pose", { hands: "rest", over: 20 }]]) });
		assert.match(rows(placed(2.4), /^- place: crate let go this far from its target: /)[0], /: \d{3,4}\.\d mm @f\d+$/, "a place out of reach is told");
		const idle = at => make().call({ scene: { frames: 120, characters: [one()], props: [table, crate] }, spec: { a: [[0, "walk", { to: [0, 0.6] }], [60, "place", { prop: "crate", at, over: 20 }]] } });
		assert.match(rows(idle([0, 0.9, 1.05]), /^- place: /)[0], /^- place: crate is this far from its target: 0\.0 mm @f80 \(a did not hold crate, so the place did not move it\)$/, "a place by a body that does not hold the prop is told, on its target or off it");
	}
	{ // the rule itself, on rows written here: no value is read into a kind
		const lean = { text: "lean" }, row = (key, value, normal) => ({ key, label: key, value, unit: "mm", frame: 5, worse: 1, spike: 5, normal });
		const told = list => toldRows(list, lean).map(t => t.key);
		assert.deepEqual(told([row("gripDrift", 0.02, 0), row("gripTurn", 0.049, 0), row("cut:a>b#0", 0, 0), row("place:p", 0, 0), row("carryGap", 33.95, 33.948)]), [], "at the engine's own value: none told");
		assert.deepEqual(told([row("gripDrift", 0.06, 0), row("gripTurn", 3, 0), row("cut:a>b#0", 12, 0), row("place:p", 0.4, 0), row("carryGap", 34.1, 33.948), row("carryIn", 20.6, 28.29)]), ["gripDrift", "gripTurn", "cut:a>b#0", "place:p", "carryGap", "carryIn"], "off it: each told");
		assert.deepEqual(toldRows([row("gripDrift", 0.02, 0), row("slide", 0.02)], { text: "base" }).map(t => t.key), ["gripDrift", "slide"], "the base variant tells a row at its normal");
	}
	{ // instances and marks
		const far = (f, z) => [f, "pose", { R: [-0.3, 0.3, z], over: 8 }], near = f => [f, "pose", { R: [-0.25, 0.1, 0.3], over: 8 }], rest = f => [f, "pose", { R: "rest", over: 8 }];
		const tool = make(), hand = r => rows(r, /^- hand off its target/)[0];
		const first = tool.call({ scene: { frames: 200, characters: [one()] }, spec: { a: [far(20, 0.9), rest(50), far(80, 1.0), rest(110), far(140, 1.1)] } });
		const m = /^- hand off its target: ([\d.]+) mm @f\d+ a \(R hand, the action at f140; .*\); also action f80: ([\d.]+) mm @f\d+, action f20: ([\d.]+) mm @f\d+$/.exec(hand(first));
		assert.ok(m && +m[1] > +m[2] && +m[2] > +m[3], `the three misses come together, the worst named, the others after "also":\n${hand(first)}`);
		const second = tool.call({ edit: { a: [near(140)] } });
		assert.match(hand(second), new RegExp(`^- hand off its target: ${m[2].replace(".", "\\.")} mm @f\\d+ a \\(R hand, the action at f80; .*\\); also action f20: ${m[3].replace(".", "\\.")} mm @f\\d+ \\[same\\]$`), `the worst repaired: the row names the next, which is as it was (no "was" of the repaired one, no count carried over):\n${hand(second)}`);
		const third = tool.call({ edit: { a: [[80, "pose", { R: [-0.3, 0.3, 1.0], over: 14 }]] } });
		assert.match(hand(third), /the action at f80; .*\[(same|was [\d.]+); spike 2 compiles in a row\]$/, `the same action with a longer blend is the same difference, counted on:\n${hand(third)}`);
		// a jump is of the action it is near: it moves with that action's over and stays the same difference
		const cup = { id: "cup", size: [0.08, 0.1, 0.08], at: [0.1, 0.8, 0.9], moves: true }, t2 = make(), jump = r => rows(r, /^- jump between two frames/)[0];
		const j1 = t2.call({ scene: { frames: 140, characters: [one()], props: [cup] }, spec: { a: [[20, "hold", { prop: "cup", hand: "L", over: 4 }]] } }), j2 = t2.call({ edit: { a: [[20, "hold", { prop: "cup", hand: "L", over: 6 }]] } });
		assert.match(jump(j1), /cm @f24 \(cup; /); assert.match(jump(j2), /cm @f26 \(cup; .*\) \[was [\d.]+; spike 2 compiles in a row\]$/, `the pull of the cup, two frames later with the hold's longer over:\n${jump(j2)}`);
		assert.match(rows(j2, /^- hand took hold short/)[0], /the action at f20; .*\[was [\d.]+; spike 2 compiles in a row\]$/, "the hold that took it short is that hold still");
	}
	{ // an elbow its wrist's target holds
		const elbow = (wrist, f = 20) => [f, "pose", { R: wrist, elbowR: [-0.17, 0.3, -0.22], over: 12 }], tool = make(), row = r => rows(r, /^- elbow off its target/);
		const first = tool.call({ scene: { frames: 160, characters: [one()] }, spec: { a: [elbow([-0.25, 0.25, 0.3])] } });
		const m = /^- elbow off its target: ([\d.]+) mm .*why: the wrist's own target holds the elbow/.exec(row(first)[0]);
		assert.ok(m, `told at the first compile that has it:\n${first.text}`);
		assert.match(tool.call({ look: { view: "side" } }).text, /^checks: every number is the same as in the previous compile$/m, "a look changes nothing: it tells what the compile before it told");
		const second = tool.call({ edit: { a: [[90, "pose", { L: [0.3, 0.2, 0.3], over: 10 }]] } });
		assert.deepEqual(row(second), [], `not again while it stays (an edit of the other arm):\n${second.text}`);
		assert.ok(Math.abs(second.rows.find(x => x.key === "reach:a:5").value - m[1]) < 10, "it is measured still, within 10 mm of what was told");
		assert.deepEqual(row(tool.call({ look: { view: "side" } })), [], "nor at a look");
		const third = tool.call({ edit: { a: [elbow([-0.25, 0.1, 0.4])] } }), moved = third.rows.find(x => x.key === "reach:a:5").value;
		assert.ok(Math.abs(moved - m[1]) > 10, `the wrist's target moved the miss by over 10 mm (${m[1]} to ${moved})`);
		assert.match(row(third)[0], new RegExp(`\\[was ${m[1].replace(".", "\\.")}(, worse)?\\]$`), `told again, against the value it was told with:\n${row(third)[0]}`);
		assert.deepEqual(row(tool.call({ edit: { a: [[90, "pose", { L: [0.3, 0.25, 0.3], over: 10 }]] } })), [], "and once more not while it stays");
		// an elbow with no wrist target of its own is told at every compile
		const free = make(), a = free.call({ scene: { frames: 120, characters: [one()] }, spec: { a: [[20, "pose", { elbowL: [1.0, 0.3, 0], over: 10 }]] } }), b = free.call({ edit: { a: [[70, "pose", { bow: 5, over: 8 }]] } });
		assert.equal(row(a).length, 1); assert.match(b.text, /^- elbow off its target|^checks: every number is the same/m, `an elbow out of reach stays told:\n${b.text}`);
	}
	{ // the cap, on rows written here
		const lean = { text: "lean", inside: true, reach: true }, inside = (k, value) => ({ key: `inside:p${k}>big`, label: `p${k} inside big`, short: "inside", value, unit: "mm", frame: 50 + k, prop: "big", note: "deeper than 25 mm on 9 frames, from f46 to f54", worse: 1, inst: [{ a: 46, b: 54, value, frame: 50 + k, tag: "f46-54" }] });
		const hand = { key: "reach:a:1", label: "hand off its target", short: "hand off", value: 40, unit: "mm", frame: 30, who: "a", note: "R hand, the action at f20", worse: 1, spike: 60, inst: [{ a: 28, b: 60, value: 40, frame: 30, tag: "action f20", note: "R hand, the action at f20" }] };
		const told = toldRows([...Array.from({ length: 24 }, (_, k) => inside(k, 100 + k)), hand], lean), got = checkLines(told, null, streakOf(told, null).counts);
		assert.equal(told.length, 25, "every row is a told row");
		assert.deepEqual([got.lines.length, got.told.length], [22, 20], "20 rows are listed under the head line, then one line counts the rest");
		assert.ok(got.lines.includes("- hand off its target: 40.0 mm @f30 a (R hand, the action at f20)"), "the one row of another kind is listed, though measured last");
		assert.equal(got.lines.at(-1), "and 5 more rows not listed, the least of their kind: inside x5 up to 104.0 mm", "the five least deep of the many are counted, with the most any of them is");
		assert.ok(!got.lines.some(l => /^- p[0-4] inside/.test(l)) && got.lines.some(l => l.startsWith("- p5 inside")), "those five are the least deep");
	}
	{ // a launched prop
		const ball = { id: "ball", size: [0.22, 0.22, 0.22], at: [0.1, 0.11, 1.2], moves: true, shape: "sphere" };
		const r = make().call({ scene: { frames: 120, characters: [one()], props: [ball] }, spec: { a: [[0, "idle"]], ball: [[40, "launch", { vel: [0, 2, 5] }]] } });
		assert.equal(r.status, "ok", r.text);
		assert.ok(!r.rows.some(x => x.key.startsWith("launch")) && !/^- launch/m.test(r.text), "no row says how far a foot is from a launched prop");
	}
	{ // refused calls
		const tool = make(), scene = { frames: 60, characters: [one()] };
		const a = tool.call({ scene });
		assert.match(a.text, /^motion 1: rejected, nothing compiled\nspec: missing\. .*\nThe tool keeps this call's scene as sent, though nothing compiled\.$/, a.text);
		assert.equal(tool.call({ spec: { a: [[0, "idle"]] } }).status, "ok", "and so the spec alone compiles next");
		const b = tool.call({ scene, spec: { nobody: [[0, "idle"]] } });
		assert.match(b.text, /\nThe tool keeps this call's scene and spec as sent, though nothing compiled\.\nThe last compiled clip is unchanged\.$/, b.text);
		assert.equal(tool.call({}).status, "rejected", "the refused spec is what the tool holds");
		const c = tool.call({ spec: { a: [[0, "idle"]] }, edit: { a: [[30, "pose", null]] } });
		assert.match(c.text, /\nThe edit was not kept\.\nThe tool keeps this call's spec as sent, though nothing compiled\.\n/, c.text);
		const d = tool.call({ edit: { a: [[30, "pose", null]] } });
		assert.match(d.text, /\nThe edit was not kept: the spec is as it was before this call\.\nThe last compiled clip is unchanged\.$/, d.text);
		assert.doesNotMatch(d.text, /The tool keeps/, "an edit alone leaves nothing new in the tool");
		assert.deepEqual(block(tool.call({})), [], "a clip with no difference has no checks block");
	}
	console.log("PASS verify-told-rows");
} finally {
	rmSync(dir, { recursive: true, force: true });
}
