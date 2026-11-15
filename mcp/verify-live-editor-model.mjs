#!/usr/bin/env node
/** Real-editor regressions: add_character preserves an explicit mannequin model,
 * and frame_shot aims the editor's shot camera at the subject it framed. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";

import { chromeArgs, resolveChromePath, seedCharacterStage } from "./qa-chrome.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const serverPath = fileURLToPath(new URL("./server.mjs", import.meta.url));

const reservePort = () =>
	new Promise((resolve, reject) => {
		const server = createServer();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (!address || typeof address === "string") {
				reject(new Error("Could not reserve a TCP port."));
				return;
			}
			server.close((error) => (error ? reject(error) : resolve(address.port)));
		});
	});

const withTimeout = (promise, label, milliseconds = 30_000) => {
	let timer;
	return Promise.race([
		promise,
		new Promise((_, reject) => {
			timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}.`)), milliseconds);
		}),
	]).finally(() => clearTimeout(timer));
};

const waitForOutput = (child, pattern, label) =>
	withTimeout(
		new Promise((resolve, reject) => {
			let output = "";
			const inspect = (chunk) => {
				// picocolors turns colour ON when CI is set even without a TTY, and
				// the port lands inside bold escapes ("...127.0.0.1:\x1b[1m5599...")
				// — strip ANSI before matching or the ready banner never matches
				// on a GitHub runner while passing everywhere locally.
				output += chunk.toString().replace(/\u001b\[[0-9;]*m/g, "");
				if (pattern.test(output)) finish(resolve);
			};
			const onExit = (code, signal) => finish(reject, new Error(`${label} exited (${code ?? signal ?? "unknown"}): ${output}`));
			const finish = (callback, value) => {
				child.stdout.off("data", inspect);
				child.stderr.off("data", inspect);
				child.off("exit", onExit);
				callback(value);
			};
			child.stdout.on("data", inspect);
			child.stderr.on("data", inspect);
			child.once("exit", onExit);
		}),
		label,
	);

const terminate = async (child) => {
	if (!child || child.exitCode !== null || child.signalCode !== null) return;
	const exited = new Promise((resolve) => child.once("exit", resolve));
	child.kill("SIGTERM");
	await withTimeout(exited, "child cleanup", 5_000).catch(() => child.kill("SIGKILL"));
};

const vitePort = Number(process.env.QA_VITE_PORT) || await reservePort();
const livePort = Number(process.env.COZYCLAY_LIVE_PORT) || await reservePort();
const cdpPort = Number(process.env.CDP_PORT) || await reservePort();
const vite = spawn(process.execPath, ["node_modules/vite/bin/vite.js", "--host", "127.0.0.1", "--port", String(vitePort), "--strictPort"], {
	cwd: root,
	env: { ...process.env, COZYCLAY_LIVE_PORT: String(livePort) },
	stdio: ["ignore", "pipe", "pipe"],
});
const browser = spawn(resolveChromePath(), chromeArgs(cdpPort), { stdio: ["ignore", "pipe", "pipe"] });
let socket;
let client;
try {
	await waitForOutput(vite, new RegExp(`http://127\\.0\\.0\\.1:${vitePort}/`), "Vite");
	const devtools = await waitForOutput(browser, /DevTools listening on (ws:\/\/[^\s]+)/, "Chrome");
	void devtools;
	const targets = await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json();
	const page = targets.find((target) => target.type === "page" && target.webSocketDebuggerUrl);
	if (!page) throw new Error("Chrome did not expose a page target.");

	socket = new WebSocket(page.webSocketDebuggerUrl);
	await withTimeout(new Promise((resolve, reject) => {
		socket.addEventListener("open", resolve, { once: true });
		socket.addEventListener("error", reject, { once: true });
	}), "CDP connection");
	let nextId = 1;
	const pending = new Map();
	let liveHello;
	let xBotDescribed;
	const editorFrames = [];
	const editorHello = new Promise((resolve) => {
		liveHello = resolve;
	});
	const xBotDescription = new Promise((resolve) => {
		xBotDescribed = resolve;
	});
	socket.addEventListener("message", (event) => {
		const frame = JSON.parse(event.data);
		if (frame.method === "Network.webSocketFrameSent") {
			const payload = frame.params.response.payloadData;
			try {
				const editorFrame = JSON.parse(payload);
				editorFrames.push(editorFrame);
				if (editorFrame.type === "hello" && editorFrame.role === "editor") liveHello();
				if (editorFrame.type === "result" && editorFrame.value?.characters?.some((character) => character.model === "x-bot-tpose")) xBotDescribed();
			} catch {
				// CDP control responses are handled below; non-JSON payloads are not protocol frames.
			}
		}
		if (frame.id && pending.has(frame.id)) {
			const { resolve, reject } = pending.get(frame.id);
			pending.delete(frame.id);
			if (frame.error) reject(new Error(JSON.stringify(frame.error)));
			else resolve(frame.result);
			return;
		}
	});
	const send = (method, params = {}) =>
		new Promise((resolve, reject) => {
			const id = nextId++;
			pending.set(id, { resolve, reject });
			socket.send(JSON.stringify({ id, method, params }));
		});
	// Reads a value out of the page; the expression may resolve a promise, which
	// is how the assertions below wait for rendered state instead of a sleep.
	const evaluate = async (expression, label) => {
		const response = await withTimeout(send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }), label);
		if (response.exceptionDetails) throw new Error(`${label}: ${response.exceptionDetails.text}`);
		return response.result.value;
	};
	await send("Network.enable");
	// Requests paused by the Fetch domain (enabled before navigation, only for
	// the x-bot mesh) collect here until the suite releases them.
	const heldModelRequests = [];
	let resolveXBotInterception;
	const xBotInterception = new Promise((resolve) => {
		resolveXBotInterception = resolve;
	});
	socket.addEventListener("message", (event) => {
		const frame = JSON.parse(event.data);
		if (frame.method === "Fetch.requestPaused") {
			const responseStage = Number.isInteger(frame.params.responseStatusCode);
			heldModelRequests.push({ requestId: frame.params.requestId, responseStage });
			resolveXBotInterception();
		}
	});
	await send("Fetch.enable", { patterns: [{ urlPattern: "*/models/x-bot-tpose.fbx*", requestStage: "Response" }] });
	await send("Page.enable");
	await seedCharacterStage(send); await send("Page.navigate", { url: `http://127.0.0.1:${vitePort}/app/` });

	client = new Client({ name: "cozyclay-live-editor-model-verify", version: "1.0.0" });
	await client.connect(new StdioClientTransport({ command: process.execPath, args: [serverPath, "--live-port", String(livePort)] }));
	await withTimeout(editorHello, "editor live hello");

	// The shot camera mounts with the R3F canvas, a few frames after the live
	// socket says hello. Wait for the renderer the editor itself announces, then
	// for the QA snapshot that publishes the camera object the assertions read.
	await evaluate(
		`window.__cozyclayMcpCaptureReady ? true : new Promise((resolve) => window.addEventListener('cozyclay:mcp-capture-ready', () => resolve(true), { once: true }))`,
		"shot renderer readiness",
	);
	await evaluate(
		`new Promise((resolve) => {
			const wait = () => (window.__cozyclay?.shotCam ? resolve(true) : requestAnimationFrame(wait));
			wait();
		})`,
		"shot camera mount",
	);

	// Initial rig hydration can publish authored cast state after the canvas
	// mounts. Admit the first edit only once that exact rig is ready.
	await evaluate(
		`window.__cozyclayMcpRigReady?.includes('char-a') ? true : new Promise(resolve => window.addEventListener('cozyclay:mcp-rig-ready', event => event.detail === 'char-a' && resolve(true)))`,
		"initial character rig readiness",
	);

	// Author a shot camera while the canvas is mounted, so framing has a camera to
	// read while the held x-bot download suspends the canvas below.
	const camera = await client.callTool({ name: "set_camera", arguments: { x: 0, y: 1.6, z: 6, focal_mm: 35, look_at_x: 0, look_at_y: 1.3, look_at_z: 0 } });
	assert.equal(camera.isError, undefined, JSON.stringify(camera));

	// From here the x-bot mesh is held at the network layer until this suite
	// releases it. A cast model that is still downloading suspends the R3F
	// scene graph and remounts every sibling rig when it resolves; that order is
	// exactly what a slow runner produces by accident, so it is produced here
	// on purpose to prove a shot framed in the meantime survives it (#86).
	// Given the actual browser editor is connected over its live WebSocket
	// When MCP adds an explicit non-default mannequin
	const added = await client.callTool({
		name: "add_character",
		arguments: { subject: "an x-bot performer", model: "x-bot-tpose" },
	});
	await withTimeout(xBotInterception, "x-bot mesh request interception", 5_000);
	const described = await client.callTool({ name: "describe_scene", arguments: {} });
	// Then the real editor loads and reports X Bot through the live describe frame.
	assert.equal(added.isError, undefined, JSON.stringify({ added, editorFrames }));
	// MCP and CDP use independent sockets: the tool response can arrive before
	// Network.webSocketFrameSent reports the editor's matching result (#612).
	await withTimeout(xBotDescription, "editor describe frame for x-bot");
	const describedFrames = editorFrames.filter((frame) => frame.type === "result" && frame.value?.characters);
	assert.ok(describedFrames.some((frame) => frame.value.characters.some((character) => character.model === "x-bot-tpose")), JSON.stringify(describedFrames));
	assert.match(described.content[0].text, /\[x-bot-tpose\]/, described.content[0].text);

	// Given a subject parked well off the origin, so an unaimed camera cannot
	// accidentally still contain it
	// When frame_shot orbits the real editor's shot camera to a profile view
	// Then the editor points the lens it just moved at the framing pivot. This
	// gates the fix without pixels: frame_shot used to send position only, and the
	// editor kept whatever orientation the last gesture left, so every view except
	// `front` lost the subject while the slate still read "98% of frame height".
	const subject = { x: -2.5, z: 1.75 };
	const FRAMING_PIVOT_Y = 1.3; // src/shot.js: the height every shot is measured to
	// The shot camera mounts with the R3F canvas, a few frames after the live
	// socket says hello, and a set_camera that lands first only updates React
	// state. Wait for the renderer the editor itself announces, then for the QA
	// snapshot that publishes the camera object this assertion reads.
	const placed = await client.callTool({ name: "place_character", arguments: { character: "A", x: subject.x, z: subject.z, facing: 25 } });
	assert.equal(placed.isError, undefined, JSON.stringify(placed));
	// The x-bot added above left the editor selecting it, and the shot is framed
	// on the selected character — pin the framing back to the one that moved.
	const focused = await client.callTool({ name: "focus_character", arguments: { character: "A" } });
	assert.equal(focused.isError, undefined, JSON.stringify(focused));
	const framed = await client.callTool({ name: "frame_shot", arguments: { size: "medium shot", view: "profile", level: "eye", side: "right", focal_mm: 35 } });
	assert.equal(framed.isError, undefined, JSON.stringify(framed));
	// The x-bot mesh is still in flight, so the Canvas is suspended and the
	// frame_shot above landed while the shot camera object was unmounted.
	// Release the download and wait for the scene to remount around the new rig
	// before reading anything: the suite must see what a user sees next.
	assert.ok(heldModelRequests.length > 0, "the x-bot mesh request was not intercepted, so the suspended-canvas case did not run");
	const lateRigReady = evaluate(
		`(window.__cozyclayMcpRigReady ?? []).length >= 2 ? true : new Promise((resolve) => window.addEventListener('cozyclay:mcp-rig-ready', () => resolve(true), { once: true }))`,
		"late rig ready",
	);
	for (const { requestId, responseStage } of heldModelRequests) {
		await send(responseStage ? "Fetch.continueResponse" : "Fetch.continueRequest", { requestId });
	}
	await send("Fetch.disable");
	await withTimeout(lateRigReady, "x-bot rig mount", 20_000);
	// Then until the shot camera holds still for two frames (at most a second): the
	// remount's effects run, the QA snapshot publishes the remounted camera, and the
	// camera keys frame_shot wrote reach it one render after the rig is ready.
	await evaluate(`new Promise((resolve) => {
		let last = null, still = 0, frames = 0;
		const step = () => {
			const cam = window.__cozyclay?.shotCam, now = cam ? cam.position.toArray().join(",") : null;
			still = now !== null && now === last ? still + 1 : 0;
			last = now;
			if (still >= 2 || ++frames > 60) resolve(true);
			else requestAnimationFrame(step);
		};
		requestAnimationFrame(step);
	})`, "post-remount settle");
	const aim = await evaluate(
		`(() => {
			const cam = window.__cozyclay.shotCam;
			cam.updateMatrixWorld();
			// Column 2 of the world matrix is the camera's local +Z, and three.js
			// cameras look down -Z, so the lens axis is its negation.
			const m = cam.matrixWorld.elements;
			const scale = Math.hypot(m[8], m[9], m[10]) || 1;
			return {
				position: { x: cam.position.x, y: cam.position.y, z: cam.position.z },
				forward: { x: -m[8] / scale, y: -m[9] / scale, z: -m[10] / scale },
			};
		})()`,
		"shot camera orientation",
	);
	const toPivot = { x: subject.x - aim.position.x, y: FRAMING_PIVOT_Y - aim.position.y, z: subject.z - aim.position.z };
	const length = Math.hypot(toPivot.x, toPivot.y, toPivot.z);
	const dot = (aim.forward.x * toPivot.x + aim.forward.y * toPivot.y + aim.forward.z * toPivot.z) / Math.max(length, 1e-6);
	const offAxisDeg = (Math.acos(Math.min(1, Math.max(-1, dot))) * 180) / Math.PI;
	assert.ok(length > 0.5, `frame_shot parked the lens on the pivot: ${JSON.stringify(aim)}`);
	assert.ok(offAxisDeg < 2, `frame_shot left the shot camera pointing ${offAxisDeg.toFixed(1)}deg off the subject: ${JSON.stringify(aim)}`);

	console.log(JSON.stringify({
		vitePort,
		livePort,
		model: "x-bot-tpose",
		editorDescribeReportedModel: true,
		mcpDescribeReportedModel: /\[x-bot-tpose\]/.test(described.content[0].text),
		frameShotProfileOffAxisDeg: Number(offAxisDeg.toFixed(3)),
		framedWhileCanvasSuspended: true,
	}));
} finally {
	socket?.close();
	await client?.close().catch(() => {});
	await Promise.all([terminate(browser), terminate(vite)]);
}
