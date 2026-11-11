#!/usr/bin/env node
// verify_result visual "closeup" (src/closeup-framing.js): which objects it draws, and that its three cameras hold the
// object's box (and the stand-in's lower body) inside the lens at any size, from the views they name.
import assert from "node:assert/strict";
import { CLOSEUP_PANE, closeupCameras, closeupTargets, figureSpot } from "../src/closeup-framing.js";
import { matFromQuat, dot, sub } from "../src/motion3/compiler/math.js";
import { validateStudioCommand } from "../src/studio-agent-protocol.js";

const objects = [{ id: "pot" }, { id: "truck" }, { id: "wheel", parent: "truck" }, { id: "hub", parent: "wheel" }, { id: "rock" }];
const scene = { objects, characters: [{ id: "char-a" }] };
const refusal = (args, code, pattern) => assert.throws(() => closeupTargets(args, scene), error => error.code === code && pattern.test(error.message));

// ---- targets ----
assert.deepEqual(closeupTargets({ targets: ["pot"] }, scene), { targets: ["pot"], ids: ["pot"] });
assert.deepEqual(closeupTargets({ targets: ["truck"] }, scene).ids, ["truck", "wheel", "hub"], "a group root draws its descendants");
assert.deepEqual(closeupTargets({}, scene, { affectedIds: ["char-a", "rock"] }).targets, ["rock"], "a receipt's objects, characters left out");
refusal({}, "INVALID_ARGUMENT", /1 to 4 object ids/);
refusal({ targets: ["pot", "truck", "wheel", "hub", "rock"] }, "INVALID_ARGUMENT", /at most 4/);
refusal({ targets: ["char-a"] }, "INVALID_ARGUMENT", /char-a is a character/);
refusal({ targets: ["ghost"] }, "STALE_TARGET", /no object ghost/);
assert.equal(validateStudioCommand({ name: "verify_result", args: { targets: ["pot"], checks: ["placement"], visual: "closeup" } }).args.visual, "closeup", "the schema takes closeup");

// ---- cameras ----
const aspect = CLOSEUP_PANE.width / CLOSEUP_PANE.height;
/** Normalised screen x, y in -1..1 of world p (camera looks down -back). */
function screen(cam, p) {
	const R = matFromQuat(cam.quaternion), right = [R[0][0], R[1][0], R[2][0]], up = [R[0][1], R[1][1], R[2][1]], back = [R[0][2], R[1][2], R[2][2]];
	const rel = sub(p, cam.eye), depth = -dot(rel, back), tan = Math.tan((cam.fovDeg * Math.PI) / 360);
	assert.ok(depth > cam.near && depth < cam.far, `${cam.name}: ${p} between near and far`);
	return [dot(rel, right) / (depth * tan * aspect), dot(rel, up) / (depth * tan)];
}
const corners = ({ min, max }) => [0, 1].flatMap(i => [0, 1].flatMap(j => [0, 1].map(k => [[min, max][i][0], [min, max][j][1], [min, max][k][2]])));
const cases = {
	small: { min: [-0.15, 0, -0.1], max: [0.15, 0.3, 0.1] },
	tall: { min: [2, 0, 3], max: [3.2, 6, 4] },
	deep: { min: [-0.4, 0, -2], max: [0.4, 1.2, 2] },
	floating: { min: [-1, 2, -1], max: [1, 3, 1] },
};
for (const [label, box] of Object.entries(cases)) {
	const cams = closeupCameras(box), names = cams.map(c => c.name);
	assert.deepEqual(names, ["three-quarter", label === "deep" ? "side" : "front", "top"], `${label}: the longer silhouette`);
	for (const cam of cams) {
		const points = corners(box).map(p => screen(cam, p));
		for (const [x, y] of points) assert.ok(Math.abs(x) <= 1 && Math.abs(y) <= 1, `${label} ${cam.name}: corner inside the frame (${x.toFixed(2)}, ${y.toFixed(2)})`);
		// fitted, not lost in the middle: the box spans at least 35% of the frame one way
		const span = k => Math.max(...points.map(p => p[k])) - Math.min(...points.map(p => p[k]));
		if (cam.name === "top" || label !== "small") assert.ok(Math.max(span(0), span(1)) >= 0.7, `${label} ${cam.name}: box fills the frame (${span(0).toFixed(2)} x ${span(1).toFixed(2)})`);
	}
	const [quarter, side, top] = cams, centre = box.min.map((v, i) => (v + box.max[i]) / 2);
	assert.ok(quarter.eye[0] > centre[0] && quarter.eye[2] > centre[2] && quarter.eye[1] > centre[1], `${label}: three-quarter from the front-right, above`);
	assert.ok(top.eye[1] > box.max[1] && Math.abs(top.eye[0] - top.target[0]) < 1e-6, `${label}: top looks straight down`);
	// the stand-in's feet are in both side views, clear of the box
	const feet = figureSpot(box);
	assert.ok(feet[0] < box.min[0] && feet[2] > box.max[2], `${label}: the figure stands off the front-left corner`);
	for (const cam of [quarter, side]) {
		// the figure's side toward the box (0.28 m from its middle), at the foot
		const at = figureSpot(box, cam.name), inner = cam.name === "side" ? [at[0], 0, at[2] - 0.28] : [at[0] + 0.28, 0, cam.name === "front" ? at[2] : at[2] - 0.28], [x, y] = screen(cam, inner);
		assert.ok(Math.abs(x) <= 1 && Math.abs(y) <= 1, `${label} ${cam.name}: the figure's near side is in frame`);
		const clear = at[0] < box.min[0] || at[2] > box.max[2];
		assert.ok(clear, `${label} ${cam.name}: the figure stands outside the box`);
	}
	// front and side: the figure is level with the box's middle in depth, so it reads at the box's scale
	const level = figureSpot(box, side.name), mid = i => (box.min[i] + box.max[i]) / 2;
	assert.ok(side.name === "front" ? level[2] === mid(2) : level[0] === mid(0), `${label}: ${side.name} figure at the box's depth`);
}
// a tall thing shows the whole figure, a small one at least its shin
const tallQuarter = closeupCameras(cases.tall)[0], [, headY] = screen(tallQuarter, [...figureSpot(cases.tall).slice(0, 1), 1.8, figureSpot(cases.tall)[2]]);
assert.ok(Math.abs(headY) <= 1, "tall: the figure's head is in frame");
console.log("closeup framing: ok");
