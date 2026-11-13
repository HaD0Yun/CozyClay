#!/usr/bin/env node
// Browser QA for Fix and tell with fix keys (motion/fix-keys.js, domains/motion/fix-islands.js, TimelineFixIslands.jsx,
// shell/FixTools.jsx on the IK keys row's header, fix-original-ghost.jsx, fix-send.js): with a walk take installed, a left-hand
// pose drag at f40 (the production IK solve/end path) puts three dots on a Left arm row: rest f34, pose f40, rest f46. Frames
// outside them are the take bone for bone, frames inside ease toward the pose, the feet stay put. A dot drags to retime (one
// undo); A/B shows the original take and, in the fixed view, its pose as a ghost; Send fixes puts one chip in the composer and
// arms the range guard; Alt-drag copies a pose key and the pose holds between the two; Shift-click on the row adds a rest key;
// more drags add keys; right-click removes a dot; the keys survive a reload; Merge writes a row's keys into the take and
// clears it (a new key after that is a new layer, undo brings the keys back, the merge survives a reload); rows saved as
// bands convert to keys.
// Run through tools/qa-browser.mjs with QA_URL pointing at `/app/`.


import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const port = Number(process.env.CDP_PORT || 9222);
const out = process.env.QA_OUT || join(process.cwd(), ".omo/evidence/fix-islands");
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
const press = async (code, keyName, modifiers = 0) => {
	const text = !modifiers && keyName.length === 1 ? { text: keyName } : {};
	await send("Input.dispatchKeyEvent", { type: "keyDown", code, key: keyName, ...text, modifiers, windowsVirtualKeyCode: keyName === "Escape" ? 27 : keyName.toUpperCase().charCodeAt(0) });
	await send("Input.dispatchKeyEvent", { type: "keyUp", code, key: keyName, modifiers });
};
const typeInto = (selector, value) => evaluate(`(() => {
	const node = document.querySelector(${JSON.stringify(selector)});
	if (!node) return false;
	node.focus();
	Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(node, ${JSON.stringify(value)});
	node.dispatchEvent(new Event("input", { bubbles: true }));
	return true;
})()`);
// A condition on page state that no DOM change announces: polled, not observed.
const poll = (condition, timeoutMs = 8000) => evaluate(`new Promise((resolve) => { const end = Date.now() + ${timeoutMs}; const tick = () => { let ok = false; try { ok = Boolean(${condition}); } catch {} if (ok) resolve(true); else if (Date.now() > end) resolve(false); else setTimeout(tick, 50); }; tick(); })`);
const settle = () => evaluate("new Promise((r) => { let k = 4; const tick = () => (--k ? requestAnimationFrame(tick) : setTimeout(r, 80)); requestAnimationFrame(tick); })");
const scrub = async (frame) => { await evaluate(`window.__cozyclay.scrub(${frame})`); await poll(`window.__cozyclay.tlFrame === ${frame}`); await settle(); };
const rigExpr = "window.__cozyclay.rigs[window.__cozyclay.characters[0].id]";
// Every bone's local rotation, and the feet in world space, as the rig shows them now.
const readRig = () => evaluate(`(() => { const rig = ${rigExpr}, q = [], feet = {}; rig.updateMatrixWorld(true); rig.traverse((n) => { if (!n.isBone) return; q.push([n.name, n.quaternion.x, n.quaternion.y, n.quaternion.z, n.quaternion.w]); if (/(Left|Right)Foot$/.test(n.name) && !feet[n.name]) feet[n.name] = n.getWorldPosition(n.position.clone()).toArray(); }); return { q, feet }; })()`);
// The angle between two rotations, from the relative quaternion conj(a)·b (atan2 keeps tiny angles exact; acos near 1 does not).
const angle = (a, b) => {
	const [, ax, ay, az, aw] = a, [, bx, by, bz, bw] = b;
	const w = aw * bw + ax * bx + ay * by + az * bz, x = aw * bx - ax * bw - ay * bz + az * by, y = aw * by + ax * bz - ay * bw - az * bx, z = aw * bz - ax * by + ay * bx - az * bw;
	return 2 * Math.atan2(Math.hypot(x, y, z), Math.abs(w));
};
const maxTurn = (a, b, only = null) => Math.max(0, ...a.q.map((row, i) => (only && !only.test(row[0]) ? 0 : angle(row, b.q[i]))));
const feetMoved = (a, b) => Math.max(0, ...Object.keys(a.feet).map((name) => Math.hypot(...a.feet[name].map((v, i) => v - b.feet[name][i]))));

