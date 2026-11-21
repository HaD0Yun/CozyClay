#!/usr/bin/env node
// Browser contract: during playback a routed car and the Follow-mode shot
// camera that tracks it are painted on the SAME timeline frame. Props and
// carriers read the playhead from a ref inside useFrame while the camera rigs
// used to receive it as a React prop one paint later, so the car advanced on
// one paint and the camera on the next. The picture then shows the car
// stuttering against the lens (judder) although both paths are smooth on paper.
//
// The scene is seeded with a car on a 40 m straight route, Character 1 grouped
// under it through the Outliner drag (#655) and one Follow shot. The studio
// plays with Space and every requestAnimationFrame samples the playhead, the
// car's world z (as props.jsx published it for that paint), the rider's body
// world z and the shot camera z. Contract:
//   1. no paint moves only the car or only the camera (both move, or neither);
//   2. the car-to-camera planar gap changes by < 1 mm between paints. On a
//      straight, constant-speed route at steady state the Follow track holds a
//      constant gap (response damping converges to it, and the max dolly speed
//      of 4 m/s is above the car's speed), so any per-paint change in the gap
//      means the two were sampled on different frames;
//   3. the rider's body stays fixed relative to the car (< 1 mm per paint).
// Paints with no playhead change are fine (headless rAF may repaint early), and
// the warm-up paints plus any paint where the playhead wrapped are ignored.
//
// Run: `CCLAY_KIMODO_HOST= COZYCLAY_LIVE_PORT=5897 npm run dev -- --port 5797`
// in one shell, then
// `QA_URL=http://127.0.0.1:5797/app/ CDP_PORT=9448 node tools/qa-browser.mjs -- node test/qa-follow-judder-browser.mjs`
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { SCENES_STORAGE_KEY } from "../src/scenes.js";
import { cameraBrowser } from "./camera-browser-harness.mjs";

const out = process.env.QA_OUT || "/tmp/follow-judder-qa";
const studioUrl = process.env.QA_URL ?? "http://127.0.0.1:5180/app/";
const b = await cameraBrowser(), { send, evaluate } = b;

const FOLLOW_DISTANCE = 3;
const ROUTE = 40;
await send("Runtime.enable");
await send("Page.enable");
// Seed storage on a same-origin page that has no editor to autosave over it.
await b.navigate(`${new URL(studioUrl).origin}/favicon.ico`);
await evaluate(`(() => {
	const shot = {
		id: "follow-judder-qa", name: "Follow judder QA", startFrame: 0, endFrame: 359,
		cameraKeys: [{ frame: 0, framing: { pos: { x: 0, y: 1.6, z: -3 }, yaw: Math.PI, pitch: -0.1, fovDeg: 45 } }],
		camera: { mode: "follow", followCam: { distance: ${FOLLOW_DISTANCE}, height: 1.6, response: 0.7, lead: 0.25, maxDollySpeed: 4, pitchOffsetDeg: 0, orbitOffsetDeg: 0 } },
	};
	const scene = {
		version: 4, activeSceneId: "scene-follow-judder",
		scenes: [{
			id: "scene-follow-judder", name: "FOLLOW JUDDER QA", objects: [],
			shotDocument: { version: 4, frameCount: 360, shots: [shot], waypoints: [] },
			stage: { characters: [{ id: "char-a", model: "y-bot-tpose", x: 0, y: 0.62, z: 0, rot: 0, hidden: false, pose: null, subject: "a driver" }], hasCharSheet: false, shotAspect: "16:9" },
		}],
	};
	localStorage.clear();
	localStorage.setItem("cozyclay.locale", "en");
	localStorage.setItem("cozyclay.project-session.v1", JSON.stringify({ name: "Follow judder QA", updatedAt: Date.now() }));
	localStorage.setItem(${JSON.stringify(SCENES_STORAGE_KEY)}, JSON.stringify(scene));
})()`);
await b.navigate(studioUrl);
await b.arm("Boolean(window.__cozyclay?.scrub && window.__cozyclay.rigA?.parent && window.__cozyclay.shotCam)", 60000);
await b.settled();

// The car is built the way the app builds one, routed, and the character is
// grouped under it by dragging its Outliner row onto the car's row (#655).
const car = await evaluate(`(() => {
	const api = window.__cozyclay.sceneObject;
	const id = api.place({ kind: "cube", name: "Vintage Car", x: 0, y: 0.4, z: 0 }).id;
	api.update({ id, scaleX: 1.3, scaleY: 0.22, scaleZ: 3.6, path: { points: [{ x: 0, y: 0.4, z: 0 }, { x: 0, y: 0.4, z: ${ROUTE} }] } });
	return id;
})()`);
await b.change(`!!document.querySelector('[data-node-id="object:${car}"]')`, () => evaluate(`(() => {
	if (document.querySelector('[data-node-id="object:${car}"]')) return;
	const fold = document.querySelector('[data-node-id="props"] .hierarchy-toggle');
	if (fold && fold.textContent.trim() === "▸") fold.click();
})()`));
await b.change(`window.__cozyclay.characters[0].parent===${JSON.stringify(car)}`, () => evaluate(`(() => {
	const source = document.querySelector('[data-node-id="character:char-a"]');
	const target = document.querySelector('[data-node-id="object:${car}"]');
	const dataTransfer = new DataTransfer();
	const fire = (node, type) => node.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer }));
	fire(source, "dragstart"); fire(target, "dragenter"); fire(target, "dragover"); fire(target, "drop"); fire(source, "dragend");
})()`));


