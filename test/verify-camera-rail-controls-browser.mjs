#!/usr/bin/env node
// The rail camera's controls in the real Details panel: pick who a shot follows
// (with Undo/Redo and reload), turn the camera by hand on a rail (the existing
// Transform rotation field, the new offset fields, the rotate gizmo and a
// right-drag while looking through the shot) and keep that over the whole
// rail, switch the head's follow off, and the aim-recording feel controls that
// persist per browser; a hand move still sets the follow distance; a pick on a
// rail with a cast aim, and what the camera does when the picked character is
// removed. The math is covered by the node tests.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cameraBrowser } from "./camera-browser-harness.mjs";
import { SCENES_STORAGE_KEY } from "../src/scenes.js";

const DEG = Math.PI / 180;
const dir = process.env.QA_EVIDENCE_DIR || "/tmp/camera-rail-controls-evidence";
mkdirSync(dir, { recursive: true });
const b = await cameraBrowser();
const log = [];
const shot = { id: "rail-a", name: "Rail A", startFrame: 0, endFrame: 143, cameraKeys: [],
	camera: { mode: "rail", cameraRail: [{ x: -3, z: 5 }, { x: 3, z: 5 }], railFollow: { mode: "range", startFrame: 0, endFrame: 143 } } };
const characters = [
	{ id: "char-a", name: "Ada", model: "y-bot-tpose", x: -2, z: 0, rot: 0, hidden: false, pose: null, subject: "a person" },
	{ id: "char-b", name: "Bo", model: "y-bot-tpose", x: 2, z: 0, rot: 0, hidden: false, pose: null, subject: "a person" },
];
const screenshot = async (name) => {
	const result = await b.send("Page.captureScreenshot", { format: "png" });
	writeFileSync(join(dir, `${name}.png`), Buffer.from(result.data, "base64"));
	log.push({ screenshot: `${name}.png` });
};
const readShot = () => b.evaluate(`window.__cozyclayProject.export('Rail controls QA').then(text => JSON.parse(text).scenes.scenes[0].shotDocument.shots[0])`);
// three painted frames after the playhead lands: the follow rig applies its sample on the next render
const settle = () => b.evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve))))");
const seek = async (frame) => {
	await b.change(`window.__cozyclay.tlFrame === ${frame}`, () => b.evaluate(`window.__cozyclay.scrub(${frame})`));
	await settle();
};
const angleAt = async (frame) => { await seek(frame); const pose = await b.pose(); return { yaw: pose.yaw, pitch: pose.pitch }; };
const near = (a, b2, eps = 1e-4) => Math.abs(a - b2) < eps;
const key = async (keyName, code, modifiers = 0, keyCode = 0) => {
	for (const type of ["keyDown", "keyUp"]) await b.send("Input.dispatchKeyEvent", { type, modifiers, key: keyName, code, windowsVirtualKeyCode: keyCode });
};
// type into a NumberField the way a user does: focus, type, Enter
const typeInto = async (scope, index, text) => {
	await b.evaluate(`(() => { const input = document.querySelectorAll(${JSON.stringify(`[data-testid="${scope}"] input`)})[${index}]; input.focus(); input.select(); })()`);
	await b.send("Input.insertText", { text });
	await key("Enter", "Enter", 0, 13);
	await b.evaluate("document.activeElement?.blur()");
};
const waitShot = (condition) => b.change(`(() => { try { const s = JSON.parse(localStorage.getItem('${SCENES_STORAGE_KEY}')).scenes[0].shotDocument.shots[0]; return ${condition}; } catch { return false; } })()`, async () => {});