await send("Page.enable"); await send("Runtime.enable"); const pageErrors = []; ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (m.method === "Runtime.exceptionThrown") pageErrors.push(m.params.exceptionDetails?.exception?.description?.slice(0, 400)); if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") pageErrors.push(m.params.args.map((a) => a.value ?? a.description).join(" ").slice(0, 400)); });
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
await setInput('[data-testid="start-project-name"]', "qa_fix_islands");
await click("[data-testid=start-create]");
expect("Create opens the editor", await waitFor("!document.querySelector('.v2-start-screen') && !!document.querySelector('.timeline')"));
await evaluate("document.querySelector('.v2-first-success-guide-close')?.click()");
await click("[data-testid=viewport-add]");
await waitFor("!!document.querySelector('.add-object-menu [data-add=character]')");
await click(".add-object-menu [data-add=character]");
await waitFor(`!!window.__cozyclay?.characters?.length && !!${rigExpr}`, 20000);

// --- 0. A walk take on the character -------------------------------------------------------------
const characterId = await evaluate("window.__cozyclay.characters[0].id");
const rest = await evaluate(`(() => { const rig = ${rigExpr}, c = window.__cozyclay.characters[0], out = { x: c.x ?? 0, z: c.z ?? 0 }; rig.updateMatrixWorld(true); rig.traverse((n) => { if (n.isBone && /Hips$/.test(n.name) && out.hips == null) out.hips = n.getWorldPosition(n.position.clone()).y; if (n.isBone && /LeftFoot$/.test(n.name) && out.ankle == null) out.ankle = n.getWorldPosition(n.position.clone()).y; }); return out; })()`);
const spec = { schema: "cozyclay.motion-spec.v1", fps: 24, frames: 140,
	keys: [{ f: 0, set: { root: [rest.x, rest.hips - 0.01, rest.z], yaw: 0, foot_l: [rest.x + 0.09, rest.ankle, rest.z - 0.03], foot_r: [rest.x - 0.09, rest.ankle, rest.z + 0.03], fyaw_l: 0, fyaw_r: 0 } }],
	generators: [{ type: "walk", f0: 6, steps: 4, heading: [0, 30] }] };
const compiled = await evaluate(`(async () => { const r = await window.__cozyclay.runStudioAction("motion.compile", ${JSON.stringify({ characterId, spec, install: true })}); return { ok: r?.ok, message: r?.message ?? null }; })()`);
expect("a walk take installs", compiled.ok && await poll("window.__cozyclay.motion?.schema === 'cozyclay.take.v3'", 20000), JSON.stringify(compiled));
await click(".vp-mode-key[data-mode=pose]");
expect("Pose mode shows the Fix tools on the IK keys row's header (the take is on)", await waitFor("!!document.querySelector('.tl-track[data-track-id=\"Full-Body\"] .tl-track-label [data-testid=fix-mode]')", 20000));
expect("Fix mode is on by default; A/B and Send wait for a fix", await evaluate("document.querySelector('[data-testid=fix-mode]').getAttribute('aria-pressed') === 'true' && document.querySelector('[data-testid=fix-ab]').disabled && document.querySelector('[data-testid=fix-send]').disabled"));
const cells = await evaluate("[...document.querySelectorAll('.pose-fix-tools > button')].map((b) => { const r = b.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; })");
expect("the four Fix tools (Fix mode, A/B, Merge all, Send) are 24 px icon cells", cells.length === 4 && cells.every(([w, h]) => w === 24 && h === 24), JSON.stringify(cells));
const reachable = await evaluate("[...document.querySelectorAll('.pose-fix-tools > button')].map((b) => { const r = b.getBoundingClientRect(); return document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)?.closest('button') === b; })");
expect("each one is on screen and not covered", reachable.length === 4 && reachable.every(Boolean), JSON.stringify(reachable));
await waitFor("false", 600);

