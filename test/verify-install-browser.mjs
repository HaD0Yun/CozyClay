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
await send("Page.navigate", { url: `${origin}/#install` });
if (!await waitFor('document.querySelector("#install")?.open')) throw new Error("install hash entry did not open");

expect("hash opens setup with runtime step visible", await evaluate('!document.querySelector(\'[data-install-step="1"]\').hidden && document.querySelector(\'[data-install-step="2"]\').hidden'));
expect("failed release lookup retains official download fallback", await evaluate('document.querySelector("#install-node").href === "https://nodejs.org/en/download"'));
for (const os of ["mac", "win", "linux"]) {
	await evaluate(`document.querySelector('[data-os="${os}"]').click(); document.querySelector('[data-install-next="2"]').click();`);
	const command = `${os === "win" ? "npx.cmd" : "npx"} --yes cozyclay@latest --via site`;
	expect(`${os} shows its launch command`, await evaluate(`document.querySelector("#install-command").textContent === ${JSON.stringify(command)}`));
	expect(`${os} next focuses the visible heading`, await evaluate('document.activeElement.id === "install-launch-title"'));
	expect(`${os} setup overrides landing section spacing`, await evaluate('getComputedStyle(document.querySelector(\'[data-install-step="2"]\')).paddingTop === "0px" && getComputedStyle(document.querySelector("#install details")).marginTop === "0px"'));
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
finish("install browser flow");
