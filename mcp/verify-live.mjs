#!/usr/bin/env node
/** #446: shipped MCP handlers -> real live socket -> App bus and owned domains.
 * React/renderer hardware use the existing domain fixture; receipts and history
 * are never mocked. Run one acceptance case with COZYCLAY_446_CASE=<name>.
 */
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { z } from "zod";
import { projectFixture } from "../test/bus/project-fixture.mjs";
import { castFixture } from "../test/bus/cast-fixture.mjs";
import { DEFAULT_POSE } from "../src/poses.js";
import { dispatchLiveFrame } from "../src/live-control.js";
import { SCENES_VERSION, readSceneDocument, serializeSceneDocument } from "../src/scenes.js";
import { createProjectDocument } from "../src/project.js";
import { validateReceipt } from "../src/studio-agent-protocol.js";
import { startLiveHub } from "./live-hub.mjs";
import { createToolHandlers, liveWorkspace, setLiveHub } from "./tool-handlers.mjs";

const bounded = (promise, label) => {
	let timer;
	return Promise.race([promise, new Promise((_, reject) => {
		timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), 15_000);
	})]).finally(() => clearTimeout(timer));
};
export async function studio({ projectRoot, withCast = false } = {}) {
	const project = projectFixture();
	const f = withCast ? castFixture(project) : project;
	// Publish the selection React renders after a room swap. The domain owns
	// the swap and all authored state; this replaces only the renderer seam.
	f.actionHandlers.current.afterRender = async () => {
		const id = f.live.current.characters[0]?.id;
		f.live.current.activeCharacterId = id ?? null;
		f.live.current.studioSelection = id ? { kind: "character", id } : null;
	};
	const hub = await startLiveHub(0);
	const wire = [], events = [];
	const sendEvent = hub.sendEvent.bind(hub);
	hub.sendEvent = (workspaceId, name, payload) => {
		if (name === "telemetry") events.push(payload);
		return sendEvent(workspaceId, name, payload);
	};
	const describe = () => {
		const live = f.actual.readStudioState();
		return structuredClone({
			sceneName: live.sceneName,
			camera: { ...live.camera.position, focalMm: live.camera.focalMm, sensorId: live.filmback.sensorId, aspectRatio: live.filmback.aspectRatio },
			characters: live.characters, objects: live.objects, stage: live.stage,
			activeCharacterId: live.activeCharacterId,
			timeline: { currentFrame: live.view.frame, frameCount: live.frameCount, fps: 24 },
			document: { version: SCENES_VERSION, activeSceneId: f.scope.activeSceneIdRef.current, scenes: f.scope.scenesRef.current },
		});
	};
	const handlers = { ...f.binding.handlers, describe };
	const socket = new WebSocket(`ws://127.0.0.1:${hub.port}/live`);
	const welcomed = Promise.withResolvers();
	socket.on("message", async raw => {
		const frame = JSON.parse(raw);
		if (frame.type === "workspace") { welcomed.resolve(frame.handle); return; }
		if (frame.type !== "cmd") return;
		wire.push(frame);
		const response = await dispatchLiveFrame(raw.toString(), handlers);
		if (response) socket.send(JSON.stringify(response));
	});
	await bounded(once(socket, "open"), "editor socket");
	socket.send(JSON.stringify({ type: "hello", role: "editor", version: 1, workspaceId: f.host().workspaceId }));
	const handle = await bounded(welcomed.promise, "workspace hello");
	f.scope.liveWorkspaceHandleRef.current = handle;
	setLiveHub(hub);
	const tools = createToolHandlers({ projectRootPromise: Promise.resolve(projectRoot) });
	const call = async (name, args = {}) => {
		const tool = tools.find(row => row.name === name);
		assert.ok(tool, name);
		const parsed = z.object(tool.inputSchema).parse(args);
		return hub.runExclusive(name, handle, resolved => liveWorkspace.run(resolved, () => hub.observeExecution(name, resolved, () => tool.handler(parsed))));
	};
	return { f, hub, wire, events, handle, tools, describe, call,
		async close() {
			setLiveHub(null);
			const closed = bounded(Promise.all([once(socket, "close"), once(hub.editors.get(handle), "close")]), "disconnect");
			socket.close(); await closed;
			await new Promise(resolve => hub.server.close(resolve));
			f.dispose();
		},
	};
}
export function receipt(result, action) {
	let value;
	try { value = JSON.parse(result.content[0].text); }
	catch { assert.fail(`Expected a bus receipt from ${action}, received: ${result.content[0].text.slice(0, 180)}`); }
	validateReceipt(value);
	assert.equal(value.ok, true, JSON.stringify(value));
	assert.equal(result.isError, undefined, JSON.stringify(result));
	assert.equal(value.action, action);
	assert.ok(Number.isSafeInteger(value.revision.before));
	assert.ok(Number.isSafeInteger(value.revision.after));
	return value;
}
const cases = {};
cases.receipts = async () => {
	const s = await studio();
	try {
		const added = receipt(await s.call("place_object", { kind: "cube", x: 2, z: -1, name: "Crate" }), "object.add");
		const id = added.affectedIds[0];
		assert.equal(s.f.objects.read().find(row => row.id === id).name, "Crate");
		assert.equal(added.undo.entries, 1);
		receipt(await s.call("update_object", { id, x: 3, facing: 30, tilt: 10, roll: 5, scale: 2, scale_y: 3, hidden: true,
			path: { points: [{ x: 0, z: 0 }, { x: 2, z: 2 }], face_travel: false } }), "object.update");
		const updated = s.f.objects.read().find(row => row.id === id);
		assert.deepEqual([updated.x, updated.rot, updated.rotX, updated.rotZ, updated.scaleX, updated.scaleY, updated.hidden, updated.path.faceTravel], [3, 30, 10, 5, 2, 3, true, false]);
		const parent = receipt(await s.call("place_object", { kind: "cylinder" }), "object.add").affectedIds[0];
		receipt(await s.call("group_objects", { parent, children: [id] }), "object.group");
		assert.equal(s.f.objects.read().find(row => row.id === id).parent, parent);
		receipt(await s.call("group_objects", { parent: null, children: [id] }), "object.ungroup");
		assert.equal(s.f.objects.read().find(row => row.id === id).parent, null);
		receipt(await s.call("remove_object", { id }), "object.remove");
		assert.equal(s.f.objects.read().some(row => row.id === id), false);
		const imported = receipt(await s.call("import_mesh", { path: fileURLToPath(new URL("../test/fixtures/unit-cube.glb", import.meta.url)), x: 2, height: 0.8, clay: true }), "asset.import");
		assert.ok(s.f.objects.read().some(row => row.id === imported.output.objectId));
		assert.equal(imported.undo.entries, 1);
		const camera = receipt(await s.call("set_camera", { x: 3, y: 2, z: 6, focal_mm: 50, look_at_x: 0, look_at_y: 1.3, look_at_z: 0 }), "shot.frame");
		assert.equal(camera.undo.entries, 1);
		assert.deepEqual(s.f.binding.context().camera.position, { x: 3, y: 2, z: 6 });
		const before = s.f.binding.context().camera;
		receipt(await s.call("set_camera", { x: 4 }), "shot.frame");
		const after = s.f.binding.context().camera;
		for (const axis of ["x", "y", "z"]) assert.ok(Math.abs((after.lookAt[axis] - after.position[axis]) - (before.lookAt[axis] - before.position[axis])) < 1e-10);
		for (const view of ["front", "front three-quarter", "profile", "rear three-quarter", "back"]) {
			receipt(await s.call("frame_shot", { size: "medium shot", view }), "shot.frame");
			assert.deepEqual(s.f.binding.context().camera.lookAt, { x: 0, y: 1.3, z: 0 });
		}
		const oldScene = s.f.scope.scenesRef.current[0].name;
		const created = await s.call("add_scene", { name: "New room" });
		receipt(created, "scene.create");
		assert.equal(s.f.scope.scenesRef.current.find(row => row.id === s.f.scope.activeSceneIdRef.current).name, "New room");
		receipt(await s.call("switch_scene", { name: oldScene }), "scene.switch");
		assert.equal(s.f.scope.activeSceneIdRef.current, "scene");
		assert.ok(s.wire.some(frame => frame.name === "run_action"));
		assert.ok(s.wire.every(frame => ["inspect_studio", "read_studio_context", "run_action", "describe"].includes(frame.name)), "migrated aliases must not send legacy mutator frames");
	} finally { await s.close(); }
};

