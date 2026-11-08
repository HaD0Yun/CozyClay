#!/usr/bin/env node
// #636: the proxy figure is cast from the Assets tab. Drag its tile onto the
// stage, find it at the drop point with the Capsule foldout in Details, sit it
// down, and check the Characters search still filters it out.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { cameraBrowser } from "./camera-browser-harness.mjs";

const outputDir = process.env.QA_OUT || "/Users/yun/CozyClay/.omo/evidence/previs-modes/previs-modes-w2b/shots";
mkdirSync(outputDir, { recursive: true });
const b = await cameraBrowser();
const errors = [];
// A separate observer leaves the shared harness's CDP response handler intact.
const targets = await (await fetch(`http://127.0.0.1:${process.env.CDP_PORT || 9222}/json`)).json();
const target = targets.find(t => t.type === "page" && t.webSocketDebuggerUrl);
const observer = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { observer.onopen = resolve; observer.onerror = reject; });
observer.onmessage = event => {
	const message = JSON.parse(event.data);
	if (message.method === "Runtime.exceptionThrown") errors.push(message.params.exceptionDetails.text);
	if (message.method === "Runtime.consoleAPICalled" && message.params.type === "error") errors.push(message.params.args.map(arg => arg.value ?? arg.description).join(" "));
};
observer.send(JSON.stringify({ id: 1, method: "Runtime.enable" }));

const TILE = '[data-asset-key="character:proxy-figure"]';
const tileCount = "document.querySelectorAll('[data-testid=\"content-browser\"] [data-testid=\"content-asset\"]').length";
const proxy = "window.__proxyQa.characters.find(c => c.model === 'proxy-figure')";

