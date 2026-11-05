#!/usr/bin/env node
// Browser contract for the first-run v2 chooser and the first-success guide.
// It creates through the new-project preview, then drives the same named guide
// controls a new author sees in the editor.

const port = Number(process.env.CDP_PORT || 9222);
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
		const message = JSON.parse(event.data);
		if (message.method === "Page.loadEventFired") finish();
	};
	const timer = setTimeout(() => finish(new Error("timed out waiting for the QA page to load")), timeoutMs);
	ws.addEventListener("message", onMessage);
});
const evaluate = async (expression) => {
	for (let attempt = 0; attempt < 2; attempt += 1) {
		try {
			const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
			if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || "evaluate failed");
			return result.result.value;
		} catch (error) {
			if (!String(error?.message).includes("Execution context was destroyed") || attempt > 0) throw error;
			const loaded = waitForPageLoad();
			await send("Page.reload", { ignoreCache: true });
			await loaded;
		}
	}
};
await send("Page.enable");
// QA_LOCALE=ko runs the same contract against the Korean labels.
const LOCALE = process.env.QA_LOCALE === "ko" ? "ko" : "en";
await evaluate(`localStorage.setItem("cozyclay.locale", ${JSON.stringify(LOCALE)})`);
const loaded = waitForPageLoad();
await send("Page.reload", { ignoreCache: true });
await loaded;
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
	observer.observe(document.body, { childList: true, subtree: true, attributes: true, characterData: true });
	const timer = setTimeout(() => finish(false), ${timeoutMs});
	check();
})`);

let failures = 0;
const expect = (name, condition, detail = "") => {
	console.log(`${condition ? "PASS" : "FAIL"} ${name}${condition ? "" : ` — ${detail}`}`);
	if (!condition) failures += 1;
};

const setInput = (selector, value) => evaluate(`(() => {
	const input = document.querySelector(${JSON.stringify(selector)});
	if (!input) return false;
	const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
	setter.call(input, ${JSON.stringify(value)});
	input.dispatchEvent(new Event("input", { bubbles: true }));
	input.dispatchEvent(new Event("change", { bubbles: true }));
	return true;
})()`);

expect("the first-run v2 project chooser renders", await waitFor("!!document.querySelector('.v2-start-screen.project-browser-backdrop.startup')"));
expect("the chooser exposes the new-project preview", await waitFor("!!document.querySelector('[data-testid=start-project-preview]')"));
expect("the chooser has a named Create action", await waitFor("!!document.querySelector('[data-testid=start-create]')"));
// The "+ New project" card is the blank-project path that opens the guide.
await evaluate("document.querySelector('[data-testid=start-new-project-card]')?.click()");
await setInput('[data-testid="start-project-name"]', "guide_project");
await evaluate("document.querySelector('[data-testid=start-create]').click()");
expect("creating from the preview opens the editor", await waitFor("!document.querySelector('.project-browser') && !!document.querySelector('.timeline')"));
expect("guidance starts after project creation", await waitFor("!!document.querySelector('.first-success-guide')"));
const guideText = await evaluate("document.querySelector('.first-success-guide')?.textContent || ''");
const animationPattern = LOCALE === "ko" ? /캐릭터를 추가.*장면 보기에서 캐릭터를 움직.*에이전트에게 동작을 요청.*타임라인을 문지르거나 Space/s : /Add a character.*Move it.*Ask the Agent for a motion.*Scrub the timeline.*Space/s;
expect("guidance names selection, movement, the agent ask, and playback", animationPattern.test(guideText), guideText);
expect("an animation project shows none of the storyboard steps", !guideText.includes("Agent panel") && !guideText.includes("에이전트 패널을 여세요"), guideText);

// #1047: a new project has no character; step 1 lights Add and ticks itself off when one is added.
expect("step 1 lights the Add button", await waitFor("document.querySelector('[data-testid=viewport-add]')?.classList.contains('guide-target')"));
await evaluate("document.querySelector('[data-testid=viewport-add]').click()");
expect("Add offers Y Bot", await waitFor("!!document.querySelector('[data-add=character]')"));
await evaluate("document.querySelector('[data-add=character]').click()");
expect("adding a character advances step 1 by itself", await waitFor(`document.querySelector('.first-success-guide')?.textContent.includes(${JSON.stringify(LOCALE === "ko" ? "2 / 4 단계" : "Step 2 of 4")})`));
expect("the Add button stops glowing after step 1", await waitFor("!document.querySelector('[data-testid=viewport-add]')?.classList.contains('guide-target')"));
for (let index = 1; index < 4; index += 1) {
	await evaluate("document.querySelector('.first-success-guide-next')?.click()");
	const expected = index === 3 ? (LOCALE === "ko" ? "첫 샷을 만들었어요." : "You made your first shot.") : (LOCALE === "ko" ? `${index + 2} / 4 단계` : `Step ${index + 2} of 4`);
	expect(`guide advances after action ${index + 1}`, await waitFor(`document.querySelector('.first-success-guide')?.textContent.includes(${JSON.stringify(expected)})`));
}
expect("the guide exposes a completion state", await waitFor(`document.querySelector('.first-success-guide')?.textContent.includes(${JSON.stringify((LOCALE === "ko" ? "첫 샷을 만들었어요." : "You made your first shot."))})`));
await evaluate("document.querySelector('.first-success-guide-close').click()");
expect("the guide can be dismissed", await waitFor("!document.querySelector('.first-success-guide')"));
expect("the editor remains available after dismissal", await waitFor("!!document.querySelector('.timeline')"));

// --- Storyboard project ---------------------------------------------------
const STORYBOARD = LOCALE === "ko"
	? ["에이전트 패널을 여세요 (Cmd/Ctrl+B).", "장면 하나를 한 문장으로 설명하세요.", "패널이 보드에 나타납니다.", "스타일을 입히거나 패널 팩으로 내보내세요."]
	: ["Open the Agent panel (Cmd/Ctrl+B).", "Describe one scene in a sentence.", "Your panel appears on the Board.", "Stylize it, or export the panel pack."];
await evaluate("window.confirm = () => true");
await evaluate("document.querySelector('[data-testid=menu-file]').click()");
expect("File shows New", await waitFor("!!document.querySelector('[data-testid=menubar-new]')"));
await evaluate("document.querySelector('[data-testid=menubar-new]').click()");
expect("File > New offers the mode control", await waitFor("!!document.querySelector('[data-testid=start-previs-mode]')"));
await evaluate("document.querySelector('[data-previs-mode=storyboard]').click()");
expect("Storyboard is the checked mode", await waitFor("document.querySelector('[data-previs-mode=storyboard]')?.getAttribute('aria-checked') === 'true'"));
await setInput('[data-testid="start-project-name"]', "guide_storyboard");
await evaluate("document.querySelector('[data-testid=start-create]').click()");
expect("the storyboard project opens", await waitFor("!document.querySelector('.v2-start-screen') && !!document.querySelector('.timeline') && document.querySelector('.app')?.dataset.previsMode === 'storyboard'"));
expect("the guide opens on blank-project creation in storyboard", await waitFor("!!document.querySelector('.first-success-guide')"));
const items = await evaluate("[...document.querySelectorAll('.first-success-guide-steps li > div > strong')].map((node) => node.textContent)");
expect("the guide lists exactly the four storyboard steps in order", JSON.stringify(items) === JSON.stringify(STORYBOARD), JSON.stringify(items));
const sbText = await evaluate("document.querySelector('.first-success-guide')?.textContent || ''");
expect("no animation step leaks into the storyboard guide", !/Ask the Agent for a motion|Scrub the timeline|에이전트에게 동작을 요청|타임라인을 문지르/.test(sbText), sbText);
if (process.env.QA_SHOTS_DIR) {
	const shot = await send("Page.captureScreenshot", { format: "png" });
	const { writeFileSync, mkdirSync } = await import("node:fs");
	mkdirSync(process.env.QA_SHOTS_DIR, { recursive: true });
	writeFileSync(`${process.env.QA_SHOTS_DIR}/task-20-storyboard-guide-${LOCALE}.png`, Buffer.from(shot.data, "base64"));
}
for (let index = 0; index < 4; index += 1) {
	await evaluate("document.querySelector('.first-success-guide-next')?.click()");
	const expected = index === 3 ? (LOCALE === "ko" ? "첫 패널을 만들었어요." : "You made your first panel.") : (LOCALE === "ko" ? `${index + 2} / 4 단계` : `Step ${index + 2} of 4`);
	expect(`storyboard guide advances after action ${index + 1}`, await waitFor(`document.querySelector('.first-success-guide')?.textContent.includes(${JSON.stringify(expected)})`));
}
await evaluate("document.querySelector('.first-success-guide-close').click()");
expect("the storyboard guide can be dismissed", await waitFor("!document.querySelector('.first-success-guide')"));

ws.close();
if (failures > 0) {
	console.error(`\n${failures} first-success guide browser check(s) failed`);
	process.exit(1);
}
console.log("\nAll first-success guide browser checks passed");