const FRAMES = [20, 33, 34, 37, 40, 43, 46, 47, 50, 60];
const take = {};
for (const f of FRAMES) { await scrub(f); take[f] = await readRig(); }

// --- 1. A pose drag of the left hand at f40 keys the left arm: rest, pose, rest ----------------------------------
const dots = (part = null) => evaluate(`[...document.querySelectorAll('.tl-track[data-track-id="Full-Body"] [data-fix-key]')].filter((n) => ${JSON.stringify(part)} === null || n.dataset.fixPart === ${JSON.stringify(part)}).map((n) => { const r = n.getBoundingClientRect(); return { part: n.dataset.fixPart, frame: Number(n.dataset.fixKey), rest: !!n.dataset.fixRest, x: r.left + r.width / 2, y: r.top + r.height / 2 }; })`);
const shape = async (part = "leftArm") => (await dots(part)).map((d) => `${d.frame}${d.rest ? "r" : "p"}`).join(" ");
const shapeIs = (want, part = "leftArm") => poll(`[...document.querySelectorAll('.tl-track[data-track-id="Full-Body"] [data-fix-key][data-fix-part=${part}]')].map((n) => n.dataset.fixKey + (n.dataset.fixRest ? "r" : "p")).join(" ") === ${JSON.stringify(want)}`, 5000);
const laneX = (frame) => evaluate(`(() => { const lane = document.querySelector('.tl-track[data-track-id="Full-Body"] .tl-lane').getBoundingClientRect(); return lane.left + ${frame} / Math.max(1, window.__cozyclay.frameCount - 1) * lane.width; })()`);
const ALT = 1, SHIFT = 8;
const pointer = (type, x, y, buttons, modifiers = 0, button = "left") => send("Input.dispatchMouseEvent", { type, x, y, button: type === "mouseMoved" && !buttons ? "none" : button, buttons, modifiers, clickCount: type === "mouseMoved" ? 0 : 1 });
const dragDot = async (frame, toFrame, modifiers = 0, part = "leftArm") => {
	const dot = (await dots(part)).find((d) => d.frame === frame), x1 = await laneX(toFrame);
	await pointer("mouseMoved", dot.x, dot.y, 0, modifiers);
	await pointer("mousePressed", dot.x, dot.y, 1, modifiers);
	for (let t = 1; t <= 6; t += 1) await pointer("mouseMoved", dot.x + (x1 - dot.x) * t / 6, dot.y, 1, modifiers);
	await pointer("mouseReleased", x1, dot.y, 0, modifiers);
};
const rightClickDot = async (frame, part = "leftArm") => { const dot = (await dots(part)).find((d) => d.frame === frame); await pointer("mousePressed", dot.x, dot.y, 2, 0, "right"); await pointer("mouseReleased", dot.x, dot.y, 0, 0, "right"); };
const undo = async () => { await evaluate("document.activeElement?.blur?.()"); await press("KeyZ", "z", 2); await settle(); };
const ARM = /Left(Arm|ForeArm|Hand)$/;

