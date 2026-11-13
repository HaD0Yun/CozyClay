#!/usr/bin/env node
// Native pointer input on the live rail; no synthetic movement events or
// clock overrides. Observers are armed before recording and every action.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cameraBrowser } from "./camera-browser-harness.mjs";
import { SCENES_STORAGE_KEY } from "../src/scenes.js";
import { buildShotCameraTracks } from "../src/camera-direction.js";

const dir = process.env.QA_EVIDENCE_DIR || "/tmp/camera-record-evidence";
mkdirSync(dir, { recursive: true });
const b = await cameraBrowser();
const log = [], measurements = [];
const shot = { id: "rail-a", name: "Rail A", startFrame: 12, endFrame: 131, cameraKeys: [
	{ id: "before", frame: 12, framing: { pos: { x: -1, y: 2, z: 5 }, yaw: 0, pitch: 0, fovDeg: 45 } },
	{ id: "after", frame: 131, framing: { pos: { x: 1, y: 2, z: 5 }, yaw: 0.1, pitch: 0, fovDeg: 45 } },
], camera: { mode: "rail", cameraRail: [{ x: -3, z: 5 }, { x: 3, z: 5 }],
	railFollow: { mode: "range", startFrame: 6, endFrame: 113 }, focalMm: 40, rollDeg: 17,
	craneHeight: { points: [{ t: 0, height: 1.8 }, { t: 1, height: 2.4 }] }, aim: { point: { x: 0, y: 1.2, z: 0 } } } };
const railTrack = buildShotCameraTracks({ shots: [shot], subjectTrack: Array.from({ length: 144 }, () => ({ x: 0, y: 0, z: 0 })), fps: 24 });
const screenshot = async (name, frame) => {
	const result = await b.send("Page.captureScreenshot", { format: "png" });
	const path = join(dir, `${name}.png`);
	writeFileSync(path, Buffer.from(result.data, "base64"));
	log.push({ screenshot: name, frame, source: frame === undefined ? "stage" : "recorded playback" });
};
const readShots = () => b.evaluate(`window.__cozyclayProject.export('Camera take QA').then(text => JSON.parse(text).scenes.scenes[0].shotDocument.shots)`);
const wait = async condition => { await b.arm(condition); await b.settled(); };
const seek = frame => b.change(`window.__cozyclay.tlFrame === ${frame}`, () => b.evaluate(`window.__cozyclay.scrub(${frame})`));
const pose = () => b.evaluate(`(() => { const c=window.__cozyclay.shotCam; return {
	pos:{x:c.position.x,y:c.position.y,z:c.position.z},yaw:c.rotation.y,pitch:c.rotation.x,roll:c.rotation.z,fov:c.fov}; })()`);

