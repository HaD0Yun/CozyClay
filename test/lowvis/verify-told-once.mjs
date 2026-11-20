#!/usr/bin/env node
// Where the writer reads what the inside lines and the at rest lines measure (prompt.mjs, compile-tool.mjs, inside.mjs,
// balance.mjs). Scenes and specs are made here.
// 1. The manual of every variant, every set of switched-off names and the start scales 1 and 0.81 has for each row it
//    tells one short line: what is told and from what size and length, and that the first answer with such a line says
//    the rest. The rest is in no manual.
// 2. In a session the tool says a row's explanation once: in the answer whose told lines first hold such a line, right
//    after them; not before, not again, not in a session where the row never appears, not when the row is switched off.
//    A rejected call or a look does not use it up.
// 3. Every number the explanations state is computed here: the frames that last a tenth of a second at the clip's rate,
//    the look whose parts are measured, the balance row's limits as verify-balance-row.mjs states them.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCompileTool } from "../../src/lowvis/pi/compile-tool.mjs";
import { OFF, VARIANTS, features, systemPrompt } from "../../src/lowvis/pi/prompt.mjs";

const TMP = mkdtempSync(join(tmpdir(), "lowvis-told-once-"));
const FPS = 24;
let SEEN = 1; while (SEEN / FPS < 0.1 - 1e-9) SEEN++; // the fewest whole frames that last a tenth of a second
const INSIDE = `- inside: how deep a body (its drawn parts, the hands left out) or a prop with moves: true is inside another prop, told when deeper than 25 mm (times the body's scale) on ${SEEN} frames in a row or more. The first answer with such a line says what it measures and leaves out.`;
const BAL = "- at rest: centre of mass outside its supports: on the frames where a body is at rest, how far its centre of mass, dropped to the floor, lies outside the area its supports span, told when over 30 mm times its scale. The first answer with such a line says what counts as rest and as a support.";
const SAID_IN = /^inside lines \(said once\): /, SAID_BAL = /^at rest lines \(said once\): /;
const subsets = list => list.reduce((all, x) => [...all, ...all.map(s => [...s, x])], [[]]);