cases.admission = async () => {
	const s = await studio();
	try {
		const [a, b] = s.f.objects.read();
		const calls = [
			["place_object", { kind: "cube" }], ["update_object", { id: a.id, x: 4 }], ["remove_object", { id: a.id }],
			["group_objects", { parent: a.id, children: [b.id] }], ["group_objects", { parent: null, children: [b.id] }],
			["import_mesh", { path: fileURLToPath(new URL("../test/fixtures/unit-cube.glb", import.meta.url)) }],
			["set_camera", { x: 3 }], ["frame_shot", { size: "medium shot" }],
			["add_scene", { name: "Stale creation" }], ["switch_scene", { name: "Second" }],
		];
		for (const [name, args] of calls) {
			const current = s.f.binding.refresh();
			const before = structuredClone({ revision: current.revision, document: current.document, camera: current.camera });
			const result = await s.call(name, { ...args, expectedRevision: before.revision + 99 });
			assert.equal(result.isError, true, `${name} accepted a stale revision`);
			const refused = JSON.parse(result.content[0].text);
			validateReceipt(refused);
			assert.equal(refused.code, "STALE_SCENE", JSON.stringify(refused));
			assert.equal(refused.mutated, false);
			assert.deepEqual(s.f.binding.refresh().document, before.document);
			assert.deepEqual(s.f.binding.refresh().camera, before.camera);
		}
		const commandId = crypto.randomUUID(), expectedRevision = s.f.binding.refresh().revision;
		const args = { kind: "cone", commandId, expectedRevision };
		const first = receipt(await s.call("place_object", args), "object.add");
		const retried = receipt(await s.call("place_object", args), "object.add");
		assert.equal(first.commandId, commandId);
		assert.deepEqual(retried, first, "a replay returns the editor's journalled receipt");
		assert.equal(s.f.objects.read().filter(row => row.id === first.affectedIds[0]).length, 1);
		// Advance the real UI domain after inspection, before run_action reaches
		// the editor: admission must remain at the inspected revision, not retry.
		const command = s.hub.command.bind(s.hub);
		let interleaved = false;
		s.hub.command = async (name, ...args) => {
			const value = await command(name, ...args);
			if (name === "inspect_studio" && !interleaved) {
				interleaved = true;
				assert.equal((await s.f.run("object.rename", { id: a.id, name: "Human edit" })).ok, true);
			}
			return value;
		};
		const raced = await s.call("update_object", { id: a.id, x: 9 });
		assert.equal(JSON.parse(raced.content[0].text).code, "STALE_SCENE");
		assert.equal(s.f.objects.read().find(row => row.id === a.id).x, a.x);
	} finally { await s.close(); }
};

