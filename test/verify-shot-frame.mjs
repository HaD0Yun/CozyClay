// Shot framing: the dock preview, Look through and every export frame the
// same picture (src/shot-frame.js). Pure math over the shared rule: project
// world points through the export camera and through each on-screen pane and
// compare normalized frame coordinates; the centre never moves with the ratio.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PerspectiveCamera, Vector3 } from "three";
import { fitAspect } from "../src/shot-frame.js";
import { SHOT_ASPECT_RATIOS, focalMmToFov, fovToFocalMm } from "../src/shot.js";
import { SHOT_ASPECT_PRESETS } from "../src/stage-startup-defaults.js";

let passed = 0;
const check = (name, fn) => { fn(); passed++; console.log("ok -", name); };
const RATIOS = ["16:9", "2.39:1", "4:3", "1:1", "9:16"].map(key => [key, SHOT_ASPECT_RATIOS[key]]);
const FOV = 45, POINTS = [[0, 1.5, -4], [0.9, 2.1, -3.5], [-1.2, 0.4, -5], [2.5, 1, -6]].map(p => new Vector3(...p));

function camera(aspect) {
	const cam = new PerspectiveCamera(FOV, aspect, 0.1, 100);
	cam.position.set(0.3, 1.6, 0.5);
	cam.rotation.set(-0.08, 0.15, 0, "YXZ");
	cam.updateMatrixWorld(true);
	cam.updateProjectionMatrix();
	return cam;
}
// The export: CaptureRig renders the shot camera with aspect = output w/h.
const exportUv = (aspect, p) => { const n = p.clone().project(camera(aspect)); return [(n.x + 1) / 2, (1 - n.y) / 2]; };
// A pane: DualRender sets camera.aspect = shot aspect and draws into fitAspect(pane).
function paneUv(pane, aspect, p) {
	const img = fitAspect(pane, aspect), n = p.clone().project(camera(aspect));
	const sx = img.x + ((n.x + 1) / 2) * img.w, sy = img.y + ((1 - n.y) / 2) * img.h;
	return [(sx - img.x) / img.w, (sy - img.y) / img.h];
}
const near = (a, b, tol = 0.01) => a.every((v, i) => Math.abs(v - b[i]) <= tol);

check("fitAspect is the largest centred rect of the aspect", () => {
	for (const [, aspect] of RATIOS) {
		const pane = { x: 272, y: 52, w: 1016, h: 573 }, r = fitAspect(pane, aspect);
		assert.ok(Math.abs(r.w / r.h - aspect) < 1e-9);
		assert.ok(Math.abs(r.x + r.w / 2 - (pane.x + pane.w / 2)) < 1e-9 && Math.abs(r.y + r.h / 2 - (pane.y + pane.h / 2)) < 1e-9);
		assert.ok(Math.abs(r.w - pane.w) < 1e-9 || Math.abs(r.h - pane.h) < 1e-9);
	}
});

check("preview card, Look through and export frame every point the same", () => {
	const panes = { preview: { x: 990, y: 679, w: 256, h: 144 }, lookThrough: { x: 272, y: 52, w: 1016, h: 573 } };
	for (const [key, aspect] of RATIOS) for (const p of POINTS) {
		const out = exportUv(aspect, p);
		for (const [name, pane] of Object.entries(panes)) assert.ok(near(paneUv(pane, aspect, p), out), `${name} ${key}`);
	}
});

check("the ratio changes the gate about the optical centre; the vertical FOV holds", () => {
	const axis = new Vector3(0, 0, -1).applyQuaternion(camera(1).quaternion).add(camera(1).position);
	const top = camera(16 / 9);
	const edge = new Vector3(0, 1, 0.5).unproject(top); // top-centre of the 16:9 frame
	for (const [key, aspect] of RATIOS) {
		assert.ok(near(exportUv(aspect, axis), [0.5, 0.5], 1e-6), `centre ${key}`);
		assert.ok(Math.abs(exportUv(aspect, edge)[1]) < 1e-6, `top edge ${key}`);
		assert.ok(Math.abs(exportUv(aspect, edge)[0] - 0.5) < 1e-6, `top centre ${key}`);
	}
});

check("user case: Camera mode, 2.39, 18 mm readout, Look through vs the 2390x1000 export", () => {
	const aspect = SHOT_ASPECT_RATIOS["2.39:1"], out = SHOT_ASPECT_PRESETS["2.39:1"];
	assert.ok(Math.abs(out.width / out.height - aspect) < 1e-9, "export size carries the shot aspect");
	// the lens readouts (rail 18mm, dock 18.2 mm) are the 45° shot FOV on the 2.39 gate
	const mm = fovToFocalMm(FOV * Math.PI / 180, "fullFrame", aspect);
	assert.ok(Math.abs(mm - 18.18) < 0.01 && Math.abs(focalMmToFov(mm, "fullFrame", aspect) * 180 / Math.PI - FOV) < 1e-9);
	// 1440x922 window: stage 248..1192 x 52..547, less 56px rails and 36px pill bands
	const pane = { x: 248 + 56, y: 52 + 36, w: 944 - 112, h: 495 - 72 };
	for (const p of POINTS) assert.ok(near(paneUv(pane, aspect, p), exportUv(out.width / out.height, p)));
});

check("Look through draws into the open stage, not under the panels", () => {
	const css = readFileSync(new URL("../src/shell/shell.css", import.meta.url), "utf8");
	const rule = /\[data-shot-look\]:not\(\[data-embed-mode\]\) \.vp-main,[^{]*\{([^}]*)\}/.exec(css)?.[1] ?? "";
	// clear of the panels, the tool rails and the exit pill, the same on both sides (centred)
	assert.ok(rule.includes("--shot-look-x: calc(var(--shell-gap) * 2 + 44px)") && rule.includes("--shot-look-y:"), "rail and pill bands");
	assert.ok(rule.includes("inset: calc(var(--shell-stage-top) + var(--shot-look-y)) calc(var(--shell-center-right) + var(--shot-look-x)) calc(var(--shell-center-bottom) + var(--shot-look-y)) calc(var(--shell-center-left) + var(--shot-look-x));"), "symmetric pane inset");
	const glass = readFileSync(new URL("../src/shell/glass.css", import.meta.url), "utf8");
	// One rail on the right edge holds both tool groups: 28px wide, a gutter off the stage edge
	// (still inside the 44px band the shot-look inset keeps clear on each side).
	assert.match(glass, /\.vp-overlay-rail \{[\s\S]*?right: 6px;[\s\S]*?width: 28px;/, "the merged rail is 28px wide, 6px inside the right edge");
	// the stage frame opens to the top gap; the bar floats over it
	assert.match(css, /--shell-view-top: var\(--shell-gap\);/);
	const dual = readFileSync(new URL("../src/dualview.jsx", import.meta.url), "utf8");
	assert.ok(dual.includes("draw(shotCam, shotPane, fitAspect(shotPane, shotAspect)") && dual.includes("draw(shotCam, previewRect, fitAspect(previewRect, shotAspect)"));
});

console.log(`\n${passed} shot-frame checks passed`);
