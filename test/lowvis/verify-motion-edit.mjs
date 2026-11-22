#!/usr/bin/env node
// A change to a motion stated against the motion before it (src/lowvis/pi/edit.mjs, compile-tool.mjs kept, harness.mjs
// kept). Scenes and specs are made here.
// 1. applyEdit: the edited spec equals the whole spec written by hand; every action the edit does not name is the same
//    object text, in its place; several actions of one id with one frame and verb are named in their order; an id
//    left with no action leaves the spec; a bad entry or a removal of an action that is not there refuses the whole
//    edit with a message that names the entry.
// 2. The tool started from a kept motion compiles an edit-only first call to the same clip bytes and the same told
//    lines as a fresh tool sent the whole edited spec: the whole clip is compiled and checked either way. A whole spec
//    sent ends the kept state; without a kept motion an edit is refused as before; from a kept spec without its scene
//    the first call must send the scene.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyEdit } from "../../src/lowvis/pi/edit.mjs";
import { createCompileTool } from "../../src/lowvis/pi/compile-tool.mjs";

const TMP = mkdtempSync(join(tmpdir(), "lowvis-motion-edit-"));
const text = spec => Object.fromEntries(Object.entries(spec).map(([id, acts]) => [id, acts.map(a => JSON.stringify(a))]));