cases.batch = async () => {
	const s = await studio();
	const expectEvents = (offset, outcome, applied) => {
		const events = s.events.slice(offset);
		assert.deepEqual(events.map(row => row.event), ["mcp:tool_requested", "mcp:tool_executed", ...(applied ? ["mcp:result_applied"] : [])]);
		assert.equal(events[1].props.outcome, outcome);
		assert.ok(events.every(row => row.props.request_id === events[0].props.request_id));
	};
	try {
		const before = structuredClone(s.f.objects.read()), depth = s.f.objects.store.depths().past;
		const ops = ["cube", "cylinder", "sphere"].map((kind, i) => ({ name: "place_object", args: { kind, x: i + 1 } }));
		let offset = s.events.length;
		const batch = receipt(await s.call("apply_batch", { ops, label: "Three edits", atomic: true, stopOnError: false }), "objects.batch");
		assert.equal(batch.undo.entries, 1);
		assert.equal(s.f.objects.store.depths().past, depth + 1);
		assert.equal(batch.revision.after, batch.revision.before + 1);
		assert.deepEqual(batch.output, { label: "Three edits", applied: [1, 2, 3], failed: [], rolledBack: false });
		expectEvents(offset, "succeeded", true);
		const undo = await s.call("studio_run", { action: "edit.undo", args: { receiptId: batch.receiptId } });
		assert.equal(JSON.parse(undo.content[0].text).status, "undone");
		assert.deepEqual(s.f.objects.read(), before);
		assert.equal(s.f.objects.store.depths().past, depth);
		for (const atomic of [true, false]) for (const stopOnError of [true, false]) {
			const baseline = structuredClone(s.f.objects.read()), initialDepth = s.f.objects.store.depths().past;
			offset = s.events.length;
			const result = receipt(await s.call("apply_batch", { atomic, stopOnError, label: "Failure semantics", ops: [
				ops[0], { name: "update_object", args: { id: "missing", x: 3 } }, ops[1],
			] }), "objects.batch");
			assert.deepEqual(result.output.applied, stopOnError ? [1] : [1, 3]);
			assert.equal(result.output.failed[0].index, 2);
			assert.equal(result.output.rolledBack, atomic);
			assert.equal(s.f.objects.store.depths().past, initialDepth + (atomic ? 0 : 1));
			expectEvents(offset, "failed", !atomic);
			if (atomic) assert.deepEqual(s.f.objects.read(), baseline);
			else {
				await s.call("studio_run", { action: "edit.undo", args: { receiptId: result.receiptId } });
				assert.deepEqual(s.f.objects.read(), baseline);
			}
		}
		offset = s.events.length;
		const noop = receipt(await s.call("apply_batch", { ops: [{ name: "update_object", args: { id: before[0].id, x: before[0].x } }] }), "objects.batch");
		assert.equal(noop.authored, false); assert.equal(noop.undo, null);
		expectEvents(offset, "succeeded", false);
		offset = s.events.length;
		const stale = await s.call("apply_batch", { ops, expectedRevision: s.f.binding.refresh().revision + 99 });
		assert.equal(JSON.parse(stale.content[0].text).code, "STALE_SCENE");
		expectEvents(offset, "failed", false);
		const nested = await s.call("apply_batch", { ops: [{ name: "apply_batch", args: { ops } }] });
		assert.equal(JSON.parse(nested.content[0].text).code, "INVALID_ARGUMENT");
		await assert.rejects(s.call("apply_batch", { ops: Array(101).fill(ops[0]) }), z.ZodError);
		await assert.rejects(s.call("apply_batch", { ops: [{ name: "update_character", args: {} }] }), z.ZodError);
		assert.deepEqual(s.f.objects.read(), before);
		const sent = s.wire.find(frame => frame.name === "run_action" && frame.args.args.action === "objects.batch");
		assert.deepEqual(sent.args.args.args, { ops, atomic: true, stopOnError: false, label: "Three edits" });
		assert.ok(!s.wire.some(frame => frame.name === "apply_batch"));
	} finally { await s.close(); }
};

