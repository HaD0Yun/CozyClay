#!/usr/bin/env node
// Stable patch addressing (json-patch.js): an array step "@field=value" picks the element by a field
// instead of an index (keys by frame, skills by name and f0, goals by name), add through a selector
// creates the element, remove drops every key at a frame, move retimes a key; index paths keep
// working, and a selector that matches nothing lists what is there so a retry lands.
import { applyPatch } from "../../src/motion3/json-patch.js";

let failures = 0;
function expect(name, condition, detail = "") {
	console.log(`${condition ? "PASS" : "FAIL"} ${name}${condition ? "" : ` — ${detail}`}`);
	if (!condition) failures += 1;
}
const json = JSON.stringify;
const refusal = fn => { try { fn(); return ""; } catch (error) { return error.message; } };
const spec = () => ({ keys: [{ f: 0, set: { root: [0, 0.97, 0] } }, { f: 24, set: { hand_l: [0.2, 1, 0.3] } }, { f: 24, set: { pitch: 10 } }, { f: 60, set: { hand_l: [0.2, 1.2, 0.3] } }],
	use: [{ skill: "reach", f0: 10, args: { at: [0, 0] } }, { skill: "reach", f0: 40, args: { at: [1, 0] } }, { skill: "walkTo", f0: 0, args: { to: [0, 1] } }],
	goals: [{ name: "cup lifted", at: 70 }], objects: { cup: { prop: "grip", keys: [{ f: 40, pos: [0, 1, 0] }] } } });
const keysAt = (s, f) => s.keys.filter(k => k.f === f);

// 1. set a channel on the key at a frame: the one that holds it, else created
let s = applyPatch(spec(), [{ op: "replace", path: "/keys/@f=24/set/hand_l", value: [0.3, 1, 0.3] }]);
expect("replace by frame edits the key at 24 that sets the channel", json(s.keys[1].set.hand_l) === json([0.3, 1, 0.3]) && s.keys.length === 4, json(s.keys));
s = applyPatch(spec(), [{ op: "add", path: "/keys/@f=24/set/elbow_l", value: [1, 0, 0] }]);
expect("add of a new channel at a keyed frame lands on the last key there (it wins the bake)", json(s.keys[2].set) === json({ pitch: 10, elbow_l: [1, 0, 0] }) && s.keys.length === 4, json(s.keys));
s = applyPatch(spec(), [{ op: "add", path: "/keys/@f=30/set/hand_l", value: [0, 1, 0] }]);
expect("add at an unkeyed frame creates { f, set }", json(keysAt(s, 30)) === json([{ f: 30, set: { hand_l: [0, 1, 0] } }]) && s.keys.length === 5, json(s.keys));
const notes = [];
s = applyPatch(spec(), [{ op: "replace", path: "/keys/@f=31/set/hand_l", value: [0, 1, 0] }], notes);
expect("a lenient replace at an unkeyed frame creates the key and says so", keysAt(s, 31).length === 1 && notes.length === 1 && /created \/keys\/4 \(f=31\)/.test(notes[0]), json(notes));
expect("repair's strict replace at an unkeyed frame is refused, listing the nearest frames", /\/keys\/@f=31 matches nothing \(keys has 4 entries; by f: \/keys\/@f=<f>, f 0, 24, 60\)/.test(refusal(() => applyPatch(spec(), [{ op: "replace", path: "/keys/@f=31/set/hand_l", value: 1 }]))));

// 2. remove and move by frame
s = applyPatch(spec(), [{ op: "remove", path: "/keys/@f=24" }]);
expect("remove /keys/@f=24 removes every key at 24", keysAt(s, 24).length === 0 && s.keys.length === 2, json(s.keys));
s = applyPatch(spec(), [{ op: "remove", path: "/keys/@f=24/set/pitch" }]);
expect("remove of a channel picks the key at the frame that has it", json(s.keys[2].set) === "{}" && json(s.keys[1].set.hand_l) === json([0.2, 1, 0.3]));
s = applyPatch(spec(), [{ op: "move", from: "/keys/@f=24", path: "/keys/@f=32" }]);
expect("move retimes the keys at 24 to 32, merged into one", keysAt(s, 24).length === 0 && json(keysAt(s, 32)) === json([{ f: 32, set: { hand_l: [0.2, 1, 0.3], pitch: 10 } }]), json(s.keys));
expect("move onto a keyed frame is refused", /already has an entry with f=60/.test(refusal(() => applyPatch(spec(), [{ op: "move", from: "/keys/@f=24", path: "/keys/@f=60" }]))));
expect("remove at an unkeyed frame lists the nearest keyed frames", /keys has no entry with f=25 \(.*f 0, 24, 60\)/.test(refusal(() => applyPatch(spec(), [{ op: "remove", path: "/keys/@f=25" }]))));
s = applyPatch(spec(), [{ op: "replace", path: "/objects/cup/keys/@f=40/pos", value: [0, 1.1, 0] }]);
expect("an object key by frame", json(s.objects.cup.keys[0].pos) === json([0, 1.1, 0]));

