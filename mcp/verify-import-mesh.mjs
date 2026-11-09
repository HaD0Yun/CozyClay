#!/usr/bin/env node
/** import_mesh: path in, admitted asset.import out — the model never sees bytes. */
import assert from "node:assert/strict";
import { closeSync, copyFileSync, ftruncateSync, mkdirSync, openSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { mcpToolCategory } from "../src/execution-telemetry.js";
import { ASSET_MAX_SOURCE_BYTES } from "../src/scene-assets.js";
import { createToolHandlers, setLiveHub } from "./tool-handlers.mjs";
import { normalizeMeshPath } from "./mesh-file.mjs";

const fixture = (name) => fileURLToPath(new URL(`../test/fixtures/${name}`, import.meta.url));
const glbPath = fixture("unit-cube.glb");
const objPath = fixture("unit-cube.obj");
const fbxPath = fixture("unit-cube.fbx");

const abs = resolve(tmpdir(), "stove.glb");
assert.equal(normalizeMeshPath(abs), abs);
assert.equal(normalizeMeshPath(pathToFileURL(abs).href), abs);
assert.equal(normalizeMeshPath("~/Downloads/stove.glb", { home: "/home/tester" }), resolve("/home/tester", "Downloads", "stove.glb"));
assert.equal(normalizeMeshPath("~other/foo", { home: "/home/tester" }), resolve("~other/foo"));
assert.equal(mcpToolCategory("import_mesh"), "scene_write");

const commands = [];
const host = { workspaceId: "workspace", documentEpoch: "document", sceneId: "scene", sceneEpoch: "epoch" };
let revision = 0;
const hub = {
	connected: true,
	command: async (name, args, _workspace, options) => {
		commands.push({ name, args });
		if (name === "inspect_studio") {
			assert.deepEqual(args, { scope: "actions", ids: ["asset.import"] });
			return { context: { host, revision: { scene: revision } }, actions: [{ id: "asset.import", timeoutMs: 30_000 }] };
		}
		assert.equal(name, "run_action", `unexpected live command ${name}`);
		assert.equal(commands.at(-2)?.name, "inspect_studio", "inspect before admission");
		assert.equal(args.name, "run_action");
		assert.equal(args.args.action, "asset.import");
		assert.deepEqual(args.host, host);
		assert.equal(args.expectedRevision, revision);
		assert.equal(options.timeoutMs, 30_000);
		const before = revision++;
		return { ok: true, status: "completed", kind: "job", action: "asset.import", commandId: args.commandId,
			receiptId: `receipt-${revision}`, host, authored: true, revision: { before, after: revision },
			affectedIds: ["mesh"], delta: [{ id: "mesh", after: { name: args.args.args.name } }], checks: {}, warnings: [],
			undo: { historyEntryId: `history-${revision}`, entries: 1, canUndoDirect: true },
			output: { assetId: `mesh-${"a".repeat(32)}`, objectId: "mesh" } };
	},
};
setLiveHub(hub);
const isImport = entry => entry.name === "run_action" && entry.args.args.action === "asset.import";
const imports = () => commands.filter(isImport).map(entry => ({ ...entry, args: entry.args.args.args }));

const tools = createToolHandlers({});
const importMesh = tools.find((tool) => tool.name === "import_mesh");
assert.ok(importMesh, "import_mesh is registered");
assert.equal(importMesh.live, true);
assert.equal(importMesh.annotations.openWorldHint, true);
assert.equal(importMesh.annotations.idempotentHint, false);
assert.match(importMesh.description, /^Unlike place_object, import_mesh /);

const placed = await importMesh.handler({ path: glbPath });
assert.equal(placed.isError, undefined, placed.content?.[0]?.text);
const placedText = placed.content[0].text;
assert.match(placedText, /mesh/);
assert.equal(placedText.includes("data:"), false, "tool result must not carry a data URL");
assert.equal(placedText.includes(Buffer.from("glTF").toString("base64")), false, "tool result must not carry file bytes");
const meshCmds = imports();
assert.equal(meshCmds.length, 1, "exactly one admitted asset.import");
assert.equal(meshCmds[0].args.placeAs, "mesh");
assert.equal(meshCmds[0].args.mimeType, "model/gltf-binary");
assert.match(meshCmds[0].args.source, /^data:model\/gltf-binary;base64,/);
assert.equal("clay" in meshCmds[0].args, false);
assert.equal("x" in meshCmds[0].args, false);
assert.equal("z" in meshCmds[0].args, false);

commands.length = 0;
const posed = await importMesh.handler({ path: objPath, x: 2, facing: 30, height: 0.5, y: 0.2, clay: true, name: "Kocher" });
assert.equal(posed.isError, undefined, posed.content?.[0]?.text);
const poseCmd = imports()[0];
assert.equal(poseCmd.args.mimeType, "model/obj");
assert.equal(poseCmd.args.x, 2);
assert.equal(poseCmd.args.z, 0);
assert.equal(poseCmd.args.y, 0.2);
assert.equal(poseCmd.args.rot, 30);
assert.equal(poseCmd.args.height, 0.5);
assert.equal(poseCmd.args.clay, true);
assert.equal(poseCmd.args.name, "Kocher");

commands.length = 0;
const heightOnly = await importMesh.handler({ path: glbPath, height: 0.8 });
assert.equal(heightOnly.isError, undefined, heightOnly.content?.[0]?.text);
const heightCmd = imports()[0];
assert.equal(heightCmd.args.height, 0.8);
assert.equal("x" in heightCmd.args, false);
assert.equal("z" in heightCmd.args, false);

commands.length = 0;
await importMesh.handler({ path: glbPath, clay: false });
assert.equal("clay" in imports()[0].args, false);

commands.length = 0;
const fbx = await importMesh.handler({ path: fbxPath });
assert.equal(fbx.isError, undefined, fbx.content?.[0]?.text);
assert.equal(imports()[0]?.args.mimeType, "model/fbx");

commands.length = 0;
const viaUri = await importMesh.handler({ path: `file://${glbPath}` });
assert.equal(viaUri.isError, undefined, viaUri.content?.[0]?.text);

const tildeName = `.cozyclay-import-mesh-${process.pid}.glb`;
const tildeAbs = join(homedir(), tildeName);
copyFileSync(glbPath, tildeAbs);
try {
	commands.length = 0;
	const viaTilde = await importMesh.handler({ path: `~/${tildeName}` });
	assert.equal(viaTilde.isError, undefined, viaTilde.content?.[0]?.text);
	assert.equal(commands.some(isImport), true);
} finally {
	unlinkSync(tildeAbs);
}

setLiveHub(null);
const offline = await importMesh.handler({ path: glbPath });
assert.equal(offline.isError, true);
assert.match(offline.content[0].text, /import_mesh requires a connected CozyClay editor/i);

setLiveHub(hub);
commands.length = 0;
const missing = await importMesh.handler({ path: join(tmpdir(), "no-such-cozyclay-mesh.glb") });
assert.equal(missing.isError, true);
assert.equal(commands.some(isImport), false);
assert.equal(/glTF|Kaydara|v 0/.test(missing.content[0].text), false);

const txt = join(tmpdir(), `cozy-mesh-${process.pid}.txt`);
writeFileSync(txt, "hello world\n");
commands.length = 0;
const rejectedTxt = await importMesh.handler({ path: txt });
assert.equal(rejectedTxt.isError, true);
assert.equal(commands.some(isImport), false);
unlinkSync(txt);

const oldFbx = join(tmpdir(), `cozy-mesh-old-${process.pid}.fbx`);
writeFileSync(oldFbx, "; FBX 6.1.0 project file\nFBXVersion: 6100\n");
commands.length = 0;
const rejectedOld = await importMesh.handler({ path: oldFbx });
assert.equal(rejectedOld.isError, true);
assert.equal(commands.some(isImport), false);
unlinkSync(oldFbx);

const oversized = join(tmpdir(), `cozy-mesh-oversize-${process.pid}.bin`);
const fd = openSync(oversized, "w");
ftruncateSync(fd, ASSET_MAX_SOURCE_BYTES + 1);
closeSync(fd);
commands.length = 0;
const rejectedSize = await importMesh.handler({ path: oversized });
assert.equal(rejectedSize.isError, true);
assert.equal(commands.some(isImport), false);
unlinkSync(oversized);

const dir = join(tmpdir(), `cozy-mesh-dir-${process.pid}`);
mkdirSync(dir, { recursive: true });
commands.length = 0;
const rejectedDir = await importMesh.handler({ path: dir });
assert.equal(rejectedDir.isError, true);
assert.equal(commands.some(isImport), false);

const linkPath = join(tmpdir(), `cozy-mesh-link-${process.pid}.glb`);
// Windows creates symlinks only with Developer Mode or elevation.
let linked = true;
try {
	symlinkSync(glbPath, linkPath);
} catch (error) {
	if (process.platform !== "win32" || error.code !== "EPERM") throw error;
	linked = false;
	console.log("SKIP symlink rejection: this Windows account cannot create symlinks");
}
if (linked) {
	try {
		commands.length = 0;
		const rejectedLink = await importMesh.handler({ path: linkPath });
		assert.equal(rejectedLink.isError, true);
		assert.equal(commands.some(isImport), false);
	} finally {
		try { unlinkSync(linkPath); } catch {}
	}
}

setLiveHub(null);
console.log("PASS verify-import-mesh: path in, admitted asset.import out, pose, rejections");
