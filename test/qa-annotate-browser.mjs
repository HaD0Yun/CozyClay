#!/usr/bin/env node
// Browser QA for Annotate (AnnotateCell.jsx, context-chip-tools.jsx,
// context-chips.js): with nothing selected, the rail's Annotate cell arms the
// pen (no tool strip). A click marks the object under it; a closed loop lists
// what lies inside it, down to a character's hand and fingers; an open stroke
// names the bones it runs along or, on the floor, is a route; the line draws
// live mid-drag (raw CDP mouse events);
// marks are numbered 1, 2, 3 with one chip each; Cmd/Ctrl+Z takes the newest
// mark back (Shift redoes it) and falls through to the scene's undo when no
// mark is left; a stroke from a character offers Apply as walk; N pins a
// timeline note mark with a ±12 range. Send carries the marks as data and ONE
// annotated picture, clears the stage, shows the picture in the message and
// arms the note's range guard.
// Run through tools/qa-browser.mjs with QA_URL pointing at `/app/`.

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const port = Number(process.env.CDP_PORT || 9222);
const out = process.env.QA_OUT || join(process.cwd(), ".omo/evidence/annotate");
await mkdir(out, { recursive: true });
const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = targets.find((target) => target.type === "page" && target.webSocketDebuggerUrl);
if (!page) throw new Error("no page target on the QA browser");

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
let nextId = 1;
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
const waitForPageLoad = (timeoutMs = 30000) => new Promise((resolve, reject) => {
	let settled = false;
	const finish = (error) => {
		if (settled) return;
		settled = true;
		ws.removeEventListener("message", onMessage);
		clearTimeout(timer);
		if (error) reject(error);
		else resolve();
	};
	const onMessage = (event) => {
		if (JSON.parse(event.data).method === "Page.loadEventFired") finish();
	};
	const timer = setTimeout(() => finish(new Error("timed out waiting for the QA page to load")), timeoutMs);
	ws.addEventListener("message", onMessage);
});
const evaluate = async (expression) => {
	const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
	if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || "evaluate failed");
	return result.result.value;
};
const waitFor = (condition, timeoutMs = 15000) => evaluate(`new Promise((resolve) => {
	let settled = false;
	const finish = (value) => {
		if (settled) return;
		settled = true;
		observer.disconnect();
		clearTimeout(timer);
		resolve(value);
	};
	const check = () => {
		let value = false;
		try { value = Boolean(${condition}); } catch {}
		if (value) finish(true);
	};
	const observer = new MutationObserver(check);
	observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });
	const timer = setTimeout(() => finish(false), ${timeoutMs});
	check();
})`);
const screenshot = async (name) => {
	const result = await send("Page.captureScreenshot", { format: "png" });
	const path = join(out, name);
	await writeFile(path, Buffer.from(result.data, "base64"));
	console.log(`SCREENSHOT ${path}`);
	return path;
};
const setInput = (selector, value) => evaluate(`(() => {
	const input = document.querySelector(${JSON.stringify(selector)});
	if (!input) return false;
	const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
	setter.call(input, ${JSON.stringify(value)});
	input.dispatchEvent(new Event("input", { bubbles: true }));
	return true;
})()`);
const click = (selector) => evaluate(`(() => { const node = document.querySelector(${JSON.stringify(selector)}); if (!node) return false; node.click(); return true; })()`);
const typeInto = (selector, value) => evaluate(`(() => {
	const node = document.querySelector(${JSON.stringify(selector)});
	if (!node) return false;
	node.focus();
	const proto = node.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
	Object.getOwnPropertyDescriptor(proto, "value").set.call(node, ${JSON.stringify(value)});
	node.dispatchEvent(new Event("input", { bubbles: true }));
	return true;
})()`);
const mouse = (type, x, y, buttons = 0) => send("Input.dispatchMouseEvent", { type, x, y, button: type === "mouseMoved" && !buttons ? "none" : "left", buttons, clickCount: type === "mouseMoved" ? 0 : 1 });
const press = async (code, keyName, modifiers = 0) => {
	const text = !modifiers && keyName.length === 1 ? { text: keyName } : {};
	await send("Input.dispatchKeyEvent", { type: "keyDown", code, key: keyName, ...text, modifiers, windowsVirtualKeyCode: keyName === "Escape" ? 27 : keyName.toUpperCase().charCodeAt(0) });
	await send("Input.dispatchKeyEvent", { type: "keyUp", code, key: keyName, modifiers });
};
// The screen point of a world point, through the camera the stage draws with.
const screenOf = (x, y, z) => evaluate(`(() => {
	const cam = window.__cozyclay.activeCam, canvas = document.querySelector(".viewport canvas");
	cam.updateMatrixWorld();
	const v = new cam.position.constructor(${x}, ${y}, ${z}).project(cam), r = canvas.getBoundingClientRect();
	return { x: r.left + (v.x + 1) / 2 * r.width, y: r.top + (1 - v.y) / 2 * r.height };
})()`);
const drag = async (screen, release = true) => {
	await mouse("mouseMoved", screen[0].x, screen[0].y);
	await mouse("mousePressed", screen[0].x, screen[0].y, 1);
	for (let i = 1; i < screen.length; i += 1) {
		const a = screen[i - 1], b = screen[i];
		for (let t = 1; t <= 12; t += 1) await mouse("mouseMoved", a.x + (b.x - a.x) * t / 12, a.y + (b.y - a.y) * t / 12, 1);
	}
	if (release) await mouse("mouseReleased", screen.at(-1).x, screen.at(-1).y);
};
const tap = async (p) => { await mouse("mouseMoved", p.x, p.y); await mouse("mousePressed", p.x, p.y, 1); await mouse("mouseReleased", p.x, p.y); };
const chips = () => evaluate("[...document.querySelectorAll('.agent-context-chip')].map((node) => ({ n: Number(node.dataset.mark), kind: node.dataset.chipKind, label: node.querySelector('.agent-context-chip-label').textContent, walk: !!node.querySelector('[data-testid=chip-apply-walk]') }))");
const badges = () => evaluate("[...document.querySelectorAll('[data-mark-badge]')].map((node) => Number(node.dataset.markBadge)).sort((a, b) => a - b)");
const notes = () => evaluate("JSON.stringify(window.__cozyclay.characters?.[0]?.layer?.notes ?? [])").then(JSON.parse);