try {
	await b.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
	await b.seed();
	await b.navigate(b.base.href);
	await b.ready();
	await b.evaluate(`(async () => {
		const element = document.querySelector('.app');
		let fiber = element[Object.keys(element).find(key => key.startsWith('__reactFiber'))];
		while (fiber && !fiber.memoizedProps?.value?.bus) fiber = fiber.return;
		if (!fiber) throw new Error('AppContext provider not found');
		const context = fiber.memoizedProps.value;
		const THREE = await import('/node_modules/.vite/deps/three.js');
		const { _roots } = await import('/node_modules/.vite/deps/@react-three_fiber.js');
		const scene = document.querySelector('canvas').__r3f?.root?.getState?.().scene ?? _roots.get(document.querySelector('canvas')).store.getState().scene;
		window.__proxyQa = {
			THREE,
			get characters() { return context.live.characters; },
			height() {
				let root;
				scene.traverse(node => { if (node.userData.characterPick === 'B') root = node; });
				if (!root) return null;
				root.updateWorldMatrix(true, true);
				const box = new THREE.Box3().setFromObject(root);
				return box.max.y - box.min.y;
			},
		};
	})()`);

	// The Assets tab's Characters folder: two rigs and the proxy figure.
	// The Sequencer header overlaps the dock tab strip's hit area at this
	// viewport (pre-existing), so the tab is activated on the element itself.
	await b.change("document.querySelector('[data-testid=\"dock-tab-assets\"]').getAttribute('aria-selected') === 'true'",
		() => b.evaluate("document.querySelector('[data-testid=\"dock-tab-assets\"]').click()"));
	// The docked pane shows every folder on one scroll ("All"); the
	// Characters section lists the three casting tiles.
	await b.change(`!!document.querySelector('${TILE}')`, () => b.evaluate("null"));
	const keys = await b.evaluate("[...document.querySelectorAll('[data-folder=\"characters\"] [data-testid=\"content-asset\"]')].map(n => n.dataset.assetKey)");
	assert.deepEqual(keys, ["character:y-bot-tpose", "character:x-bot-tpose", "character:proxy-figure"]);
	console.log(`PASS Characters folder lists three tiles: ${keys.join(", ")}`);
	console.log(`PASS proxy tile label: ${await b.evaluate(`document.querySelector('${TILE} .content-tile-name').textContent`)}`);

	// Drag the tile onto a known floor point.
	const drop = { x: 1.2, z: 0.6 };
	const point = await b.evaluate(`(() => {
		const c = window.__cozyclay;
		const cam = c.lookThroughShot ? c.shotCam : c.editorCam;
		const p = new window.__proxyQa.THREE.Vector3(${drop.x}, 0, ${drop.z}).project(cam);
		const r = c.mainPane.getBoundingClientRect();
		return { x: r.left + (p.x + 1) * r.width / 2, y: r.top + (1 - p.y) * r.height / 2 };
	})()`);
	const grab = await b.centre(TILE);
	await b.change(`!!(${proxy}) && !!document.querySelector('[data-testid="proxy-posture"]')`, async () => {
		await b.mouse("mousePressed", { ...grab, button: "left", buttons: 1, clickCount: 1 });
		for (let step = 1; step <= 10; step++) {
			await b.mouse("mouseMoved", { x: grab.x + (point.x - grab.x) * step / 10, y: grab.y + (point.y - grab.y) * step / 10, button: "left", buttons: 1 });
		}
		await b.mouse("mouseReleased", { ...point, button: "left", buttons: 0, clickCount: 1 });
	});
	const placed = await b.evaluate(`(() => { const c = ${proxy}; return { id: c.id, model: c.model, posture: c.posture, x: c.x, z: c.z }; })()`);
	assert.ok(Math.hypot(placed.x - drop.x, placed.z - drop.z) < 0.05, JSON.stringify(placed));
	assert.equal(placed.posture, "stand");
	console.log(`PASS dropped proxy figure ${JSON.stringify(placed)} at drop point ${JSON.stringify(drop)}`);
	assert.equal(await b.evaluate("document.querySelectorAll('[data-rig-id]').length"), 0, "no rig picker for a proxy figure");
	const foldout = await b.evaluate("document.querySelector('[data-testid=\"proxy-posture\"]').closest('section').querySelector('.foldout-title').textContent");
	assert.equal(foldout, "Capsule figure");
	const radios = await b.evaluate("[...document.querySelectorAll('[data-testid=\"proxy-posture\"] [role=radio]')].map(n => `${n.textContent}:${n.getAttribute('aria-checked')}`)");
	console.log(`PASS Details shows the "${foldout}" foldout, no rig picker; posture radios ${radios.join(" ")}`);

	const standHeight = await b.evaluate("window.__proxyQa.height()");
	await b.change(`${proxy}.posture === 'sit' && document.querySelector('[data-posture="sit"]').getAttribute('aria-checked') === 'true'`,
		() => b.click('[data-testid="proxy-posture"] [data-posture="sit"]'));
	const sitHeight = await b.evaluate("window.__proxyQa.height()");
	assert.ok(sitHeight < standHeight - 0.3, `sit ${sitHeight} vs stand ${standHeight}`);
	console.log(`PASS Sit radio sets posture sit; render height ${standHeight.toFixed(3)} m -> ${sitHeight.toFixed(3)} m`);

	await b.arm("true");
	await b.evaluate(`window.__cozyclay.frameEditorCam({ x: ${drop.x + 2.6}, y: 1.7, z: ${drop.z + 3.2} }, { x: ${drop.x}, y: 0.5, z: ${drop.z} })`);
	await b.settled();
	const shot = await b.send("Page.captureScreenshot", { format: "png" });
	writeFileSync(`${outputDir}/task-8-previs-modes.png`, Buffer.from(shot.data, "base64"));
	console.log(`QA_SCREENSHOT ${outputDir}/task-8-previs-modes.png`);

	// Failure path: a name query that matches nothing leaves no tile to drag.
	await b.click('[data-testid="content-search"]');
	await b.change(`${tileCount} === 0`, () => b.send("Input.insertText", { text: "xyz" }));
	const empty = await b.evaluate("document.querySelector('[data-testid=\"content-browser\"] .content-empty')?.textContent");
	assert.equal(await b.evaluate(`!!document.querySelector('${TILE}')`), false);
	console.log(`PASS search "xyz" -> ${await b.evaluate(tileCount)} tiles; note "${empty}"`);
	await b.change(`!!document.querySelector('${TILE}') && ${tileCount} === 1`, () => b.evaluate(`(() => {
		const input = document.querySelector('[data-testid="content-search"]');
		Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'caps');
		input.dispatchEvent(new Event('input', { bubbles: true }));
	})()`));
	console.log(`PASS search "caps" -> ${await b.evaluate(tileCount)} tile (proxy figure)`);
	assert.equal(errors.length, 0, errors.join("\n"));
	console.log("PASS zero page/console errors");
} finally {
	observer.close();
	b.close();
}
