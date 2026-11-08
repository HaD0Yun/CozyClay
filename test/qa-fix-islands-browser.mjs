#!/usr/bin/env node
// Browser QA for Fix and tell (domains/motion/fix-islands.js, motion/fix-weight.js, TimelineFixIslands.jsx,
// shell/FixTools.jsx on the IK keys row's header, fix-original-ghost.jsx, fix-send.js): with a walk take installed, a left-hand pose drag at f40
// (the production IK solve/end path) makes ONE correction island reaching 6 frames each side; frames outside it are the
// take bone for bone, frames inside blend toward the fix, the feet stay put; a band edge drags to widen it (one undo);
// A/B shows the original take at f40 and, in the fixed view, its pose as a ghost; Send fixes puts one chip in the
// composer whose mark carries the fix payload and a before | after still, and arms the range guard; right-click removes
// the island and undo brings it back; one more undo removes the fix itself.
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
const mouse = (type, x, y, buttons = 0) => send("Input.dispatchMouseEvent", { type, x, y, button: type === "mouseMoved" && !buttons ? "none" : "left", buttons, clickCount: type === "mouseMoved" ? 0 : 1 });
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
const band = () => evaluate("(() => { const node = document.querySelector('.tl-track[data-track-id=\"Full-Body\"] [data-fix-island]'); if (!node) return null; const r = node.getBoundingClientRect(); return { frame: Number(node.dataset.fixFrame), title: node.title, x: r.left, w: r.width, y: r.top + r.height / 2, h: r.height }; })()");
const laneX = (frame) => evaluate(`(() => { const lane = document.querySelector('.tl-track[data-track-id="Full-Body"] .tl-lane').getBoundingClientRect(); return lane.left + ${frame} / Math.max(1, window.__cozyclay.frameCount - 1) * lane.width; })()`);

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
expect("the three Fix tools are 24 px icon cells", cells.length === 3 && cells.every(([w, h]) => w === 24 && h === 24), JSON.stringify(cells));
const reachable = await evaluate("[...document.querySelectorAll('.pose-fix-tools > button')].map((b) => { const r = b.getBoundingClientRect(); return document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)?.closest('button') === b; })");
expect("each one is on screen and not covered", reachable.length === 3 && reachable.every(Boolean), JSON.stringify(reachable));
await waitFor("false", 600);

const FRAMES = [20, 33, 34, 37, 40, 43, 46, 47, 50, 60];
const take = {};
for (const f of FRAMES) { await scrub(f); take[f] = await readRig(); }

// --- 1. A pose drag of the left hand at f40 makes one island -----------------------------------------------
await scrub(40);
expect("the IK drag seam moves the left hand at f40", await evaluate("window.__cozyclay.ikPreviewApply('leftHand', { x: 0.1, y: 0.14, z: 0.06 })"));
expect("an island band appears on the IK keys row at f40", await waitFor("!!document.querySelector('.tl-track[data-track-id=\"Full-Body\"] [data-fix-island]')"));
const made = await band();
const fills = await evaluate("(() => { const root = document.documentElement, was = root.dataset.theme, n = document.querySelector('[data-fix-island]'), out = []; for (const t of ['light', 'dark']) { root.dataset.theme = t; out.push(getComputedStyle(n).backgroundColor); } root.dataset.theme = was; return out; })()"); expect("the island reaches 6 frames each side: f34–46, with a visible fill in light and dark", made?.frame === 40 && /f34–46/.test(made.title) && fills.every((c) => c !== "rgba(0, 0, 0, 0)"), JSON.stringify({ made, fills }));
expect("no whole-take range preview is pending (Fix mode took the drag)", await evaluate("!document.querySelector('[data-testid=ik-pending-edit]')"));
const dot = await evaluate("(() => { const d = [...document.querySelectorAll('.tl-track[data-track-id=\"Full-Body\"] .tl-marker.ik')].find((n) => /at frame 40\\b/.test(n.title)); if (!d) return null; const r = d.getBoundingClientRect(); return { y: r.top + r.height / 2 }; })()");
expect("the band sits on the IK keys row with the key dot", dot && made && Math.abs(dot.y - made.y) <= 2, JSON.stringify({ dot, made }));
const fixed = {};
for (const f of FRAMES) { await scrub(f); fixed[f] = await readRig(); }
const turn = Object.fromEntries(FRAMES.map((f) => [f, maxTurn(take[f], fixed[f])]));
const ARM = /Left(Arm|ForeArm|Hand)$/;
expect("f40 shows the fix (left arm bones turned)", maxTurn(take[40], fixed[40], ARM) > 0.05, JSON.stringify(turn));
expect("outside f34–46 every bone is the take's (f20, f33, f47, f60)", [20, 33, 47, 60].every((f) => turn[f] < 1e-5), JSON.stringify(turn));
expect("inside, the fix eases in and out (f34 < f37 < f40 > f43 > f46 > 0)", turn[34] > 0 && turn[34] < turn[37] && turn[37] < turn[40] && turn[43] < turn[40] && turn[46] < turn[43] && turn[46] > 0, JSON.stringify(turn));
expect("only the left arm moved: other bones are the take's at f40", maxTurn(take[40], fixed[40], /^(?!.*Left(Arm|ForeArm|Hand|Hand.*\d)$).*/) < 1e-5, String(maxTurn(take[40], fixed[40], /^(?!.*Left(Arm|ForeArm|Hand|Hand.*\d)$).*/)));
expect("the feet stay where the take puts them at f37, f40, f43", [37, 40, 43].every((f) => feetMoved(take[f], fixed[f]) < 0.001), JSON.stringify([37, 40, 43].map((f) => feetMoved(take[f], fixed[f]))));
await scrub(40);
await screenshot("01-island-f40.png");

