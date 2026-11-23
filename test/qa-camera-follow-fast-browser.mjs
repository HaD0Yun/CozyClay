#!/usr/bin/env node
// Browser check: a Follow shot keeps a subject that moves at 10 m/s in the
// picture of the exported frames. Character 1 rides a red car (grouped under it
// in the Outliner) along a 40 m straight, a corner and 30 m more at 10 m/s,
// then stands; the shot follows from the side (orbit 90°). QA_SPEED (m/s, up to
// the 50 an object's route allows) and QA_ORBIT (0 behind, 90 side, 180 front)
// run the same route, scaled to the speed, at another speed or side; QA_SHOT=rail
// rides a rail laid 4 m beside the first leg over its 96 frames instead (frames
// 12, 48 and 90 are checked). Each checked frame
// is drawn through the export's own path (captureShotFrame: posed and parked as
// the MP4 pass does) and the character's white pixels must lie inside the picture near
// its middle. The shot camera's place is read at the same frames: it holds the
// framing it was set to (within the one frame of travel the step runs ahead,
// 14° at most) and its follow distance (the old 2.8 m/s steering cap let it
// slide behind the car).
//
// Run: `COZYCLAY_LIVE_PORT=5397 npm run dev -- --port 5197` in one shell, then
// `QA_URL=http://127.0.0.1:5197/app/ CDP_PORT=9344 node tools/qa-browser.mjs -- node test/qa-camera-follow-fast-browser.mjs`
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { SCENES_STORAGE_KEY } from "../src/scenes.js";
import { cameraBrowser } from "./camera-browser-harness.mjs";

const out = process.env.QA_OUT || "/tmp/camera-follow-fast-qa";
const studioUrl = process.env.QA_URL ?? "http://127.0.0.1:5180/app/";
const b = await cameraBrowser(), { send, evaluate } = b;
const DISTANCE = 4, SPEED = Number(process.env.QA_SPEED ?? 10), ORBIT = Number(process.env.QA_ORBIT ?? 90), SHOT = process.env.QA_SHOT ?? "follow";
// a rail shot: the rail beside the first leg, ridden over the frames the car takes for it
const RAIL = SHOT === "follow" ? "" : `, mode: "rail", cameraRail: [{ x: ${DISTANCE}, z: 0 }, { x: ${DISTANCE}, z: ${4 * SPEED} }], railFollow: { mode: "range", startFrame: 0, endFrame: 95 }`;

await send("Runtime.enable");
await send("Page.enable");
await b.navigate(`${new URL(studioUrl).origin}/favicon.ico`);
await evaluate(`(() => {
	const shot = {
		id: "follow-fast-qa", name: "Follow fast QA", startFrame: 0, endFrame: 239,
		cameraKeys: [{ frame: 0, framing: { pos: { x: 4, y: 1.6, z: 0 }, yaw: Math.PI / 2, pitch: -0.1, fovDeg: 45 } }],
		camera: { mode: "follow", followCam: { distance: ${DISTANCE}, height: 1.6, response: 0.7, lead: 0.25, pitchOffsetDeg: 0, orbitOffsetDeg: ${ORBIT} }${RAIL} },
	};
	const scene = {
		version: 4, activeSceneId: "scene-follow-fast",
		scenes: [{
			id: "scene-follow-fast", name: "FOLLOW FAST QA", objects: [],
			shotDocument: { version: 4, frameCount: 240, shots: [shot], waypoints: [] },
			stage: { characters: [{ id: "char-a", model: "y-bot-tpose", x: 0, y: 0.62, z: 0, rot: 0, hidden: false, pose: null, subject: "a driver" }], hasCharSheet: false, shotAspect: "16:9" },
		}],
	};
	localStorage.clear();
	localStorage.setItem("cozyclay.locale", "en");
	localStorage.setItem("cozyclay.project-session.v1", JSON.stringify({ name: "Follow fast QA", updatedAt: Date.now() }));
	localStorage.setItem(${JSON.stringify(SCENES_STORAGE_KEY)}, JSON.stringify(scene));
})()`);
await b.navigate(studioUrl);
await b.arm("Boolean(window.__cozyclay?.scrub && window.__cozyclay.rigA?.parent && window.__cozyclay.shotCam)", 60000);
await b.settled();

