// Run with QA_URL=http://127.0.0.1:5180/ node tools/qa-browser.mjs -- node test/verify-install-browser.mjs
import { connectStudio } from "./qa-stage-hdr-harness.mjs";

const { send, evaluate, waitFor, expect, finish } = await connectStudio(Number(process.env.CDP_PORT || 9222));
await send("Page.enable");
const origin = await evaluate("location.origin");
await send("Page.addScriptToEvaluateOnNewDocument", { source: `
	window.__installCopy = [];
	Object.defineProperty(navigator, "clipboard", { configurable: true, value: {
		writeText: async (text) => {
			if (window.__copyBlocked) throw new Error("clipboard blocked");
			window.__installCopy.push(text);
		}
	} });
	const originalFetch = window.fetch;
	window.fetch = (input, options) => String(input).includes("nodejs.org/dist/index.json")
		? Promise.resolve(new Response("[]", { status: 503 })) : originalFetch(input, options);
` });
// Vite redirects / to the Studio; /index.html serves the same landing entry.
await send("Page.navigate", { url: `${origin}/index.html#install` });
if (!await waitFor('document.querySelector("#install")?.open')) throw new Error("install hash entry did not open");

expect("hash opens setup with runtime step visible", await evaluate('!document.querySelector(\'[data-install-step="1"]\').hidden && document.querySelector(\'[data-install-step="2"]\').hidden'));
expect("failed release lookup retains official download fallback", await evaluate('document.querySelector("#install-node").href === "https://nodejs.org/en/download"'));
async function verifyTokens(label) {
	for (const width of [390, 768, 1180, 1440]) {
		await send("Emulation.setDeviceMetricsOverride", { width, height: 844, deviceScaleFactor: 1, mobile: width === 390 });
		const command = await evaluate(`(() => {
			const code = document.querySelector("#install-command"), node = code.firstChild;
			const tokens = [...node.textContent.matchAll(/\\S+/g)].map(match => {
				const range = document.createRange();
				range.setStart(node, match.index); range.setEnd(node, match.index + match[0].length);
				return { token: match[0], lines: range.getClientRects().length };
			});
			const pre = code.closest("pre");
			pre.scrollLeft = pre.scrollWidth;
			const last = document.createRange(); last.setStart(node, node.textContent.lastIndexOf(" ") + 1); last.setEnd(node, node.length);
			const end = last.getBoundingClientRect(), box = pre.getBoundingClientRect();
			return { tokens, endReachable: end.right <= box.right + 1, visible: box.width > 0 && box.height > 0 };
		})()`);
		expect(`${label} at ${width}px keeps every command token intact`, command.visible && command.tokens.every(token => token.lines === 1), JSON.stringify(command));
		expect(`${label} at ${width}px can reach the command end`, command.endReachable, JSON.stringify(command));
	}
}
for (const os of ["mac", "win", "linux"]) {
	await evaluate(`document.querySelector('[data-os="${os}"]').click(); document.querySelector('[data-install-next="2"]').click();`);
	const command = `${os === "win" ? "npx.cmd" : "npx"} --yes cozyclay@latest --via site`;
	expect(`${os} shows its launch command`, await evaluate(`document.querySelector("#install-command").textContent === ${JSON.stringify(command)}`));
	expect(`${os} Quick start shows the same command`, await evaluate(`document.querySelector("[data-launch-command]").textContent === ${JSON.stringify(command)} && document.querySelector("[data-launch-copy]").dataset.copy === ${JSON.stringify(command)}`));
	expect(`${os} next focuses the visible heading`, await evaluate('document.activeElement.id === "install-launch-title"'));
	expect(`${os} setup overrides landing section spacing`, await evaluate('getComputedStyle(document.querySelector(\'[data-install-step="2"]\')).paddingTop === "0px" && getComputedStyle(document.querySelector("#install details")).marginTop === "0px"'));
	await verifyTokens(`${os} site`);
	await evaluate('document.querySelector("[data-install-copy]").click()');
	expect(`${os} copy uses the shown command`, await waitFor(`window.__installCopy.at(-1) === ${JSON.stringify(command)}`));
	expect(`${os} copy reports success`, await evaluate('document.querySelector("#install-status").dataset.state === "copied"'));
	await evaluate('document.querySelector(\'[data-install-next="1"]\').click()');
	expect(`${os} back restores runtime step`, await evaluate('!document.querySelector(\'[data-install-step="1"]\').hidden && document.activeElement.id === "install-runtime-title"'));
}
await evaluate('document.querySelector(\'[data-install-next="2"]\').click(); window.__copyBlocked = true; document.querySelector("[data-install-copy]").click()');
expect("blocked clipboard explains manual copy", await waitFor('document.querySelector("#install-status").dataset.state === "error"'));
expect("manual copy selects the command", await evaluate('window.getSelection().toString() === document.querySelector("#install-command").textContent'));
await evaluate('document.querySelector(\'[data-os="win"]\').click()');
expect("OS changes clear stale copy feedback", await evaluate('document.querySelector("#install-status").dataset.state === "" && !document.querySelector("[data-install-copy]").disabled'));
await evaluate('document.querySelector("[data-install-close]").click()');
expect("close dismisses the dialog", await evaluate('!document.querySelector("#install").open'));
await evaluate('document.querySelector("[data-install-open]").click()');
expect("install button reopens at step one", await evaluate('document.querySelector("#install").open && !document.querySelector(\'[data-install-step="1"]\').hidden'));
await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
expect("Escape closes the dialog", await waitFor('!document.querySelector("#install").open'));

// #1183: the hosted Studio links here with ?from=studio. The page then shows and copies --via playground wherever it
// shows the command; opened any other way (everything above) it says --via site.
await send("Page.navigate", { url: `${origin}/index.html?from=studio#install` });
if (!await waitFor('location.search === "?from=studio" && document.querySelector("#install")?.open')) throw new Error("install entry from the Studio did not open");
for (const os of ["mac", "win", "linux"]) {
	await evaluate(`document.querySelector('[data-os="${os}"]').click(); document.querySelector('[data-install-next="2"]').click();`);
	const command = `${os === "win" ? "npx.cmd" : "npx"} --yes cozyclay@latest --via playground`;
	expect(`from the Studio: ${os} shows the playground command`, await evaluate(`document.querySelector("#install-command").textContent === ${JSON.stringify(command)}`), await evaluate('document.querySelector("#install-command").textContent'));
	expect(`from the Studio: ${os} Quick start shows the same command`, await evaluate(`document.querySelector("[data-launch-command]").textContent === ${JSON.stringify(command)} && document.querySelector("[data-launch-copy]").dataset.copy === ${JSON.stringify(command)}`));
	await verifyTokens(`${os} playground`);
	await evaluate('document.querySelector("[data-install-copy]").click()');
	expect(`from the Studio: ${os} copy uses the shown command`, await waitFor(`window.__installCopy.at(-1) === ${JSON.stringify(command)}`, 5000), await evaluate("window.__installCopy.at(-1)"));
}
expect("from the Studio: the page shows one command, never the landing page's own", await evaluate('!document.body.textContent.includes("--via site") && !document.querySelector(\'[data-copy*="--via site"]\')'));

finish("install browser flow");
