#!/usr/bin/env node
/** Live scene parity uses the real scene owner and receipts, not load_scenes
 * acknowledgements. The fixture's socket close is the headless-mode fence. */
import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { createSceneObject } from "../src/scene-objects.js";
import { createToolHandlers, state } from "./tool-handlers.mjs";
import { studio, receipt } from "./verify-live.mjs";

const cwd = process.cwd();
const root = await realpath(await mkdtemp(join(tmpdir(), "cozyclay-scene-parity-")));
const s = await studio({ projectRoot: root });
let closed = false;
try {
	process.chdir(root);
	const objects = Array.from({ length: 51 }, (_, i) => ({ ...createSceneObject("cube"), id: `cube-${i + 1}`, name: `Cube ${i + 1}`, x: i }));
	assert.equal((await s.f.run("objects.replace", { objects })).ok, true);
	const bounded = await s.call("describe_scene", { object_cursor: 0, limit: 50 });
	assert.match(bounded.content[0].text, /SET \(total: 51, returned: 50, truncated: true, revision: [a-f0-9]+\)/);
	assert.doesNotMatch(bounded.content[0].text, /cube-51/);
	const remainder = await s.call("describe_scene", { object_cursor: 50, limit: 50 });
	assert.match(remainder.content[0].text, /SET \(total: 51, returned: 1, truncated: false, revision: [a-f0-9]+\)/);
	assert.match(remainder.content[0].text, /cube-51/);

	const described = bounded.content[0].text;
	assert.doesNotMatch(described, /previsMode/);
	assert.match(described, /model: y-bot-tpose  kind: rig/);
	const before = s.describe().document;
	const refused = await s.call("add_scene", { name: "REFUSED", expectedRevision: s.f.binding.refresh().revision + 1 });
	assert.equal(refused.isError, true);
	assert.equal(JSON.parse(refused.content[0].text).code, "STALE_SCENE");
	assert.deepEqual(s.describe().document, before);
	const added = await s.call("add_scene", { name: "LIVE SECOND" });
	receipt(added, "scene.create");
	const named = JSON.parse(added.content[1].text);
	assert.equal(named.action, "scene.rename"); assert.equal(named.ok, true);
	const path = join(root, "live-scenes.cclayproject");
	const saved = await s.call("save_project", { path });
	assert.equal(saved.isError, undefined, JSON.stringify(saved));
	const serverDocument = JSON.parse(await readFile(path, "utf8")).scenes;
	assert.deepEqual(serverDocument.scenes.map(({ id, name }) => ({ id, name })), s.describe().document.scenes.map(({ id, name }) => ({ id, name })));
	receipt(await s.call("switch_scene", { name: "First" }), "scene.switch");
	assert.equal(s.f.scope.activeSceneIdRef.current, "scene");
	await s.call("describe_scene");
	await s.close(); closed = true;

	const tools = createToolHandlers({ projectRootPromise: Promise.resolve(root) });
	const call = (name, args = {}) => {
		const tool = tools.find(row => row.name === name);
		return tool.handler(z.object(tool.inputSchema).parse(args));
	};
	await call("add_scene", { name: "HEADLESS" });
	await call("switch_scene", { name: "HEADLESS" });
	const headless = structuredClone(state.doc);
	const headlessPath = join(root, "headless.cclayproject");
	await call("save_project", { path: headlessPath });
	await call("switch_scene", { name: "First" });
	await call("open_project", { path: headlessPath });
	assert.deepEqual(state.doc, headless);
	console.log("PASS scene parity: bounded reads, admitted refusal, create/rename receipts, saved live projection, switch and headless roundtrip");
} finally {
	process.chdir(cwd);
	if (!closed) await s.close();
	await rm(root, { recursive: true, force: true });
}