cases.confirmation = async () => {
	const cwd = process.cwd();
	const root = await realpath(await mkdtemp(join(tmpdir(), "cozyclay-446-")));
	const s = await studio({ projectRoot: root });
	try {
		process.chdir(root);
		const before = s.describe().document;
		const replacement = structuredClone(before);
		replacement.scenes = [{ ...replacement.scenes[0], id: "replacement-scene", name: "Replacement" }];
		replacement.activeSceneId = "replacement-scene";
		const document = readSceneDocument(serializeSceneDocument(replacement)).document;
		const path = join(root, "replacement.cclayproject");
		await writeFile(path, JSON.stringify(createProjectDocument({ scenesDocument: document, name: "Replacement project", customPoses: [], workspaceLayout: null })));
		const assertRefused = (result, code) => {
			assert.equal(result.isError, true, JSON.stringify(result));
			let refused;
			try { refused = JSON.parse(result.content[0].text); }
			catch { assert.fail(`Expected ${code} receipt, got: ${result.content[0].text}`); }
			validateReceipt(refused); assert.equal(refused.code, code);
			assert.equal(refused.mutated, false);
			assert.deepEqual(s.describe().document, before);
		};
		assertRefused(await s.call("open_project", { path }), "CONFIRMATION_REQUIRED");
		assertRefused(await s.call("open_project", { path, confirmationToken: "untrusted-token" }), "CONFIRMATION_REQUIRED");
		// Only the UI can mint a token. It is bound to the exact normalized
		// document and remains unconsumed when revision admission refuses.
		const confirmationToken = s.f.binding.bus.confirm("load_scenes", { document });
		assertRefused(await s.call("open_project", { path, confirmationToken, expectedRevision: s.f.binding.refresh().revision + 99 }), "STALE_SCENE");
		const different = structuredClone(document); different.scenes[0].name = "Different request";
		assertRefused(await s.call("studio_run", { action: "load_scenes", args: { document: different }, confirmationToken }), "CONFIRMATION_REQUIRED");
		const loaded = receipt(await s.call("open_project", { path, confirmationToken }), "load_scenes");
		assert.equal(loaded.output.activeSceneId, document.activeSceneId);
		assert.deepEqual(loaded.output.scenes, document.scenes.map(({ id, name }) => ({ id, name })));
		assert.deepEqual(s.describe().document.scenes.map(row => row.id), ["replacement-scene"]);
		assert.ok(!s.wire.some(frame => frame.name === "load_scenes"));
		// Same-id scene loads remain an admitted non-replacing boundary.
		const same = receipt(await s.call("open_project", { path }), "load_scenes");
		assert.equal(same.undo, null);
		const other = { ...document, activeSceneId: "other", scenes: [{ ...document.scenes[0], id: "other" }] };
		const reused = await s.call("studio_run", { action: "load_scenes", args: { document: other }, confirmationToken });
		assert.equal(JSON.parse(reused.content[0].text).code, "CONFIRMATION_REQUIRED");
	} finally { process.chdir(cwd); await s.close(); await rm(root, { recursive: true, force: true }); }
};

