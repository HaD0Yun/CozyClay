#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { cameraBrowser } from "./camera-browser-harness.mjs";

const outputDir = process.env.QA_OUT || "/Users/yun/CozyClay/.omo/evidence/previs-modes/previs-modes-w2b/shots";
mkdirSync(outputDir, { recursive: true });
const b = await cameraBrowser();
const errors = [];
// A separate observer leaves the shared harness's CDP response handler intact.
const targets = await (await fetch(`http://127.0.0.1:${process.env.CDP_PORT || 9631}/json`)).json();
const target = targets.find(t => t.type === "page" && t.webSocketDebuggerUrl);
const observer = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { observer.onopen = resolve; observer.onerror = reject; });
observer.onmessage = event => {
	const message = JSON.parse(event.data);
	if (message.method === "Runtime.exceptionThrown") errors.push(message.params.exceptionDetails.text);
	if (message.method === "Runtime.consoleAPICalled" && message.params.type === "error") errors.push(message.params.args.map(arg => arg.value ?? arg.description).join(" "));
};
observer.send(JSON.stringify({ id: 1, method: "Runtime.enable" }));

try {
	await b.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
	await b.seed();
	// Use the mounted AppContext provider, not a second command bus.
	await b.evaluate(`(() => {
		const element = document.querySelector('.app');
		let fiber = element[Object.keys(element).find(key => key.startsWith('__reactFiber'))];
		while (fiber && !fiber.memoizedProps?.value?.bus) fiber = fiber.return;
		if (!fiber) throw new Error('AppContext provider not found');
		const context = fiber.memoizedProps.value;
		window.__proxyContext = context;
		window.__proxyBus = { bus: context.bus, get characters() { return context.live.characters; } };
	})()`);
	await b.change("!!document.querySelector('[data-node-id=\"character:qa-proxy\"]')", () => b.evaluate(`window.__proxyBus.bus.run('character.add', { character: { id: 'qa-proxy', model: 'proxy-figure', tint: '#cf946e', posture: 'stand', x: 0, z: 0, rot: 0 } })`));
	assert.equal(await b.evaluate("window.__proxyBus.characters.find(c => c.id === 'qa-proxy')?.model"), "proxy-figure");
	await b.evaluate(`(() => {
		let root = window.__cozyclay.rigA;
		while (root.parent) root = root.parent;
		window.__proxyScene = root;
	})()`);
	assert.equal(await b.evaluate("window.__proxyScene.isScene"), true, "inspect the renderer-owned scene, not a second module's root map");
	await b.evaluate(`(async () => {
		const THREE = await import('/node_modules/.vite/deps/three.js');
		window.__proxyThree = THREE;
		window.__proxyRoot = () => {
			let found;
			window.__proxyScene.traverse(node => { if (node.userData.characterPick === 'qa-proxy') found = node; });
			return found;
		};
		window.__proxyBounds = () => {
			const root = window.__proxyRoot();
			root.updateWorldMatrix(true, true);
			const box = new THREE.Box3().setFromObject(root);
			return {
				height: box.max.y - box.min.y,
				minX: box.min.x,
				maxX: box.max.x,
				minY: box.min.y,
				maxY: box.max.y,
				maxZ: box.max.z,
				minZ: box.min.z,
			};
		};
	})()`);
	assert.ok(await b.evaluate("!!window.__proxyRoot()"), "proxy pick root exists");
	assert.equal(await b.evaluate(`(() => { let meshes = 0; window.__proxyRoot().traverse(n => { if (n.isMesh) meshes++; }); return meshes; })()`), 2, "body and head render");
	await b.evaluate(`window.__proxyBus.bus.run('character.update', { characterId: 'char-a', patch: { hidden: true } })`);
	await b.click('[data-node-id="camera"]');
	await b.evaluate("window.__cozyclay.frameEditorCam({x: 2.2, y: 1.8, z: 3}, {x: 0, y: 0.8, z: 0})");
	const point = await b.evaluate(`(() => {
		const p = new window.__proxyThree.Vector3(0, 0.7, 0).project(window.__cozyclay.editorCam);
		const r = window.__cozyclay.mainPane.getBoundingClientRect();
		return { x: r.left + (p.x + 1) * r.width / 2, y: r.top + (1 - p.y) * r.height / 2 };
	})()`);
	await b.change("document.querySelector('[data-node-id=\"character:qa-proxy\"]')?.getAttribute('aria-selected') === 'true' || document.querySelector('[data-node-id=\"character:qa-proxy\"]')?.classList.contains('selected')", async () => {
		await b.mouse("mousePressed", { ...point, button: "left", buttons: 1, clickCount: 1 });
		await b.mouse("mouseReleased", { ...point, button: "left", buttons: 0, clickCount: 1 });
	});
	console.log("PASS clicking proxy mesh selects its stable character row");
	await b.arm("window.__characterGizmoHandles?.().some(h => h.axis === 'x')");
	await b.settled();
	for (const axis of ["x", "z"]) {
		const before = await b.evaluate(`window.__proxyBus.characters.find(c => c.id === 'qa-proxy').${axis}`);
		const handle = await b.evaluate(`window.__characterGizmoHandles().find(h => h.axis === '${axis}')`);
		await b.change(`Math.abs(window.__proxyBus.characters.find(c => c.id === 'qa-proxy').${axis} - ${before}) > 0.01`, async () => {
			await b.mouse("mousePressed", { x: handle.x, y: handle.y, button: "left", buttons: 1 });
			for (let tick = 1; tick <= 8; tick++) {
				await b.mouse("mouseMoved", { x: handle.x + tick * 8, y: handle.y + tick * 2, button: "left", buttons: 1 });
			}
			await b.mouse("mouseReleased", { x: handle.x + 64, y: handle.y + 16, button: "left", buttons: 0 });
		});
		await b.change(`Math.abs(window.__proxyBus.characters.find(c => c.id === 'qa-proxy').${axis} - ${before}) < 1e-6`, async () => {
			const key = { key: "z", code: "KeyZ", windowsVirtualKeyCode: 90, modifiers: process.platform === "darwin" ? 4 : 2 };
			await b.send("Input.dispatchKeyEvent", { type: "keyDown", ...key });
			await b.send("Input.dispatchKeyEvent", { type: "keyUp", ...key });
		});
		console.log(`PASS ${axis} gizmo drag changes placement; Cmd/Ctrl+Z restores`);
	}
	for (const posture of ["stand", "sit", "lie"]) {
		await b.change(`window.__proxyBus.characters.find(c => c.id === 'qa-proxy').posture === '${posture}'`, () =>
			b.evaluate(`window.__proxyBus.bus.run('character.update', { characterId: 'qa-proxy', patch: { posture: '${posture}' } })`));
		const bounds = await b.evaluate("window.__proxyBounds()");
		if (posture === "stand") assert.ok(Math.abs(bounds.height - 1.7) < 0.01);
		if (posture === "sit") assert.ok(bounds.height < 1.2 && bounds.height > 1);
		if (posture === "lie") assert.ok(bounds.height < 0.5, JSON.stringify(bounds));
		const target = {
			x: (bounds.minX + bounds.maxX) / 2,
			y: (bounds.minY + bounds.maxY) / 2,
			z: (bounds.minZ + bounds.maxZ) / 2,
		};
		const offset = posture === "lie"
			? { x: 2.2, y: 1.8, z: 2.8 }
			: { x: 2.4, y: 1.4, z: 3.0 };
		const eye = {
			x: target.x + offset.x,
			y: target.y + offset.y,
			z: target.z + offset.z,
		};
		await b.arm(`(() => {
			const c = window.__cozyclay.editorCam;
			return Math.hypot(c.position.x - ${eye.x}, c.position.y - ${eye.y}, c.position.z - ${eye.z}) < 1e-5;
		})()`);
		await b.evaluate(`window.__cozyclay.frameEditorCam(${JSON.stringify(eye)}, ${JSON.stringify(target)})`);
		await b.settled();
		const plate = await b.evaluate(`(() => {
			const c = window.__cozyclay;
			const camera = c.editorCam;
			return c.captureFraming({
				pos: { x: camera.position.x, y: camera.position.y, z: camera.position.z },
				yaw: camera.rotation.y,
				pitch: camera.rotation.x,
				fovDeg: camera.fov,
			});
		})()`);
		const path = `${outputDir}/proxy-figure-${posture}.png`;
		writeFileSync(path, Buffer.from(plate.split(",")[1], "base64"));
		console.log(`PASS ${posture} bounds ${JSON.stringify(bounds)}; QA_SCREENSHOT ${path} bytes=${statSync(path).size}`);
	}
	await b.change("window.__proxyBus.characters.find(c => c.id === 'qa-proxy').posture === 'stand'", () =>
		b.evaluate("window.__proxyBus.bus.run('character.update', { characterId: 'qa-proxy', patch: { posture: 'unknown' } })"));
	assert.ok(await b.evaluate("!!window.__proxyRoot()"));
	assert.equal(errors.length, 0, errors.join("\n"));
	console.log("PASS unknown posture normalizes to stand; figure still renders; zero page/console errors");
	for (const shotId of ["shot-a", "shot-b"]) {
		const removeReceipt = await b.evaluate(`window.__proxyBus.bus.run('shot.remove', { shotId: ${JSON.stringify(shotId)} })`);
		assert.equal(removeReceipt.ok, true, JSON.stringify(removeReceipt));
	}
	const seekReceipt = await b.evaluate("window.__proxyBus.bus.run('timeline.seek', { frame: 0 })");
	assert.equal(seekReceipt.ok, true, JSON.stringify(seekReceipt));
	const shotReceipt = await b.evaluate(`(() => {
		const original = URL.createObjectURL;
		window.__proxyVideoSizes = [];
		URL.createObjectURL = function(blob) {
			if (blob.type === 'video/mp4') window.__proxyVideoSizes.push(blob.size);
			return original.call(this, blob);
		};
		return window.__proxyBus.bus.run('shot.create');
	})()`);
	assert.equal(shotReceipt.ok, true, JSON.stringify(shotReceipt));
	const shotId = shotReceipt.affectedIds?.[0] ?? shotReceipt.output?.shotId;
	assert.ok(shotId, JSON.stringify(shotReceipt));
	const rangeReceipt = await b.evaluate(`window.__proxyBus.bus.run('shot.setRange', { shotId: ${JSON.stringify(shotId)}, range: { startFrame: 0, endFrameExclusive: 24 } })`);
	assert.equal(rangeReceipt.ok, true, JSON.stringify(rangeReceipt));
	const rangedShot = await b.evaluate(`(async () => {
		const project = JSON.parse(await window.__cozyclayProject.export()).scenes;
		const scene = project.scenes.find(entry => entry.id === project.activeSceneId) || project.scenes[0];
		return scene.shotDocument.shots.find(shot => shot.id === ${JSON.stringify(shotId)});
	})()`);
	assert.equal(rangedShot?.startFrame, 0, JSON.stringify(rangedShot));
	assert.equal(rangedShot?.endFrame, 23, JSON.stringify(rangedShot));
	const stillVideo = await b.evaluate(`window.__proxyBus.bus.run('export.shotVideo', { shotId: ${JSON.stringify(shotId)} })`);
	assert.equal(stillVideo.status, "completed", JSON.stringify(stillVideo));
	assert.equal(stillVideo.output?.frameCount, 24, JSON.stringify(stillVideo));
	const noPathBytes = await b.evaluate("window.__proxyVideoSizes.at(-1)");
	assert.ok(Number.isInteger(noPathBytes) && noPathBytes > 0, `no-path sizes=${JSON.stringify(await b.evaluate("window.__proxyVideoSizes"))}`);
	for (const [frame, position] of [[8, { x: 1, z: 0 }], [16, { x: 1, z: 1 }]]) {
		const receipt = await b.evaluate(`window.__proxyBus.bus.run('character.addWaypoint', { characterId: 'qa-proxy', frame: ${frame}, position: ${JSON.stringify(position)} })`);
		assert.equal(receipt.ok, true, JSON.stringify(receipt));
	}
	await b.change("Math.abs(window.__proxyRoot().position.x - 1) < 1e-6", () =>
		b.evaluate("window.__proxyBus.bus.run('timeline.seek', { frame: 12 })"));
	const midpoint = await b.evaluate(`(() => {
		let puck;
		window.__proxyScene.traverse(node => { if (node.userData.characterPuck === 'qa-proxy') puck = node; });
		return { mesh: window.__proxyRoot().getWorldPosition(new window.__proxyThree.Vector3()).toArray(), puck: puck.position.toArray() };
	})()`);
	assert.ok(Math.abs(midpoint.mesh[0] - 1) < 1e-6, JSON.stringify(midpoint));
	assert.ok(Math.abs(midpoint.puck[0] - 1) < 1e-6, JSON.stringify(midpoint));
	assert.ok(Math.abs(midpoint.mesh[2] - 0.5) < 1e-6, JSON.stringify(midpoint));
	assert.ok(Math.abs(midpoint.puck[2] - 0.5) < 1e-6, JSON.stringify(midpoint));
	console.log(`PASS root-path midpoint mesh and puck follow ${JSON.stringify(midpoint)}`);
	const movingVideo = await b.evaluate(`window.__proxyBus.bus.run('export.shotVideo', { shotId: ${JSON.stringify(shotId)} })`);
	assert.equal(movingVideo.status, "completed", JSON.stringify(movingVideo));
	assert.equal(movingVideo.output?.frameCount, 24, JSON.stringify(movingVideo));
	const pathBytes = await b.evaluate("window.__proxyVideoSizes.at(-1)");
	assert.ok(Number.isInteger(pathBytes) && pathBytes > 0, `path sizes=${JSON.stringify(await b.evaluate("window.__proxyVideoSizes"))}`);
	assert.notEqual(noPathBytes, pathBytes, `moving mp4 byte size matches no-path export: ${noPathBytes}`);
	assert.ok(Math.abs(await b.evaluate("window.__proxyRoot().position.x") - 1) < 1e-6, "export restores viewport placement");
	console.log(`PASS export.shotVideo bus action 24-frame mp4 byte sizes differ no-path=${noPathBytes} path=${pathBytes}; viewport restored`);
	await b.evaluate("window.__proxyBus.bus.run('character.update', { characterId: 'char-a', patch: { hidden: false } })");
	await b.settled();
	const rigBefore = await b.evaluate(`(() => {
		let rig;
		window.__proxyScene.traverse(node => { if (node.userData.characterPick === 'char-a' && node.type === 'Group') rig = node; });
		return rig?.getWorldPosition(new window.__proxyThree.Vector3()).toArray() ?? null;
	})()`);
	assert.ok(rigBefore, "rigged character root exists");
	const rigReceipt = await b.evaluate("window.__proxyBus.bus.run('character.addWaypoint', { characterId: 'char-a', frame: 24, position: { x: 1, z: 0 } })");
	assert.equal(rigReceipt.ok, true, JSON.stringify(rigReceipt));
	await b.change("Math.abs(window.__proxyRoot().position.x - 1) < 1e-6", () =>
		b.evaluate("window.__proxyBus.bus.run('timeline.seek', { frame: 18 })"));
	const rigAfter = await b.evaluate(`(() => {
		let rig;
		window.__proxyScene.traverse(node => { if (node.userData.characterPick === 'char-a' && node.type === 'Group') rig = node; });
		return rig?.getWorldPosition(new window.__proxyThree.Vector3()).toArray() ?? null;
	})()`);
	assert.deepEqual(rigAfter, rigBefore);
	console.log(`PASS rigged waypoint does not change rendered position before=${JSON.stringify(rigBefore)} after=${JSON.stringify(rigAfter)}`);
	const shot = await b.send("Page.captureScreenshot", { format: "png" });
	const screenshot = `${outputDir}/task-6-previs-modes.png`;
	writeFileSync(screenshot, Buffer.from(shot.data, "base64"));
	console.log(`QA_SCREENSHOT ${screenshot} bytes=${statSync(screenshot).size}`);

	// #635: rig-only features refuse the capsule figure; the rig keeps them.
	const capture = async (name) => {
		const image = await b.send("Page.captureScreenshot", { format: "png" });
		const file = `${outputDir}/${name}.png`;
		writeFileSync(file, Buffer.from(image.data, "base64"));
		console.log(`QA_SCREENSHOT ${file} bytes=${statSync(file).size}`);
	};
	const pressTwo = async () => {
		const key = { key: "2", code: "Digit2", windowsVirtualKeyCode: 50 };
		await b.send("Input.dispatchKeyEvent", { type: "keyDown", ...key, text: "2" });
		await b.send("Input.dispatchKeyEvent", { type: "keyUp", ...key });
	};
	const workflowMode = "document.querySelector('[data-mode][aria-selected=\"true\"]')?.dataset.mode";
	const proxyRefusal = "Capsule figures have no rig - Pose mode works on rigged characters only.";
	await b.change("window.__proxyContext.live.state?.activeCharacterId === 'qa-proxy'", () => b.click('[data-node-id="character:qa-proxy"]'));
	const modeBefore = await b.evaluate(workflowMode);
	assert.equal(await b.evaluate("document.querySelector('[data-mode=\"pose\"]').dataset.disabledReason"), proxyRefusal);
	await b.change(`[...document.querySelectorAll('.toast')].some(t => t.textContent === ${JSON.stringify(proxyRefusal)})`, pressTwo);
	assert.equal(await b.evaluate(workflowMode), modeBefore, "mode stays after the refusal");
	console.log(`PASS capsule active + 2 -> toast "${proxyRefusal}"; mode stays ${modeBefore}`);
	await capture("task-7-proxy-pose-refused");
	await b.change("window.__proxyContext.live.state?.activeCharacterId === 'char-a'", () => b.click('[data-node-id="character:char-a"]'));
	assert.equal(await b.evaluate("document.querySelector('[data-mode=\"pose\"]').dataset.disabledReason ?? null"), null);
	await b.change(`${workflowMode} === 'pose'`, pressTwo);
	console.log("PASS rig active + 2 -> Pose mode opens");
	await capture("task-7-rig-pose-open");
	assert.equal(errors.length, 0, errors.join("\n"));
} finally {
	observer.close();
	b.close();
}