await send("Page.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1438, height: 979, deviceScaleFactor: 1, mobile: false });
let failures = 0;
const expect = (name, condition, detail = "") => {
	console.log(`${condition ? "PASS" : "FAIL"} ${name}${condition ? "" : ` — ${detail}`}`);
	if (!condition) failures += 1;
};

const appUrl = new URL(process.env.QA_URL || "http://127.0.0.1:5180/app/");
appUrl.searchParams.set("agent", "mock");
appUrl.searchParams.set("state", "ready");
await evaluate(`(() => { for (const key of Object.keys(localStorage)) if (/project-session|scenes|left-collapsed|first-success|mock\\.agent/i.test(key)) localStorage.removeItem(key); })()`);
{ const loaded = waitForPageLoad(); await send("Page.navigate", { url: appUrl.href }); await loaded; }
expect("the start screen renders", await waitFor("!!document.querySelector('.v2-start-screen.startup [data-testid=start-create]')"));
await setInput('[data-testid="start-project-name"]', "qa_annotate");
await click("[data-testid=start-create]");
expect("Create opens the editor", await waitFor("!document.querySelector('.v2-start-screen') && !!document.querySelector('.timeline')"));
await evaluate("document.querySelector('.v2-first-success-guide-close')?.click()");
await waitFor("!!window.__cozyclay?.activeCam && !!window.__cozyclay?.sceneObject", 20000);
await evaluate("window.dispatchEvent(new CustomEvent('cozyclay:agent-panel-toggle'))");
expect("the agent composer is open (mock agent)", await waitFor("(() => { const r = document.querySelector('.agent-composer textarea')?.getBoundingClientRect(); return !!r && r.width > 100 && r.height > 10; })()", 20000));

// --- 1. No selection needed ----------------------------------------------------
expect("Annotate sits on the rail with nothing in the scene", await evaluate("!window.__cozyclay.characters?.length && !!document.querySelector('.vp-overlay-rail [data-testid=annotate]')"));
const cubeId = await evaluate("window.__cozyclay.sceneObject.place({ kind: 'cube', name: 'Cube', x: -1.8, z: -2.5 }).id");
const sphereId = await evaluate("window.__cozyclay.sceneObject.place({ kind: 'sphere', name: 'Ball', x: -3.2, z: -2.5 }).id");
await waitFor("false", 500);
await click("[data-testid=annotate]");
expect("the Annotate cell arms the pen directly: no tool strip", await waitFor("document.querySelector('[data-testid=annotate]')?.getAttribute('aria-pressed') === 'true' && document.documentElement.dataset.viewportSketch === 'pen' && !document.querySelector('.vp-annotate-strip, [data-annotate-tool]')"));
expect("the cell is a 24px rail cell with a 13px glyph", await evaluate("(() => { const b = document.querySelector('[data-testid=annotate]').getBoundingClientRect(), i = document.querySelector('[data-testid=annotate] svg').getBoundingClientRect(); return b.width <= 24.5 && i.width <= 13.5; })()"));
await screenshot("01-armed.png");

// --- 2. A click on an object marks that point ------------------------------------------
await tap(await screenOf(-1.8, 0.5, -2.5));
expect("a click on the cube makes point mark 1 naming the cube", await waitFor("document.querySelectorAll('.agent-context-chip').length === 1"), JSON.stringify(await chips()));
let list = await chips();
expect("its chip reads ① Cube <face>, the full words in its tooltip", /^① Cube (top|front|back|left|right)/.test(list[0]?.label ?? "") && !/f0/.test(list[0].label) && /^① Cube · .+ · f0$/.test(await evaluate("document.querySelector('.agent-context-chip[data-mark=\"1\"]').title")), list[0]?.label);

// --- 3. A closed loop around the cube and the ball -------------------------------------------
const a = await screenOf(-1.8, 0.5, -2.5), b = await screenOf(-3.2, 0.5, -2.5);
const ring = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, rx: Math.abs(a.x - b.x) / 2 + 70, ry: 70 };
await drag(Array.from({ length: 33 }, (_, i) => ({ x: ring.x + Math.cos(i / 32 * Math.PI * 2) * ring.rx, y: ring.y + Math.sin(i / 32 * Math.PI * 2) * ring.ry })));
expect("the loop makes mark 2", await waitFor("document.querySelectorAll('.agent-context-chip').length === 2"));
list = await chips();
expect("its chip names a member and counts the other (② Cube +1 or ② Ball +1)", /^② (Cube|Ball) \+1$/.test(list[1]?.label ?? ""), list[1]?.label);