cases.cast = async () => {
	const s = await studio({ withCast: true });
	const snapshot = () => structuredClone({ characters: s.f.cast.read(), timeline: s.f.binding.refresh().frameCount });
	const undo = async value => {
		const result = await s.call("studio_run", { action: "edit.undo", args: { receiptId: value.receiptId } });
		assert.equal(JSON.parse(result.content[0].text).status, "undone", JSON.stringify(result));
	};
	try {
		const before = snapshot();
		const addArgs = { subject: "New performer", model: "x-bot-tpose", x: 2, z: -3, facing: 45,
			commandId: crypto.randomUUID(), expectedRevision: s.f.binding.refresh().revision };
		const added = receipt(await s.call("add_character", addArgs), "character.add");
		assert.equal(added.undo.entries, 1);
		assert.ok(added.revision.after > added.revision.before);
		const id = added.affectedIds.find(id => !before.characters.some(row => row.id === id));
		const created = s.f.cast.read().find(row => row.id === id);
		assert.deepEqual([created.subject, created.model, created.x, created.z, created.rot], [addArgs.subject, addArgs.model, 2, -3, 45]);
		assert.deepEqual(created.pose, DEFAULT_POSE);
		assert.deepEqual(receipt(await s.call("add_character", addArgs), "character.add"), added, "retry replays the receipt without a second actor");
		await undo(added); assert.deepEqual(snapshot(), before);
		const again = receipt(await s.call("add_character", { subject: "Removable performer" }), "character.add");
		const newId = again.affectedIds.find(id => !before.characters.some(row => row.id === id));
		for (const [reference, target] of [["A", "actor-a"], ["2", "actor-b"], [newId, newId]]) {
			const prior = snapshot();
			const moved = receipt(await s.call("place_character", { character: reference, x: 1.5, y: 0.8, z: -2, facing: 90, subject: "Updated performer", hidden: true }), "character.update");
			const actor = s.f.cast.read().find(row => row.id === target);
			assert.deepEqual([actor.x, actor.y, actor.z, actor.rot, actor.subject, actor.hidden], [1.5, 0.8, -2, 90, "Updated performer", true]);
			assert.deepEqual(s.f.cast.read().filter(row => row.id !== target), prior.characters.filter(row => row.id !== target));
			await undo(moved); assert.deepEqual(snapshot(), prior);
		}
		const noop = receipt(await s.call("place_character", { character: "A", x: s.f.cast.read()[0].x }), "character.update");
		assert.equal(noop.status, "noop"); assert.equal(noop.undo, null);
		const missing = await s.call("place_character", { character: "missing", x: 1 });
		assert.equal(JSON.parse(missing.content[0].text).code, "STALE_TARGET");

		const beforeRemove = snapshot();
		const removed = receipt(await s.call("remove_character", { character: newId }), "character.remove");
		assert.equal(s.f.cast.read().some(row => row.id === newId), false);
		await undo(removed); assert.deepEqual(snapshot(), beforeRemove);
		for (const [name, args] of [["add_character", { subject: "Stale actor" }], ["place_character", { character: "A", x: 8 }],
			["remove_character", { character: newId }]]) {
			const prior = snapshot();
			const result = await s.call(name, { ...args, expectedRevision: s.f.binding.refresh().revision + 99 });
			assert.equal(result.isError, true, `${name} accepted a stale revision`);
			const refused = JSON.parse(result.content[0].text); validateReceipt(refused);
			assert.equal(refused.code, "STALE_SCENE"); assert.equal(refused.mutated, false);
			assert.deepEqual(snapshot(), prior);
		}
		// A concurrent edit between reference resolution and commit must refuse
		// the admitted revision rather than silently retargeting slot B.
		const command = s.hub.command.bind(s.hub);
		let interleaved = false;
		s.hub.command = async (name, ...args) => {
			const value = await command(name, ...args);
			if (name === "describe" && !interleaved) {
				interleaved = true;
				assert.equal((await s.f.run("character.update", { characterId: "actor-b", patch: { subject: "Human edit" } })).ok, true);
			}
			return value;
		};
		const raced = await s.call("place_character", { character: "B", x: 9 });
		assert.equal(JSON.parse(raced.content[0].text).code, "STALE_SCENE");
		assert.equal(s.f.cast.read().find(row => row.id === "actor-b").x, 4);
		s.hub.command = command;
		assert.equal((await s.f.call("operate_studio", s.f.request("operate_studio", { selection: { kind: "character", id: "actor-a" } }))).ok, true);
		s.f.cast.switchActiveCharacterLayer();
		receipt(await s.call("remove_character", { character: "2" }), "character.remove");
		receipt(await s.call("remove_character", { character: "B" }), "character.remove");
		// The last character goes too: an empty stage is legal.
		receipt(await s.call("remove_character", { character: "A" }), "character.remove");
		assert.equal(s.f.cast.read().length, 0);
		assert.ok(s.wire.every(frame => ["inspect_studio", "read_studio_context", "run_action", "describe"].includes(frame.name)), "cast aliases use no legacy mutation frames");
	} finally { await s.close(); }
};