try {
	// 1. the manuals
	let manuals = 0;
	for (const variant of VARIANTS) for (const off of subsets(OFF)) for (const start of [1, 0.81]) {
		const f = features(variant, off), text = systemPrompt(variant, off, start), lines = text.split("\n");
		assert.equal(lines.filter(l => l === INSIDE).length, f.inside ? 1 : 0, `${variant} -${off} ${start}: the inside line`);
		assert.equal(lines.filter(l => l === BAL).length, f.balance ? 1 : 0, `${variant} -${off} ${start}: the at rest line`);
		assert.ok(!/said once\)|Not told: a body with|Supports: a foot/.test(text), `${variant} -${off} ${start}: no explanation in the manual`);
		manuals++;
	}
	assert.ok(INSIDE.length < 300 && BAL.length < 300, `the lines are short (${INSIDE.length}, ${BAL.length})`);
	console.log(`ok manual: ${manuals} manuals, each row the variant tells in one line (${INSIDE.length} and ${BAL.length} characters), no explanation`);

	// 2. sessions
	let n = 0;
	const session = (calls, { figure = "block", off = [], variant = "studio" } = {}) => {
		const tool = createCompileTool({ name: `once-${n}`, outDir: join(TMP, `${n}`), clipFile: join(TMP, `${n++}.json`), variant, off, figure });
		return calls.map(c => tool.call(c).text.split("\n"));
	};
	const counts = (texts, re) => texts.map(t => t.filter(l => re.test(l)).length);
	const firstTold = (texts, re) => texts.findIndex(t => t.some(l => re.test(l)));
	const insideRow = /^- \S+(?:'s body)? inside \S+: /, balRow = /^- at rest: /;
	// the explanation comes right after the told lines
	const after = (t, re) => { const k = t.findIndex(l => re.test(l)); assert.ok(k > 0 && (t[k - 1].startsWith("- ") || SAID_IN.test(t[k - 1]) || SAID_BAL.test(t[k - 1])), `right after the told lines:\n${t.join("\n")}`); };
	const wall = { id: "wall", size: [2, 2, 0.2], at: [0, 1, 1.5] }, crate = { id: "crate", size: [0.4, 0.4, 0.4], at: [0, 1.7, 0] };
	const scene = props => ({ frames: 120, characters: [{ id: "a", at: [0, 0], heading: 0 }], props });
	const walk = { a: [[5, "walk", { to: [0, 3] }]] }, lean = { a: [[0, "pose", { hip: [0.3, 0, 0], over: 0 }]] };
	for (const figure of ["block", "cube", "no-such-look"]) {
		// at the first compile, again at the second: said once
		let t = session([{ scene: scene([wall]), spec: walk }, { spec: { a: [[5, "walk", { to: [0, 3.2] }]] } }], { figure });
		assert.deepEqual(counts(t, SAID_IN), [1, 0], "said at the first compile only"); assert.ok(t[1].some(l => insideRow.test(l)), "the row is told again");
		after(t[0], SAID_IN);
		const said = t[0].find(l => SAID_IN.test(l));
		assert.ok(said.includes(`each part as the ${figure === "cube" ? "cube" : "block"} look draws it`), `the look measured: ${said}`);
		assert.ok(said.includes(`on ${SEEN} frames in a row or more (at ${FPS} fps the fewest that last a tenth of a second)`), said);
		assert.ok(said.includes("Not told: a body with a prop it holds, carries, pushes or places"), said);
		// at a later compile, then gone and back: said where it first appears, once
		t = session([{ scene: scene([]), spec: walk }, { scene: scene([wall]) }, { scene: scene([]) }, { scene: scene([wall]) }], { figure });
		assert.deepEqual(counts(t, SAID_IN), [0, 1, 0, 0]); assert.equal(firstTold(t, insideRow), 1);
		// never
		t = session([{ scene: scene([]), spec: walk }, { spec: { a: [[5, "walk", { to: [1, 3] }]] } }], { figure });
		assert.deepEqual([...counts(t, SAID_IN), ...counts(t, SAID_BAL)], [0, 0, 0, 0]);
		// the at rest row first, a look, a rejected call, then the inside row
		t = session([{ scene: scene([]), spec: lean }, { look: { frames: [5, 50], view: "side" } }, { spec: { a: [[0, "walk", { to: "x" }], [500, "idle"]] } }, { scene: scene([crate]) }, { spec: { a: [[0, "idle"]] } }], { figure });
		assert.equal(firstTold(t, balRow), 0); assert.deepEqual(counts(t, SAID_BAL), [1, 0, 0, 0, 0]); after(t[0], SAID_BAL);
		assert.equal(counts(t, SAID_IN).reduce((a, b) => a + b, 0), 1); assert.equal(counts(t, SAID_IN).indexOf(1), firstTold(t, insideRow));
		// both at once; each switched off by name; the base variant
		t = session([{ scene: scene([crate]), spec: lean }, { spec: { a: [[0, "pose", { hip: [0.32, 0, 0], over: 0 }]] } }], { figure });
		for (const [said, row] of [[SAID_IN, insideRow], [SAID_BAL, balRow]]) { const k = firstTold(t, row); if (k >= 0) assert.equal(counts(t, said).indexOf(1), k); assert.equal(counts(t, said).reduce((a, b) => a + b, 0), k >= 0 ? 1 : 0); }
		for (const off of [["inside"], ["balance"], ["inside", "balance"]]) {
			t = session([{ scene: scene([crate]), spec: lean }], { figure, off });
			if (off.includes("inside")) assert.equal(counts(t, SAID_IN)[0], 0, "inside off: not said");
			if (off.includes("balance")) assert.equal(counts(t, SAID_BAL)[0], 0, "balance off: not said");
		}
		t = session([{ scene: scene([wall]), spec: walk }, { scene: scene([wall]), spec: lean }], { figure, variant: "base" });
		assert.deepEqual(counts(t, SAID_IN), [1, 0], "base variant: said once"); assert.deepEqual(counts(t, SAID_BAL), [0, 0], "base variant has no at rest row");
	}
	// 3. the at rest explanation: its numbers are the row's limits (verify-balance-row.mjs states them: mm at scale 1, frames)
	const t = session([{ scene: scene([]), spec: lean }]), said = t[0].find(l => SAID_BAL.test(l));
	for (const part of ["lies in 12 frames in a row", "within 30 mm times its scale of one another", "at most 2 mm times its scale to each neighbouring frame", "within 100 mm times the scale of the floor", "over frames (12 when not given)", "within 10 mm times the scale of the floor", "from 60 mm behind the ankle to the toe tip, 90 mm wide", "a hand or an elbow within 10 mm of its target", "a knee within 100 mm times the scale"]) assert.ok(said.includes(part), `the at rest explanation says ${part}`);
	assert.deepEqual([...new Set(said.match(/\d+/g).map(Number))].sort((a, b) => a - b), [2, 10, 12, 30, 60, 90, 100], "no other number");
	console.log("ok sessions: each explanation once, right after the told lines where its row first appears; never without the row or with the row off; its numbers as computed here");
} finally {
	rmSync(TMP, { recursive: true, force: true });
}
console.log("PASS verify-told-once");