try {
	// Session autosave is debounced and localStorage emits no same-tab event.
	// Observe the real completed write without changing its data or timing.
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
		localStorage.setItem('cozyclay.project-session.v1',JSON.stringify({name:'Camera take QA',updatedAt:Date.now()}));
		localStorage.setItem('${SCENES_STORAGE_KEY}',JSON.stringify({version:4,activeSceneId:'camera-take',scenes:[{
			id:'camera-take',name:'Camera take QA',objects:[],
			shotDocument:{version:6,frameCount:144,waypoints:[],shots:[${JSON.stringify(shot)}]},
			stage:{characters:[{id:'char-a',model:'y-bot-tpose',x:0,z:0,rot:0,hidden:false,pose:null,subject:'a person'}],hasCharSheet:false,shotAspect:'16:9'}
		}]}));
	})()`);
	await b.navigate(new URL("/app/", b.base));
	await b.ready();
	await seek(18);
	await b.change("!!document.querySelector('[data-testid=\"camera-performance-record\"]')", () =>
		b.click('[data-node-id="camera"]'));
	const before = await readShots();
	await screenshot("ready");

	async function record(name, direction) {
		const phases = [["start", 21, 22, -7], ["middle", 65, -31, 12], ["end", 115, 19, -9]];
		const head = railTrack[18];
		await wait(`Math.abs(window.__cozyclay.shotCam.position.x-(${head.pos.x})) < 0.001`);
		const initial = await pose();
		const p = await b.centre('[data-testid="camera-performance-record"]');
		await b.evaluate(`(async () => {
			const {playbackFrame}=await import('/src/motion/playback-frame-store.js');
			const q=window.__railQA={frame:playbackFrame,inputs:[],frames:{},errors:[],phaseResolvers:[],
				expected:${JSON.stringify({ yaw: head.yaw, pitch: head.pitch })}};
			q.phaseWaits=${JSON.stringify(phases.map(phase => phase[1]))}.map((target,index)=>
				new Promise(resolve=>{q.phaseResolvers[index]={target,resolve};}));
			window.addEventListener('error',event=>window.__railQA.errors.push(event.message),
				{signal:(window.__railErrorController=new AbortController()).signal});
			document.addEventListener('mousemove',event=>{
				if(!document.pointerLockElement || (!event.movementX && !event.movementY))return;
				const q=window.__railQA, a=q.expected;
				a.yaw-=event.movementX*0.0032;
				a.pitch=Math.max(-85*Math.PI/180,Math.min(85*Math.PI/180,a.pitch-event.movementY*0.0032));
				q.inputs.push({frame:q.frame(),dx:event.movementX,dy:event.movementY});
			},{signal:(window.__railQAController=new AbortController()).signal});
			window.addEventListener('qa:camera-state',()=>{
				const q=window.__railQA;
				if(!q.expected||!document.pointerLockElement)return;
				const c=window.__cozyclay.shotCam;
				q.frames[q.frame()]={yaw:c.rotation.y,pitch:c.rotation.x,roll:c.rotation.z,fov:c.fov,
					pos:{x:c.position.x,y:c.position.y,z:c.position.z},expected:{...q.expected}};
				q.phaseResolvers.forEach((pending,index)=>{
					if(pending && q.frame()>=pending.target){
						q.phaseResolvers[index]=null;pending.resolve({frame:q.frame(),ended:false});
					}
				});
			},{signal:window.__railQAController.signal});
			document.addEventListener('pointerlockchange',()=>{
				if(document.pointerLockElement){q.started=true;return;}
				if(q.started)q.phaseResolvers.forEach(pending=>pending?.resolve({frame:q.frame(),ended:true}));
			},{signal:window.__railQAController.signal});
		})()`);
		// Subscribe before Record. Only native input delivery occupies the
		// short take window; screenshots and extra observations run afterward.
		const inputsDone = Promise.all(phases.map(async ([phase, target, dx, dy], index) => {
			const signal = await b.evaluate(`window.__railQA.phaseWaits[${index}]`);
			assert.ok(!signal.ended && signal.frame >= target && signal.frame < 125, `${phase} is reached while recording`);
			await b.mouse("mouseMoved", { x: p.x + dx * direction, y: p.y + dy * direction, buttons: 0 });
		}));
		await Promise.all([inputsDone, b.change("document.pointerLockElement === document.querySelector('.stage canvas')", () =>
			b.click('[data-testid="camera-performance-record"]'))]);
		await wait("document.pointerLockElement === null && window.__cozyclay.playing === false");
		const inputs = await b.evaluate("({inputs:window.__railQA.inputs,frames:window.__railQA.frames})");
		assert.equal(inputs.inputs.length, 3, "all three native steering inputs arrive during the take");
		for (const [index, input] of inputs.inputs.entries()) {
			assert.ok(input.frame >= 18 + index * 36 && input.frame <= 18 + (index + 1) * 36,
				`${phases[index][0]} input reaches its own third of the rail`);
		}
		assert.ok(inputs.inputs.some(e => e.dx !== 0 || e.dy !== 0), "native mouse movement delivered");
		const saved = (await readShots())[0];
		const take = saved.camera.aimTake;
		assert.equal(take.startFrame, 6);
		assert.equal(take.samples.length, 108, "inclusive complete rail range is saved");
		let checked = 0;
		for (const [frameText, recorded] of Object.entries(inputs.frames)) {
			const index = Number(frameText) - 18;
			if (index < 0 || index >= take.samples.length) continue;
			for (const axis of ["yaw", "pitch"]) {
				assert.ok(Math.abs(take.samples[index][axis] - recorded.expected[axis]) <= 0.005, `${name} frame ${frameText} reproduces native ${axis}`);
				assert.ok(Math.abs(recorded[axis] - recorded.expected[axis]) <= 0.005, `${name} live frame ${frameText} follows native ${axis}`);
			}
			const base = railTrack[Number(frameText)];
			assert.ok(Math.hypot(recorded.pos.x - base.pos.x, recorded.pos.y - base.pos.y, recorded.pos.z - base.pos.z) < 0.001, `${name} live frame ${frameText} stays on the rail`);
			assert.ok(Math.abs(recorded.roll - 17 * Math.PI / 180) < 0.00001, "live recording keeps authored roll");
			assert.ok(Math.abs(recorded.fov - initial.fov) < 0.00001, "live recording keeps authored lens");
			checked++;
		}
		assert.ok(checked > 10, "measured multiple frames, not thumbnails");
		assert.deepEqual(await b.evaluate("window.__railQA.errors"), [], "recording cannot reach scene raycasters or throw page errors");
		log.push({ take: name, nativeInput: inputs.inputs, checkedFrames: checked, samples: take.samples.length, toleranceRad: 0.005 });
		await b.evaluate("window.__railQAController.abort();window.__railErrorController.abort()");
		const liveFrames = Object.entries(inputs.frames).sort(([a], [b]) => Number(a) - Number(b));
		for (const [index, input] of inputs.inputs.entries()) {
			const captured = liveFrames.find(([frame]) => Number(frame) >= input.frame);
			assert.ok(captured, `${phases[index][0]} has a measured live camera frame`);
			const frame = Number(captured[0]), expected = take.samples[frame - 18];
			measurements.push({ take: name, phase: phases[index][0], frame, camera: captured[1] });
			await seek(frame);
			await wait(`Math.abs(window.__cozyclay.shotCam.rotation.y-(${expected.yaw})) < 0.00001`);
			await screenshot(`${name}-${phases[index][0]}`, frame);
		}
		return saved;
	}

	const first = await record("first", 1);
	for (const frame of [22, 66, 119]) {
		await seek(frame);
		const expected = first.camera.aimTake.samples[frame - 18];
		await wait(`Math.abs(window.__cozyclay.shotCam.rotation.y-(${expected.yaw})) < 0.00001`);
		const actual = await pose(), base = railTrack[frame];
		assert.ok(Math.hypot(actual.pos.x - base.pos.x, actual.pos.y - base.pos.y, actual.pos.z - base.pos.z) < 0.001, "rail carries position during playback");
		assert.ok(Math.abs(actual.pitch - expected.pitch) < 0.00001, "playback reproduces pitch");
		assert.ok(Math.abs(actual.roll - 17 * Math.PI / 180) < 0.00001, "authored roll survives recording");
		measurements.push({ playback: frame, camera: actual });
	}
	await b.evaluate(`window.__railExpectedTake=${JSON.stringify(JSON.stringify(first.camera.aimTake))}`);
	await wait(`JSON.stringify(JSON.parse(localStorage.getItem('${SCENES_STORAGE_KEY}')).scenes[0].shotDocument.shots[0].camera.aimTake) === window.__railExpectedTake`);
	await b.navigate(new URL("/app/", b.base));
	await b.ready();
	assert.deepEqual((await readShots())[0].camera.aimTake, first.camera.aimTake, "take survives reload");
	await seek(18);
	await b.change("!!document.querySelector('[data-testid=\"camera-performance-record\"]')", () => b.click('[data-node-id="camera"]'));
	const second = await record("second", -1);
	const strip = value => { const copy = structuredClone(value); delete copy.camera.aimTake; return copy; };
	assert.deepEqual(strip(second), before[0], "re-record only replaces the take");
	assert.notDeepEqual(second.camera.aimTake, first.camera.aimTake, "new input replaces previous recording");
	await b.change("!document.querySelector('[data-testid=\"camera-take-discard\"]')", () => b.click('[data-testid="camera-take-discard"]'));
	assert.deepEqual((await readShots())[0], before[0], "discard restores the original shot");
	await screenshot("discarded");
	writeFileSync(join(dir, "results.json"), JSON.stringify({ pass: true, viewport: [1438, 979], log, measurements }, null, 2));
	console.log("PASS native aim recording, start/middle/end measurements, faithful playback, reload, re-record and discard");
	console.log(`EVIDENCE ${dir}/results.json`);
} finally {
	b.close();
}