// #652: the tool list is fixed at server start.
const RECORDED_TOOLS = [
	"describe_scene", "live_status", "describe_shot", "capture_frame", "set_camera", "frame_shot", "add_character", "place_character",
	"remove_character", "focus_character", "place_object", "import_mesh", "sculpt_object", "compare_sculpt", "group_objects",
	"update_object", "remove_object", "apply_batch", "render_prompt", "mark_camera_move", "describe_camera_move",
	"add_scene", "switch_scene", "open_project", "save_project", "studio_commands", "studio_run",
];
cases.toolList = async () => {
	const s = await studio({ withCast: true });
	try {
		assert.deepEqual(s.tools.map(row => row.name), RECORDED_TOOLS, "no tool is added, removed or renamed");
		console.log(`tool list: ${s.tools.length} tools, identical to the recorded list`);
		assert.doesNotMatch((await s.call("describe_scene")).content[0].text, /previsMode/);
	} finally { await s.close(); }
};

cases["legacy-removed"] = async () => {
	const obsolete = ["applied", "Live", "Mutation"].join("");
	const references = [];
	const scan = async directory => {
		for (const entry of await readdir(directory, { withFileTypes: true })) {
			if (entry.name === "node_modules") continue;
			const path = join(directory, entry.name);
			if (entry.isDirectory()) await scan(path);
			else if (/\.(?:mjs|js|md)$/.test(entry.name) && (await readFile(path, "utf8")).includes(obsolete)) references.push(path);
		}
	};
	await scan(fileURLToPath(new URL(".", import.meta.url)));
	assert.deepEqual(references, [], `${obsolete} references in mcp/ must be zero`);
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const selected = process.env.COZYCLAY_446_CASE;
	if (selected) assert.ok(cases[selected], `Unknown case ${selected}`);
	for (const [name, run] of Object.entries(cases)) if (!selected || selected === name) {
		await run(); console.log(`PASS #446 ${name}`);
	}
}
