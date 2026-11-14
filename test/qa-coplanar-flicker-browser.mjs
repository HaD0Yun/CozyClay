#!/usr/bin/env node
// Browser contract: coplanar faces of an assembly must not z-fight (flicker)
// while the assembly travels. The Studio agent builds a vintage car as a chassis
// box with body parts parented under it, and the parts' faces are exactly
// coplanar with the chassis' (the hood's top is flush with the chassis top, the
// cabin shares the chassis side planes, the fender and running board share the
// top, ...). With the same depth the GPU picks, per pixel, whichever face wins
// the rounding of the interpolated depth; as the car yaws along a curved route
// the rounding pattern changes every frame, so the painted colour of the
// coplanar region flips between the chassis' and the part's from one frame to
// the next. The picture then shimmers although every transform is exact.
//
// The scene is seeded with a car on a CURVED route (a straight route keeps the
// rounding pattern constant and does not reproduce), four parts with distinct
// colours (one colour hides the fight) parented under it, Character 1 grouped
// under the car (#655) and one Follow shot viewed through the shot camera. The
// test scrubs frames 60..99 and, on every one, reads the painted canvas over a
// disc on the HOOD's top face (flush with the chassis top, nothing else
// covers it). The disc is placed from the hood's published world position, so
// it needs no knowledge of the car's yaw. Per frame it measures the fraction
// of pixels that are the chassis' red ("redFrac") and the hood's blue. Contract:
//   1. the region is really the hood top (>= 70% of its pixels are red or blue; the rest is shadow and ink lines);
//   2. no frame-to-frame flip: |redFrac(f) - redFrac(f-1)| <= 0.3 on all frames;
//   3. each frame is decided, not a blend: redFrac < 0.1 or > 0.9.
// Which face wins is the fix's choice; that it is the same face on every frame
// is the contract.
//
// Run: `CCLAY_KIMODO_HOST= COZYCLAY_LIVE_PORT=5902 npm run dev -- --port 5802`
// in one shell, then
// `QA_OUT=/tmp/coplanar-flicker-qa QA_URL=http://127.0.0.1:5802/app/ CDP_PORT=9472 node tools/qa-browser.mjs -- node test/qa-coplanar-flicker-browser.mjs`
// Never aim it at a studio holding work: it clears localStorage.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { SCENES_STORAGE_KEY } from "../src/scenes.js";
import { cameraBrowser } from "./camera-browser-harness.mjs";

const out = process.env.QA_OUT || "/tmp/coplanar-flicker-qa";
const studioUrl = process.env.QA_URL ?? "http://127.0.0.1:5802/app/";
const b = await cameraBrowser(), { send, evaluate } = b;

const START = 60;
const FRAMES = 40;
const FLIP = 0.3; // redFrac change between consecutive frames that counts as a flip
const DECIDED = 0.1; // a frame's redFrac must be < DECIDED or > 1 - DECIDED
const HOOD_TOP = 0.22; // the hood's scaleY: its top face is this far above its origin
const DISC = 0.25; // metres: radius of the sampled disc, inside the hood top at any yaw
// A curved route: a straight one keeps the depth rounding pattern constant.
const ROUTE = [{ x: 0, y: 0.4, z: 0 }, { x: 0, y: 0.4, z: 6 }, { x: 5, y: 0.4, z: 12 }, { x: 10, y: 0.4, z: 14 }, { x: 16, y: 0.4, z: 20 }, { x: 16, y: 0.4, z: 30 }];