await scrub(40);
expect("the IK drag seam moves the left hand at f40", await evaluate("window.__cozyclay.ikPreviewApply('leftHand', { x: 0.1, y: 0.14, z: 0.06 })"));
expect("three dots appear on a Left arm row: rest f34, pose f40, rest f46", await shapeIs("34r 40p 46r"), await shape());
expect("no whole-take range preview is pending (Fix mode took the drag)", await evaluate("!document.querySelector('[data-testid=ik-pending-edit]')"));
const rowH = await evaluate("document.querySelector('.tl-track[data-track-id=\"Full-Body\"] .tl-track-subrow').getBoundingClientRect().height");
const dot40 = await evaluate("(() => { const d = [...document.querySelectorAll('.tl-track[data-track-id=\"Full-Body\"] .tl-marker.ik')].find((n) => /at frame 40\\b/.test(n.title)); if (!d) return null; const r = d.getBoundingClientRect(); return { y: r.top + r.height / 2 }; })()");
const made = (await dots()).find((d) => d.frame === 40);
expect("the dots sit on their own Left arm row, one row under the IK keys row", dot40 && made && Math.abs(made.y - dot40.y - rowH) <= 2 && await evaluate("/Left arm/.test(document.querySelector('.tl-ik-part-row[data-ik-part=leftArm]')?.textContent ?? '') && document.querySelectorAll('.tl-ik-part-row').length === 1"), JSON.stringify({ dot40, made, rowH }));
expect("the lines between the dots read ease in, ease out", await evaluate("[...document.querySelectorAll('[data-fix-seg]')].map((n) => n.dataset.fixSeg).join() === 'in,out'"));
await scrub(20);
await poll("!document.querySelector('.toast')", 10000);
expect("each dot is on screen and takes the pointer (playhead away at f20)", await evaluate("[...document.querySelectorAll('[data-fix-key]')].every((n) => { const r = n.getBoundingClientRect(); return document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) === n; })"));
const fixed = {};
for (const f of FRAMES) { await scrub(f); fixed[f] = await readRig(); }
const turn = Object.fromEntries(FRAMES.map((f) => [f, maxTurn(take[f], fixed[f])]));
expect("f40 shows the pose (left arm bones turned)", maxTurn(take[40], fixed[40], ARM) > 0.05, JSON.stringify(turn));
expect("on and outside the rest keys every bone is the take's (f20, f33, f34, f46, f47, f60)", [20, 33, 34, 46, 47, 60].every((f) => turn[f] < 1e-5), JSON.stringify(turn));
expect("between them the pose eases in and out (0 < f37 < f40 > f43 > 0)", turn[37] > 0 && turn[37] < turn[40] && turn[43] < turn[40] && turn[43] > 0, JSON.stringify(turn));
expect("only the left arm moved: other bones are the take's at f40", maxTurn(take[40], fixed[40], /^(?!.*Left(Arm|ForeArm|Hand|Hand.*\d)$).*/) < 1e-5);
expect("the IK keys row shows one dot for the pose key and none for the rest keys", await evaluate("(() => { const t = [...document.querySelectorAll('.tl-track[data-track-id=\"Full-Body\"] .tl-marker.ik')].map((n) => n.title); return t.some((x) => /at frame 40\\b/.test(x)) && !t.some((x) => /at frame (34|46)\\b/.test(x)); })()"));
expect("the feet stay where the take puts them at f37, f40, f43", [37, 40, 43].every((f) => feetMoved(take[f], fixed[f]) < 0.001));
await scrub(40);
await screenshot("01-first-key.png");

// --- 2. A rest dot drags to change where the pose eases out (one undo) --------------------------------------------
await dragDot(46, 56);
expect("dragging the rest dot from f46 to f56 lengthens the ease out", await shapeIs("34r 40p 56r"), await shape());
await scrub(50);
expect("f50 now eases out of the pose", maxTurn(take[50], await readRig()) > 1e-4);
await undo();
expect("one undo puts it back at f46", await shapeIs("34r 40p 46r"), await shape());
await scrub(50);
expect("and f50 is the take again", maxTurn(take[50], await readRig()) < 1e-5);

// --- 3. A/B ---------------------------------------------------------------------------------------------------
await scrub(40);
expect("the fixed view ghosts the original pose at f40", await poll("window.__cozyclayFixGhost?.visible === true && window.__cozyclayFixGhost.frame === 40"), JSON.stringify(await evaluate("window.__cozyclayFixGhost")));
const ghostLayer = await evaluate("(() => { const masks = new Set(); window.__cozyclayGhosts?.scene?.getObjectByName?.('fix-original-ghost')?.traverse((n) => { if (n.isMesh) masks.add(n.layers.mask); }); return [...masks]; })()");
expect("that ghost lives on the editor-only layer", ghostLayer.length === 1 && ghostLayer[0] === 1 << 5, JSON.stringify(ghostLayer));
await click("[data-testid=fix-ab]");
await settle();
const original = await readRig();
expect("A shows the original take at f40", maxTurn(take[40], original) < 1e-5 && await evaluate("document.querySelector('[data-testid=fix-ab]').getAttribute('aria-pressed') === 'true'"), String(maxTurn(take[40], original)));
expect("no original ghost while A is on", await poll("window.__cozyclayFixGhost?.visible === false"));
await screenshot("02-ab-original.png");
await click("[data-testid=fix-ab]");
await settle();
expect("B shows the fix again", maxTurn(fixed[40], await readRig()) < 1e-5);
await scrub(20);
expect("off the island there is no original ghost", await poll("window.__cozyclayFixGhost?.visible === false"));

