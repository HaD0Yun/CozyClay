#!/usr/bin/env node
// Browser QA for issue #526's v2 Details primitives. The suite selects a real
// cube, measures the rendered rows, edits the real NumberField through CDP,
// reads the saved scene document through the page's QA seam, and captures the
// Details surface beside the 2a reference.
import { mkdirSync, writeFileSync } from "node:fs";

const port = Number(process.env.CDP_PORT || 9526);
const out = process.env.QA_OUT || process.env.QA_SHOT_DIR || "/tmp/task-12-details";
mkdirSync(out, { recursive: true });

const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = targets.find((target) => target.type === "page" && target.webSocketDebuggerUrl);
if (!page) throw new Error("no page target on the QA browser");

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
	ws.onopen = resolve;
	ws.onerror = reject;
});

let nextId = 1;
const pending = new Map();
const pageErrors = [];
const consoleErrors = [];
ws.onmessage = (event) => {
	const message = JSON.parse(event.data);
	if (message.method === "Runtime.exceptionThrown") {
		pageErrors.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text);
		return;
	}
	if (message.method === "Runtime.consoleAPICalled" && message.params.type === "error") {
		consoleErrors.push(message.params.args?.map((argument) => argument.value ?? argument.description ?? "").join(" ") || "console error");
		return;
	}
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
	return result.result?.value;
};
const waitFor = (condition, timeoutMs = 20_000) => evaluate(`new Promise((resolve, reject) => {
	let timer;
	const finish = (value, error) => {
		observer?.disconnect();
		clearTimeout(timer);
		if (error) reject(error); else resolve(value);
	};
	const check = () => {
		try { if (${condition}) finish(true); } catch (error) { finish(false, error); }
	};
	const observer = new MutationObserver(check);
	observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
	timer = setTimeout(() => finish(false), ${timeoutMs});
	check();
})`);
const subscribe = async (condition, timeoutMs = 20_000) => evaluate(`(() => {
	window.__qaDetailsWait = new Promise((resolve, reject) => {
		let timer;
		const finish = (value, error) => {
			observer?.disconnect();
			clearTimeout(timer);
			if (error) reject(error); else resolve(value);
		};
		const check = () => {
			try { if (${condition}) finish(true); } catch (error) { finish(false, error); }
		};
		const observer = new MutationObserver(check);
		observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
		timer = setTimeout(() => finish(false), ${timeoutMs});
		check();
	});
	return true;
})()`);
const resolveSubscribed = () => evaluate("window.__qaDetailsWait");
const expect = (name, condition, detail = "") => {
	console.log(`${condition ? "PASS" : "FAIL"} ${name}${condition ? "" : ` — ${detail}`}`);
	if (!condition) failures += 1;
};
const screenshot = async (name) => {
	const { data } = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
	const file = `${out}/${name}.png`;
	writeFileSync(file, Buffer.from(data, "base64"));
	console.log(`     screenshot ${file}`);
	return file;
};
const pageReload = async () => {
	const loaded = new Promise((resolve) => {
		const listener = (event) => {
			const message = JSON.parse(event.data);
			if (message.method !== "Page.loadEventFired") return;
			ws.removeEventListener("message", listener);
			resolve();
		};
		ws.addEventListener("message", listener);
	});
	await send("Page.reload", { ignoreCache: false });
	await loaded;
};
const key = async (type, keyName, code) => send("Input.dispatchKeyEvent", {
	type,
	key: keyName,
	code,
	windowsVirtualKeyCode: keyName.length === 1 ? keyName.toUpperCase().charCodeAt(0) : undefined,
});
const enter = async () => {
	await key("keyDown", "Enter", "Enter");
	await key("keyUp", "Enter", "Enter");
};