// 2b. add on a keyed frame (#1126; trip-run v2: patch[13] add /keys/@f=44 refused a 28-op patch): with notes
// (motion.compile) it merges into the key that wins the bake, set channel by channel, and says what it added and replaced
const merged = [];
s = applyPatch(spec(), [{ op: "add", path: "/keys/@f=24", value: { f: 24, set: { pitch: 30, elbow_l: [1, 0, 0] }, step: ["pitch"] } }], merged);
expect("add on a keyed frame merges into its last key, the value winning", s.keys.length === 4 && json(keysAt(s, 24)) === json([{ f: 24, set: { hand_l: [0.2, 1, 0.3] } }, { f: 24, set: { pitch: 30, elbow_l: [1, 0, 0] }, step: ["pitch"] }])
	&& json(merged) === json(["corrected: patch[0] (add /keys/@f=24): keys already had a key at f=24; merged into it, set adds elbow_l, set replaces pitch"]), json([s.keys, merged]));
s = applyPatch(spec(), [{ op: "add", path: "/objects/cup/keys/@f=40", value: { pos: [0, 1.2, 0] } }], []);
expect("an object key at a keyed frame merges the same way", json(s.objects.cup.keys) === json([{ f: 40, pos: [0, 1.2, 0] }]), json(s.objects.cup.keys));
expect("without notes (repair) add on a keyed frame is refused as before", /patch\[0\] \(add \/keys\/@f=24\): keys already has an entry with f=24; replace its fields or remove it first/.test(refusal(() => applyPatch(spec(), [{ op: "add", path: "/keys/@f=24", value: { f: 24, set: { pitch: 30 } } }]))));
// a move onto a keyed frame has two readings (push-crate v2: 374->377, 378->381, 381->385 meant a shift, a merge would put two keys at 385)
expect("a move onto a keyed frame is refused even with notes", /patch\[0\] \(add \/keys\/@f=60\): keys already has an entry with f=60; replace its fields or remove it first/.test(refusal(() => applyPatch(spec(), [{ op: "move", from: "/keys/@f=24", path: "/keys/@f=60" }], []))));
expect("add on a keyed goal name is refused (only frame selectors on keys merge)", /goals already has an entry with name=cup lifted/.test(refusal(() => applyPatch(spec(), [{ op: "add", path: "/goals/@name=cup lifted", value: { at: 75 } }], []))));

// 3. by name: skills, goals; ambiguity names the field that tells them apart
s = applyPatch(spec(), [{ op: "replace", path: "/use/@skill=reach&f0=40/args/at", value: [2, 0] }, { op: "replace", path: "/goals/@name=cup lifted/at", value: 72 }]);
expect("a skill by name and f0, a goal by name", json(s.use[1].args.at) === json([2, 0]) && s.goals[0].at === 72 && json(s.use[0].args.at) === json([0, 0]));
expect("two reaches: refused with their f0s and how to narrow it", /2 use entries have skill=reach \(f0 10, 40; add &f0=<f0>\)/.test(refusal(() => applyPatch(spec(), [{ op: "replace", path: "/use/@skill=reach/args/at", value: [1, 1] }]))));
expect("an unknown skill lists the skills there", /use has 3 entries; by skill: \/use\/@skill=<skill>, skill reach, walkTo/.test(refusal(() => applyPatch(spec(), [{ op: "replace", path: "/use/@skill=sit/args/at", value: 1 }]))));

// 4. index paths are unchanged; an index miss now says how to address by frame
s = applyPatch(spec(), [{ op: "replace", path: "/keys/1/set/hand_l", value: [0, 0, 0] }, { op: "add", path: "/keys/-", value: { f: 90, set: {} } }, { op: "test", path: "/keys/4/f", value: 90 }]);
expect("index replace, append and test still work", json(s.keys[1].set.hand_l) === json([0, 0, 0]) && s.keys[4].f === 90);
expect("an index past the end names the length and the frames", /\/keys\/12 does not exist \(keys has 4 entries; by f: \/keys\/@f=<f>, f 0, 24, 60\)/.test(refusal(() => applyPatch(spec(), [{ op: "replace", path: "/keys/12/f", value: 1 }]))));
expect("the base spec is never changed", json(spec()) === json((() => { const b = spec(); applyPatch(b, [{ op: "remove", path: "/keys/@f=24" }]); return b; })()));

if (failures) { console.error(`${failures} motion3 patch-keys check(s) failed`); process.exit(1); }
console.log("motion3 patch-keys: all checks passed");