// --- 4. Send fixes -----------------------------------------------------------------------------------------
await evaluate("window.dispatchEvent(new CustomEvent('cozyclay:agent-panel-toggle'))");
await waitFor("(() => { const r = document.querySelector('.agent-composer textarea')?.getBoundingClientRect(); return !!r && r.width > 100; })()", 20000);
await scrub(40);
await click("[data-testid=fix-send]");
expect("Send fixes puts one fix chip in the composer (one per pose key): Fix f34–46 · Left hand", await waitFor("document.querySelectorAll('.agent-context-chip[data-chip-kind=fix]').length === 1 && /Fix f34–46 · Left hand/.test(document.querySelector('.agent-context-chip[data-chip-kind=fix]').textContent)"), JSON.stringify(await evaluate("[...document.querySelectorAll('.agent-context-chip')].map((n) => n.textContent)")));
expect("the playhead keeps its fixed pose after the stills are taken", maxTurn(fixed[40], await readRig()) < 1e-5);
await screenshot("03-fix-chip.png");
await typeInto(".agent-composer textarea", "Make the take do this at f40");
await waitFor("!document.querySelector('[data-fid=agent_send]')?.disabled");
await click("[data-fid=agent_send]");
expect("the turn is sent", await waitFor("!!localStorage.getItem('cozyclay.mock.agent.last-turn')", 15000));
const sent = await evaluate("JSON.parse(localStorage.getItem('cozyclay.mock.agent.last-turn') || 'null')");
const mark = sent?.marks?.[0];
expect("the turn carries the fix mark: kind, take, frame 40, range 34–46, bones [leftHand]", mark?.kind === "fix" && typeof mark.takeId === "string" && mark.frame === 40 && mark.range?.frameStart === 34 && mark.range?.frameEnd === 46 && JSON.stringify(mark.bones) === '["leftHand"]' && mark.hit?.id === characterId, JSON.stringify(mark)?.slice(0, 400));
expect("deltaDeg names the arm bones it turned (degrees > 0)", mark && Object.keys(mark.deltaDeg ?? {}).some((name) => /LeftArm$/.test(name)) && Object.values(mark.deltaDeg).some((deg) => deg > 1), JSON.stringify(mark?.deltaDeg));
expect("pose before and after are whole poses that differ", mark?.pose?.before?.bones && mark.pose.after?.bones && JSON.stringify(mark.pose.before) !== JSON.stringify(mark.pose.after), JSON.stringify(mark?.pose)?.slice(0, 200));
expect("UI-only data stays home", mark && !("local" in mark));
expect("two pictures ride along: the annotated view and the fix's before | after still", sent?.attachments === 2, String(sent?.attachments));
const guard = await evaluate(`(async () => {
	const importer = await (await fetch("/src/context-chips.js")).text();
	const url = (importer.match(new RegExp('from "(/src/note-range-guard[.]js[^"]*)"')) || [])[1] || "/src/note-range-guard.js";
	const { checkNoteRange } = await import(url);
	const verdict = (frame) => { try { checkNoteRange("character.setIkKey", { characterId: ${JSON.stringify(characterId)}, frame }, { origin: "agent" }); return "ok"; } catch (error) { return error.code; } };
	return { inside: verdict(44), outside: verdict(80) };
})()`);
expect("the range guard holds the agent to f34–46", guard.inside === "ok" && guard.outside === "INVALID_RANGE", JSON.stringify(guard));
const still = await evaluate("[...document.querySelectorAll('.agent-bubble-attachments img')].map((img) => [img.naturalWidth, img.naturalHeight, img.src.length]).at(-1) ?? null");
if (still) {
	const src = await evaluate("[...document.querySelectorAll('.agent-bubble-attachments img')].at(-1).src");
	if (src.startsWith("data:image/jpeg;base64,")) await writeFile(join(out, "04-fix-still.jpg"), Buffer.from(src.split(",")[1], "base64"));
}
expect("the still is before | after side by side (twice as wide as tall-ish)", still && still[0] > still[1] * 1.6, JSON.stringify(still));