// --- 4. Pen: live mid-drag, then the mark ---------------------------------------------
const pen = [await screenOf(1.2, 0, -0.5), await screenOf(2.2, 0, -1.5), await screenOf(2.6, 0, -3)];
await drag(pen, false);
const live = await evaluate("window.__cozyclayRouteSketch?.livePoints ?? 0");
expect("the pen stroke draws live while dragging (before pointerup)", live >= 2, String(live));
await screenshot("02-pen-live.png");
await mouse("mouseReleased", pen.at(-1).x, pen.at(-1).y);
expect("the stroke makes mark 3", await waitFor("document.querySelectorAll('.agent-context-chip').length === 3"));
list = await chips();
expect("③ Floor 3.0 m, with no walk suggestion (it starts on the floor)", /^③ Floor \d+\.\d m$/.test(list[2]?.label ?? "") && !list[2].walk, JSON.stringify(list[2]));
expect("marks are numbered 1, 2, 3: one chip and one badge each", JSON.stringify(list.map((chip) => chip.n)) === "[1,2,3]" && JSON.stringify(await badges()) === "[1,2,3]", JSON.stringify({ list, badges: await badges() }));
await evaluate("document.querySelector('.agent-context-chip[data-mark=\"1\"]').dispatchEvent(new PointerEvent('pointerenter', { bubbles: false }))");
await evaluate("(() => { const chip = document.querySelector('.agent-context-chip[data-mark=\"1\"]'); const r = chip.getBoundingClientRect(); return [r.left + 10, r.top + 8]; })()").then(async ([x, y]) => mouse("mouseMoved", x, y));
expect("hovering chip 1 lights mark 1 in the view", await waitFor("!!document.querySelector('.annotate-badge.hot[data-mark-badge=\"1\"]')"));
await screenshot("03-three-marks.png");
expect("the chips stay on one compact row", await evaluate("(() => { const rows = new Set([...document.querySelectorAll('.agent-context-chip')].map((node) => Math.round(node.getBoundingClientRect().top))); return rows.size <= 2 && [...document.querySelectorAll('.agent-context-chip')].every((node) => node.getBoundingClientRect().height <= 22); })()"));
await mouse("mouseMoved", 700, 300);