try {
	// The scene save is debounced and localStorage has no same-tab event: announce the real write.
	await b.send("Page.addScriptToEvaluateOnNewDocument", { source: `(() => {
		const write=Storage.prototype.setItem;
		Storage.prototype.setItem=function(key,value){
			const result=write.call(this,key,value);
			if(this===localStorage && key==='${SCENES_STORAGE_KEY}')window.dispatchEvent(new Event('qa:camera-state'));
			return result;
		};
	})()` });
	await b.send("Emulation.setDeviceMetricsOverride", { width: 1438, height: 979, deviceScaleFactor: 1, mobile: false });
	await b.navigate(`${b.base.origin}/favicon.ico`);
	await b.evaluate(`(() => {
		localStorage.clear();
		localStorage.setItem('cozyclay.locale','en');
		localStorage.setItem('cozyclay.project-session.v1',JSON.stringify({name:'Rail controls QA',updatedAt:Date.now()}));
		localStorage.setItem('${SCENES_STORAGE_KEY}',JSON.stringify({version:4,activeSceneId:'rail-controls',scenes:[{
			id:'rail-controls',name:'Rail controls QA',objects:[],
			shotDocument:{version:6,frameCount:144,waypoints:[],shots:[${JSON.stringify(shot)}]},
			stage:{characters:${JSON.stringify(characters)},hasCharSheet:false,shotAspect:'16:9'}
		}]}));
	})()`);
	await b.navigate(new URL("/app/", b.base));
	await b.ready();
	await seek(72);
	await b.change("!!document.querySelector('[data-testid=\"camera-follow-controls\"]')", () => b.click('[data-node-id="camera"]'));

	// B: nobody picked, the selected character (Ada, left) is followed.
	assert.equal(await b.evaluate(`document.querySelector('[data-testid="camera-follow-subject-char-b"]').getAttribute('aria-pressed')`), "false");
	const adaYaw = (await angleAt(72)).yaw;
	assert.ok(adaYaw > 0.2, `the untouched rail turns left to Ada: ${adaYaw}`);
	await screenshot("1-untouched");
	await b.click('[data-testid="camera-follow-subject-char-b"]');
	await waitShot(`JSON.stringify(s.subjectIds) === '["char-b"]'`);
	const boYaw = (await angleAt(72)).yaw;
	assert.ok(boYaw < -0.2, `picking Bo turns the rail to Bo while Ada stays selected: ${boYaw}`);
	assert.equal(await b.evaluate(`document.querySelector('[data-testid="camera-follow-subject-char-b"]').getAttribute('aria-pressed')`), "true");
	log.push({ pick: "char-b", yawBefore: adaYaw, yawAfter: boYaw });
	await screenshot("2-picked-bo");
	await key("z", "KeyZ", 2, 90);
	await waitShot("!s.subjectIds");
	assert.ok(near((await angleAt(72)).yaw, adaYaw), "Undo returns to the selected character");
	await key("Z", "KeyZ", 10, 90);
	await waitShot(`JSON.stringify(s.subjectIds) === '["char-b"]'`);
	assert.ok(near((await angleAt(72)).yaw, boYaw), "Redo picks Bo again");

	// A: the angle by hand on a rail, kept as an offset over the whole rail.
	const base30 = await angleAt(30), base110 = await angleAt(110);
	await seek(72);
	await typeInto("camera-head-angle", 0, "20");
	await waitShot("s.camera.head?.yawDeg === 20");
	for (const [frame, base] of [[30, base30], [110, base110]]) {
		const now = await angleAt(frame);
		assert.ok(near(now.yaw, base.yaw + 20 * DEG), `pan offset field holds 20 degrees at frame ${frame}: ${now.yaw} vs ${base.yaw + 20 * DEG}`);
		assert.ok(near(now.pitch, base.pitch), `and leaves the tilt at frame ${frame}`);
	}
	await typeInto("camera-head-angle", 1, "-5");
	await waitShot("s.camera.head?.pitchDeg === -5");
	assert.ok(near((await angleAt(110)).pitch, base110.pitch - 5 * DEG), "tilt offset field holds -5 degrees");
	// the existing Transform rotation field (it was overwritten by the rail before): turn 10 degrees more by hand
	await seek(72);
	const before72 = await b.pose();
	await typeInto("camera-transform", 4, String((before72.yaw / DEG + 10).toFixed(1)));
	await waitShot("Math.abs(s.camera.head?.yawDeg - 30) < 0.11");
	assert.ok(Math.abs((await angleAt(30)).yaw - (base30.yaw + 30 * DEG)) < 0.002, "a hand turn at one frame rides the whole rail");
	await screenshot("3-turned-by-hand");
	log.push({ head: (await readShot()).camera.head });

	// A: the rotate gizmo on the camera in the editor view. The free camera is put 4 m in front of the gizmo first.
	await seek(72);
	const followBefore = (await readShot()).camera.followCam;
	await b.evaluate("document.activeElement?.blur()");
	await b.change("document.querySelector('[data-tool-key].active')?.dataset.tool === 'rotate'", () => key("e", "KeyE", 0, 69));
	await b.evaluate(`(() => { const c = window.__cozyclay.editorCam, s = window.__cozyclay.shotCam, d = c.position.clone(); c.getWorldDirection(d);
		c.position.set(s.position.x - d.x * 4, s.position.y - 0.12 - d.y * 4, s.position.z - d.z * 4); c.updateMatrixWorld(); })()`);
	const ring = `(() => { const c = (window.__gizmoHandles?.() ?? []).find(h => h.axis === 'y'); if (!c) return null;
		const solid = (x, y) => [[0,0],[3,0],[-3,0],[0,3],[0,-3]].every(([dx, dy]) => window.__gizmoPick(x + dx, y + dy) === 'y');
		for (let r = 8; r < 260; r += 2) for (let a = 0; a < 360; a += 15) {
			const x = Math.round(c.x + r * Math.cos(a * Math.PI / 180)), y = Math.round(c.y + r * Math.sin(a * Math.PI / 180));
			if (solid(x, y) && document.elementFromPoint(x, y)?.tagName === 'CANVAS') return { x, y, hubX: c.x, hubY: c.y }; }
		return null; })()`;
	let grab = null;
	for (let tries = 0; tries < 60 && !grab; tries += 1) { await settle(); grab = await b.evaluate(ring); }
	assert.ok(grab, "the camera's pan ring is on screen and can be grabbed");
	const head3 = (await readShot()).camera.head, radius = Math.hypot(grab.x - grab.hubX, grab.y - grab.hubY), from = Math.atan2(grab.y - grab.hubY, grab.x - grab.hubX);
	const onRing = (angle) => ({ x: Math.round(grab.hubX + radius * Math.cos(angle)), y: Math.round(grab.hubY + radius * Math.sin(angle)) });
	await b.mouse("mouseMoved", { x: grab.x, y: grab.y });
	await b.mouse("mousePressed", { x: grab.x, y: grab.y, button: "left", buttons: 1, clickCount: 1 });
	for (let i = 1; i <= 12; i += 1) { await b.mouse("mouseMoved", { ...onRing(from + (i / 12) * (Math.PI / 4)), button: "left", buttons: 1 }); await settle(); }
	await b.mouse("mouseReleased", { ...onRing(from + Math.PI / 4), button: "left", buttons: 0, clickCount: 1 });
	await waitShot(`Math.abs(s.camera.head.yawDeg - ${head3.yawDeg}) > 2`);
	const ringShot = await readShot();
	assert.equal(ringShot.camera.head.pitchDeg, head3.pitchDeg, "the pan ring leaves the tilt");
	assert.deepEqual(ringShot.camera.followCam, followBefore, "a turn with the gizmo leaves the follow settings, and so the dolly");
	assert.ok(Math.abs((await angleAt(30)).yaw - (base30.yaw + ringShot.camera.head.yawDeg * DEG)) < 0.002, "the gizmo turn rides the whole rail");
	log.push({ gizmoHead: ringShot.camera.head });

	// A: right-drag while looking through the shot camera.
	await seek(72);
	await b.change("window.__cozyclay.lookThroughShot === true", () => b.click(".dock-shot-card .dock-shot-look"));
	await settle();
	const lookBefore = await b.pose(), stage = await b.centre(".stage canvas");
	await b.mouse("mouseMoved", { ...stage });
	await b.change("document.pointerLockElement === document.querySelector('.stage canvas')", () => b.mouse("mousePressed", { ...stage, button: "right", buttons: 2, clickCount: 1 }));
	await b.change(`Math.abs(window.__cozyclay.shotCam.rotation.y - ${lookBefore.yaw}) > 0.01`, () => b.mouse("mouseMoved", { x: stage.x + 90, y: stage.y + 24, button: "right", buttons: 2 }));
	const lookAfter = await b.pose();
	const dragged = { yawDeg: ringShot.camera.head.yawDeg + (lookAfter.yaw - lookBefore.yaw) / DEG, pitchDeg: ringShot.camera.head.pitchDeg + (lookAfter.pitch - lookBefore.pitch) / DEG };
	await b.change("document.pointerLockElement === null", () => b.mouse("mouseReleased", { x: stage.x + 90, y: stage.y + 24, button: "right", buttons: 0, clickCount: 1 }));
	await waitShot(`Math.abs(s.camera.head.yawDeg - ${dragged.yawDeg}) < 0.11 && Math.abs(s.camera.head.pitchDeg - ${dragged.pitchDeg}) < 0.11`);
	const lookShot = await readShot();
	assert.deepEqual(lookShot.camera.followCam, followBefore, "a right-drag turn leaves the follow settings, and so the dolly");
	const at110 = await angleAt(110);
	assert.ok(Math.abs(at110.yaw - (base110.yaw + lookShot.camera.head.yawDeg * DEG)) < 0.002 && Math.abs(at110.pitch - (base110.pitch + lookShot.camera.head.pitchDeg * DEG)) < 0.002, "the right-drag turn rides the whole rail");
	await screenshot("3b-right-drag");
	log.push({ rightDragHead: lookShot.camera.head });
	await b.change("window.__cozyclay.lookThroughShot === false", () => b.escape());
	if (!(await b.evaluate(`!!document.querySelector('[data-testid="camera-head-follow"]')?.offsetParent`))) await b.click('[data-node-id="camera"]');

	// A: follow off holds the angle shown at the playhead, at every frame.
	await seek(72);
	const shown = await b.pose();
	await b.click('[data-testid="camera-head-follow"]');
	await waitShot("s.camera.head?.follow === false");
	assert.match(await b.evaluate(`document.querySelector('[data-testid="camera-head-follow"]').textContent`), /Off/);
	for (const frame of [30, 72, 110]) {
		const now = await angleAt(frame);
		assert.ok(Math.abs(now.yaw - shown.yaw) < 0.002 && Math.abs(now.pitch - shown.pitch) < 0.002, `follow off holds the angle at frame ${frame}`);
	}
	await typeInto("camera-head-angle", 0, "45");
	await waitShot("s.camera.head?.yawDeg === 45 && s.camera.head.follow === false");
	for (const frame of [30, 110]) assert.ok(near((await angleAt(frame)).yaw, 45 * DEG), `the pan field sets the held angle at frame ${frame}`);
	assert.equal(await b.evaluate(`document.querySelector('[data-testid="camera-follow-subject-char-a"]').disabled`), true, "nobody is followed while the head turns to no one");
	await screenshot("4-follow-off");

	// C: the feel controls start slower than the look (7 deg/100 px, 0.2 s) and persist per browser.
	assert.equal(await b.evaluate(`document.querySelector('[data-testid="rail-aim-sensitivity-value"]').textContent`), "7.0 °/100px");
	assert.equal(await b.evaluate(`document.querySelector('[data-testid="rail-aim-smoothing-value"]').textContent`), "0.20 s");
	const slide = (id, value) => b.evaluate(`(() => {
		const input = document.querySelector('[data-testid="rail-aim-${id}"]');
		Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '${value}');
		input.dispatchEvent(new Event('input', { bubbles: true }));
	})()`);
	await b.change(`document.querySelector('[data-testid="rail-aim-sensitivity-value"]').textContent === '3.5 °/100px'`, () => slide("sensitivity", 3.5));
	await b.change(`document.querySelector('[data-testid="rail-aim-smoothing-value"]').textContent === '0.50 s'`, () => slide("smoothing", 0.5));
	assert.deepEqual(JSON.parse(await b.evaluate("localStorage.getItem('cozyclay.railAimFeel')")), { sensitivity: 3.5, smoothing: 0.5 });
	await screenshot("5-feel");

	// Reload: the pick, the head and the feel come back.
	await waitShot("s.camera.head?.yawDeg === 45");
	await b.navigate(new URL("/app/", b.base));
	await b.ready();
	await seek(72);
	await b.change("!!document.querySelector('[data-testid=\"camera-follow-controls\"]')", () => b.click('[data-node-id="camera"]'));
	const reloaded = await readShot();
	// the held tilt is the one shown when follow went off (the -5 offset included)
	assert.deepEqual([reloaded.subjectIds, reloaded.camera.head], [["char-b"], { follow: false, yawDeg: 45, pitchDeg: Math.round(shown.pitch / DEG * 10) / 10 }], JSON.stringify(reloaded.camera.head));
	assert.ok(near((await angleAt(110)).yaw, 45 * DEG), "the held angle plays after reload");
	assert.equal(await b.evaluate(`document.querySelector('[data-testid="rail-aim-sensitivity-value"]').textContent`), "3.5 °/100px", "the feel is the user's own after a reload");
	// on again: the subject is centred, no offset
	await b.click('[data-testid="camera-head-follow"]');
	await waitShot("!s.camera.head");
	assert.ok(near((await angleAt(72)).yaw, boYaw), "follow on again turns to Bo with no offset");
	await screenshot("6-reloaded-follow-on");

	// A hand MOVE of the camera on a rail frame still sets the follow distance, as it did before the head existed.
	await seek(72);
	const still = await b.pose(), distanceBefore = (await readShot()).camera.followCam.distance;
	await typeInto("camera-transform", 2, (still.pos.z + 1).toFixed(2));
	await waitShot(`s.camera.followCam.distance !== ${distanceBefore}`);
	const movedShot = await readShot();
	assert.ok(Math.abs(movedShot.camera.followCam.distance - Math.hypot(still.pos.x - 2, still.pos.z + 1)) < 0.011, `the distance is read from the moved camera to Bo: ${movedShot.camera.followCam.distance}`);
	assert.equal(movedShot.camera.head, undefined, "a move is not a turn");

	// B on a rail that already holds a cast aim (laid with shot.setCameraRail): the pick is the aim, marked as the user's.
	const aimed = await b.evaluate(`window.__cozyclay.runStudioAction('shot.setCameraRail', { shotId: 'rail-a', points: [{ x: -3, z: 5 }, { x: 3, z: 5 }], aim: ['char-a'] })`);
	assert.equal(aimed.ok, true, JSON.stringify(aimed));
	await waitShot(`JSON.stringify(s.camera.aim) === '{"ids":["char-a"]}'`);
	await b.change(`document.querySelector('[data-testid="camera-follow-subject-char-a"]').getAttribute('aria-pressed') === 'true'`, async () => {});
	await b.click('[data-testid="camera-follow-subject-char-b"]');
	await waitShot(`JSON.stringify(s.camera.aim) === '{"ids":["char-a","char-b"],"picked":true}'`);
	await b.click('[data-testid="camera-follow-subject-char-a"]');
	await waitShot(`JSON.stringify(s.camera.aim) === '{"ids":["char-b"],"picked":true}'`);
	const toBo = await angleAt(110);
	// the picked character removed: the camera holds still and says so; Undo follows Bo again
	const removed = await b.evaluate(`window.__cozyclay.runStudioAction('character.remove', { characterId: 'char-b' })`);
	assert.equal(removed.ok, true, JSON.stringify(removed));
	// the Studio shell hides the inspector's hint lines, so the user reads this as the tooltip of the Follows row
	const followTip = `(document.querySelector('[data-testid="camera-follow-pick"]')?.title ?? '')`;
	await b.change(`/holds still/.test(${followTip})`, async () => {});
	assert.match(await b.evaluate(`document.querySelector('[data-testid="camera-follow-subject-char-b"]').textContent`), /removed/, "the removed pick stays listed");
	const held30 = await angleAt(30), held110 = await angleAt(110);
	assert.ok(near(held30.yaw, held110.yaw) && near(held30.pitch, held110.pitch), "with the picked character gone the camera holds still, it does not turn to Ada");
	await screenshot("7-picked-removed");
	await b.evaluate("document.activeElement?.blur()");
	await b.change(`!/holds still/.test(${followTip})`, () => key("z", "KeyZ", 2, 90));
	assert.ok(near((await angleAt(110)).yaw, toBo.yaw), "Undo of the removal follows Bo again");

	writeFileSync(join(dir, "results.json"), JSON.stringify({ pass: true, viewport: [1438, 979], log }, null, 2));
	console.log("PASS rail camera controls: pick Bo (undo/redo/reload), hand angle over the whole rail (offset fields, Transform rotation, rotate gizmo, right-drag in Look through), follow off holds the angle, aim feel controls persist, a hand move sets the follow distance, a removed pick holds the camera still");
	console.log(`EVIDENCE ${dir}/results.json`);
} finally {
	b.close();
}