// --- 5. Alt-drag copies a pose key: the pose holds between the two -----------------------------------------------
await dragDot(40, 60, ALT);
expect("Alt-dragging the pose dot to f60 copies it and carries the rest dot past it (rest f66)", await shapeIs("34r 40p 60p 66r"), await shape());
expect("the line between the two pose keys is solid", await evaluate("[...document.querySelectorAll('[data-fix-seg]')].map((n) => n.dataset.fixSeg).join() === 'in,pose,out'"));
for (const f of [40, 50, 60]) { await scrub(f); const now = await readRig(); expect(`held: the left arm is the posed arm at f${f}`, maxTurn(fixed[40], now, ARM) < 1e-4, String(maxTurn(fixed[40], now, ARM))); }
await scrub(60);
expect("held: every other bone is the take's at f60", maxTurn(take[60], await readRig(), /^(?!.*Left(Arm|ForeArm|Hand|Hand.*\d)$).*/) < 1e-5);
await scrub(20);
expect("outside the keys f20 is still the take", maxTurn(take[20], await readRig()) < 1e-5);
await scrub(50);
await screenshot("05-held.png");
// Shift-click on the row: a rest key, the arm is the take's there
{ const y = (await dots())[0].y, x = await laneX(50); await pointer("mouseMoved", x, y, 0, SHIFT); await pointer("mousePressed", x, y, 1, SHIFT); await pointer("mouseReleased", x, y, 0, SHIFT); }
expect("Shift-click on the row at f50 adds a rest key there", await shapeIs("34r 40p 50r 60p 66r"), await shape());
await scrub(50);
expect("and f50 is the take again", maxTurn(take[50], await readRig()) < 1e-5);
await undo();
await undo();
expect("two undos (rest key, copy) leave rest f34, pose f40, rest f46", await shapeIs("34r 40p 46r"), await shape());

// --- 6. Dragging a pose dot retimes the whole correction ------------------------------------------------------------
await dragDot(40, 44);
expect("dragging the pose dot to f44 moves it with its two rest dots (f38, f44, f50)", await shapeIs("38r 44p 50r"), await shape());
await scrub(44);
expect("f44 now shows the posed arm", maxTurn(fixed[40], await readRig(), ARM) < 1e-4);
await scrub(36);
expect("f20 is still the take", maxTurn(take[20], await (async () => { await scrub(20); return readRig(); })()) < 1e-5);
await scrub(20);
await dragDot(44, 100);
expect("dragging it far (to f100) carries both rest dots along (f94, f100, f106)", await shapeIs("94r 100p 106r"), await shape());
await undo();
await undo();
expect("two undos put the keys back (f34, f40, f46)", await shapeIs("34r 40p 46r"), await shape());

// --- 7. More drags add keys; a key inside a correction is one more dot ------------------------------------------------
await scrub(43);
await evaluate("window.__cozyclay.ikPreviewApply('leftHand', { x: 0.04, y: 0.08, z: 0 })");
expect("a drag at f43 (inside) adds one pose dot and no rest dots", await shapeIs("34r 40p 43p 46r"), await shape());
await scrub(37);
expect("frames before the first pose key are untouched by it (f37)", maxTurn(fixed[37], await readRig()) < 1e-5);
await scrub(70);
await evaluate("window.__cozyclay.ikPreviewApply('leftHand', { x: 0.05, y: 0.1, z: 0 })");
expect("a drag at f70 (far outside) adds its own rest, pose, rest (f64, f70, f76)", await shapeIs("34r 40p 43p 46r 64r 70p 76r"), await shape());
await scrub(60);
expect("between the two corrections the arm is the take's (f60)", maxTurn(take[60], await readRig()) < 1e-5);
expect("the Left arm label counts three pose keys", await evaluate("document.querySelector('.tl-ik-part-row[data-ik-part=leftArm] .tl-ik-part-count')?.textContent === '3'"));
await scrub(42);
await evaluate("window.__cozyclay.ikPreviewApply('rightHand', { x: -0.1, y: 0.12, z: 0.06 })");
expect("a right-hand drag at f42 opens a Right arm row with its own three dots", await shapeIs("36r 42p 48r", "rightArm") && await evaluate("[...document.querySelectorAll('.tl-ik-part-row')].map((n) => n.dataset.ikPart).join() === 'leftArm,rightArm'"), await shape("rightArm"));
{ const l = (await dots("leftArm"))[0], r = (await dots("rightArm"))[0]; expect("the Right arm row is one row under the Left arm row", Math.abs(r.y - l.y - rowH) <= 2, JSON.stringify([l.y, r.y, rowH])); }
await scrub(42);
await screenshot("07-many-keys.png");