// --- 5. Undo and redo of marks ----------------------------------------------------------
await evaluate("document.activeElement?.blur?.()");
await press("KeyZ", "z", 2);
expect("Ctrl+Z takes the newest mark back: 2 marks, 2 chips", await waitFor("document.querySelectorAll('.agent-context-chip').length === 2") && JSON.stringify(await badges()) === "[1,2]", JSON.stringify(await badges()));
await press("KeyZ", "z", 2);
expect("again: 1 mark, 1 chip", await waitFor("document.querySelectorAll('.agent-context-chip').length === 1"));
await press("KeyZ", "z", 2 | 8);
await press("KeyZ", "z", 2 | 8);
expect("Ctrl+Shift+Z twice brings both back with their numbers", await waitFor("document.querySelectorAll('.agent-context-chip').length === 3") && JSON.stringify(await badges()) === "[1,2,3]", JSON.stringify(await badges()));
expect("the scene was not undone meanwhile (both objects stay)", await evaluate(`window.__cozyclay.objects.some((o) => o.id === ${JSON.stringify(cubeId)}) && window.__cozyclay.objects.some((o) => o.id === ${JSON.stringify(sphereId)})`));

// --- 6. A stroke from a character suggests Apply as walk -------------------------------------
await press("Escape", "Escape");
expect("Esc leaves Annotate", await waitFor("document.querySelector('[data-testid=annotate]')?.getAttribute('aria-pressed') === 'false' && !document.documentElement.dataset.viewportSketch"));
await click("[data-testid=viewport-add]");
await waitFor("!!document.querySelector('.add-object-menu [data-add=character]')");
await click(".add-object-menu [data-add=character]");
await waitFor("!!window.__cozyclay.characters?.length && !!window.__cozyclay.rigs?.[window.__cozyclay.characters[0].id]", 20000);
const character = await evaluate("(() => { const c = window.__cozyclay.characters[0]; return { id: c.id, x: c.x, z: c.z }; })()");
await click("[data-testid=annotate]");
await drag([await screenOf(character.x + 0.1, 0, character.z + 0.1), await screenOf(character.x + 0.8, 0, character.z - 1.5), await screenOf(character.x + 1.2, 0, character.z - 3)]);
expect("the character stroke makes mark 4 with an Apply as walk suggestion", await waitFor("!!document.querySelector('.agent-context-chip[data-mark=\"4\"] [data-testid=chip-apply-walk]')"), JSON.stringify(await chips()));
await click(".agent-context-chip[data-mark=\"4\"] [data-testid=chip-apply-walk]");
expect("Apply as walk writes the root waypoints", await waitFor("(window.__cozyclay.characters?.[0]?.layer?.waypoints ?? []).length > 1"));
expect("only the character stroke offers it", (await chips()).filter((chip) => chip.walk).map((chip) => chip.n).join() === "4");

// --- 7. N pins a note mark with a range -------------------------------------------------------
await press("Escape", "Escape");
await evaluate("window.__cozyclay.scrub(42)");
await waitFor("window.__cozyclay.tlFrame === 42");
await evaluate("document.activeElement?.blur?.()");
await press("KeyN", "n");
expect("N pins a note at the playhead with the default ±12 range", await waitFor("(window.__cozyclay.characters?.[0]?.layer?.notes ?? []).length === 1") && JSON.stringify((await notes()).map((n) => [n.frame, n.frameStart, n.frameEnd])) === "[[42,30,54]]", JSON.stringify(await notes()));
expect("the note is mark 5 with its range (⑤ Note f30–54)", await waitFor("document.querySelector('.agent-context-chip[data-mark=\"5\"] .agent-context-chip-label')?.textContent === '⑤ Note f30–54'"), JSON.stringify(await chips()));
expect("its pin renders on the Body lane", await evaluate("!!document.querySelector('.tl-track[data-track-id=\"Full-Body\"] .tl-note-pin')"));
await press("Escape", "Escape");

