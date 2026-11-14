// The CDP plumbing test/qa-stage-hdr-browser.mjs drives the studio page with:
// evaluate in the page, run Studio actions, wait, count failures.

/** Connect to the QA browser's studio page. */
export async function connectStudio(port) {
	const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
	const page = targets.find((target) => target.type === "page" && target.url.includes("/app/")) ?? targets.find((target) => target.type === "page" && target.webSocketDebuggerUrl);
	if (!page) throw new Error("no page target on the QA browser");
	const ws = new WebSocket(page.webSocketDebuggerUrl);
	await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
	let nextId = 1, failures = 0;
	const pending = new Map();
	ws.onmessage = (event) => {
		const message = JSON.parse(event.data);
		if (!message.id || !pending.has(message.id)) return;
		const { resolve, reject } = pending.get(message.id);
		pending.delete(message.id);
		if (message.error) reject(new Error(JSON.stringify(message.error)));
		else resolve(message.result);
	};
	const send = (method, params = {}) => new Promise((resolve, reject) => {
		const id = nextId++;
		pending.set(id, { resolve, reject });
		ws.send(JSON.stringify({ id, method, params }));
	});
	const evaluate = async (expression) => {
		const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
		if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || "evaluate failed");
		return result.result.value;
	};
	const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
	const waitFor = async (expression, timeoutMs = 30000) => {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			if (await evaluate(expression).catch(() => false)) return true;
			await sleep(150);
		}
		return false;
	};
	const expect = (name, condition, detail = "") => {
		console.log(`${condition ? "PASS" : "FAIL"} ${name}${condition ? "" : ` — ${detail}`}`);
		if (!condition) failures += 1;
	};
	const act = (id, args) => evaluate(`(async () => { const r = await window.__cozyclay.runStudioAction(${JSON.stringify(id)}, ${JSON.stringify(args)}); return { ok: r?.ok, receiptId: r?.receiptId, error: r?.ok ? undefined : (r?.error?.message ?? r?.message ?? null) }; })()`);
	const finish = (name) => {
		ws.close();
		if (failures) {
			console.log(`${name}: ${failures} failure(s)`);
			process.exitCode = 1;
			return;
		}
		console.log(`${name}: all checks passed`);
	};
	return { send, evaluate, act, sleep, waitFor, expect, finish };
}

/**
 * In-page helpers (window.__hdrQa): the stage scene's environment state, the
 * export frame through a framing with mean colour in pixel windows around world
 * points (bone names, [x, y, z]), pixels ({ px: [x, y] }) or fractions of the frame
 * ({ fx: [x, y] }), the +x / -x / chest
 * points of the character, and a frame of the exported video.
 */
export const HDR_PAGE_HELPERS = `(() => {
	const studio = window.__cozyclay;
	const root = () => { let node = studio.editorCam; while (node.parent) node = node.parent; return node; };
	const bone = (name) => { let found = null; studio.rigA.traverse((o) => { if (!found && o.isBone && o.name === name) found = o; }); return found.getWorldPosition(found.position.clone()); };
	const windowsOf = (data, width, height, points, radius, project) => Object.fromEntries(Object.entries(points ?? {}).map(([key, point]) => {
		const [cx, cy] = point.px ?? (point.fx ? [Math.round(point.fx[0] * width), Math.round(point.fx[1] * height)] : project(typeof point === "string" ? bone(point) : studio.rigA.position.clone().set(...point)));
		let r = 0, g = 0, b = 0, n = 0;
		for (let y = Math.max(0, cy - radius); y <= Math.min(height - 1, cy + radius); y++) for (let x = Math.max(0, cx - radius); x <= Math.min(width - 1, cx + radius); x++) {
			const i = (y * width + x) * 4; r += data[i]; g += data[i + 1]; b += data[i + 2]; n++;
		}
		return [key, { at: [cx, cy], rgb: [r / n, g / n, b / n].map((v) => Number(v.toFixed(1))), luma: (0.2126 * r + 0.7152 * g + 0.0722 * b) / n }];
	}));
	const pixelsOf = async (source) => {
		const canvas = document.createElement("canvas"); canvas.width = source.videoWidth || source.width; canvas.height = source.videoHeight || source.height;
		const context = canvas.getContext("2d"); context.drawImage(source, 0, 0);
		return context.getImageData(0, 0, canvas.width, canvas.height);
	};
	window.__hdrQa = {
		// The backdrop a perspective camera gets (the stage swaps it per camera before each draw).
		state: () => { const scene = root(); scene.onBeforeRender?.(null, scene, studio.shotCam); return { environment: !!scene.environment, intensity: scene.environmentIntensity, rotation: Number(scene.environmentRotation.y.toFixed(4)), background: !!scene.background?.isTexture && scene.background.image?.width >= 256, backgroundIntensity: scene.backgroundIntensity }; },
		sides: () => {
			const left = bone("mixamorigLeftArm"), right = bone("mixamorigRightArm");
			const [plusX, minusX] = left.x > right.x ? ["mixamorigLeftArm", "mixamorigRightArm"] : ["mixamorigRightArm", "mixamorigLeftArm"];
			return { plusX, minusX, chest: "mixamorigSpine2" };
		},
		async frame(framing, points, radius) {
			const url = framing ? studio.captureFraming(framing) : studio.captureWithReferences().dataUrl;
			const image = new Image(); image.src = url; await image.decode();
			const { data, width, height } = await pixelsOf(image);
			let hash = 2166136261;
			for (let i = 0; i < data.length; i += 4) hash = Math.imul(hash ^ data[i] ^ (data[i + 1] << 8) ^ (data[i + 2] << 16), 16777619) >>> 0;
			const cam = studio.shotCam.clone();
			if (framing) {
				cam.clearViewOffset(); cam.position.set(framing.pos.x, framing.pos.y, framing.pos.z);
				cam.rotation.order = "YXZ"; cam.rotation.set(framing.pitch, framing.yaw, 0); cam.fov = framing.fovDeg;
			}
			cam.aspect = width / height; cam.updateProjectionMatrix(); cam.updateMatrixWorld(true);
			const project = (world) => { const ndc = world.clone().project(cam); return [Math.round(((ndc.x + 1) / 2) * width), Math.round(((1 - ndc.y) / 2) * height)]; };
			return { hash, url, width, height, windows: windowsOf(data, width, height, points, radius, project) };
		},
		async video(points, radius) {
			const result = await studio.exportShotVideo({ download: false });
			const video = document.createElement("video"); video.muted = true; video.src = URL.createObjectURL(result.blob);
			await new Promise((resolve, reject) => { video.onloadeddata = resolve; video.onerror = () => reject(new Error("the video does not decode")); });
			video.currentTime = 0.05; await new Promise((resolve) => { video.onseeked = resolve; });
			const { data, width, height } = await pixelsOf(video);
			return { frames: result.frameCount, width, height, windows: windowsOf(data, width, height, points, radius, null) };
		},
	};
	return true;
})()`;