await send("Runtime.enable");
await send("Page.enable");
// Seed storage on a same-origin page that has no editor to autosave over it.
await b.navigate(`${new URL(studioUrl).origin}/favicon.ico`);
await evaluate(`(() => {
	const shot = {
		id: "coplanar-flicker-qa", name: "Coplanar flicker QA", startFrame: 0, endFrame: 359,
		cameraKeys: [{ frame: 0, framing: { pos: { x: 0, y: 1.6, z: -3 }, yaw: Math.PI, pitch: -0.1, fovDeg: 45 } }],
		camera: { mode: "follow", followCam: { distance: 4, height: 1.6, response: 0.7, lead: 0.25, maxDollySpeed: 4, pitchOffsetDeg: 0, orbitOffsetDeg: 0 } },
	};
	const scene = {
		version: 4, activeSceneId: "scene-coplanar-flicker",
		scenes: [{
			id: "scene-coplanar-flicker", name: "COPLANAR FLICKER QA", objects: [],
			shotDocument: { version: 4, frameCount: 360, shots: [shot], waypoints: [] },
			stage: { characters: [{ id: "char-a", model: "y-bot-tpose", x: 0, y: 0.62, z: 0.9, rot: 0, hidden: false, pose: null, subject: "a driver" }], hasCharSheet: false, shotAspect: "16:9" },
		}],
	};
	localStorage.clear();
	localStorage.setItem("cozyclay.locale", "en");
	localStorage.setItem("cozyclay.project-session.v1", JSON.stringify({ name: "Coplanar flicker QA", updatedAt: Date.now() }));
	localStorage.setItem(${JSON.stringify(SCENES_STORAGE_KEY)}, JSON.stringify(scene));
})()`);
await b.navigate(studioUrl);
await b.arm("Boolean(window.__cozyclay?.scrub && window.__cozyclay.shotCam && window.__cozyclay.setLookThrough && window.__cozyclay.sceneObject)", 60000);
await b.settled();

// The car, in the agent's shape: a chassis box and parts parented under it that
// each share at least one face plane with it, in distinct colours.
const COLORS = { chassis: "#c0392b", hood: "#2c6fbb", cabin: "#e8d9a0", fender: "#222222", board: "#6b8e23" };
const ids = await evaluate(`(() => {
	const api = window.__cozyclay.sceneObject;
	const chassis = api.place({ kind: "cube", name: "Vintage Car", x: 0, y: 0.4, z: 0 }).id;
	api.update({ id: chassis, scaleX: 1.3, scaleY: 0.22, scaleZ: 3.6, color: ${JSON.stringify(COLORS.chassis)}, path: { points: ${JSON.stringify(ROUTE)} } });
	const mk = (name, color, x, y, z, sx, sy, sz) => { const id = api.place({ kind: "cube", name, parent: chassis, x, y, z }).id; api.update({ id, scaleX: sx, scaleY: sy, scaleZ: sz, color }); return id; };
	// hood: inside the chassis volume; its top, bottom and sides are coplanar with the chassis'
	const hood = mk("Hood", ${JSON.stringify(COLORS.hood)}, 0, 0.4, -0.6, 1.3, ${HOOD_TOP}, 0.8);
	// cabin: as wide as the chassis, so its sides share the chassis side planes
	const cabin = mk("Cabin", ${JSON.stringify(COLORS.cabin)}, 0, 0.5, 0.9, 1.3, 0.9, 1.4);
	// fender: sticks 5 cm out of the side, top flush with the chassis top
	const fender = mk("Fender FR", ${JSON.stringify(COLORS.fender)}, 0.5, 0.4, -1.4, 0.4, 0.22, 0.8);
	const board = mk("Running Board", ${JSON.stringify(COLORS.board)}, 0.75, 0.4, 0.3, 0.2, 0.22, 2.0);
	return { chassis, hood, cabin, fender, board };
})()`);
await b.arm(`Object.values(${JSON.stringify(ids)}).every((id) => window.__cclayPropWorld?.[id])`);
await b.settled();
await b.change(`!!document.querySelector('[data-node-id="object:${ids.chassis}"]')`, () => evaluate(`(() => {
	if (document.querySelector('[data-node-id="object:${ids.chassis}"]')) return;
	const fold = document.querySelector('[data-node-id="props"] .hierarchy-toggle');
	if (fold && fold.textContent.trim() === "▸") fold.click();
})()`));
// Group Character 1 under the car through the Outliner drag (#655): that is what
// makes the Follow shot track the car.
await b.change(`window.__cozyclay.characters[0].parent===${JSON.stringify(ids.chassis)}`, () => evaluate(`(() => {
	const source = document.querySelector('[data-node-id="character:char-a"]');
	const target = document.querySelector('[data-node-id="object:${ids.chassis}"]');
	const dataTransfer = new DataTransfer();
	const fire = (node, type) => node.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer }));
	fire(source, "dragstart"); fire(target, "dragenter"); fire(target, "dragover"); fire(target, "drop"); fire(source, "dragend");
})()`));
// View through the shot camera, the way the take is delivered.
await b.change(`window.__cozyclay.lookThroughShot&&window.__cozyclay.tlFrame===0&&window.__cclayPropWorld?.[${JSON.stringify(ids.chassis)}]?.frame===0`, () => evaluate("window.__cozyclay.setLookThrough(true);window.__cozyclay.scrub(0)"));

