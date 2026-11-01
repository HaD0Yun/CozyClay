#!/usr/bin/env node
// patch-guard.js (deep research 5): PATCH_TOO_BROAD for a patch over 6 ops or one that mixes /anchors or /fix with key edits;
// keptFill: a small change to one authored key keeps the fill keys (no re-fill), anything more fills again.
import { patchTooBroad, smallKeyPatch, keptFill } from "../../src/motion3/patch-guard.js";
import { applyPatch } from "../../src/motion3/json-patch.js";

let failures = 0;
const expect = (name, ok, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` — ${detail}`}`); if (!ok) failures++; };
const key = (f, ch, value) => ({ op: "replace", path: `/keys/@f=${f}/set/${ch}`, value });

expect("two key ops are not too broad", patchTooBroad([key(40, "hand_r", [0, 1, 0.3]), key(40, "elbow_r", [0, -1, 0])]) === null);
expect("an anchors-only or a fix-only patch is not too broad", patchTooBroad([{ op: "add", path: "/anchors/0", value: {} }]) === null && patchTooBroad([{ op: "add", path: "/fix", value: {} }]) === null);
expect("no patch, no note", patchTooBroad(undefined) === null && patchTooBroad([]) === null);
const seven = Array.from({ length: 7 }, (_, i) => key(10 * i, "yaw", i));
expect("7 ops are too broad", /^PATCH_TOO_BROAD 7 ops: applied/.test(patchTooBroad(seven) ?? ""), patchTooBroad(seven));
expect("6 ops are not", patchTooBroad(seven.slice(0, 6)) === null);
const mixed = patchTooBroad([key(40, "yaw", 10), { op: "add", path: "/anchors/0", value: {} }, { op: "add", path: "/fix", value: {} }]);
expect("anchors and fix mixed with key edits are too broad", /^PATCH_TOO_BROAD \/anchors and \/fix mixed with key edits/.test(mixed ?? ""), mixed);
expect("both reasons join", /^PATCH_TOO_BROAD 8 ops; \/fix mixed/.test(patchTooBroad([...seven, { op: "add", path: "/fix", value: {} }]) ?? ""));


// the edit loop: base (authored f0 / f24 / f48 with fill keys between) + patch -> keep the fill or fill again
const fill = f => ({ f, set: { root: [0, 0.9, f / 100] }, src: "fill#0000000a.0000000b" });
const base = { frames: 49, keys: [{ f: 0, set: { root: [0, 0.9, 0], yaw: 0, hand_r: [0.2, 1, 0.3] } }, fill(8), fill(16),
	{ f: 24, set: { root: [0, 0.9, 0.5], yaw: 10, elbow_r: [0, -1, 0], hand_r: [0.2, 1.1, 0.4] } }, fill(32), { f: 48, set: { root: [0, 0.9, 1], yaw: 20 } }] };
const after = patch => applyPatch(base, patch);
const small = after([key(24, "hand_r", [0.21, 1.1, 0.41]), key(24, "yaw", 13)]);
expect("2 cm and 3 deg on one authored key: the fill is kept", keptFill(base, small)?.kept === true && keptFill(base, small).keys === 3, JSON.stringify(keptFill(base, small)));
expect("a pole moved 0.05: small; 0.2: not", smallKeyPatch(base, after([key(24, "elbow_r", [0.05, -1, 0])])) && !smallKeyPatch(base, after([key(24, "elbow_r", [0.2, -1, 0])])));
expect("4 cm: fills again", keptFill(base, after([key(24, "hand_r", [0.24, 1.1, 0.4])])) === null);
expect("6 deg: fills again", keptFill(base, after([key(24, "yaw", 16)])) === null);
expect("two authored keys: fills again", keptFill(base, after([key(24, "yaw", 11), key(48, "yaw", 21)])) === null);
expect("a new channel on the key: fills again", keptFill(base, after([{ op: "add", path: "/keys/@f=24/set/head_yaw", value: 2 }])) === null);
expect("a key moved in time or added: fills again", keptFill(base, after([{ op: "move", from: "/keys/@f=24", path: "/keys/@f=26" }])) === null
	&& keptFill(base, after([{ op: "add", path: "/keys/@f=40", value: { f: 40, set: { yaw: 15 } } }])) === null);
expect("a fill key edited: fills again (it is the author's now)", keptFill(base, after([key(16, "root", [0, 0.9, 0.17])])) === null);
expect("frames or fix changed with it: fills again", keptFill(base, after([key(24, "yaw", 11), { op: "replace", path: "/frames", value: 60 }])) === null);
expect("no fill keys to keep: null", keptFill({ ...base, keys: base.keys.filter(k => !k.src) }, applyPatch({ ...base, keys: base.keys.filter(k => !k.src) }, [key(24, "yaw", 11)])) === null);

if (failures) { console.error(`${failures} patch-guard check(s) failed`); process.exit(1); }
console.log("verify-motion3-patch-guard: all checks passed");