// Play and sample every painted frame, all read in the same rAF.
await b.change(`window.__cozyclay.tlFrame===0&&window.__cclayPropWorld?.[${JSON.stringify(car)}]?.frame===0`, () => evaluate("window.__cozyclay.scrub(0)"));
await evaluate(`document.activeElement?.blur?.(); document.body.focus();`);
await evaluate(`(() => { window.__judderSamples = new Promise((resolve) => {
	const out = []; const t0 = performance.now();
	const body = window.__cozyclay.rigA.parent; const cam = window.__cozyclay.shotCam;
	const v = new body.position.constructor();
	(function tick() {
		const prop = window.__cclayPropWorld?.[${JSON.stringify(car)}];
		body.updateWorldMatrix(true, false); body.getWorldPosition(v);
		out.push({ t: +(performance.now() - t0).toFixed(1), tl: window.__cozyclay.tlFrame, carF: prop?.frame, carX: prop?.x, carZ: prop?.z, bodyX: v.x, bodyZ: v.z, camX: cam.position.x, camZ: cam.position.z });
		if (performance.now() - t0 < 4000) requestAnimationFrame(tick); else resolve(out);
	})();
}); return true; })()`);
for (const type of ["rawKeyDown", "keyUp"]) await send("Input.dispatchKeyEvent", { type, key: " ", code: "Space", windowsVirtualKeyCode: 32 });
const samples = await evaluate("window.__judderSamples");
await mkdir(out, { recursive: true });
await writeFile(`${out}/judder.json`, JSON.stringify(samples));

const WARMUP = 5;
const EPS = 1e-6; // metres: below this a coordinate did not move
const TOLERANCE = 0.001; // 1 mm
assert.ok(samples.every((s) => Number.isFinite(s.carZ) && Number.isFinite(s.camZ) && Number.isFinite(s.bodyZ)), "every paint reads the car, the rider and the camera");
const rows = samples.slice(WARMUP);
// Pair each paint with the previous one, dropping pairs where the playhead
// wrapped back (loop) or the car's frame did.
const pairs = rows.slice(1).map((r, i) => ({ a: rows[i], b: r })).filter(({ a, b }) => b.tl >= a.tl && b.carF >= a.carF);
const planar = (r) => Math.hypot(r.carX - r.camX, r.carZ - r.camZ);
const carMoved = ({ a, b }) => Math.abs(b.carZ - a.carZ) > EPS;
const camMoved = ({ a, b }) => Math.abs(b.camZ - a.camZ) > EPS;
const carOnly = pairs.filter((p) => carMoved(p) && !camMoved(p));
const camOnly = pairs.filter((p) => camMoved(p) && !carMoved(p));
const both = pairs.filter((p) => carMoved(p) && camMoved(p));
const gapJumps = pairs.map(({ a, b }) => Math.abs(planar(b) - planar(a)));
const bodyJumps = pairs.map(({ a, b }) => Math.abs((b.bodyZ - b.carZ) - (a.bodyZ - a.carZ)));
const gaps = rows.map(planar);
const summary = {
	paints: rows.length,
	comparedPaints: pairs.length,
	playheadFrames: { first: rows[0].tl, last: rows.at(-1).tl },
	carZ: { first: +rows[0].carZ.toFixed(3), last: +rows.at(-1).carZ.toFixed(3) },
	paintsWhereCarMovedButCameraDidNot: carOnly.length,
	paintsWhereCameraMovedButCarDidNot: camOnly.length,
	bothMoved: both.length,
	neitherMoved: pairs.length - carOnly.length - camOnly.length - both.length,
	carMinusCamGap: { min: +Math.min(...gaps).toFixed(3), max: +Math.max(...gaps).toFixed(3), maxJumpPerPaint: +Math.max(...gapJumps).toFixed(4) },
	bodyMinusCarMaxJump: +Math.max(...bodyJumps).toFixed(4),
};
console.log(JSON.stringify(summary, null, 1));

// Not vacuous (counts paints where either moved, so the buggy tree reaches the
// real assertions below): the take really played and the car really travelled.
assert.ok(carOnly.length + camOnly.length + both.length >= 20, `enough paints moved the car or the camera to judge them: ${JSON.stringify(summary)}`);
assert.ok(summary.carZ.last - summary.carZ.first > 5, `the car travelled along its route: ${JSON.stringify(summary.carZ)}`);
assert.equal(carOnly.length + camOnly.length, 0, `car and camera must move on the same painted frames (car-only ${carOnly.length}, camera-only ${camOnly.length}): ${JSON.stringify(summary)}`);
assert.ok(summary.carMinusCamGap.maxJumpPerPaint < TOLERANCE, `the car-to-camera gap must not jitter between paints (max ${summary.carMinusCamGap.maxJumpPerPaint} m, range ${summary.carMinusCamGap.min}..${summary.carMinusCamGap.max} m): ${JSON.stringify(summary)}`);
assert.ok(summary.bodyMinusCarMaxJump < TOLERANCE, `the rider stays fixed on the car: ${JSON.stringify(summary)}`);
console.log("follow judder browser QA: the car and its Follow camera are painted on the same frame");
b.close();