// Scrub each frame, wait for it to be painted, read the canvas over the hood top.
const run = await evaluate(`(async () => {
	const id = ${JSON.stringify(ids)};
	const cam = window.__cozyclay.shotCam;
	const V = cam.position.constructor;
	const canvas = document.querySelector("#stage canvas");
	let scene=window.__cozyclay.rigA;
	while(scene.parent)scene=scene.parent;
	const afterRender=scene.onAfterRender;
	let pendingPaint=null;
	scene.onAfterRender=function(...args){
		afterRender.apply(this,args);
		if(pendingPaint&&args[2]===cam&&window.__cclayPropWorld[id.chassis].frame===pendingPaint.frame&&window.__cozyclay.tlFrame===pendingPaint.frame)pendingPaint.done();
	};
	const paint = frame => new Promise((resolve,reject) => {
		const timer=setTimeout(()=>{pendingPaint=null;reject(new Error('Painted frame deadline '+frame));},60000);
		pendingPaint={frame,done(){clearTimeout(timer);pendingPaint=null;resolve();}};
	});
	// canvas px of a world point as the main pane draws the shot camera (16:9, letterboxed)
	const toPx = (v) => {
		cam.updateMatrixWorld();
		const stage = document.getElementById("stage").getBoundingClientRect();
		const pane = document.querySelector(".vp-main").getBoundingClientRect();
		const rect = { x: pane.left - stage.left, y: pane.top - stage.top, w: pane.width, h: pane.height };
		let w = rect.w, h = w / (16 / 9); if (h > rect.h) { h = rect.h; w = h * (16 / 9); }
		const img = { x: rect.x + (rect.w - w) / 2, y: rect.y + (rect.h - h) / 2, w, h };
		const p = v.clone().project(cam);
		const k = canvas.width / stage.width;
		return { x: (img.x + (p.x + 1) / 2 * img.w) * k, y: (img.y + (1 - p.y) / 2 * img.h) * k };
	};
	const inside = (poly, x, y) => { let r = false; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const a = poly[i], b = poly[j]; if ((a.y > y) !== (b.y > y) && x < (b.x - a.x) * (y - a.y) / (b.y - a.y) + a.x) r = !r; } return r; };
	const rows = []; const crops = [];
	for (let f = ${START}; f < ${START + FRAMES}; f++) {
		const painted=paint(f);window.__cozyclay.scrub(f);await painted;
		const hood = window.__cclayPropWorld[id.hood], chassis = window.__cclayPropWorld[id.chassis];
		// a disc on the hood's top face: the origin is its centre, the top is HOOD_TOP above it
		const poly = [];
		for (let a = 0; a < 24; a++) poly.push(toPx(new V(hood.x + ${DISC} * Math.cos(a / 24 * 2 * Math.PI), hood.y + ${HOOD_TOP}, hood.z + ${DISC} * Math.sin(a / 24 * 2 * Math.PI))));
		const src = document.createElement("canvas"); src.width = canvas.width; src.height = canvas.height;
		const ctx = src.getContext("2d", { willReadFrequently: true }); ctx.drawImage(canvas, 0, 0);
		const xs = poly.map((p) => p.x), ys = poly.map((p) => p.y);
		const x0 = Math.max(0, Math.floor(Math.min(...xs))), x1 = Math.min(src.width, Math.ceil(Math.max(...xs)));
		const y0 = Math.max(0, Math.floor(Math.min(...ys))), y1 = Math.min(src.height, Math.ceil(Math.max(...ys)));
		const w = x1 - x0, h = y1 - y0;
		let n = 0, red = 0, blue = 0;
		if (w > 0 && h > 0) {
			const d = ctx.getImageData(x0, y0, w, h).data;
			for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
				if (!inside(poly, x0 + x + 0.5, y0 + y + 0.5)) continue;
				const i = (y * w + x) * 4, R = d[i], G = d[i + 1], B = d[i + 2];
				n++;
				if (R > 1.8 * G && R > 1.8 * B) red++; // the chassis' red
				else if (B > 1.3 * R && B > G) blue++; // the hood's blue
			}
		}
		rows.push({ f, px: n, redFrac: n ? +(red / n).toFixed(4) : null, blueFrac: n ? +(blue / n).toFixed(4) : null, carX: +chassis.x.toFixed(3), carZ: +chassis.z.toFixed(3), cam: cam.position.toArray().map((v) => +v.toFixed(3)) });
		// a zoomed crop around the region, with margin, for the artefact folder
		if (w > 0 && h > 0) {
			const m = 30, cx0 = Math.max(0, x0 - m), cy0 = Math.max(0, y0 - m), cw = Math.min(src.width, x1 + m) - cx0, ch = Math.min(src.height, y1 + m) - cy0;
			const crop = document.createElement("canvas"); crop.width = cw * 3; crop.height = ch * 3;
			const cc = crop.getContext("2d"); cc.imageSmoothingEnabled = false; cc.drawImage(src, cx0, cy0, cw, ch, 0, 0, crop.width, crop.height);
			crops.push({ f, url: crop.toDataURL("image/png") });
		} else crops.push({ f, url: null });
	}
	scene.onAfterRender=afterRender;
	return { rows, crops };
})()`);