expect("the five chips fit in at most two rows", await evaluate("new Set([...document.querySelectorAll('.agent-context-chip')].map((node) => Math.round(node.getBoundingClientRect().top))).size <= 2"), JSON.stringify(await evaluate("({ panel: Math.round(document.querySelector('.agent-context-chips').getBoundingClientRect().width), chips: [...document.querySelectorAll('.agent-context-chip')].map((node) => [Math.round(node.getBoundingClientRect().top), Math.round(node.getBoundingClientRect().width), getComputedStyle(node.querySelector('.agent-context-chip-label')).fontSize]) })")));
await screenshot("04a-five-chips.png");

// --- 7b. A pin on the character in front of the cube names the character and a bone -------------
await click("[data-testid=annotate]");
const chest = await evaluate(`(() => {
	const rig = window.__cozyclay.rigs[${JSON.stringify(character.id)}], cam = window.__cozyclay.activeCam, canvas = document.querySelector(".viewport canvas");
	let spine = null;
	rig.traverse((node) => { if (/Spine1$/.test(node.name)) spine = node; });
	rig.updateWorldMatrix(true, true); cam.updateMatrixWorld();
	const v = spine.getWorldPosition(new cam.position.constructor()).project(cam), r = canvas.getBoundingClientRect();
	return { x: r.left + (v.x + 1) / 2 * r.width, y: r.top + (1 - v.y) / 2 * r.height };
})()`);
expect("the cube stands behind the character's chest on screen", await evaluate(`(() => {
	const cube = window.__cozyclay.objects.find((o) => o.id === ${JSON.stringify(cubeId)}), cam = window.__cozyclay.activeCam, canvas = document.querySelector(".viewport canvas"), r = canvas.getBoundingClientRect();
	const v = new cam.position.constructor(cube.x, 0.5, cube.z).project(cam), x = r.left + (v.x + 1) / 2 * r.width, y = r.top + (1 - v.y) / 2 * r.height;
	return Math.abs(x - ${chest.x}) < 140 && Math.abs(y - ${chest.y}) < 140;
})()`));
await tap(chest);
expect("the pin on the character's chest is mark 6: the character and a bone, not the cube behind", await waitFor(`/^⑥ Y Bot (Chest|Upper chest|Spine)/.test(document.querySelector('.agent-context-chip[data-mark="6"] .agent-context-chip-label')?.textContent ?? '')`), JSON.stringify(await chips()));

// --- 7c. A closed pen loop around the left hand names the hand, not the floor ----------------------
const jointsOnScreen = () => evaluate(`(() => {
	const rig = window.__cozyclay.rigs[${JSON.stringify(character.id)}], cam = window.__cozyclay.activeCam, canvas = document.querySelector(".viewport canvas"), r = canvas.getBoundingClientRect(), out = {};
	rig.updateWorldMatrix(true, true); cam.updateMatrixWorld();
	rig.traverse((node) => { const m = /(LeftArm|LeftForeArm|LeftHand|LeftHandMiddle1)$/.exec(node.name); if (!m) return; const v = node.getWorldPosition(new cam.position.constructor()).project(cam); out[m[1]] = { x: r.left + (v.x + 1) / 2 * r.width, y: r.top + (1 - v.y) / 2 * r.height }; });
	return out;
})()`);
const j = await jointsOnScreen();
const hand = { x: (j.LeftHand.x + j.LeftHandMiddle1.x) / 2, y: (j.LeftHand.y + j.LeftHandMiddle1.y) / 2 };
await drag(Array.from({ length: 25 }, (_, i) => ({ x: hand.x + Math.cos(i / 24 * Math.PI * 2) * 22, y: hand.y + Math.sin(i / 24 * Math.PI * 2) * 22 })));
expect("a closed loop around the left hand is mark 7: ⑦ Y Bot Left hand", await waitFor(`document.querySelector('.agent-context-chip[data-mark="7"] .agent-context-chip-label')?.textContent === '⑦ Y Bot Left hand'`), JSON.stringify(await chips()));
await screenshot("04b-hand-loop.png");

// --- 7d. An open stroke along the left arm names the arm bones ------------------------------------
await drag([j.LeftArm, j.LeftForeArm, j.LeftHand].map((p) => ({ x: p.x, y: p.y })));
expect("a stroke along the left arm is mark 8 on the character's arm", await waitFor(`/^⑧ Y Bot Left (arm|forearm)$/.test(document.querySelector('.agent-context-chip[data-mark="8"] .agent-context-chip-label')?.textContent ?? '')`), JSON.stringify(await chips()));
await press("Escape", "Escape");
await mouse("mouseMoved", 700, 300);
expect("Apply as walk is a small icon button", await evaluate("(() => { const b = document.querySelector('[data-testid=chip-apply-walk]'); return !b || (b.getBoundingClientRect().width <= 17 && !!b.title); })()"));
await screenshot("04-five-marks.png");

