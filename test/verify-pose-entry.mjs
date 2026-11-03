#!/usr/bin/env node
// #1048: what a Pose click does when the active character cannot be posed yet.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { planPoseEntry, pointAt } from "../src/pose-entry.js";

const bot = (id) => ({ id, model: "y-bot-tpose" });
const capsule = (id) => ({ id, model: "proxy-figure" });
const REFUSED = "Load a character to pose it";

// Nothing refuses: Pose just opens.
assert.deepEqual(planPoseEntry([bot("a")], bot("a"), null), { enter: true });

// No character at all (a new project): refuse, point at Add.
const none = planPoseEntry([], { id: "charA", model: "y-bot-tpose" }, REFUSED);
assert.equal(none.selectId, undefined);
assert.equal(none.point, "add");
assert.match(none.reason, /Add a character/);

// Exactly one rigged character, not active (a capsule is): select it.
assert.deepEqual(planPoseEntry([capsule("c"), bot("a")], capsule("c"), "capsule refusal"), { selectId: "a" });

// The one character is active but its rig is still resolving: wait on it, do not refuse.
assert.deepEqual(planPoseEntry([bot("a")], bot("a"), REFUSED), { selectId: "a" });
// Same with several: the active rigged one wins.
assert.deepEqual(planPoseEntry([bot("a"), bot("b")], bot("b"), REFUSED), { selectId: "b" });

// Several rigged characters and a capsule active: refuse, point at the character rows.
const several = planPoseEntry([capsule("c"), bot("a"), bot("b")], capsule("c"), "capsule refusal");
assert.equal(several.selectId, undefined);
assert.equal(several.point, "characters");
assert.match(several.reason, /Select a character to pose/);

// Only capsules: none can be posed, so the capsule reason stands and Add is the way out.
assert.deepEqual(planPoseEntry([capsule("c")], capsule("c"), "capsule refusal"), { reason: "capsule refusal", point: "add" });

// pointAt lights the named targets and leaves unknown ones alone.
const lit = [];
const node = () => {
	const classes = new Set();
	const element = { classList: { add: (name) => { classes.add(name); lit.push(element); }, remove: (name) => classes.delete(name) }, offsetWidth: 1, classes };
	return element;
};
const rows = [node(), node()];
const asked = [];
const doc = { querySelectorAll: (selector) => { asked.push(selector); return selector.includes("data-kind='character'") ? rows : []; } };
pointAt("characters", doc);
assert.ok(rows.every((row) => row.classes.has("pose-point")), "every character row is lit");
pointAt("nowhere", doc);
assert.equal(asked.length, 1, "an unknown target queries nothing");
pointAt("add", undefined);

// The tab carries the planned state, and the rows carry their kind for the selector.
const app = readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");
assert.match(app, /poseRefusal: poseEntry\.blocked \? poseEntry\.plan\.reason : null/, "the toolbar disables Pose only when the click cannot help");
assert.match(readFileSync(new URL("../src/hierarchy-panel.jsx", import.meta.url), "utf8"), /data-kind=\{node\.kind\}/);
assert.match(readFileSync(new URL("../src/styles.css", import.meta.url), "utf8"), /\.vp-mode-key\[aria-disabled="true"\] \{ opacity/, "a disabled mode tab looks disabled");

console.log("pose entry: all checks passed");
setTimeout(() => process.exit(0), 0);
