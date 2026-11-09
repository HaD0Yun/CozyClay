#!/usr/bin/env node
/** Issue #123: capture_framing_png and import_asset round-trip over a real
 * local LiveHub with a fake editor socket, plus the editor-side dispatcher
 * contract from src/live-control.js. Asserts the command names round-trip
 * unchanged and the result frames carry the documented shapes. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

// ws lives in the MCP runtime tree (the root install does not ship it); the
// same resolution tools/run-tests.mjs probes before running the MCP suites.
const mcpRequire = createRequire(fileURLToPath(new URL("../mcp/package.json", import.meta.url)));
const { WebSocket } = mcpRequire("ws");
const { startLiveHub } = await import("../mcp/live-hub.mjs");
const { dispatchLiveFrame, liveControlUrl } = await import("../src/live-control.js");

const reservePort = () => new Promise((resolve, reject) => {
	const server = createServer();
	server.once("error", reject);
	server.listen(0, "127.0.0.1", () => {
		const address = server.address();
		if (!address || typeof address === "string") return reject(new Error("Could not reserve a TCP port."));
		server.close((error) => error ? reject(error) : resolve(address.port));
	});
});
const withTimeout = (promise, label, milliseconds = 10_000) => {
	let timer;
	return Promise.race([
		promise,
		new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}.`)), milliseconds); }),
	]).finally(() => clearTimeout(timer));
};

// One transparent 1x1 PNG; the canned capture answer only has to survive the
// round trip intact — the browser QA parses real IHDR bytes from the editor.
const CANNED_PNG_DATA_URL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const UNIT_CUBE_BYTES = readFileSync(new URL("./fixtures/unit-cube.glb", import.meta.url));
const UNIT_CUBE_B64 = Buffer.from(UNIT_CUBE_BYTES).toString("base64");
const CANNED_GLB_DATA_URL = `data:model/gltf-binary;base64,${UNIT_CUBE_B64}`;
const CANNED_OCTET_GLB_DATA_URL = `data:application/octet-stream;base64,${UNIT_CUBE_B64}`;
const UNIT_OBJ_BYTES = readFileSync(new URL("./fixtures/unit-cube.obj", import.meta.url));
const UNIT_OBJ_B64 = Buffer.from(UNIT_OBJ_BYTES).toString("base64");
const CANNED_OBJ_DATA_URL = `data:model/obj;base64,${UNIT_OBJ_B64}`;
const CANNED_PLAIN_OBJ_DATA_URL = `data:text/plain;base64,${UNIT_OBJ_B64}`;
const CANNED_OCTET_OBJ_DATA_URL = `data:application/octet-stream;base64,${UNIT_OBJ_B64}`;
const UNIT_FBX_BYTES = readFileSync(new URL("./fixtures/unit-cube.fbx", import.meta.url));
const UNIT_FBX_B64 = Buffer.from(UNIT_FBX_BYTES).toString("base64");
const CANNED_FBX_DATA_URL = `data:model/fbx;base64,${UNIT_FBX_B64}`;
const CANNED_PLAIN_FBX_DATA_URL = `data:text/plain;base64,${UNIT_FBX_B64}`;
const CANNED_OCTET_FBX_DATA_URL = `data:application/octet-stream;base64,${UNIT_FBX_B64}`;

const port = await reservePort();
const hub = await startLiveHub(port);
assert.ok(hub, `LiveHub should bind a reserved loopback port (got ${port})`);

const received = [];
let importFailNext = false;
const socket = new WebSocket(liveControlUrl(port));
const opened = new Promise((resolve, reject) => {
	socket.once("open", resolve);
	socket.once("error", reject);
});
socket.on("message", (raw) => {
	const frame = JSON.parse(raw.toString());
	if (frame.type === "workspace") {
		workspaceReady(frame.handle);
		return;
	}
	if (frame.type !== "cmd") return;
	received.push({ id: frame.id, name: frame.name, args: frame.args });
	const reply = (ok, body) => socket.send(JSON.stringify(
		ok ? { type: "result", id: frame.id, ok: true, value: body } : { type: "result", id: frame.id, ok: false, error: body },
	));
	if (frame.name === "capture_framing_png") {
		reply(true, {
			dataUrl: CANNED_PNG_DATA_URL,
			width: 1920,
			height: 1080,
			frame: 7,
			shotId: "shot-1",
		});
	}
	if (frame.name === "import_asset") {
		if (importFailNext) {
			importFailNext = false;
			reply(false, "The shot renderer is not ready");
			return;
		}
		const mesh = frame.args?.placeAs === "mesh";
		reply(true, {
			assetId: `${mesh ? "mesh" : "img"}-${"a".repeat(32)}`,
			objectId: mesh ? "mesh" : "cutout",
		});
	}
	if (frame.name === "update_object") {
		reply(true, { id: frame.args?.id });
	}
});
let workspaceReady;
const workspace = new Promise((resolve) => { workspaceReady = resolve; });
await withTimeout(opened, "fake editor connection");
socket.send(JSON.stringify({ type: "hello", role: "editor", version: 1, workspaceId: "verify-agent-commands" }));
const handle = await withTimeout(workspace, "workspace handshake");

// 1. capture_framing_png: the name travels to the editor untouched and the
// documented value shape comes back to the awaiting caller.
const shot = await withTimeout(hub.command("capture_framing_png", {}, handle));
assert.equal(received.length, 1, "the fake editor should have received exactly one command");
assert.equal(received[0].name, "capture_framing_png");
assert.deepEqual(received[0].args, {});
assert.deepEqual(Object.keys(shot).sort(), ["dataUrl", "frame", "height", "shotId", "width"]);
assert.equal(shot.width, 1920);
assert.equal(shot.height, 1080);
assert.equal(shot.dataUrl, CANNED_PNG_DATA_URL, "the data URL must survive the round trip byte-for-byte");
assert.equal(shot.frame, 7);
assert.equal(shot.shotId, "shot-1");

// 2. import_asset: every argument the caller sends arrives whole at the
// editor, and the result names the asset and the placed object.
const importArgs = {
	name: "QA Card.png",
	mimeType: "image/png",
	dataUrl: CANNED_PNG_DATA_URL,
	placeAs: "cutout",
};
const placed = await withTimeout(hub.command("import_asset", importArgs, handle));
assert.equal(received.length, 2);
assert.equal(received[1].name, "import_asset");
assert.deepEqual(received[1].args, importArgs, "import_asset arguments must round-trip unchanged");
assert.deepEqual(Object.keys(placed).sort(), ["assetId", "objectId"]);
assert.equal(placed.assetId, `img-${"a".repeat(32)}`);
assert.equal(placed.objectId, "cutout");

// 3. backdrop placement is part of the documented arg domain.
const backdrop = await withTimeout(hub.command("import_asset", { ...importArgs, placeAs: "backdrop" }, handle));
assert.deepEqual(received[2].args, { ...importArgs, placeAs: "backdrop" });
assert.deepEqual(Object.keys(backdrop).sort(), ["assetId", "objectId"]);

// 4. An editor rejection surfaces as a failed command, never as silence.
importFailNext = true;
await assert.rejects(
	() => withTimeout(hub.command("import_asset", importArgs, handle)),
	/The shot renderer is not ready/,
);
assert.equal(received.length, 4, "the rejected command still reached the editor");

// 5. Mesh placement is the same command with a GLB data URL — wallpaper stays
// rejected. clay: true has to arrive untouched so the editor can pass it to
// createMeshObject without a second round-trip.
assert.ok(CANNED_GLB_DATA_URL.startsWith("data:model/gltf-binary;base64,"));
const meshImportArgs = {
	name: "unit-cube.glb",
	mimeType: "model/gltf-binary",
	dataUrl: CANNED_GLB_DATA_URL,
	placeAs: "mesh",
	clay: true,
};
const meshPlaced = await withTimeout(hub.command("import_asset", meshImportArgs, handle));
assert.equal(received.length, 5);
assert.equal(received[4].name, "import_asset");
assert.deepEqual(received[4].args, meshImportArgs, "mesh import_asset arguments must round-trip unchanged, including clay");
assert.deepEqual(Object.keys(meshPlaced).sort(), ["assetId", "objectId"]);
assert.equal(meshPlaced.assetId, `mesh-${"a".repeat(32)}`);
assert.equal(meshPlaced.objectId, "mesh");

const octetImportArgs = {
	name: "cooker.glb",
	mimeType: "application/octet-stream",
	dataUrl: CANNED_OCTET_GLB_DATA_URL,
	placeAs: "mesh",
};
const octetPlaced = await withTimeout(hub.command("import_asset", octetImportArgs, handle));
assert.deepEqual(received[5].args, octetImportArgs, "octet-stream GLB dataUrls round-trip as mesh imports");
assert.deepEqual(Object.keys(octetPlaced).sort(), ["assetId", "objectId"]);

const objImportArgs = {
	name: "unit-cube.obj",
	mimeType: "model/obj",
	dataUrl: CANNED_OBJ_DATA_URL,
	placeAs: "mesh",
};
const objPlaced = await withTimeout(hub.command("import_asset", objImportArgs, handle));
assert.deepEqual(received[6].args, objImportArgs, "model/obj dataUrls round-trip as mesh imports");
assert.equal(objPlaced.assetId, `mesh-${"a".repeat(32)}`);

const plainObjImportArgs = {
	name: "unit-cube.obj",
	mimeType: "text/plain",
	dataUrl: CANNED_PLAIN_OBJ_DATA_URL,
	placeAs: "mesh",
};
assert.deepEqual((await withTimeout(hub.command("import_asset", plainObjImportArgs, handle))) && received[7].args, plainObjImportArgs, "text/plain OBJ dataUrls round-trip as mesh imports");

const octetObjImportArgs = {
	name: "unit-cube.obj",
	mimeType: "application/octet-stream",
	dataUrl: CANNED_OCTET_OBJ_DATA_URL,
	placeAs: "mesh",
};
assert.deepEqual((await withTimeout(hub.command("import_asset", octetObjImportArgs, handle))) && received[8].args, octetObjImportArgs, "octet-stream OBJ dataUrls round-trip as mesh imports");

const fbxImportArgs = {
	name: "unit-cube.fbx",
	mimeType: "model/fbx",
	dataUrl: CANNED_FBX_DATA_URL,
	placeAs: "mesh",
};
assert.deepEqual((await withTimeout(hub.command("import_asset", fbxImportArgs, handle))) && received[9].args, fbxImportArgs, "model/fbx dataUrls round-trip as mesh imports");

const octetFbxImportArgs = {
	name: "unit-cube.fbx",
	mimeType: "application/octet-stream",
	dataUrl: CANNED_OCTET_FBX_DATA_URL,
	placeAs: "mesh",
};
assert.deepEqual((await withTimeout(hub.command("import_asset", octetFbxImportArgs, handle))) && received[10].args, octetFbxImportArgs, "octet-stream FBX dataUrls round-trip as mesh imports");

const plainFbxImportArgs = {
	name: "unit-cube.fbx",
	mimeType: "text/plain",
	dataUrl: CANNED_PLAIN_FBX_DATA_URL,
	placeAs: "mesh",
};
assert.deepEqual((await withTimeout(hub.command("import_asset", plainFbxImportArgs, handle))) && received[11].args, plainFbxImportArgs, "text/plain FBX dataUrls round-trip as mesh imports");

const posedMeshArgs = {
	name: "unit-cube.glb",
	mimeType: "model/gltf-binary",
	dataUrl: CANNED_GLB_DATA_URL,
	placeAs: "mesh",
	x: 2,
	z: -1,
	y: 0.1,
	rot: 30,
	height: 0.5,
};
assert.deepEqual((await withTimeout(hub.command("import_asset", posedMeshArgs, handle))) && received[12].args, posedMeshArgs, "optional mesh pose fields round-trip on import_asset");

const updateArgs = { id: "mesh", height: 0.5, clay: true };
const updated = await withTimeout(hub.command("update_object", updateArgs, handle));
assert.equal(received[13].name, "update_object");
assert.deepEqual(received[13].args, updateArgs, "update_object height and clay must round-trip unchanged");
assert.deepEqual(updated, { id: "mesh" });

// 6. The editor half of the same contract: dispatchLiveFrame must answer both
// names with the documented result frames, success and failure alike.
const editorHandlers = {
	capture_framing_png: () => ({ dataUrl: CANNED_PNG_DATA_URL, width: 1920, height: 1080, frame: 0, shotId: null }),
	import_asset: async (args) => {
		if (args.placeAs !== "cutout" && args.placeAs !== "backdrop" && args.placeAs !== "mesh") {
			throw new Error('placeAs must be "cutout", "backdrop" or "mesh"');
		}
		if (args.placeAs === "mesh") return { assetId: `mesh-${"b".repeat(32)}`, objectId: "mesh" };
		return { assetId: `img-${"b".repeat(32)}`, objectId: "cutout-2" };
	},
	update_object: async (args) => ({ id: args.id }),
};
const okCapture = await dispatchLiveFrame(
	JSON.stringify({ type: "cmd", id: "c1", name: "capture_framing_png", args: {} }),
	editorHandlers,
);
assert.deepEqual(okCapture, {
	type: "result", id: "c1", ok: true,
	value: { dataUrl: CANNED_PNG_DATA_URL, width: 1920, height: 1080, frame: 0, shotId: null },
});
const okImport = await dispatchLiveFrame(
	JSON.stringify({ type: "cmd", id: "c2", name: "import_asset", args: { name: "x.png", dataUrl: CANNED_PNG_DATA_URL, placeAs: "backdrop" } }),
	editorHandlers,
);
assert.deepEqual(okImport, {
	type: "result", id: "c2", ok: true,
	value: { assetId: `img-${"b".repeat(32)}`, objectId: "cutout-2" },
});
const badImport = await dispatchLiveFrame(
	JSON.stringify({ type: "cmd", id: "c3", name: "import_asset", args: { name: "x.png", dataUrl: CANNED_PNG_DATA_URL, placeAs: "wallpaper" } }),
	editorHandlers,
);
assert.deepEqual(badImport, { type: "result", id: "c3", ok: false, error: 'placeAs must be "cutout", "backdrop" or "mesh"' });
const okMesh = await dispatchLiveFrame(
	JSON.stringify({
		type: "cmd",
		id: "c4",
		name: "import_asset",
		args: { name: "unit-cube.glb", mimeType: "model/gltf-binary", dataUrl: CANNED_GLB_DATA_URL, placeAs: "mesh", clay: true },
	}),
	editorHandlers,
);
assert.deepEqual(okMesh, {
	type: "result", id: "c4", ok: true,
	value: { assetId: `mesh-${"b".repeat(32)}`, objectId: "mesh" },
});
const okOctet = await dispatchLiveFrame(
	JSON.stringify({
		type: "cmd",
		id: "c5",
		name: "import_asset",
		args: { name: "cooker.glb", mimeType: "application/octet-stream", dataUrl: CANNED_OCTET_GLB_DATA_URL, placeAs: "mesh" },
	}),
	editorHandlers,
);
assert.deepEqual(okOctet, {
	type: "result", id: "c5", ok: true,
	value: { assetId: `mesh-${"b".repeat(32)}`, objectId: "mesh" },
});
const okObj = await dispatchLiveFrame(
	JSON.stringify({
		type: "cmd",
		id: "c5b",
		name: "import_asset",
		args: { name: "unit-cube.obj", mimeType: "model/obj", dataUrl: CANNED_OBJ_DATA_URL, placeAs: "mesh" },
	}),
	editorHandlers,
);
assert.deepEqual(okObj, {
	type: "result", id: "c5b", ok: true,
	value: { assetId: `mesh-${"b".repeat(32)}`, objectId: "mesh" },
});
const okFbx = await dispatchLiveFrame(
	JSON.stringify({
		type: "cmd",
		id: "c5c",
		name: "import_asset",
		args: { name: "unit-cube.fbx", mimeType: "model/fbx", dataUrl: CANNED_FBX_DATA_URL, placeAs: "mesh" },
	}),
	editorHandlers,
);
assert.deepEqual(okFbx, {
	type: "result", id: "c5c", ok: true,
	value: { assetId: `mesh-${"b".repeat(32)}`, objectId: "mesh" },
});
const okUpdate = await dispatchLiveFrame(
	JSON.stringify({ type: "cmd", id: "c6", name: "update_object", args: { id: "mesh", height: 0.5, clay: true } }),
	editorHandlers,
);
assert.deepEqual(okUpdate, { type: "result", id: "c6", ok: true, value: { id: "mesh" } });

// Tear the client down hard before the server: on Linux the WebSocketServer
// never emits "close" while a client is still draining its close handshake,
// so a polite socket.close() here timed out in CI.
const socketClosed = new Promise((resolve) => socket.once("close", resolve));
socket.terminate();
await withTimeout(socketClosed, "fake editor socket close");
for (const client of hub.server.clients) client.terminate();
await withTimeout(new Promise((resolve) => hub.server.close(() => resolve())), "hub close");

const protocol = readFileSync(new URL("../mcp/LIVE-PROTOCOL.md", import.meta.url), "utf8");
assert.match(protocol, /data:model\/fbx/, "LIVE-PROTOCOL documents FBX mesh data URLs");
assert.match(protocol, /glTF magic first, then FBX/, "LIVE-PROTOCOL documents sniff order glTF then FBX then OBJ");
assert.match(protocol, /x\?, y\?, z\?, rot\?, height\?/, "LIVE-PROTOCOL documents optional mesh pose on import_asset");
assert.match(protocol, /missing axis is 0/, "LIVE-PROTOCOL documents partial floor pose");

console.log("PASS verify-live-agent-commands: capture_framing_png + import_asset (cutout/backdrop/mesh) round-trip, shapes, rejection path, editor dispatch");