// --- 8. Send: marks as data, one annotated picture, the stage clears ----------------------------
await typeInto(".agent-composer textarea", "Make ① red, move ② apart, and lift her arm in ⑤");
await waitFor("!document.querySelector('[data-fid=agent_send]')?.disabled");
await click("[data-fid=agent_send]");
expect("the turn is sent", await waitFor("!!localStorage.getItem('cozyclay.mock.agent.last-turn')", 15000));
const turn = await evaluate("JSON.parse(localStorage.getItem('cozyclay.mock.agent.last-turn') || 'null')");
const marks = turn?.marks ?? null;
expect("the request context carries 8 marks numbered 1-8", Array.isArray(marks) && JSON.stringify(marks.map((mark) => mark.n)) === "[1,2,3,4,5,6,7,8]", JSON.stringify(turn)?.slice(0, 300));
expect("mark 7 is a loop INSIDE which is the character's left hand and its fingers", marks?.[6]?.kind === "pen" && marks[6].shape === "loop" && marks[6].hit?.type === "character" && marks[6].hit.bone === "lHand" && marks[6].hit.bones.includes("lHand") && marks[6].hit.bones.some((id) => /^left(Index|Middle|Ring|Pinky|Thumb)\d$/.test(id)), JSON.stringify(marks?.[6]?.hit));
expect("the loop is drawn at the hand's depth, not flattened on the floor", marks?.[6]?.points?.length > 10 && marks[6].points.every((p) => p.y > 0.3), JSON.stringify(marks?.[6]?.points?.slice(0, 3)));
expect("mark 8 is a stroke over the arm bones, in stroke order", marks?.[7]?.shape === "stroke" && marks[7].hit?.type === "character" && marks[7].hit.bones.some((id) => ["lArm", "lForeArm"].includes(id)), JSON.stringify(marks?.[7]?.hit));
expect("the floor strokes stay floor routes (③, and ④ from the character's feet)", marks?.[2]?.shape === "route" && marks[2].hit.type === "floor" && marks?.[3]?.shape === "route", JSON.stringify([marks?.[2]?.shape, marks?.[3]?.shape, marks?.[3]?.hit?.type]));
expect("every mark carries its screen outline in 0..1 of the picture", marks?.every((mark) => Array.isArray(mark.screen) && mark.screen.length >= 1 && mark.screen.length <= 64 && mark.screen.every((p) => p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1)), JSON.stringify(marks?.map((mark) => mark.screen?.length)));
expect("mark 6 is a point on the character with a bone", marks?.[5]?.shape === "point" && marks[5].hit?.type === "character" && marks[5].hit.id === character.id && typeof marks[5].hit.bone === "string", JSON.stringify(marks?.[5]?.hit));
expect("mark 1 is the point on the cube (hit object, its id, a point in metres, frame 0)", marks?.[0]?.kind === "pen" && marks[0].shape === "point" && marks[0].hit?.type === "object" && marks[0].hit.id === cubeId && marks[0].points?.length === 1 && marks[0].frame === 0, JSON.stringify(marks?.[0]));
expect("mark 2 is a loop with the cube and the ball inside", marks?.[1]?.shape === "loop" && [cubeId, sphereId].every((id) => marks[1].members?.some((member) => member.id === id)), JSON.stringify(marks?.[1]?.members));
expect("mark 3 is the floor stroke with <= 64 points and its length", marks?.[2]?.kind === "pen" && marks[2].hit?.type === "floor" && marks[2].points.length >= 2 && marks[2].points.length <= 64 && marks[2].length_m > 2, JSON.stringify(marks?.[2])?.slice(0, 200));
expect("mark 5 is the note: the character, frame 42 and range 30-54", marks?.[4]?.kind === "note" && marks[4].hit?.id === character.id && marks[4].frame === 42 && marks[4].range?.frameStart === 30 && marks[4].range?.frameEnd === 54, JSON.stringify(marks?.[4]));
expect("UI-only data stays home", marks?.every((mark) => !("local" in mark) && !("id" in mark)));
expect("ONE annotated picture rides as the attachment", turn?.attachments === 1, String(turn?.attachments));
expect("sending clears the marks from the stage and the composer", await waitFor("!document.querySelector('.agent-context-chip') && !document.querySelector('[data-mark-badge]')"));
expect("the sent message shows the annotated picture", await waitFor("[...document.querySelectorAll('.agent-bubble-attachments img')].some((img) => img.src.startsWith('data:image/jpeg') && img.naturalWidth > 200)", 10000));
await screenshot("05-sent.png");
const sentPicture = await evaluate("[...document.querySelectorAll('.agent-bubble-attachments img')].at(-1)?.src ?? ''");
if (sentPicture.startsWith("data:image/jpeg;base64,")) await writeFile(join(out, "06-annotated-picture.jpg"), Buffer.from(sentPicture.split(",")[1], "base64"));

