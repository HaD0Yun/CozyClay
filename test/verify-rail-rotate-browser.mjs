#!/usr/bin/env node
// The rotate tool on a rail shot, the way the owner works: the camera tab, a rail mark (dot) clicked in the editor
// view while the Outliner holds something else, E. The dot then carries pan and tilt rings (no move arrows), and
// dragging a ring turns the camera at that place of the rail: stored on the mark, eased along the ride, one undo step
// per drag, kept over a reload. The camera's own rings still turn the whole shot. The math is in
// verify-crane-mark-turn.mjs.
// Run: `COZYCLAY_LIVE_PORT=5395 npm run dev -- --port 5195 --strictPort`, then
// `QA_URL=http://127.0.0.1:5195/app/ CDP_PORT=9342 node tools/qa-browser.mjs -- node test/verify-rail-rotate-browser.mjs`
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cameraBrowser } from "./camera-browser-harness.mjs";
import { SCENES_STORAGE_KEY } from "../src/scenes.js";
import { buildShotCameraTracks } from "../src/camera-direction.js";
import { buildRail } from "../src/camera-follow.js";
import { railTurnAt } from "../src/camera-rail-head.js";

const DEG = Math.PI / 180;
const dir = process.env.QA_EVIDENCE_DIR || "/tmp/rail-rotate-evidence";
mkdirSync(dir, { recursive: true });
const b = await cameraBrowser();
const log = [];
const shot = { id: "rail-r", name: "Rail R", startFrame: 0, endFrame: 119, cameraKeys: [],
	camera: { mode: "rail", cameraRail: [{ x: -3, z: 4 }, { x: 0, z: 5 }, { x: 3, z: 4 }], railFollow: { mode: "range", startFrame: 0, endFrame: 119 },
		craneHeight: { points: [{ t: 0, height: 1.6 }, { t: 0.5, height: 2.1 }, { t: 1, height: 1.6 }] } } };
const characters = [{ id: "char-a", name: "Ada", model: "y-bot-tpose", x: 0, z: 0, rot: 0, hidden: false, pose: null, subject: "a person" }];
// Where the dolly is on the rail at each frame (the character stands still at the origin): the turn a frame shows is
// the marks' turn at that place, so the check reads it from the stored marks, not from a frame number.
const progress = buildShotCameraTracks({ shots: [shot], subjectTrack: Array.from({ length: 120 }, () => ({ x: 0, z: 0 })), fps: 24 })
	.map((sample) => sample.s / buildRail(shot.camera.cameraRail).length);