// A red car on a 10 m/s route, built the way the app builds one; the character is grouped under it in the Outliner.
const car = await evaluate(`(() => {
	const api = window.__cozyclay.sceneObject;
	const id = api.place({ kind: "cube", name: "Fast Car", x: 0, y: 0.4, z: 0 }).id;
	api.update({ id, color: "#ff0000", scaleX: 1.3, scaleY: 0.22, scaleZ: 3.6,
		path: { points: [{ x: 0, y: 0.4, z: 0 }, { x: 0, y: 0.4, z: ${4 * SPEED} }, { x: ${3 * SPEED}, y: 0.4, z: ${4 * SPEED} }], speed: ${SPEED} } });
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

/** The export frame's white pixels (the character; the car is red, the set dark): box and middle in the picture's -1..1 coordinates, and the shot camera's place. */
const exportFrame = async (frame) => {
	await b.change(`window.__cozyclay.tlFrame===${frame}&&window.__cclayPropWorld?.[${JSON.stringify(car)}]?.frame===${frame}`, () => evaluate(`window.__cozyclay.scrub(${frame})`));
	return evaluate(`(async () => {
		const element = document.querySelector('.app');
		let fiber = element[Object.keys(element).find(key => key.startsWith('__reactFiber'))];
		while (fiber && !fiber.memoizedProps?.value?.live) fiber = fiber.return;
		const live = fiber.memoizedProps.value.live.state;
		const shot = live.captureShotFrame(${frame});
		const image = new Image();
		await new Promise((resolve, reject) => { image.onload = resolve; image.onerror = reject; image.src = shot.dataUrl; });
		const canvas = document.createElement('canvas');
		canvas.width = image.width; canvas.height = image.height;
		const context = canvas.getContext('2d');
		context.drawImage(image, 0, 0);
		const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
		let count = 0, sx = 0, sy = 0, x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
		for (let y = 0; y < canvas.height; y += 1) for (let x = 0; x < canvas.width; x += 1) {
			const i = (y * canvas.width + x) * 4, r = data[i], g = data[i + 1], bl = data[i + 2];
			if (Math.min(r, g, bl) > 150 && Math.max(r, g, bl) - Math.min(r, g, bl) < 40) { count += 1; sx += x; sy += y; x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
		}
		const nx = (x) => (2 * x) / canvas.width - 1, ny = (y) => 1 - (2 * y) / canvas.height;
		const body = window.__cozyclay.rigA.parent;
		body.updateWorldMatrix(true, false);
		const p = body.getWorldPosition(body.position.clone());
		return { frame: ${frame}, width: canvas.width, height: canvas.height, dataUrl: shot.dataUrl, white: count,
			box: count ? [nx(x0), nx(x1), ny(y1), ny(y0)] : null, middle: count ? [nx(sx / count), ny(sy / count)] : null,
			body: { x: p.x, z: p.z } };
	})()`);
};
/** Where the character's body is at a frame (the route bends a little into its corner, so its heading is read, not assumed). */
const bodyAt = async (frame) => {
	await b.change(`window.__cozyclay.tlFrame===${frame}&&window.__cclayPropWorld?.[${JSON.stringify(car)}]?.frame===${frame}`, () => evaluate(`window.__cozyclay.scrub(${frame})`));
	return evaluate("(() => { const body = window.__cozyclay.rigA.parent; body.updateWorldMatrix(true, false); const p = body.getWorldPosition(body.position.clone()); return { x: p.x, z: p.z }; })()");
};
/** The shot camera the stage shows at the playhead (the same follow track the export parks). */
const shotCamera = () => evaluate("(() => { const c = window.__cozyclay.shotCam.position; return { x: c.x, z: c.z }; })()");

await mkdir(out, { recursive: true });
const report = [];
// 0-95 the first leg, the corner near 96-110, the second leg after it, standing from about 175
for (const frame of SHOT === "follow" ? [12, 48, 90, 100, 106, 112, 130, 170, 200, 239] : [12, 48, 90]) {
	const before = await bodyAt(frame - 2), shot = await exportFrame(frame), cam = await shotCamera();
	await writeFile(`${out}/export-${String(frame).padStart(3, "0")}.png`, Buffer.from(shot.dataUrl.split(",")[1], "base64"));
	const planar = Math.hypot(cam.x - shot.body.x, cam.z - shot.body.z);
	// behind is against the body's heading, and the orbit turns the camera from there (90°: to the +x side of a +z drive)
	const hx = shot.body.x - before.x, hz = shot.body.z - before.z, turn = (ORBIT * Math.PI) / 180;
	const want = Math.atan2(-hx * Math.cos(turn) + hz * Math.sin(turn), -hx * Math.sin(turn) - hz * Math.cos(turn)), at = Math.atan2(cam.x - shot.body.x, cam.z - shot.body.z);
	const side = Math.abs(Math.atan2(Math.sin(at - want), Math.cos(at - want))) * (180 / Math.PI);
	report.push({ frame, white: shot.white, box: shot.box?.map((v) => +v.toFixed(2)), middle: shot.middle?.map((v) => +v.toFixed(2)), planar: +planar.toFixed(2), side: +side.toFixed(1), body: { x: +shot.body.x.toFixed(1), z: +shot.body.z.toFixed(1) } });
}
console.log(JSON.stringify(report));
for (const row of report) {
	assert.ok(row.white > 2000, `frame ${row.frame}: the character is in the exported frame (${row.white} white pixels)`);
	assert.ok(row.box.every((v) => Math.abs(v) <= 1) && Math.abs(row.middle[0]) < 0.5 && Math.abs(row.middle[1]) < 0.6, `frame ${row.frame}: the character sits inside the picture near its middle (${JSON.stringify(row)})`);
	if (SHOT !== "follow") continue;
	assert.ok(Math.abs(row.planar - DISTANCE) < 0.05, `frame ${row.frame}: the camera holds its ${DISTANCE} m follow distance (${row.planar} m)`);
	// two seconds in: the start has settled and the route has not begun to bend into its corner (from about frame 60 the
	// trailing direction turns slower than the heading, as it does at a walk)
	if (row.frame === 48) assert.ok(row.side < 17, `frame ${row.frame}: the camera holds the framing it was set to (${row.side}° off)`);
}
assert.ok(SHOT !== "follow" || report.at(-1).body.x > 2.5 * SPEED, `the car reached the end of its route: ${JSON.stringify(report.at(-1).body)}`);
console.log(`camera follow fast browser QA: a ${SPEED} m/s subject stays in the exported frames, ${SHOT === "follow" ? `follow, orbit ${ORBIT}°` : "rail"} (frames in ${out})`);
b.close();