// --- 2. A band edge drag widens the island (one undo) -------------------------------------------------------
const edge = await evaluate("(() => { const r = document.querySelector('[data-fix-island] [data-fix-edge=end]').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()");
const to = await laneX(52);
await mouse("mouseMoved", edge.x, edge.y);
await mouse("mousePressed", edge.x, edge.y, 1);
for (let t = 1; t <= 6; t += 1) await mouse("mouseMoved", edge.x + (to - edge.x) * t / 6, edge.y, 1);
await mouse("mouseReleased", to, edge.y);
const wide = await band();
expect("dragging the end edge to f52 widens the island to f34–52", /f34–5[1-3]/.test(wide?.title ?? ""), JSON.stringify(wide));
await scrub(50);
expect("f50 now eases out of the fix", maxTurn(take[50], await readRig()) > 1e-4);
await evaluate("document.activeElement?.blur?.()");
await press("KeyZ", "z", 2);
expect("one undo puts the reach back to f34–46", await waitFor("/f34–46/.test(document.querySelector('[data-fix-island]')?.title ?? '')"), JSON.stringify(await band()));
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
expect("Send fixes puts one fix chip in the composer: Fix f34–46 · Left hand", await waitFor("document.querySelectorAll('.agent-context-chip[data-chip-kind=fix]').length === 1 && /Fix f34–46 · Left hand/.test(document.querySelector('.agent-context-chip[data-chip-kind=fix]').textContent)"), JSON.stringify(await evaluate("[...document.querySelectorAll('.agent-context-chip')].map((n) => n.textContent)")));
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

// --- 5. Right-click removes the island; undo brings it back; one more undo removes the fix --------------------
await evaluate("document.activeElement?.blur?.()");
const hit = await band();
await send("Input.dispatchMouseEvent", { type: "mousePressed", x: hit.x + 6, y: hit.y, button: "right", buttons: 2, clickCount: 1 });
await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: hit.x + 6, y: hit.y, button: "right", buttons: 0, clickCount: 1 });
expect("right-click on the band removes the island", await waitFor("!document.querySelector('[data-fix-island]')"));
await scrub(40);
expect("f40 is the take again", maxTurn(take[40], await readRig()) < 1e-5);
await press("KeyZ", "z", 2);
expect("one undo brings the island back", await waitFor("!!document.querySelector('[data-fix-island]')"));
await scrub(40);
expect("with its fix", maxTurn(fixed[40], await readRig()) < 1e-5);
await press("KeyZ", "z", 2);
expect("one more undo removes the fix itself (back to the take)", await waitFor("!document.querySelector('[data-fix-island]')"));
await scrub(40);
expect("f40 is the take", maxTurn(take[40], await readRig()) < 1e-5);

expect("no page errors", pageErrors.length === 0, JSON.stringify(pageErrors).slice(0, 1200));
ws.close();
if (failures > 0) {
	console.error(`\n${failures} fix island check(s) failed`);
	process.exit(1);
}
console.log("\nAll fix island checks passed");