// --- 9. The note's range guard, and undo falling through to the scene ----------------------------
const guard = await evaluate(`(async () => {
	// The app's own instance of the module: the dev server may stamp its URL (?t=), so read it from the importer.
	const importer = await (await fetch("/src/context-chips.js")).text();
	const url = (importer.match(new RegExp('from "(/src/note-range-guard[.]js[^"]*)"')) || [])[1] || "/src/note-range-guard.js";
	const { noteRangeGuard, checkNoteRange } = await import(url);
	const verdict = (frame) => { try { checkNoteRange("character.setIkKey", { characterId: ${JSON.stringify(character.id)}, frame }, { origin: "agent" }); return "ok"; } catch (error) { return error.code + ": " + error.message; } };
	return { armed: noteRangeGuard(), inside: verdict(50), outside: verdict(120) };
})()`);
expect("the sent note arms the range guard with 30-54", guard.armed?.characterId === character.id && guard.armed.frameStart === 30 && guard.armed.frameEnd === 54, JSON.stringify(guard.armed));
expect("an agent IK key outside the note is refused; inside passes", /^INVALID_RANGE: Refused by the timeline note/.test(guard.outside) && guard.inside === "ok", JSON.stringify(guard));
await evaluate("document.activeElement?.blur?.()");
await press("KeyZ", "z", 2);
expect("with no marks left, Ctrl+Z undoes the scene (the note pin goes)", await waitFor("(window.__cozyclay.characters?.[0]?.layer?.notes ?? []).length === 0"), JSON.stringify(await notes()));

// --- 10. A posed body: head, a hand held forward and a foot are hit as posed, never the floor ----------
await evaluate(`window.__cozyclay.runStudioAction("character.setPose", { characterId: ${JSON.stringify(character.id)}, pose: { id: "qa-reach", bones: { lArm: [-1.3, 0, 0.3], rArm: [-1.3, 0, -0.3], lForeArm: [0, 0, 0.4], head: [0.5, 0.4, 0], lUpLeg: [-0.6, 0, 0], lLeg: [0.6, 0, 0] } } })`);
await waitFor("false", 800);
const posed = await evaluate(`(() => {
	const rig = window.__cozyclay.rigs[${JSON.stringify(character.id)}], cam = window.__cozyclay.activeCam, canvas = document.querySelector(".viewport canvas"), r = canvas.getBoundingClientRect(), world = {}, out = {};
	rig.updateWorldMatrix(true, true); cam.updateMatrixWorld();
	rig.traverse((node) => { const m = /(Head|HeadTop_End|LeftHand|LeftHandMiddle1|LeftFoot|LeftToeBase|LeftArm)$/.exec(node.name); if (m) world[m[1]] = node.getWorldPosition(new cam.position.constructor()); });
	const at = (v) => { const p = v.clone().project(cam); return { x: r.left + (p.x + 1) / 2 * r.width, y: r.top + (1 - p.y) / 2 * r.height }; };
	out.head = at(world.Head.clone().lerp(world.HeadTop_End ?? world.Head, 0.5));
	out.hand = at(world.LeftHand.clone().lerp(world.LeftHandMiddle1, 0.5));
	out.foot = at(world.LeftFoot.clone().lerp(world.LeftToeBase ?? world.LeftFoot, 0.5));
	out.handForward = world.LeftHand.z - world.LeftArm.z;
	return out;
})()`);
expect("the pose holds the left hand forward of the shoulder (a non-bind pose)", posed.handForward > 0.2, JSON.stringify(posed));
await click("[data-testid=annotate]");
for (const part of ["head", "hand", "foot"]) await tap(posed[part]);
await screenshot("07-posed-points.png");
list = await chips();
expect("a click on the posed head names the head", /^① Y Bot Head$/.test(list[0]?.label ?? ""), JSON.stringify(list));
expect("a click on the hand held forward names the left hand", /^② Y Bot Left hand$/.test(list[1]?.label ?? ""), JSON.stringify(list));
expect("a click on the posed foot names the left foot", /^③ Y Bot Left foot$/.test(list[2]?.label ?? ""), JSON.stringify(list));
expect("none of the three is the floor", list.length === 3 && list.every((chip) => !/Floor/.test(chip.label)), JSON.stringify(list));
await press("Escape", "Escape");

