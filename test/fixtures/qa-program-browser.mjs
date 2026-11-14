// Real-browser lifecycle fixture for tools/run-qa.mjs manual QA. The marker
// must be absent on every invocation, including repeated runs of this file.
import assert from "node:assert/strict";
import { appendFileSync, writeFileSync } from "node:fs";

const port = process.env.CDP_PORT;
const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const target = targets.find((entry) => entry.type === "page");
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
let id = 0;
const pending = new Map();
ws.onmessage = ({ data }) => {
	const message = JSON.parse(data);
	const request = pending.get(message.id);
	if (!request) return;
	pending.delete(message.id);
	if (message.error) request.reject(new Error(JSON.stringify(message.error)));
	else request.resolve(message.result);
};
const send = (method, params) => new Promise((resolve, reject) => {
	pending.set(++id, { resolve, reject });
	ws.send(JSON.stringify({ id, method, params }));
});
try {
	if (process.env.QA_PROGRAM_OBSERVE === "1") {
		await new Promise((resolve, reject) => {
			const finish = () => { clearTimeout(timer); resolve(); };
			const timer = setTimeout(() => {
				process.off("SIGUSR1", finish);
				reject(new Error("manual browser observation timed out"));
			}, 120000);
			process.once("SIGUSR1", finish);
			console.log(`QA_PROGRAM_READY ${process.pid}`);
		});
	}
	const { result } = await send("Runtime.evaluate", { expression: `(() => {
		const prior = localStorage.getItem('qa-program-marker');
		localStorage.setItem('qa-program-marker', 'written');
		return { prior, url: location.href };
	})()`, returnByValue: true });
	assert.equal(result.value.prior, null, "each program receives a fresh browser profile");
	assert.equal(new URL(result.value.url).pathname, "/app/");
	const image = await send("Page.captureScreenshot", { format: "png" });
	if (process.env.QA_OUT) writeFileSync(`${process.env.QA_OUT}/${target.id}.png`, Buffer.from(image.data, "base64"));
	appendFileSync(process.env.QA_PROGRAM_LOG, `${JSON.stringify({ browser: version.webSocketDebuggerUrl, target: target.id, ...result.value })}\n`);
	console.log("PASS independent page and storage lifetime");
	if (process.env.QA_PROGRAM_FAIL === "1") {
		console.error("DELIBERATE_BROWSER_PROGRAM_FAILURE");
		process.exitCode = 1;
	}
} finally {
	ws.close();
}