const FRAMES = [0, progress.reduce((best, p, f) => (Math.abs(p - 0.5) < Math.abs(progress[best] - 0.5) ? f : best), 0), 119];
const expected = (crane, frame) => railTurnAt(crane, progress[frame])?.yawDeg ?? 0;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const settle = () => b.evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve))))");
const screenshot = async (name) => {
	await settle();
	const result = await b.send("Page.captureScreenshot", { format: "png" });
	writeFileSync(join(dir, `${name}.png`), Buffer.from(result.data, "base64"));
	log.push({ screenshot: `${name}.png` });
};
const stored = () => b.evaluate(`JSON.parse(localStorage.getItem('${SCENES_STORAGE_KEY}')).scenes[0].shotDocument.shots[0]`);
const waitShot = (condition) => b.change(`(() => { try { const s = JSON.parse(localStorage.getItem('${SCENES_STORAGE_KEY}')).scenes[0].shotDocument.shots[0]; return ${condition}; } catch { return false; } })()`, async () => {});
const seek = async (frame) => { await b.change(`window.__cozyclay.tlFrame === ${frame}`, () => b.evaluate(`window.__cozyclay.scrub(${frame})`)); await settle(); };
const angleAt = async (frame) => { await seek(frame); const pose = await b.pose(); return { yaw: pose.yaw, pitch: pose.pitch }; };
const key = async (keyName, code, keyCode, modifiers = 0) => {
	await b.evaluate("document.activeElement?.blur()");
	for (const type of ["keyDown", "keyUp"]) await b.send("Input.dispatchKeyEvent", { type, modifiers, key: keyName, code, windowsVirtualKeyCode: keyCode });
};
const clickAt = async (point) => {
	await b.mouse("mouseMoved", point);
	await b.mouse("mousePressed", { ...point, button: "left", buttons: 1, clickCount: 1 });
	await b.mouse("mouseReleased", { ...point, button: "left", buttons: 0, clickCount: 1 });
	await sleep(200);
};
// A mark's dot, and points on its rings, in client pixels through the editor camera (the main pane's rect).
const geometry = (index) => b.evaluate(`(async () => {
	const { buildRail, railPoint } = await import('/src/camera-follow.js');
	const shot = JSON.parse(localStorage.getItem('${SCENES_STORAGE_KEY}')).scenes[0].shotDocument.shots[0];
	const cam = window.__cozyclay.editorCam, V = cam.position.constructor, pane = document.querySelector('.vp-main').getBoundingClientRect();
	cam.updateMatrixWorld();
	const rail = buildRail(shot.camera.cameraRail), mark = shot.camera.craneHeight.points[${index}], at = railPoint(rail, mark.t * rail.length);
	const origin = new V(at.x, mark.height, at.z), scale = Math.max(0.35, cam.position.distanceTo(origin) * 0.16), r = 0.42 * scale;
	const px = (v) => { const p = v.clone().project(cam); return { x: Math.round(pane.left + (p.x + 1) / 2 * pane.width), y: Math.round(pane.top + (1 - p.y) / 2 * pane.height) }; };
	const pan = (deg) => px(new V(origin.x + r * Math.cos(deg * Math.PI / 180), origin.y, origin.z + r * Math.sin(deg * Math.PI / 180)));
	return { dot: px(origin), pan: Array.from({ length: 36 }, (_, i) => ({ deg: i * 10, ...pan(i * 10) })) };
})()`);
// Drag the pan ring by `sweep` degrees (positive turns the camera left), starting where it stands clear of the dot.
const dragPan = async (index, sweep) => {
	const g = await geometry(index);
	const ring = (deg) => g.pan[((Math.round(deg / 10) % 36) + 36) % 36];
	// a start the ring itself claims (not the tilt ring where the two cross), as far from the dot as it can be
	const claimed = [];
	for (const p of g.pan) if (await b.evaluate(`window.__craneRingAt?.(${p.x}, ${p.y})`) === "yawDeg") claimed.push(p);
	assert.ok(claimed.length >= 4, `the pan ring is on screen and takes a press (${claimed.length} of 36 points)`);
	const start = claimed.reduce((best, p) => (Math.hypot(p.x - g.dot.x, p.y - g.dot.y) > Math.hypot(best.x - g.dot.x, best.y - g.dot.y) ? p : best));
	await b.mouse("mouseMoved", { x: start.x, y: start.y });
	await b.mouse("mousePressed", { x: start.x, y: start.y, button: "left", buttons: 1, clickCount: 1 });
	// the ring's parameter runs the other way round the up axis from the pan (atan2(x, z) = 90° - deg)
	for (let i = 1; i <= 8; i += 1) { const p = ring(start.deg - (sweep * i) / 8); await b.mouse("mouseMoved", { x: p.x, y: p.y, button: "left", buttons: 1 }); await settle(); }
	const end = ring(start.deg - sweep);
	await b.mouse("mouseReleased", { x: end.x, y: end.y, button: "left", buttons: 0, clickCount: 1 });
	return start;
};

