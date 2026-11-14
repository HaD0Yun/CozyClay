// Shared only by the two camera acceptance suites. Observers are installed
// before actions; no sleeps or timer-driven polling. Instrumentation observes
// the production QA state and Three's rotation notifications without replacing
// camera controls, rendering, persistence, or browser pointer-lock APIs.
import assert from "node:assert/strict";
import { SCENES_STORAGE_KEY } from "../src/scenes.js";

export async function cameraBrowser() {
	const port = Number(process.env.CDP_PORT || 9222);
	const base = new URL(process.env.QA_URL || "http://127.0.0.1:5180/app/");
	const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
	const page = targets.find((target) => target.type === "page" && target.webSocketDebuggerUrl);
	assert.ok(page, "QA browser has a page target");
	const ws = new WebSocket(page.webSocketDebuggerUrl);
	await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
	let nextId = 0;
	const pending = new Map();
	ws.onmessage = (event) => {
		const message = JSON.parse(event.data);
		const request = pending.get(message.id);
		if (!request) return;
		pending.delete(message.id);
		clearTimeout(request.timer);
		if (message.error) request.reject(new Error(JSON.stringify(message.error)));
		else request.resolve(message.result);
	};
	const send = (method, params = {}) => new Promise((resolve, reject) => {
		const id = ++nextId;
		const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 45000);
		pending.set(id, { resolve, reject, timer });
		ws.send(JSON.stringify({ id, method, params }));
	});
	const evaluate = async (expression) => {
		const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
		if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || "page evaluation failed");
		return result.result.value;
	};
	const eventOnce = (method) => new Promise((resolve, reject) => {
		const cleanup = () => { clearTimeout(timer); ws.removeEventListener("message", listener); };
		const listener = (event) => { if (JSON.parse(event.data).method === method) { cleanup(); resolve(); } };
		const timer = setTimeout(() => { cleanup(); reject(new Error(`event timeout: ${method}`)); }, 40000);
		ws.addEventListener("message", listener);
	});
	await send("Page.enable");
	await send("Page.addScriptToEvaluateOnNewDocument", { source: `(() => {
		let state;
		const watched = new WeakSet();
		Object.defineProperty(window, '__cozyclay', {
			configurable: true,
			get: () => state,
			set: (value) => {
				state = value;
				for (const cam of [value?.shotCam, value?.editorCam]) {
					if (!cam || watched.has(cam)) continue;
					watched.add(cam);
					const original = cam.rotation._onChangeCallback;
					cam.rotation._onChange(function () {
						original.call(this);
						window.dispatchEvent(new Event('qa:camera-state'));
					});
				}
				window.dispatchEvent(new Event('qa:camera-state'));
			},
		});
	})()` });
	const navigate = async (url) => {
		const loaded = eventOnce("Page.loadEventFired");
		const result = await send("Page.navigate", { url: String(url) });
		assert.equal(result.errorText, undefined, "navigation succeeds");
		await loaded;
	};
	const arm = (condition, timeoutMs = 30000) => evaluate(`(() => {
		const check = () => !!(${condition});
		window.__qaCameraWait = new Promise((resolve, reject) => {
			const observer = new MutationObserver(probe);
			const cleanup = () => {
				clearTimeout(timer); observer.disconnect();
				window.removeEventListener('qa:camera-state', probe);
				document.removeEventListener('pointerlockchange', probe);
			};
			function probe() { if (check()) { cleanup(); resolve(true); } }
			const timer = setTimeout(() => { cleanup(); reject(new Error('camera state timeout: ' + ${JSON.stringify(condition)})); }, ${timeoutMs});
			observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
			window.addEventListener('qa:camera-state', probe);
			document.addEventListener('pointerlockchange', probe);
			probe();
		});
		window.__qaCameraWait.catch(() => {});
		return true;
	})()`);
	const settled = () => evaluate("window.__qaCameraWait");
	const change = async (condition, action) => { await arm(condition); await action(); await settled(); };
	const ready = async () => {
		await arm("!!window.__cozyclay?.rigA && !!window.__cozyclay?.editorCam && !!document.querySelector('.stage canvas')");
		await settled();
		// A headless page can mount without document focus, and Chrome refuses
		// pointer lock to an unfocused document, so every right-drag fly would
		// time out. A user right-dragging the stage has the window focused.
		await send("Page.bringToFront");
		assert.equal(await evaluate("document.hasFocus()"), true, "QA page has document focus");
	};
	const centre = (selector) => evaluate(`(() => {
		const element = document.querySelector(${JSON.stringify(selector)});
		if (!element) throw new Error('missing element: ' + ${JSON.stringify(selector)});
		const r = element.getBoundingClientRect();
		if (r.width < 1 || r.height < 1) throw new Error('hidden element: ' + ${JSON.stringify(selector)});
		return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
	})()`);
	const mouse = (type, options) => send("Input.dispatchMouseEvent", { type, ...options });
	const click = async (selector) => {
		const point = await centre(selector);
		await mouse("mousePressed", { ...point, button: "left", buttons: 1, clickCount: 1 });
		await mouse("mouseReleased", { ...point, button: "left", buttons: 0, clickCount: 1 });
	};
	const escape = async () => {
		await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
		await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
	};
	const pose = (name = "shotCam") => evaluate(`(() => {
		const c = window.__cozyclay[${JSON.stringify(name)}];
		return { pos: { x: c.position.x, y: c.position.y, z: c.position.z }, yaw: c.rotation.y, pitch: c.rotation.x, fovDeg: c.fov };
	})()`);
	const seed = async () => {
		await navigate(`${base.origin}/favicon.ico`);
		await evaluate(`(() => {
			localStorage.clear();
			localStorage.setItem('cozyclay.locale', 'en');
			localStorage.setItem('cozyclay.project-session.v1', JSON.stringify({ name: 'Camera QA', updatedAt: Date.now() }));
			localStorage.setItem('${SCENES_STORAGE_KEY}', JSON.stringify({ version: 4, activeSceneId: 'camera-qa', scenes: [{
				id: 'camera-qa', name: 'Camera QA', objects: [],
				shotDocument: { version: 4, frameCount: 144, waypoints: [], shots: [
					{ id: 'shot-a', name: 'Shot A', startFrame: 0, endFrame: 47, camera: { mode: 'keys' }, cameraKeys: [] },
					{ id: 'shot-b', name: 'Shot B', startFrame: 48, endFrame: 95, camera: { mode: 'keys' }, cameraKeys: [
						{ id: 'key-b', frame: 48, framing: { pos: { x: -2, y: 2, z: 4 }, yaw: -0.45, pitch: -0.12, fovDeg: 45 } }
					] }
				] },
				stage: { characters: [{ id: 'char-a', model: 'y-bot-tpose', x: 0, z: 0, rot: 0, hidden: false, pose: null, subject: 'a person' }], hasCharSheet: false, shotAspect: '16:9' }
			}] }));
		})()`);
		await navigate(new URL("/app/", base));
		await ready();
	};
	return { base, send, evaluate, navigate, arm, settled, change, ready, centre, mouse, click, escape, pose, seed,
		close: () => { for (const request of pending.values()) clearTimeout(request.timer); ws.close(); } };
}

export function assertPose(actual, expected, message) {
	for (const field of ["yaw", "pitch", "fovDeg"]) assert.ok(Math.abs(actual[field] - expected[field]) < 1e-5, `${message}: ${field}: ${actual[field]} != ${expected[field]}`);
	for (const axis of ["x", "y", "z"]) assert.ok(Math.abs(actual.pos[axis] - expected.pos[axis]) < 1e-5, `${message}: position.${axis}`);
}