// --- 8. Right-click removes a dot; the last pose key takes the row with it ----------------------------------------------
await rightClickDot(43);
expect("right-click on the f43 dot removes that key", await shapeIs("34r 40p 46r 64r 70p 76r"), await shape());
await undo();
expect("one undo brings it back", await shapeIs("34r 40p 43p 46r 64r 70p 76r"), await shape());
await rightClickDot(42, "rightArm");
expect("removing the Right arm's only pose key removes its rest keys and its row", await poll("!document.querySelector('[data-fix-key][data-fix-part=rightArm]') && document.querySelectorAll('.tl-ik-part-row').length === 1"), await shape("rightArm"));
await scrub(42);
const many = {};
for (const f of [37, 41, 43, 45, 55, 70, 73]) { await scrub(f); many[f] = await readRig(); }

// --- 9. The keys survive a reload ---------------------------------------------------------------------------------------
await waitFor("false", 2500);
{ const loaded = waitForPageLoad(); await send("Page.reload"); await loaded; }
expect("the project comes back after a reload", await waitFor(`!!window.__cozyclay?.characters?.length && !!${rigExpr} && window.__cozyclay.motion?.schema === 'cozyclay.take.v3'`, 30000));
expect("with the same dots", await shapeIs("34r 40p 43p 46r 64r 70p 76r"), await shape());
for (const f of [37, 41, 43, 45, 55, 70, 73]) { await scrub(f); const now = await readRig(); expect(`and the same motion at f${f}`, maxTurn(many[f], now) < 1e-4, String(maxTurn(many[f], now))); }

// --- 9b. Merge writes a row's keys into the take and clears the row ----------------------------------------------------------
await click(".vp-mode-key[data-mode=pose]");
await waitFor("!!document.querySelector('[data-testid=fix-merge-all]')", 20000);
await scrub(42);
await evaluate("window.__cozyclay.ikPreviewApply('rightHand', { x: -0.1, y: 0.12, z: 0.06 })");
await shapeIs("36r 42p 48r", "rightArm");
const before = {};
const CHECK = [20, 37, 41, 43, 45, 55, 70, 73];
for (const f of CHECK) { await scrub(f); before[f] = await readRig(); }
await click("[data-fix-merge=leftArm]");
expect("the check on the Left arm label merges its keys: its dots and row go, the Right arm row stays", await poll("!document.querySelector('[data-fix-key][data-fix-part=leftArm]') && [...document.querySelectorAll('.tl-ik-part-row')].map((n) => n.dataset.ikPart).join() === 'rightArm'"), await shape());
for (const f of CHECK) { await scrub(f); const now = await readRig(); expect(`the motion is unchanged by the merge at f${f} (every bone)`, maxTurn(before[f], now) < 1e-5, String(maxTurn(before[f], now))); }
await click("[data-testid=fix-ab]");
await settle();
await scrub(41);
{ const a = await readRig(); expect("A (the take) is now the merged left arm, without the open right-arm key", maxTurn(before[41], a, ARM) < 1e-5 && maxTurn(before[41], a, /Right(Arm|ForeArm|Hand)$/) > 0.02, JSON.stringify([maxTurn(before[41], a, ARM), maxTurn(before[41], a, /Right(Arm|ForeArm|Hand)$/)])); }
await click("[data-testid=fix-ab]");
await settle();
// a key after the merge is a new layer over the merged motion
await scrub(41);
await evaluate("window.__cozyclay.ikPreviewApply('leftHand', { x: 0.03, y: 0.06, z: 0 })");
expect("a new left-hand drag at f41 starts a clean Left arm row (rest f35, pose f41, rest f47)", await shapeIs("35r 41p 47r"), await shape());
await scrub(37);
{ const now = await readRig(); expect("it eases in over the merged motion (f37 moved a little, f33 not at all)", maxTurn(before[37], now, ARM) > 1e-4, String(maxTurn(before[37], now, ARM))); }
await rightClickDot(41);
await poll("!document.querySelector('[data-fix-key][data-fix-part=leftArm]')");
for (const f of [37, 41, 43]) { await scrub(f); expect(`removing that key leaves the merged motion, not the old take (f${f})`, maxTurn(before[f], await readRig()) < 1e-5); }
await undo();
await undo();
await undo();
expect("three undos (remove, new key, merge) bring the merged keys back as dots", await shapeIs("34r 40p 43p 46r 64r 70p 76r"), await shape());
await scrub(43);
expect("with the same motion (f43)", maxTurn(before[43], await readRig()) < 1e-5);
await poll("!document.querySelector('.toast')", 10000);
await click("[data-testid=fix-merge-all]");
expect("Merge all clears every row (Body group back to two rows); A/B, Merge all and Send have nothing left", await poll("!document.querySelector('[data-fix-key]') && !document.querySelector('.tl-ik-part-row') && Math.abs(document.querySelector('.tl-track[data-track-id=\"Full-Body\"]').getBoundingClientRect().height - " + rowH + " * 2) <= 2 && ['fix-ab', 'fix-merge-all', 'fix-send'].every((id) => document.querySelector('[data-testid=' + id + ']').disabled)"));
for (const f of CHECK) { await scrub(f); const now = await readRig(); expect(`the motion is still unchanged at f${f}`, maxTurn(before[f], now) < 1e-5, String(maxTurn(before[f], now))); }
await screenshot("09-merged.png");
await waitFor("false", 2500);
{ const loaded = waitForPageLoad(); await send("Page.reload"); await loaded; }
expect("the project comes back after a second reload", await waitFor(`!!window.__cozyclay?.characters?.length && !!${rigExpr} && window.__cozyclay.motion?.schema === 'cozyclay.take.v3'`, 30000));
for (const f of [41, 43, 70]) { await scrub(f); const now = await readRig(); expect(`the reloaded take plays the merged keys (f${f}), with no dots`, maxTurn(before[f], now) < 1e-4 && !(await evaluate("!!document.querySelector('[data-fix-key]')")), String(maxTurn(before[f], now))); }

