#!/usr/bin/env node
// The viewport's fly speed pill, with real pointer, key and wheel events: a click opens a field, typing and Enter
// sets the speed, Escape keeps the old one, a click outside applies, the arrows and the wheel over the pill step it,
// and the wheel during a right-drag still changes the same speed (it steps from the typed value, and a fast run
// of notches loses none). An emptied field keeps the speed; after Enter the focus is off the pill.
// Run: `COZYCLAY_LIVE_PORT=5398 npm run dev -- --port 5198 --strictPort`, then
// `QA_URL=http://127.0.0.1:5198/app/ CDP_PORT=9345 node tools/qa-browser.mjs -- node test/verify-fly-speed-browser.mjs`
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cameraBrowser } from "./camera-browser-harness.mjs";

const dir = process.env.QA_EVIDENCE_DIR || "/tmp/fly-speed-evidence";
mkdirSync(dir, { recursive: true });
const PILL = "[data-testid=fly-speed]", FIELD = "[data-testid=fly-speed-input]";
const b = await cameraBrowser();
const shown = () => b.evaluate(`document.querySelector('${PILL} .vp-speed-value').textContent`);
const fieldOpen = () => b.evaluate(`!!document.querySelector('${FIELD}')`);
const press = async (key, code, keyCode, text) => {
	await b.send("Input.dispatchKeyEvent", { type: "keyDown", key, code, windowsVirtualKeyCode: keyCode, ...(text ? { text } : {}) });
	await b.send("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: keyCode });
};
const type = async (text) => { for (const char of text) await press(char, char === "." ? "Period" : `Digit${char}`, char === "." ? 190 : char.charCodeAt(0), char); };
const wheelAt = (point, deltaY) => b.mouse("mouseWheel", { ...point, deltaX: 0, deltaY });
const open = async () => {
	await b.change(`!!document.querySelector('${FIELD}') && document.activeElement === document.querySelector('${FIELD}')`, () => b.click(PILL));
};
const shot = async (name) => {
	const result = await b.send("Page.captureScreenshot", { format: "png" });
	writeFileSync(join(dir, `${name}.png`), Buffer.from(result.data, "base64"));
};
try {
	await b.seed();
	assert.equal(await shown(), "1×", "the speed starts at 1×");
	const title = await b.evaluate(`document.querySelector('${PILL}').title`);
	assert.match(title, /click/i, "the title names the click");
	assert.match(title, /right-drag/i, "the title still names the right-drag scroll");

	// Click, type 2.5, Enter.
	await open();
	await shot("field-open");
	assert.equal(await b.evaluate(`document.querySelector('${FIELD}').value`), "1", "the field starts at the current speed");
	const mode = () => b.evaluate("[...document.querySelectorAll('[data-mode-key]')].find((k) => k.classList.contains('active') || k.getAttribute('aria-selected') === 'true')?.dataset.modeKey");
	const modeBefore = await mode();
	await type("2.5");
	await b.change(`document.querySelector('${PILL} .vp-speed-value').textContent === '2.5×' && !document.querySelector('${FIELD}')`,
		() => press("Enter", "Enter", 13));
	assert.equal(await mode(), modeBefore, "typing 2 in the field is not the Pose mode key");
	// A focused button owns Space (the timeline skips its keys there): after a pointer's
	// edit the focus is off the pill, so Space is the playback toggle, not the pill again.
	assert.equal(await b.evaluate(`document.querySelector('[data-vp-menu=fly-speed]').contains(document.activeElement)`), false, "Enter gives the focus back to the stage");
	console.log("PASS click, type 2.5, Enter sets the fly speed to 2.5×");

	// An emptied field is not a number: Enter keeps the speed (it is not 0 clamped to the slowest).
	await open();
	await press("Backspace", "Backspace", 8);
	assert.equal(await b.evaluate(`document.querySelector('${FIELD}').value`), "", "Backspace empties the selected field");
	await b.change(`!document.querySelector('${FIELD}')`, () => press("Enter", "Enter", 13));
	assert.equal(await shown(), "2.5×", "an empty field keeps the speed");
	console.log("PASS an emptied field keeps 2.5×");

	// Escape keeps the old value.
	await open();
	await type("4");
	await b.change(`!document.querySelector('${FIELD}')`, () => press("Escape", "Escape", 27));
	assert.equal(await shown(), "2.5×", "Escape cancels the typed value");
	console.log("PASS Escape closes the field and keeps 2.5×");

	// Out-of-range input clamps to the scroll path's limit; a click outside applies it.
	await open();
	await type("99");
	const outside = await b.centre(".stage canvas");
	await b.change(`document.querySelector('${PILL} .vp-speed-value').textContent === '6×' && !document.querySelector('${FIELD}')`, async () => {
		await b.mouse("mousePressed", { ...outside, button: "left", buttons: 1, clickCount: 1 });
		await b.mouse("mouseReleased", { ...outside, button: "left", buttons: 0, clickCount: 1 });
	});
	console.log("PASS a click outside applies the typed 99, clamped to 6×");

	// The arrows step by the wheel's 10 %.
	await open();
	await b.change(`document.querySelector('${PILL} .vp-speed-value').textContent === '5.4×'`, () => b.click("[data-step=slower]"));
	assert.equal(await b.evaluate(`document.querySelector('${FIELD}').value`), "5.4", "the field follows the step");
	// A typed number that is not applied yet is where the next step starts.
	const selectField = () => b.evaluate(`document.querySelector('${FIELD}').select()`);
	await selectField();
	await type("3");
	await b.change(`document.querySelector('${PILL} .vp-speed-value').textContent === '3.3×'`, () => b.click("[data-step=faster]"));
	assert.equal(await b.evaluate(`document.querySelector('${FIELD}').value`), "3.3", "+ steps from the typed 3");
	await selectField();
	await type("6");
	await b.change(`document.querySelector('${PILL} .vp-speed-value').textContent === '5.4×'`, () => b.click("[data-step=slower]"));
	await b.change(`!document.querySelector('${FIELD}')`, () => press("Enter", "Enter", 13));
	assert.equal(await shown(), "5.4×", "Enter after a step keeps the stepped speed");
	console.log("PASS the − arrow steps 6× down by 10 % to 5.4×, and a typed 3 steps to 3.3×");

	// The wheel over the pill (closed) steps too.
	const pill = await b.centre(PILL);
	await b.mouse("mouseMoved", pill);
	await b.change(`document.querySelector('${PILL} .vp-speed-value').textContent === '4.9×'`, () => wheelAt(pill, 100));
	assert.equal(await fieldOpen(), false);
	console.log("PASS the wheel over the pill steps 5.4× down to 4.86× (shown 4.9×)");

	// Set 2 by typing, then scroll while right-dragging: it steps from 2 (one shared speed).
	await open();
	await type("2");
	await b.change(`!document.querySelector('${FIELD}')`, () => press("Enter", "Enter", 13));
	assert.equal(await shown(), "2×");
	const p = await b.centre(".stage canvas");
	await b.mouse("mouseMoved", p);
	await b.change("document.pointerLockElement === document.querySelector('.stage canvas')", () =>
		b.mouse("mousePressed", { ...p, button: "right", buttons: 2, clickCount: 1 }));
	await b.change(`document.querySelector('${PILL} .vp-speed-value').textContent === '2.2×'`, () =>
		b.mouse("mouseWheel", { ...p, deltaX: 0, deltaY: -100, buttons: 2 }));
	await b.change(`document.querySelector('${PILL} .vp-speed-value').textContent === '2×'`, () =>
		b.mouse("mouseWheel", { ...p, deltaX: 0, deltaY: 100, buttons: 2 }));
	await b.change("document.pointerLockElement === null", () =>
		b.mouse("mouseReleased", { ...p, button: "right", buttons: 0, clickCount: 1 }));
	console.log("PASS scrolling while right-dragging steps the typed 2× to 2.2× and back (1.98×, shown 2×)");

	// A fast run of notches during the right-drag: every wheel event the page gets is one step. The
	// browser may merge notches, so the count is the page's own. One protocol round trip paces them
	// (no timer): a speed copied back from a render that is one notch behind loses steps here in
	// about half the runs, and a speed stepped as an updater never does.
	await open();
	await type("1");
	await b.change(`!document.querySelector('${FIELD}')`, () => press("Enter", "Enter", 13));
	await b.evaluate("window.__qaWheels = 0; window.__qaLastWheel = false; window.addEventListener('wheel', (event) => { window.__qaWheels += 1; if (event.shiftKey) window.__qaLastWheel = true; }, true); true");
	await b.change("document.pointerLockElement === document.querySelector('.stage canvas')", () =>
		b.mouse("mousePressed", { ...p, button: "right", buttons: 2, clickCount: 1 }));
	const notches = [];
	for (let i = 0; i < 16; i++) {
		notches.push(b.mouse("mouseWheel", { ...p, deltaX: 0, deltaY: -100, buttons: 2 }));
		await b.evaluate("1");
	}
	// Wheel events reach the page in order, and one with another modifier is not merged into the
	// run: once the page has this last one (Shift held), it has had them all, still in the drag.
	await b.change("window.__qaLastWheel === true", () => b.mouse("mouseWheel", { ...p, deltaX: 0, deltaY: -100, buttons: 2, modifiers: 8 }));
	await Promise.all(notches);
	const received = await b.evaluate("window.__qaWheels");
	assert.ok(received >= 2 && received <= 17, `the page got some of the 17 notches (${received})`);
	const stepped = `${Number((1.1 ** received).toFixed(1))}×`;
	await b.arm(`document.querySelector('${PILL} .vp-speed-value').textContent === '${stepped}'`);
	await b.settled();
	await b.change("document.pointerLockElement === null", () =>
		b.mouse("mouseReleased", { ...p, button: "right", buttons: 0, clickCount: 1 }));
	assert.equal(await shown(), stepped, "the release keeps the stepped speed");
	console.log(`PASS ${received} wheel events in a row during the right-drag are ${received} steps (1× to ${stepped})`);
	await open();
	await type("2");
	await b.change(`!document.querySelector('${FIELD}')`, () => press("Enter", "Enter", 13));

	// A plain wheel on the stage still dollies and leaves the speed alone.
	const before = await b.pose("editorCam");
	await b.change(`Math.abs(window.__cozyclay.editorCam.position.z - ${before.pos.z}) > 1e-4 || Math.abs(window.__cozyclay.editorCam.position.x - ${before.pos.x}) > 1e-4`,
		() => wheelAt(p, -100));
	assert.equal(await shown(), "2×", "a plain wheel dollies, the speed stays");
	console.log("PASS a plain wheel on the stage dollies and keeps 2×");
	await open();
	await shot("field-reopened");
	await press("Escape", "Escape", 27);
	console.log(`fly speed browser: all checks passed (screenshots in ${dir})`);
} finally {
	b.close();
}