let failures = 0;
await send("Runtime.enable");
await send("Page.enable");
await send("Log.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
await waitFor("location.href.startsWith('http')", 30_000);
await evaluate("localStorage.removeItem('cozyclay.scene.v1'); localStorage.removeItem('cozyclay.scene.v1.quarantine'); localStorage.setItem('cozyclay.locale', 'en'); true");
await pageReload();
expect("the studio exposes its Details QA seams", await waitFor("!!window.__cozyclay?.sceneObject && !!window.__cozyclayProject && !!document.querySelector('.hierarchy-row-wrap')", 40_000));

/* The catalogue's one visible Add route is the viewport "+ Add" pill (G10);
   Props keeps only its picture and model import pickers. */
await subscribe("document.querySelector('.props-drop')?.getBoundingClientRect().height > 0");
await evaluate(`document.querySelector('[data-node-id="props"] .hierarchy-row').click(); true`);
expect("selecting Props exposes its import controls", await resolveSubscribed());
const propsAdd = await evaluate(`(() => {
	const panel = document.querySelector('.props-drop');
	const trigger = document.querySelector('[data-testid="viewport-add"]');
	return {
		height: trigger.getBoundingClientRect().height,
		background: getComputedStyle(trigger).backgroundColor,
		radius: getComputedStyle(trigger).borderRadius,
		propsAdd: !!panel.querySelector('.add-object-trigger'),
		imports: [...panel.querySelectorAll('input[type="file"]')].map((input) => input.accept),
	};
})()`);
expect("the viewport Add control uses the v2 pill height, overlay surface and radius, and Props has no Add button", propsAdd.height === 28 && propsAdd.background === "rgba(12, 12, 13, 0.78)" && propsAdd.radius === "6px" && !propsAdd.propsAdd, JSON.stringify(propsAdd));
expect("Props retains both image and model import pickers", propsAdd.imports.length === 2 && propsAdd.imports.some((accept) => accept.includes('image/')) && propsAdd.imports.some((accept) => accept.includes('.glb')), JSON.stringify(propsAdd.imports));

await subscribe("document.querySelector('[data-testid=\"viewport-add\"]')?.getAttribute('aria-expanded') === 'true' && !!document.querySelector('.viewport-titlebar .add-object-swatch.cube')");
await evaluate("document.querySelector('[data-testid=\"viewport-add\"]').click(); true");
expect("the viewport Add menu opens with the cube catalogue entry", await resolveSubscribed());
const catalogue = await evaluate(`(() => {
	const viewport = document.querySelector('.viewport');
	const menu = document.querySelector('.viewport-titlebar .add-object-menu');
	return {
		background: getComputedStyle(menu).backgroundColor,
		rows: [...menu.querySelectorAll('.add-object-item')].map((item) => item.getBoundingClientRect().height),
		fits: menu.getBoundingClientRect().right <= viewport.getBoundingClientRect().right && menu.getBoundingClientRect().bottom <= viewport.getBoundingClientRect().bottom,
	};
})()`);
expect("the Add catalogue has 24 px rows and fits the viewport", catalogue.rows.length > 0 && catalogue.rows.every((height) => height === 24) && catalogue.fits && catalogue.background === 'rgb(12, 12, 13)', JSON.stringify(catalogue));
await screenshot("task-12-props-add");
await subscribe("document.querySelector('.inspector-sidebar')?.dataset.inspector?.startsWith('object:') && document.querySelectorAll('.v2-details-section:not([hidden]) .vec3-row').length === 3");
await evaluate("document.querySelector('.viewport-titlebar .add-object-swatch.cube').closest('button').click(); true");
expect("adding a cube from the viewport Add opens its Details panel", await resolveSubscribed());

const details = await evaluate(`(() => {
	const visible = [...document.querySelectorAll('.v2-details-section:not([hidden])')]
		.find((section) => [...section.querySelectorAll('.vec3-label')].some((label) => label.textContent.trim() === 'Position'));
	if (!visible) return null;
	const rows = [...visible.querySelectorAll('.field, .vec3-row, .row, .details-toggle-row')]
		.map((row) => row.getBoundingClientRect().height)
		.filter((height) => height > 0);
	const labels = [...visible.querySelectorAll('.field > label')].map((label) => label.getBoundingClientRect().width);
	const position = [...visible.querySelectorAll('.vec3-row')]
		.find((row) => row.querySelector('.vec3-label')?.textContent.trim() === 'Position');
	const axis = Object.fromEntries([...position.querySelectorAll('.axis')].map((node) => [node.dataset.axis, getComputedStyle(node).color]));
	const head = visible.querySelector('.foldout-head');
	return {
		rows,
		labels,
		axis,
		head: {
			background: getComputedStyle(head).backgroundColor,
			borderRadius: getComputedStyle(visible).borderRadius,
			checkboxes: head.querySelectorAll('input[type="checkbox"]').length,
		},
	};
})()`);
expect("the selected prop renders v2 Details rows", details !== null, JSON.stringify(details));
expect("Details rows are 24 px", details?.rows.length > 0 && details.rows.every((height) => Math.abs(height - 24) < 0.5), JSON.stringify(details?.rows));
expect("Details labels are 100 px", details?.labels.length > 0 && details.labels.every((width) => Math.abs(width - 100) < 0.5), JSON.stringify(details?.labels));
expect("X/Y/Z use the exact axis colours", JSON.stringify(details?.axis) === JSON.stringify({ X: "rgb(229, 72, 77)", Y: "rgb(79, 191, 122)", Z: "rgb(76, 141, 255)" }), JSON.stringify(details?.axis));
expect("Foldout is flat instead of checkbox-like", details?.head.background === "rgba(0, 0, 0, 0)" && details?.head.checkboxes === 0 && details?.head.borderRadius === "0px", JSON.stringify(details?.head));

const readCube = () => evaluate(`(async () => {
	const raw = await window.__cozyclayProject.export('QA Details');
	const document = JSON.parse(raw);
	const scene = document.scenes.scenes.find((entry) => entry.id === document.scenes.activeSceneId);
	return scene?.objects?.find((object) => object.renderer === 'cube') ?? null;
})()`);
const fieldExpression = `(() => {
	const row = [...document.querySelectorAll('.v2-details-section:not([hidden]) .vec3-row')]
		.find((entry) => entry.querySelector('.vec3-label')?.textContent.trim() === 'Position');
	const field = row?.querySelector('.number-field .axis[data-axis="X"]')?.closest('.number-field');
	return field?.querySelector('input') ?? null;
})()`;
const field = await evaluate(`(() => { const input = ${fieldExpression}; if (!input) return null; const rect = input.getBoundingClientRect(); input.focus(); input.select(); return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, value: input.value }; })()`);
expect("Location X is an editable number field", field !== null, JSON.stringify(field));
await send("Input.insertText", { text: "1.5" });
await enter();
const moved = await readCube();
expect("typing 1.5 moves the cube", moved?.x === 1.5, JSON.stringify(moved));

await evaluate(`(() => {
	const input = ${fieldExpression};
	if (!input) throw new Error('Location X input disappeared');
	input.focus();
	input.select();
	window.__qaDetailsBlur = new Promise((resolve) => input.addEventListener('blur', resolve, { once: true }));
	return true;
})()`);
await send("Input.insertText", { text: "not-a-number" });
await evaluate(`(() => { const input = ${fieldExpression}; input.blur(); return true; })()`);
await evaluate("window.__qaDetailsBlur");
const reverted = await readCube();
const revertedInput = await evaluate(`(() => { const input = ${fieldExpression}; return input?.value ?? null; })()`);
expect("a non-numeric Location X entry reverts", reverted?.x === 1.5 && revertedInput === "1.5", JSON.stringify({ object: reverted, input: revertedInput }));

await screenshot("task-12-details");

/* #552: the right column matches 2a. The panel head reads Details, the
   selection header carries the name in 15/600 white over an 11 px type line,
   the Outliner has no project row, and the open agent shows Details | Agent
   tabs. */
const readSelection = () => evaluate(`(() => {
	const head = document.querySelector('.inspector-pane .details-panel-head');
	const box = document.querySelector('.inspector-pane [data-testid="details-selection"]');
	const name = box?.querySelector('.details-selection-name');
	const type = box?.querySelector('.details-selection-type');
	const style = (node) => node ? { size: getComputedStyle(node).fontSize, weight: getComputedStyle(node).fontWeight, color: getComputedStyle(node).color } : null;
	return {
		title: head?.querySelector('.details-panel-title')?.textContent.trim() ?? null,
		headHeight: head?.getBoundingClientRect().height ?? null,
		inspectorHeading: [...document.querySelectorAll('.inspector-sidebar .inspector-heading strong')].some((node) => node.textContent.trim() === 'Inspector'),
		name: name?.textContent.trim() ?? null,
		type: type?.textContent.trim() ?? null,
		nameStyle: style(name),
		typeStyle: style(type),
	};
})()`);
const selectRow = async (nodeId, condition) => {
	await subscribe(condition);
	await evaluate(`document.querySelector('[data-node-id="${nodeId}"] .hierarchy-row').click(); true`);
	return resolveSubscribed();
};
const cubeHeader = await readSelection();
expect("the Details panel head reads Details at 36 px, with no Inspector heading", cubeHeader.title === "Details" && cubeHeader.headHeight === 36 && !cubeHeader.inspectorHeading, JSON.stringify(cubeHeader));
expect("the cube's selection header reads Cube / Prop · Mesh", cubeHeader.name === "Cube" && cubeHeader.type === "Prop · Mesh", JSON.stringify(cubeHeader));
expect("the selection name is 15px/600 white", cubeHeader.nameStyle?.size === "15px" && cubeHeader.nameStyle.weight === "600" && cubeHeader.nameStyle.color === "rgb(255, 255, 255)", JSON.stringify(cubeHeader.nameStyle));
expect("the selection type line is 11px #636369", cubeHeader.typeStyle?.size === "11px" && cubeHeader.typeStyle.color === "rgb(99, 99, 105)", JSON.stringify(cubeHeader.typeStyle));
const outlinerTop = await evaluate(`(() => {
	const column = document.querySelector('.hierarchy-left');
	const head = column?.querySelector('.v2-outliner .hierarchy-heading');
	return {
		projectRow: !!column?.querySelector('.hierarchy-project, .hierarchy-project-label'),
		first: column?.firstElementChild?.className ?? null,
		headHeight: head?.getBoundingClientRect().height ?? null,
		count: head?.querySelector('[data-testid="outliner-count"]')?.textContent.trim() ?? null,
	};
})()`);
expect("the Outliner has no project row and keeps its 36 px head with a count", !outlinerTop.projectRow && outlinerTop.headHeight === 36 && /^\d+$/.test(outlinerTop.count ?? ""), JSON.stringify(outlinerTop));
await screenshot("task-22-cube");

expect("selecting Character 1 retitles the header", await selectRow("characterA", "document.querySelector('.inspector-pane .details-selection-name')?.textContent.trim() === 'Character 1'"));
const characterHeader = await readSelection();
expect("the character type line names its rig", /^Character · \S/.test(characterHeader.type ?? ""), JSON.stringify(characterHeader));
await screenshot("task-22-character");

expect("selecting the Camera retitles the header", await selectRow("camera", "document.querySelector('.inspector-pane .details-selection-name')?.textContent.trim() === 'Camera'"));
const cameraHeader = await readSelection();
expect("the camera type line carries the focal length", /^Camera · \d+mm$/.test(cameraHeader.type ?? ""), JSON.stringify(cameraHeader));
await screenshot("task-22-camera");

await subscribe("document.querySelector('.studio-agent-inspector')?.hidden === false");
await evaluate("window.dispatchEvent(new CustomEvent('cozyclay:agent-panel-toggle')); true");
expect("the agent toggle opens the agent pane", await resolveSubscribed());
const agentTabs = await evaluate(`[...document.querySelectorAll('.studio-agent-inspector .details-panel-head[role="tablist"] [role="tab"]')]
	.map((tab) => ({ text: tab.textContent.trim(), selected: tab.getAttribute('aria-selected') }))`);
expect("the open agent shows Details | Agent tabs with Agent selected", JSON.stringify(agentTabs) === JSON.stringify([{ text: "Details", selected: "false" }, { text: "Agent", selected: "true" }]), JSON.stringify(agentTabs));
await screenshot("task-22-agent-tabs");
await subscribe("document.querySelector('.studio-agent-inspector')?.hidden === true && document.querySelector('.inspector-pane')?.hidden === false");
await evaluate("document.querySelector('.studio-agent-inspector [role=\"tab\"][aria-selected=\"false\"]').click(); true");
expect("the Details tab closes the agent and returns to Details", await resolveSubscribed());

/* The reference is rendered by the same QA browser, so this second capture is
   the direct visual comparison source used in the PR evidence. */
const referenceLoaded = new Promise((resolve) => {
	const listener = (event) => {
		const message = JSON.parse(event.data);
		if (message.method !== "Page.loadEventFired") return;
		ws.removeEventListener("message", listener);
		resolve();
	};
	ws.addEventListener("message", listener);
});
await send("Page.navigate", { url: `${new URL((await evaluate("location.href"))).origin}/docs/design/v2-reference.html#2a` });
await referenceLoaded;
expect("the 2a reference card renders", await waitFor("!!document.getElementById('2a')?.querySelector('.dv-card')", 20_000));
await screenshot("task-12-compare");

const artifact = {
	issue: 526,
	propsAdd,
	catalogue,
	details,
	moved,
	reverted,
	revertedInput,
	cubeHeader,
	characterHeader,
	cameraHeader,
	outlinerTop,
	agentTabs,
	screenshots: [`${out}/task-12-props-add.png`, `${out}/task-12-details.png`, `${out}/task-22-cube.png`, `${out}/task-22-character.png`, `${out}/task-22-camera.png`, `${out}/task-22-agent-tabs.png`, `${out}/task-12-compare.png`],
	pageErrors,
	consoleErrors,
	failures,
};
writeFileSync(`${out}/task-12-details.json`, `${JSON.stringify(artifact, null, "\t")}\n`);
expect("the browser page threw no uncaught errors", pageErrors.length === 0, pageErrors.join(" | "));
expect("the browser console has no error entries", consoleErrors.length === 0, consoleErrors.join(" | "));

console.log(failures === 0 ? "\nqa-shell-details-browser: all checks passed" : `\n${failures} FAILURE(S)`);
ws.close();
if (failures) process.exitCode = 1;