const { rows } = run;
const flips = rows.slice(1).map((r, i) => ({ f: r.f, delta: Math.abs(r.redFrac - rows[i].redFrac) })).filter((x) => !(x.delta <= FLIP));
const undecided = rows.filter((r) => !(r.redFrac < DECIDED || r.redFrac > 1 - DECIDED));
const stdev = (() => { const v = rows.map((r) => r.redFrac); const m = v.reduce((a, b) => a + b, 0) / v.length; return Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / v.length); })();
const summary = {
	frames: { first: rows[0].f, last: rows.at(-1).f, count: rows.length },
	car: { x: [rows[0].carX, rows.at(-1).carX], z: [rows[0].carZ, rows.at(-1).carZ] },
	regionPx: { min: Math.min(...rows.map((r) => r.px)), max: Math.max(...rows.map((r) => r.px)) },
	hoodOrChassisColourFracMin: +Math.min(...rows.map((r) => r.redFrac + r.blueFrac)).toFixed(3),
	redFrac: { min: Math.min(...rows.map((r) => r.redFrac)), max: Math.max(...rows.map((r) => r.redFrac)), stdev: +stdev.toFixed(3) },
	flipsOver0_3: flips.length,
	flipFrames: flips.map((x) => `${x.f}(${x.delta.toFixed(2)})`),
	undecidedFrames: undecided.length,
	redFracPerFrame: rows.map((r) => r.redFrac),
};
await mkdir(out, { recursive: true });
await writeFile(`${out}/coplanar-flicker.json`, JSON.stringify({ summary, rows }, null, 1));
// Screenshots: the first frames, plus every frame that flipped.
const keep = new Set([...rows.slice(0, 4).map((r) => r.f), ...flips.slice(0, 6).map((x) => x.f), ...flips.slice(0, 6).map((x) => x.f - 1)]);
for (const crop of run.crops) if (crop.url && keep.has(crop.f)) await writeFile(`${out}/coplanar-f${crop.f}.png`, Buffer.from(crop.url.split(",")[1], "base64"));
console.log(JSON.stringify(summary));

// Not vacuous: the take played, the car travelled a curve, and the sampled
// region really is the hood top (red or blue pixels, enough of them).
assert.ok(summary.regionPx.min >= 150, `the sampled hood region has enough pixels on every frame: ${JSON.stringify(summary.regionPx)}`);
assert.ok(summary.hoodOrChassisColourFracMin >= 0.7, `the sampled region is the hood top, not sky or ground (red+blue fraction ${summary.hoodOrChassisColourFracMin})`);
assert.ok(Math.abs(summary.car.x[1] - summary.car.x[0]) > 1 && Math.abs(summary.car.z[1] - summary.car.z[0]) > 2, `the car travelled along the curved route: ${JSON.stringify(summary.car)}`);
// The contract.
assert.equal(flips.length, 0, `the coplanar hood top must not flip between the chassis' red and the hood's blue from frame to frame (${flips.length} flips over ${FLIP}: ${summary.flipFrames.join(" ")}; redFrac stdev ${summary.redFrac.stdev}): ${JSON.stringify(summary.redFracPerFrame)}`);
assert.equal(undecided.length, 0, `every frame paints the coplanar region as one face, not a blend (${undecided.length} blended frames: ${undecided.map((r) => `${r.f}=${r.redFrac}`).join(" ")})`);
console.log("coplanar flicker browser QA: coplanar faces paint steadily along a curved route");
b.close();
