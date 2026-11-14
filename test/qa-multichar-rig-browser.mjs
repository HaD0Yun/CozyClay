#!/usr/bin/env node
// Browser QA for #76/#77/#78: with a two-member cast, Character 2's hierarchy
// row expands into its own namespaced rig subtree, selecting one of its bones
// routes the inspector (and the active character) to character 2, and the
// rig ids never collide with character 1's. Driven over CDP through the QA
// browser wrapper. Evidence script; not part of the manifest.
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
const evaluate = async (expression) => {
	const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
	if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || "evaluate failed");
	return result.result.value;
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const waitFor = async (expression, timeoutMs = 15000) => {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await evaluate(expression).catch(() => false)) return true;
		await sleep(120);
	}
	return false;
};
let failures = 0;
const expect = (name, condition, detail = "") => {
	console.log(`${condition ? "PASS" : "FAIL"} ${name}${condition ? "" : ` — ${detail}`}`);
	if (!condition) failures += 1;
};

// tree rows carry data-node-id; expansion is the .hierarchy-toggle button
const nodeRow = (id) => `document.querySelector('[data-node-id="${id}"]')`;
// idempotent: only presses the caret when the row is actually collapsed
const expandNode = (id) => evaluate(`(() => {
	const row = ${nodeRow(id)};
	if (!row) return false;
	if (row.getAttribute('aria-expanded') === 'false') row.querySelector('.hierarchy-toggle')?.click();
	return true;
})()`);
const selectNode = (id) => evaluate(`${nodeRow(id)}?.querySelector('.hierarchy-row')?.click() ?? false`);

expect("app becomes ready", await waitFor("!!document.querySelector('.v2-outliner .v2-outliner-search')", 30000));

// a second cast member via the Subjects panel
await evaluate(`[...document.querySelectorAll('button')].find(b => /add second subject|\ub450 \ubc88\uc9f8 \uc778\ubb3c/i.test(b.textContent))?.click()`);
expect("a second character joins the cast", await waitFor(`!!${nodeRow("characterB")}`, 8000));

// #78: Character 2 expands into its own namespaced rig subtree
await expandNode("characterB");
expect("Character 2 exposes its own Rig row", await waitFor(`!!${nodeRow("characterB.rig")}`, 8000));
await expandNode("characterB.rig");
expect("the rig opens into body groups", await waitFor(`!!${nodeRow("characterB.rig.leftArm")}`, 8000));
await expandNode("characterB.rig.leftArm");
expect("bones are reachable", await waitFor(`!!${nodeRow("characterB.rig.leftHand")}`, 8000));

// #76: the ids are namespaced — character 1's tree still uses its own row
await expandNode("characterA");
expect("Character 1 keeps its own rig row beside character 2's", await waitFor(`!!${nodeRow("characterA.rig")}`, 8000));
expect(
	"the two rig trees never share a node id",
	await evaluate(`[...document.querySelectorAll('[data-node-id]')].map(n => n.dataset.nodeId).every((id, i, all) => all.indexOf(id) === i)`),
);

// selecting character 2's bone routes the inspector to that bone
await selectNode("characterB.rig.leftHand");
expect(
	"the bone row takes the selection",
	await waitFor(`${nodeRow("characterB.rig.leftHand")}?.classList.contains("selected")`, 8000),
);
expect(
	"the inspector heading names the bone through its token",
	await waitFor(`/Left Hand|\uc67c\uc190/.test(document.querySelector('.inspector-heading-selection')?.textContent ?? '')`, 8000),
);
expect(
	"the Rig Control foldout is live for character 2's bone",
	await evaluate(`[...document.querySelectorAll('aside, [class*="inspector"]')].some(n => /Rig Control|\ub9ac\uadf8 \uc81c\uc5b4/.test(n.textContent))`),
);

if (failures > 0) { console.error(`${failures} FAILURES`); process.exit(1); }
console.log("qa-multichar-rig-browser: all checks passed");
ws.close();