// --- 10. Rows saved as bands (the earlier Fix model) convert to keys with the same shape ----------------------------------
{
	const { convertBandKeys, partKeysOf } = await import("../src/motion/fix-keys.js");
	const q = { x: 0, y: 0, z: 0, w: 1 }, key = (fix) => ({ q: [q], baseQ: [q], blend: 6, fix });
	const plain = [{ frame: 5, tracks: { leftHand: { q: [q] } } }];
	expect("rows without band keys come back as they are", convertBandKeys(plain, 99) === plain);
	const eased = convertBandKeys([{ frame: 40, tracks: { leftHand: key({ id: "a", takeId: "t", before: 6, after: 10 }) } }], 99);
	const read = (rows) => (partKeysOf(rows).get("leftArm") ?? []).map((d) => `${d.frame}${d.rest ? "r" : "p"}`).join(" ");
	expect("an eased band f34–50 becomes rest f33, pose f40, rest f51", read(eased) === "33r 40p 51r" && eased[1].tracks.leftHand.fix.kf === true && !("before" in eased[1].tracks.leftHand.fix) && !("blend" in eased[1].tracks.leftHand), read(eased));
	const held = convertBandKeys([{ frame: 17, tracks: { rightFoot: key({ id: "b", before: 17, after: 62, hold: { in: 0, out: 6 } }) } }], 79);
	const legs = (partKeysOf(held).get("rightLeg") ?? []).map((d) => `${d.frame}${d.rest ? "r" : "p"}`).join(" ");
	expect("a held band f0–79 (ease out 6) becomes pose f0, pose f17, pose f73 and no rest past the take's end", legs === "0p 17p 73p", legs);
	expect("converting twice changes nothing more", JSON.stringify(convertBandKeys(eased, 99)) === JSON.stringify(eased));
}

expect("no page errors", pageErrors.length === 0, JSON.stringify(pageErrors).slice(0, 1200));
ws.close();
if (failures > 0) {
	console.error(`\n${failures} fix key check(s) failed`);
	process.exit(1);
}
console.log("\nAll fix key checks passed");