// --- 11. With the pen armed: keys still undo, and clicks never select or drag the scene -------------
const selectedRow = "document.querySelector('.studio-left-column [aria-selected=\"true\"]')?.textContent?.trim() ?? null";
const before = await evaluate(selectedRow);
const cubeAt = await evaluate(`(() => { const o = window.__cozyclay.objects.find((row) => row.id === ${JSON.stringify(cubeId)}); return { x: o.x, y: o.y ?? 0, z: o.z }; })()`);
// The author was typing in the composer, then reaches for the stage.
await typeInto(".agent-composer textarea", "");
await click("[data-testid=annotate]");
const cubeTop = await screenOf(-1.8, 0.95, -2.8);
await tap(cubeTop);
expect("a pen click on the unselected cube marks it", await waitFor("document.querySelectorAll('.agent-context-chip').length === 4"), JSON.stringify(await chips()));
await drag([cubeTop, { x: cubeTop.x + 90, y: cubeTop.y + 10 }]);
expect("and a drag over it draws a stroke", await waitFor("document.querySelectorAll('.agent-context-chip').length === 5"), JSON.stringify(await chips()));
await waitFor("false", 300);
expect("the pen leaves the selection as it was", (await evaluate(selectedRow)) === before, JSON.stringify({ before, after: await evaluate(selectedRow) }));
expect("and never moves the cube", await evaluate(`(() => { const o = window.__cozyclay.objects.find((row) => row.id === ${JSON.stringify(cubeId)}); return o.x === ${cubeAt.x} && (o.y ?? 0) === ${cubeAt.y} && o.z === ${cubeAt.z}; })()`));
expect("the composer let go of the focus when the pen drew", await evaluate("document.activeElement !== document.querySelector('.agent-composer textarea')"));
await press("KeyZ", "z", 2);
expect("pen armed: Ctrl+Z removes the newest mark", await waitFor("document.querySelectorAll('.agent-context-chip').length === 4"));
await press("KeyY", "y", 2);
expect("Ctrl+Y brings it back", await waitFor("document.querySelectorAll('.agent-context-chip').length === 5"));
await press("KeyZ", "z", 4);
expect("Cmd+Z removes it too", await waitFor("document.querySelectorAll('.agent-context-chip').length === 4"));
for (let i = 0; i < 4; i += 1) await press("KeyZ", "z", 2);
expect("Ctrl+Z empties the marks one by one", await waitFor("!document.querySelector('.agent-context-chip')"));
const extraId = await evaluate("window.__cozyclay.sceneObject.place({ kind: 'cylinder', name: 'Post', x: 2, z: -3 }).id");
await waitFor(`window.__cozyclay.objects.some((o) => o.id === ${JSON.stringify(extraId)})`);
await evaluate("document.activeElement?.blur?.()");
expect("the pen is still armed", await evaluate("document.querySelector('[data-testid=annotate]')?.getAttribute('aria-pressed') === 'true'"));
await press("KeyZ", "z", 2);
expect("pen armed, no marks: Ctrl+Z undoes the scene edit", await waitFor(`!window.__cozyclay.objects.some((o) => o.id === ${JSON.stringify(extraId)})`, 5000));
await press("Escape", "Escape");
await tap(cubeTop);
expect("with the pen off, a click selects again", await waitFor(`(${selectedRow}) !== ${JSON.stringify(before)}`, 5000), JSON.stringify(await evaluate(selectedRow)));

ws.close();
if (failures > 0) {
	console.error(`\n${failures} annotate check(s) failed`);
	process.exit(1);
}
console.log("\nAll annotate checks passed");