try {
	await b.send("Page.addScriptToEvaluateOnNewDocument", { source: `(() => {
		const write = Storage.prototype.setItem;
		Storage.prototype.setItem = function (key, value) {
			const result = write.call(this, key, value);
			if (this === localStorage && key === '${SCENES_STORAGE_KEY}') window.dispatchEvent(new Event('qa:camera-state'));
			return result;
		};
	})()` });
	await b.send("Emulation.setDeviceMetricsOverride", { width: 1438, height: 979, deviceScaleFactor: 1, mobile: false });
	await b.navigate(`${b.base.origin}/favicon.ico`);
	await b.evaluate(`(() => {
		localStorage.clear();
		localStorage.setItem('cozyclay.locale', 'en');
		localStorage.setItem('cozyclay.project-session.v1', JSON.stringify({ name: 'Rail rotate QA', updatedAt: Date.now() }));
		localStorage.setItem('${SCENES_STORAGE_KEY}', JSON.stringify({ version: 4, activeSceneId: 'rail-rotate', scenes: [{
			id: 'rail-rotate', name: 'Rail rotate QA', objects: [],
			shotDocument: { version: 6, frameCount: 120, waypoints: [], shots: [${JSON.stringify(shot)}] },
			stage: { characters: ${JSON.stringify(characters)}, hasCharSheet: false, shotAspect: '16:9' },
		}] }));
	})()`);
	await b.navigate(new URL("/app/", b.base));
	await b.ready();
	const yawsAt = async () => { const out = []; for (const frame of FRAMES) out.push((await angleAt(frame)).yaw); return out; };
	const before = await yawsAt();
	// each frame turns by the marks' turn where the dolly is then, within a degree
	const turnsMatch = async (crane, label) => {
		const now = await yawsAt();
		FRAMES.forEach((frame, i) => assert.ok(Math.abs((now[i] - before[i]) / DEG - expected(crane, frame)) < 1, `${label}: frame ${frame} (rail ${progress[frame].toFixed(2)}) turned ${((now[i] - before[i]) / DEG).toFixed(2)} vs ${expected(crane, frame).toFixed(2)}`));
		return FRAMES.map((frame, i) => ({ frame, progress: progress[frame], turnedDeg: (now[i] - before[i]) / DEG, markTurnDeg: expected(crane, frame) }));
	};
	// The camera tab (it selects the camera), the editor view framed on the rail from behind and above.
	await b.click('[data-mode="camera"]');
	await sleep(1500);
	await b.evaluate("window.__cozyclay.frameEditorCam({ x: -4, y: 5, z: 13 }, { x: 0.5, y: 1, z: 3 })");
	await seek(60);
	// The owner's state: something else in the Outliner, the rail's end dot clicked in the view, E.
	await b.click('[data-node-id="props"]');
	await clickAt((await geometry(2)).dot);
	await key("w", "KeyW", 87);
	await screenshot("1-end-dot-move-tool");
	await b.change("document.querySelector('[data-tool-key].active')?.dataset.tool === 'rotate'", () => key("e", "KeyE", 69));
	await screenshot("2-end-dot-rotate-tool");
	assert.equal(await b.evaluate("document.querySelector('.hierarchy-row-wrap.selected')?.dataset.nodeId"), "props", "the Outliner still holds Props, as in the owner's screenshot");

	// Drag the end dot's pan ring 40 degrees: the camera turns left where the ride ends, not where it starts.
	const grabbed = await dragPan(2, 40);
	await waitShot("Math.abs((s.camera.craneHeight.points[2].yawDeg ?? 0) - 40) <= 8");
	const turnedShot = await stored();
	const endTurn = turnedShot.camera.craneHeight.points[2].yawDeg;
	assert.deepEqual([turnedShot.camera.craneHeight.points[0], turnedShot.camera.craneHeight.points[1]], shot.camera.craneHeight.points.slice(0, 2), "the other marks are untouched");
	assert.equal(turnedShot.camera.head, undefined, "a mark's ring does not touch the shot's hand angle");
	const endRide = await turnsMatch(turnedShot.camera.craneHeight, "end dot turned");
	assert.ok(Math.abs(endRide[0].turnedDeg) < 0.2 && endRide[2].turnedDeg > 30, "none where the ride starts, the end dot's turn where it ends");
	log.push({ grabbed, endTurn, endRide });
	await seek(119);
	await screenshot("3-end-dot-turned");

	// One undo step per drag, and Redo.
	await key("z", "KeyZ", 90, 2);
	await waitShot("s.camera.craneHeight.points[2].yawDeg === undefined");
	assert.ok(Math.abs((await angleAt(119)).yaw - before[2]) < 0.05 * DEG, "Undo takes the whole drag back");
	await key("Z", "KeyZ", 90, 10);
	await waitShot(`s.camera.craneHeight.points[2].yawDeg === ${endTurn}`);

	// The interior dot, clicked the same way: its ring turns the middle of the ride, and the two marks ease into each other.
	await seek(60);
	await clickAt((await geometry(1)).dot);
	await screenshot("4-middle-dot-rotate-tool");
	await dragPan(1, -25);
	await waitShot("Math.abs((s.camera.craneHeight.points[1].yawDeg ?? 0) + 25) <= 8");
	const midTurn = (await stored()).camera.craneHeight.points[1].yawDeg;
	const bothRide = await turnsMatch((await stored()).camera.craneHeight, "middle and end dots turned");
	assert.ok(bothRide[1].turnedDeg < -15, "the middle of the ride turns by the middle dot");
	log.push({ midTurn, bothRide });

	// The camera selected (Outliner) with Rotate: its own rings are there and still turn the whole shot (the head).
	await b.click('[data-node-id="camera"]');
	await settle();
	const handles = await b.evaluate("(window.__gizmoHandles?.() ?? []).map(h => h.axis)");
	assert.ok(handles.includes("y") && !handles.some((axis) => String(axis).startsWith("plane")), `the camera's rotate gizmo is drawn: ${handles}`);
	await screenshot("5-camera-selected-rotate");

	// Reload: the marks' turns come back and play.
	const end = await angleAt(119);
	await waitShot(`s.camera.craneHeight.points[1].yawDeg === ${midTurn}`);
	await b.navigate(new URL("/app/", b.base));
	await b.ready();
	const reloaded = await stored();
	assert.deepEqual(reloaded.camera.craneHeight.points.map((p) => p.yawDeg), [undefined, midTurn, endTurn], "the turns survive a reload");
	assert.ok(Math.abs((await angleAt(119)).yaw - end.yaw) < 0.05 * DEG, "and play the same after it");

	writeFileSync(join(dir, "results.json"), JSON.stringify({ pass: true, viewport: [1438, 979], log }, null, 2));
	console.log(`PASS rail rotate: a rail dot clicked with Props in the Outliner, E shows pan/tilt rings; the end dot's ring turned ${endTurn} deg at the ride's end only, one undo step, redo; the middle dot ${midTurn} deg; the camera's own rings still there; kept over a reload`);
	console.log(`EVIDENCE ${dir}/results.json`);
} finally {
	b.close();
}