try {
	// 1. applyEdit
	const spec = {
		a: [[0, "idle"], [10, "walk", { to: [0, 2] }], [40, "pose", { hands: "rest" }], [40, "pose", { lean: 10 }], [60, "turn", { heading: 90 }]],
		b: [[0, "idle"], [20, "walk", { to: [1, 1], heading: 45 }]],
	};
	const frozen = JSON.stringify(spec);
	let r = applyEdit(spec, { a: [[10, "walk", { to: [0, 3] }], [60, "turn", null], [70, "pose", { bow: 20 }]] });
	assert.equal(JSON.stringify(spec), frozen, "the spec given is not changed");
	assert.deepEqual(r.spec, { a: [[0, "idle"], [10, "walk", { to: [0, 3] }], [40, "pose", { hands: "rest" }], [40, "pose", { lean: 10 }], [70, "pose", { bow: 20 }]], b: spec.b });
	assert.deepEqual(r.did, { replaced: 1, added: 1, removed: 1 });
	assert.equal(r.said, "edit: 1 replaced, 1 added, 1 removed; the spec now has 7 actions");
	const before = text(spec), after = text(r.spec);
	assert.deepEqual(after.b, before.b, "an id the edit does not name is byte-equal");
	for (const k of [0, 2, 3]) assert.equal(after.a[k], before.a[k], `untouched action a[${k}] is byte-equal and in its place`);
	// two actions of one id with one frame and verb: the edit's entries name them in their order
	r = applyEdit(spec, { a: [[40, "pose", { hands: "rest" }], [40, "pose", { lean: 20 }]] });
	assert.deepEqual(r.spec.a.slice(2, 4), [[40, "pose", { hands: "rest" }], [40, "pose", { lean: 20 }]]);
	assert.deepEqual(r.did, { replaced: 2, added: 0, removed: 0 });
	r = applyEdit(spec, { a: [[40, "pose", null], [40, "pose", null], [40, "pose", { twist: 5 }]] });
	assert.deepEqual(r.spec.a, [[0, "idle"], [10, "walk", { to: [0, 2] }], [60, "turn", { heading: 90 }], [40, "pose", { twist: 5 }]], "both removed, a third added at the end of the list");
	r = applyEdit(spec, { a: [[40, "pose", { hands: "rest" }], [40, "pose", { lean: 10 }], [40, "pose", { twist: 5 }]] });
	assert.deepEqual(r.did, { replaced: 2, added: 1, removed: 0 }, "a third entry where there are two is added");
	// an id with no actions yet; an entry with no options
	r = applyEdit(spec, { c: [[5, "idle"]] });
	assert.deepEqual(r.spec.c, [[5, "idle"]]);
	// an id the edit leaves with no action leaves the spec (so a character taken out of the scene can be edited out); an edit that names an id and nothing of it adds no id
	r = applyEdit(spec, { b: [[0, "idle", null], [20, "walk", null]] });
	assert.deepEqual(r.spec, { a: spec.a }); assert.equal(r.said, "edit: 0 replaced, 0 added, 2 removed; the spec now has 5 actions");
	assert.deepEqual(applyEdit(spec, { c: [] }).spec, spec);
	// refused whole, the entry named
	for (const [edit, want] of [
		[{ a: [[10, "walk", { to: [0, 3] }], [61, "turn", null]] }, /^edit\.a: \[61,"turn",null\] removes an action that is not there: a has no actions at frame 61 with verb "turn"$/],
		[{ a: [[40, "pose", null], [40, "pose", null], [40, "pose", null]] }, /^edit\.a: \[40,"pose",null\] removes an action that is not there: a has only 2 actions at frame 40 with verb "pose"$/],
		[{ a: [[60, "turn", { heading: 0 }], [60, "turn", { heading: 10 }], [60, "turn", null]] }, /^edit\.a: \[60,"turn",null\] removes an action that is not there: a has only 1 action at frame 60 with verb "turn"$/],
		[{ a: [["10", "walk", {}]] }, /^edit\.a: want \[frame, verb, options\] \(options an object, or null to remove\), got \["10","walk",\{\}\]$/],
		[{ b: [[10, "walk", [1, 2]]] }, /^edit\.b: want \[frame, verb, options\].*got \[10,"walk",\[1,2\]\]$/],
		[{ b: [[10, "walk", {}, 3]] }, /^edit\.b: want \[frame, verb, options\].*got \[10,"walk",\{\},3\]$/],
		[{ b: { 10: "walk" } }, /^edit\.b: want a list of \[frame, verb, options\], got \{"10":"walk"\}$/],
		[[1], /^edit: want \{ <id>: \[\[frame, verb, options\], \.\.\.\] \}, got \[1\]$/],
	]) {
		r = applyEdit(spec, edit);
		assert.match(r.error ?? "", want, JSON.stringify(edit));
		assert.equal(r.spec, undefined, "nothing applied");
	}
	assert.match(applyEdit(null, { a: [] }).error, /there is no spec yet/);
	console.log("PASS applyEdit: equals the hand-written spec, untouched actions byte-equal, same frame and verb named in order, bad edits refused whole and named");

	// 2. the tool from a kept motion
	let n = 0;
	const tool = kept => { const k = n++; return createCompileTool({ name: "edit", outDir: join(TMP, `${k}`), clipFile: join(TMP, `${k}.json`), variant: "studio", kept }); };
	const scene = { frames: 96, characters: [{ id: "a", at: [0, 0], heading: 0 }, { id: "b", at: [1.5, 0], heading: 0 }], props: [{ id: "box", size: [0.4, 0.4, 0.4], at: [0, 0.2, 2.6] }] };
	const first = { a: [[0, "idle"], [10, "walk", { to: [0, 2] }], [50, "pose", { lean: 15, over: 12 }]], b: [[0, "idle"], [20, "walk", { to: [1.5, 2] }]] };
	const edit = { a: [[10, "walk", { to: [0, 2.6] }]], b: [[60, "turn", { heading: -90 }]] };
	const whole = applyEdit(first, edit).spec;
	const fresh = tool(), sent = fresh.call({ scene, spec: whole });
	const kept = tool({ scene, spec: first }), got = kept.call({ edit });
	assert.equal(got.status, "ok", got.text);
	assert.equal(got.kept, true); assert.equal(sent.kept, false);
	const clipText = file => { const c = JSON.parse(readFileSync(file, "utf8")); delete c.stats.buildMs; return JSON.stringify(c); }; // buildMs: the time the build took
	assert.equal(clipText(kept.clipFile), clipText(fresh.clipFile), "the same clip as the whole spec sent");
	const lines = t => t.split("\n").filter(l => !/^motion \d+: compiled|^edit: /.test(l));
	assert.deepEqual(lines(got.text), lines(sent.text), "the same checks, table and notes as the whole spec sent");
	assert.match(got.text, /^edit: 1 replaced, 1 added, 0 removed; the spec now has 6 actions$/m);
	assert.deepEqual(text(kept.state.spec).a.slice(0, 1).concat(text(kept.state.spec).a.slice(2)), text(first).a.filter((_, k) => k !== 1), "untouched actions byte-equal in the stored spec");
	assert.deepEqual(text(kept.state.spec).b.slice(0, 2), text(first).b);
	assert.ok(got.rows.length > 0 && got.rows.length === sent.rows.length, "every row is measured over the whole clip");
	assert.match(got.text, /^- a's body inside box: /m, "the edit walks a into the box: told as for the whole spec");
	// a look alone compiles the kept motion; a rejected edit leaves it; a whole spec ends the kept state
	const look = tool({ scene, spec: first }), seen = look.call({ look: { view: "side" } });
	assert.equal(seen.status, "ok", seen.text); assert.equal(seen.kept, true);
	const bad = look.call({ edit: { a: [[11, "walk", null]] } });
	assert.equal(bad.status, "rejected"); assert.match(bad.text, /edit\.a: \[11,"walk",null\] removes an action that is not there/); assert.deepEqual(look.state.spec, first);
	assert.equal(look.call({ spec: whole }).kept, false); assert.equal(look.call({ edit }).kept, false, "an edit after a whole spec is not of the kept motion");
	// the kept objects are the tool's own copy
	const mine = { scene: structuredClone(scene), spec: structuredClone(first) }, own = tool(mine);
	own.call({ edit }); assert.deepEqual(mine.spec, first, "the caller's spec is not changed");
	// no kept motion: as before
	const none = tool(), refused = none.call({ edit });
	assert.equal(refused.status, "rejected"); assert.match(refused.text, /edit: there is no spec yet\. Send spec first/); assert.equal(refused.kept, false);
	assert.equal(tool({ scene }).call({ edit }).status, "rejected", "a kept scene without a spec is not kept");
	// a kept spec without its scene (the Studio scene is no longer that scene): the scene must be sent, then as above
	const bare = tool({ spec: first }), early = bare.call({ edit });
	assert.equal(early.status, "rejected"); assert.match(early.text, /^scene: missing\. Send scene: /m); assert.match(early.text, /The edit was not kept/); assert.deepEqual(bare.state.spec, first);
	const then = bare.call({ scene, edit });
	assert.equal(then.status, "ok", then.text); assert.equal(then.kept, true); assert.equal(clipText(bare.clipFile), clipText(fresh.clipFile), "the same clip as the whole spec sent");
	// a character taken out of the scene: its actions go by an edit, and the scene without it compiles
	const alone = tool({ spec: first }), solo = alone.call({ scene: { ...scene, characters: scene.characters.slice(0, 1) }, edit: { b: first.b.map(a => [a[0], a[1], null]) } });
	assert.equal(solo.status, "ok", solo.text); assert.deepEqual(alone.state.spec, { a: first.a });
	console.log("PASS kept motion: an edit-only call compiles the same clip and checks as the whole spec; untouched actions byte-equal; kept ends with a whole spec; a kept spec without its scene waits for the scene");
} finally {
	rmSync(TMP, { recursive: true, force: true });
}
