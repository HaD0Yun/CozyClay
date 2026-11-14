#!/usr/bin/env node
import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import * as protocol from "../src/studio-agent-protocol.js";
import * as contextTools from "../src/studio-agent-context.js";
import { STUDIO_ELEMENTS } from "../src/studio-elements.js";
import { createAgentHandler } from "../bin/agent/agent-routes.mjs";
import { PREVIS_MODES } from "../src/project.js";
import { POSTURES } from "../src/scenes.js";
import { createFakeModel } from "./fixtures/fake-model.mjs";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { toAgentTools } from "../bin/agent/pi-tools.mjs";

export const uuid = "00000000-0000-4000-8000-000000000001";
export function contextFixture() {
	return {
		schema: "studio-context-v1",
		host: { surface: "studio", workspaceId: "tab-7", workspaceHandle: "handle-12", documentEpoch: "doc-3", sceneId: "scene-main", sceneEpoch: "scene-open-4" },
		revision: { scene: 41, physics: 9, view: 18 },
		units: { distance: "m", angle: "deg", up: "+Y", yawZero: "+Z", yawPositiveToward: "+X", pivot: "base", fps: 24, rangeEnd: "exclusive" },
		scene: { name: "Workshop", aspect: "16:9", floorY: 0, frameCount: 144, objectCount: 0, characterCount: 1 },
		selection: { kind: "character", id: "char-alex", hierarchyId: "character:char-alex" }, activeCharacterId: "char-alex",
		view: { mode: "scene", frame: 0, playing: false, lookThrough: false, grid: false, autoColor: false }, shot: null, camera: null,
		entities: [{ id: "char-alex", kind: "character", name: "Alex", token: "ct-11", position: { x: 0, y: 0, z: 0 }, yawDeg: 0, scale: 1 }],
		entityPage: { returned: 1, total: 1, truncated: false, nextCursor: null },
		shots: [], shotsTruncated: false, assets: [], recentReceipts: [], jobs: [],
		capabilities: { profile: "studio-slice-1", tools: [...protocol.STUDIO_TOOL_FAMILIES], rigReady: true, cameraReady: false, bridgeReady: false },
	};
}
export const envelopeFixture = () => ({ surface: "studio", sessionId: uuid, turnId: "00000000-0000-4000-8000-000000000002", text: "inspect selection", context: contextFixture() });
const point = () => ({ x: 1, y: 0, z: 2 });
const createOp = (name = "Box") => ({ op: "create", source: { kind: "cylinder" }, name, position: { world: point() } });
const guard = () => ({ workspaceId: "tab-7", sceneId: "scene-main", documentEpoch: "doc-3", sceneEpoch: "scene-open-4", targetId: "char-alex", token: "ct-11" });
export function receiptFixture(status = "applied") {
	const result = { ok: true, commandId: "cmd-1", receiptId: "receipt-1", host: { workspaceId: "tab-7", sceneId: "scene-main", documentEpoch: "doc-3", sceneEpoch: "scene-open-4" }, status,
		authored: true, revision: { before: 41, after: 42 }, affectedIds: ["char-alex"], delta: [{ id: "char-alex", after: { position: point() } }], checks: { coverage: "affected-targets" }, undo: { historyEntryId: "history-1", entries: 1, canUndoDirect: true }, warnings: [] };
	if (status === "noop") Object.assign(result, { authored: false, mutated: false, revision: { before: 41, after: 41 }, delta: [], undo: null });
	if (status === "transient") Object.assign(result, { authored: false, revision: { before: 41, after: 41 }, view: { before: 18, after: 19 }, undo: null });
	if (status === "undone") Object.assign(result, { undoneReceiptId: "receipt-old", restoredTargets: [guard()] });
	if (status === "installed") Object.assign(result, { jobId: "job-1", artifactId: "artifact-1", installed: { characterId: "char-alex", beforeTakeId: null, takeId: "take-1", targetToken: "ct-12", frameCount: 144, fps: 24, durationSeconds: 6, blocks: [{ sourceBeat: 0, startFrame: 0, endFrameExclusive: 72 }, { sourceBeat: 1, startFrame: 72, endFrameExclusive: 144 }], selectionChanged: false }, verification: { id: "verify-1", status: "verified", profile: "studio-motion-v1", range: { startFrame: 0, endFrameExclusive: 144 }, evaluatedFrames: 144, physicsRevision: 9, limitations: ["discrete-frame-sampling"] } });
	return result;
}
const rejects = (fn, code) => assert.throws(fn, e => e instanceof Error && (code ? e.code === code : typeof e.code === "string"));

export async function withHttp(run, options = {}) {
	const fakeModel = createFakeModel({ provider: "openai-codex", modelId: "gpt-6-astra", modelName: "GPT-6 Astra" });
	fakeModel.script([{ type: "text", text: "" }]);
	const calls = fakeModel.calls;
	const codex = { parseQuotaHeaders: () => ({ primary: {}, credits: {} }) };
	const handler = createAgentHandler({ auth: { getAccessToken: async () => "fake-token" }, codex, models: fakeModel.models, fauxProvider: fakeModel.fauxProvider, handlers: [], liveHub: {}, port: () => server.address().port, ...options });
	const server = createServer((req, res) => handler(req, res).catch(error => { res.writeHead(500); res.end(error.message); }));
	const ready = once(server, "listening"); server.listen(0, "127.0.0.1"); await ready;
	const origin = `http://127.0.0.1:${server.address().port}`;
	const post = async (body, path = "/agent/turn") => {
		const response = await fetch(origin + path, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(5000) });
		return { status: response.status, contentType: response.headers.get("content-type"), text: await response.text() };
	};
	try { await run(post, calls); } finally { await handler.close(); await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
}

function registerTests() {
	test("D1 shared modules validate and encode UTF-8 without Buffer", () => {
		const saved = globalThis.Buffer;
		try { globalThis.Buffer = undefined; const value = contextFixture(); value.scene.name = "한글 😀 <&>"; protocol.validateStudioContext(value); const encoded = contextTools.encodeStudioContext(value); assert.equal(JSON.parse(encoded).scene.name, value.scene.name); assert.equal(encoded.includes("<"), false); }
		finally { globalThis.Buffer = saved; }
	});
	test("D1b a context carrying annotation marks validates (the server reads the same schema)", () => {
		const value = { ...contextFixture(), marks: [{ n: 1, kind: "pin", hit: { type: "object", id: "cube", name: "Cube" }, points: [{ x: 0, y: 1, z: 0 }], frame: 0 }] };
		assert.equal(protocol.validateStudioContext(value).marks[0].hit.id, "cube");
	});
	test("D2 HTTP uses turnId and rejects turn_id as a Studio identity alias", async () => {
		protocol.validateStudioTurnEnvelope(envelopeFixture());
		const alias = envelopeFixture(); alias.turn_id = alias.turnId; delete alias.turnId;
		rejects(() => protocol.validateStudioTurnEnvelope(alias));
		await withHttp(async (post, calls) => {
			const valid = await post(envelopeFixture());
			assert.equal(valid.status, 409); assert.equal(JSON.parse(valid.text).error.code, "CAPABILITY_MISSING");
			assert.equal(calls.length, 0, "until task 6 supplies the Studio executor, never run Workflow for Studio");
			assert.equal((await post(alias)).status, 400);
		});
	});
	test("D2 the turn envelope carries up to four author image attachments (#367)", () => {
		const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
		const attachment = (index) => ({ dataUrl: png, name: `screenshot-${index}.png` });
		for (const count of [1, 2, 3, 4]) {
			const value = envelopeFixture();
			value.attachments = Array.from({ length: count }, (_, index) => attachment(index));
			const accepted = protocol.validateStudioTurnEnvelope(value);
			assert.equal(accepted.attachments.length, count);
			assert.equal(accepted.attachments[0].dataUrl, png);
			assert.equal(accepted.attachments[0].name, "screenshot-0.png");
		}
		// The name is the author's file name, not a required field.
		assert.equal(protocol.validateStudioTurnEnvelope({ ...envelopeFixture(), attachments: [{ dataUrl: png }] }).attachments[0].name, undefined);
		assert.equal(protocol.validateStudioTurnEnvelope(envelopeFixture()).attachments, undefined, "a turn without pictures carries no field");
		for (const attachments of [
			Array.from({ length: 5 }, (_, index) => attachment(index)),
			[],
			[{ dataUrl: "data:text/plain;base64,aGk=" }],
			[{ dataUrl: "data:image/svg+xml;base64,aGk=" }],
			[{ dataUrl: "https://example.test/screenshot.png" }],
			[{ dataUrl: png, name: "a".repeat(121) }],
			[{ dataUrl: png, alt: "private" }],
			[png],
		]) rejects(() => protocol.validateStudioTurnEnvelope({ ...envelopeFixture(), attachments }), "INVALID_REQUEST");
	});
	test("D3 bogus typed object op, unknown nested fields and later variants cannot pass", () => {
		for (const args of [{ ops: [{ op: "bogus" }] }, { ops: [] }, { ops: [createOp()], document: {} }, { ops: [{ ...createOp(), source: { imageId: "image-1", placeAs: "cutout" } }] }, { ops: [{ op: "attach", id: "a", characterId: "b", bone: null }] }, { ops: [{ ...createOp(), position: { world: { ...point(), password: "private" } } }] }, { ops: [{ op: "update", id: "a" }] }]) rejects(() => protocol.validateStudioCommand({ name: "arrange_objects", args }));
	});
	test("#637 context carries previsMode, character kind and storyboard capability, all optional", () => {
		const bare = contextFixture();
		assert.deepEqual(protocol.StudioSchemas.StudioContextV1.properties.scene.properties.previsMode.enum, [...PREVIS_MODES], "protocol mirrors PREVIS_MODES");
		assert.deepEqual(protocol.StudioSchemas.Entity.properties.posture.enum, [...POSTURES], "protocol mirrors POSTURES");
		assert.equal(protocol.validateStudioContext(bare).scene.previsMode, undefined, "a context without previsMode still validates");
		const value = contextFixture();
		value.scene.previsMode = "storyboard"; value.capabilities.storyboard = true;
		value.entities = [value.entities[0], { id: "char-cap", kind: "character", name: "Cap", token: "ct-12", position: { x: 1, y: 0, z: 1 }, yawDeg: 0, scale: 1, modelId: "proxy-figure", characterKind: "proxy", posture: "sit", capabilities: { rigReady: false, ik: false, measuredFeet: false } }];
		value.scene.characterCount = 2; value.entityPage = { returned: 2, total: 2, truncated: false, nextCursor: null };
		const accepted = contextTools.buildStudioContext(value);
		assert.equal(accepted.scene.previsMode, "storyboard");
		assert.equal(accepted.capabilities.storyboard, true);
		assert.deepEqual(accepted.entities.map(e => e.characterKind ?? null).sort(), [null, "proxy"]);
		assert.deepEqual(protocol.STUDIO_VARIANTS.modes, ["scene", "pose", "camera", "motion"], "tool modes stay four");
		const mutations = [c => c.scene.previsMode = "x", c => c.entities[1].characterKind = "capsule", c => c.entities[1].posture = "float", c => c.capabilities.storyboard = "yes"];
		for (const mutate of mutations) { const invalid = structuredClone(value); mutate(invalid); rejects(() => protocol.validateStudioContext(invalid), "INVALID_CONTEXT"); }
	});
	test("#405 context units validate and retain the base pivot", () => {
		assert.equal(protocol.validateStudioContext(contextFixture()).units.pivot, "base");
		const invalid = contextFixture(); invalid.units.pivot = "centre";
		rejects(() => protocol.validateStudioContext(invalid), "INVALID_CONTEXT");
	});
	test("#626 shot summaries carry an optional kind and caption", () => {
		const range = { startFrame: 0, endFrameExclusive: 48 };
		const value = contextFixture();
		value.shots = [{ id: "shot-a", name: "Hero", range, keyCount: 0, kind: "still", caption: "She looks up." }, { id: "shot-b", name: "Wide", range: { startFrame: 48, endFrameExclusive: 96 }, keyCount: 1 }];
		value.shot = { id: "shot-a", name: "Hero", range, mode: "keys", kind: "still", caption: "She looks up." };
		const accepted = protocol.validateStudioContext(value);
		assert.equal(accepted.shots[0].kind, "still");
		assert.equal(accepted.shot.caption, "She looks up.");
		assert.equal(accepted.shots[1].kind, undefined, "kind stays optional");
		for (const patch of [{ kind: "gif" }, { caption: "x".repeat(501) }, { caption: "" }]) {
			rejects(() => protocol.validateStudioContext({ ...value, shots: [{ ...value.shots[0], ...patch }, value.shots[1]] }), "INVALID_CONTEXT");
			rejects(() => protocol.validateStudioContext({ ...value, shot: { ...value.shot, ...patch } }), "INVALID_CONTEXT");
		}
	});
	test("#405 patch descriptors retain declared pivot notes", () => {
		for (const path of ["object.position", "character.position"]) {
			const descriptor = protocol.STUDIO_PATCH_DESCRIPTORS.find(row => row.path === path);
			assert.equal(typeof descriptor.note, "string", `${path} descriptor must carry its pivot note`);
			assert.equal(descriptor.note, STUDIO_ELEMENTS.find(row => row.path === path).note);
		}
	});
	test("D3 finite limits, mutually exclusive fields and avoid constraints", () => {
		const invalid = [
			{ name: "inspect_studio", args: { scope: "entities", ids: ["a"], query: "A" } },
			{ name: "inspect_studio", args: { scope: "entities", limit: 33 } },
			{ name: "operate_studio", args: {} },
			{ name: "operate_studio", args: { frame: -1 } },
			{ name: "operate_studio", args: { mode: "script" } },
			{ name: "arrange_objects", args: { ops: [createOp()], collisionPolicy: "avoid" } },
			{ name: "arrange_objects", args: { ops: [{ ...createOp(), scale: { ...point(), y: Infinity } }] } },
			{ name: "arrange_objects", args: { ops: [{ op: "group", parentId: "a", childIds: ["a"] }] } },
			{ name: "arrange_objects", args: { ops: [{ op: "update", id: "a", facing: { yawDeg: 1 }, rotationDeg: point() }] } },
			{ name: "arrange_characters", args: { ops: [{ op: "update", characterId: "a", modelId: "new-model" }] } },
			{ name: "frame_shot", args: { subjectIds: ["a", "b"], framing: { exact: { position: point(), lookAt: point(), focalMm: 35 } } } },
			{ name: "verify_result", args: { receiptId: "r", targets: ["a"], checks: ["placement"] } },
			{ name: "undo_edit", args: {} },
		];
		for (const command of invalid) rejects(() => protocol.validateStudioCommand(command));
	});
	test("D3 all nine families have executable happy paths and stable defaults", () => {
		const commands = [
			{ name: "inspect_studio", args: { scope: "entities" } },
			{ name: "operate_studio", args: { selection: null, frame: 0, playing: false, view: { grid: true } } },
			{ name: "arrange_objects", args: { ops: [createOp()] } },
			{ name: "arrange_characters", args: { ops: [{ op: "create", name: "Alex", position: { world: point() } }] } },
			{ name: "patch_elements", args: { ops: [{ target: { kind: "character", id: "char-alex" }, set: { tint: "#a1b2c3" } }] } },
			{ name: "frame_shot", args: { subjectIds: ["char-alex"], framing: { intent: { size: "medium shot", view: "front three-quarter", level: "eye", side: "left" } } } },
			{ name: "verify_result", args: { targets: ["char-alex"], checks: ["motion"] } },
			{ name: "undo_edit", args: { receiptId: "r-1" } },
			{ name: "run_action", args: { action: "shot.create" } },
		];
		assert.deepEqual(commands.map(command => command.name).sort(), [...protocol.STUDIO_TOOLS].sort());
		const normalized = commands.map(command => protocol.validateStudioCommand(command));
		assert.equal(normalized[0].args.limit, 12); assert.equal(normalized[2].args.collisionPolicy, "report"); assert.equal(normalized[6].args.visual, "none"); assert.equal(normalized[6].args.range, "whole_clip");
		assert.equal(commands[0].args.limit, undefined, "normalization does not edit caller input");
		rejects(() => protocol.validateStudioCommand({ name: "arrange_objects", args: { ops: [createOp("Same"), createOp("Same")] } }), "DUPLICATE_NAME");
	});
	test("D3 storyboard framing accepts a still shot id and optional caption", () => {
		const command = protocol.validateStudioCommand({ name: "frame_shot", args: {
			subjectIds: ["char-alex"], shotId: "still-1", caption: "Two people at a table",
			framing: { intent: { size: "medium shot", view: "front", level: "eye", side: "right" } },
		} });
		assert.equal(command.args.shotId, "still-1");
		assert.equal(command.args.caption, "Two people at a table");
	});
	test("the Studio prompt states the scene-geometry facts and prefers object.set over object.update", async () => {
		const { STUDIO_SYSTEM_PROMPT: prompt } = await import("../bin/agent/studio-prompt.mjs");
		for (const rule of [/Euler order XYZ for rotX\/rot\/rotZ/, /yaw zero \+Z/, /base pivot: y is the bottom/, /x\/z are the footprint centre/, /unit cube at scale 1 is 1 m/,
			/world space unless the tool says otherwise/, /not parent-relative/, /at least 0\.01 m; smaller requests are clamped/, /Prefer object\.set or arrange_objects to the legacy object\.update/,
			/use an empty \(kind "empty", no geometry\) as the root/, /never use a tiny cube as a folder/, /rotating it rotates them about the parent's pivot; scale is not carried/,
			/coplanar overlapping faces: offset them by at least 3 mm or put one fully inside/]) assert.match(prompt, rule);
		assert.doesNotMatch(prompt, /Grouping carries position only/);
	});
	test("#742 the Studio prompt carries the previs procedure and keeps the protocol rules", async () => {
		const { STUDIO_SYSTEM_PROMPT: prompt, STUDIO_SYSTEM_PROMPT_STORYBOARD: storyboard } = await import("../bin/agent/studio-prompt.mjs");
		assert.match(prompt, /Previs procedure/);
		assert.match(prompt, /180/);
		assert.match(prompt, /axisConsistent/);
		assert.ok(prompt.includes("On STALE_SCENE, the admission is already refreshed: adapt the operation to the listed changes and resubmit; inspect_studio only ids not listed"));
		assert.ok(prompt.indexOf("Previs procedure") > prompt.indexOf("Ask concise questions only when"), "appended after the existing rules");
		assert.doesNotMatch(storyboard, /Previs procedure/);
	});
	test("D3 patch_elements schema is derived from the element declaration table", () => {
		assert.equal(protocol.STUDIO_TOOL_FAMILIES.length, 3);
		assert.ok(protocol.STUDIO_CATALOGUE.some(tool => tool.name === "patch_elements"));
		// Every family must fit the context capability list.
		const c = contextFixture(); c.capabilities.tools = [...protocol.STUDIO_TOOL_FAMILIES]; protocol.validateStudioContext(c);
		// Existing v1 clients can still advertise the compatibility aliases.
		c.capabilities.tools = [...protocol.STUDIO_TOOLS]; protocol.validateStudioContext(c);
		// Derived, not hand-written: an element added to the table appears in the
		// schema with its declared bounds, and a removed one disappears.
		const table = [...STUDIO_ELEMENTS, { path: "stage.spotlight", type: "number", persisted: true, undoDomain: "stage", normalizer: "createSceneStage", min: -2, max: 7 }];
		const derived = protocol.buildPatchSchema(table);
		assert.deepEqual(derived.stage.properties.spotlight, { type: "number", minimum: -2, maximum: 7 });
		assert.equal(protocol.STUDIO_PATCH_SET_SCHEMAS.stage.properties.spotlight, undefined);
		assert.equal(derived.character.properties.tint.pattern, "^#[0-9a-fA-F]{6}$");
		assert.deepEqual(derived.character.properties.model.enum, ["y-bot-tpose", "x-bot-tpose", "proxy-figure"]);
		assert.deepEqual(derived.character.properties.posture.enum, ["stand", "sit", "lie"]);
		assert.equal(derived.character.properties.scale.minimum, 0.2);
		assert.equal(derived.character.properties.scale.maximum, 3);
		const hidden = protocol.buildPatchSchema(STUDIO_ELEMENTS.map(entry => entry.path === "character.tint" ? { ...entry, readOnly: true } : entry));
		assert.equal(hidden.character.properties.tint, undefined);
		for (const kind of protocol.STUDIO_PATCH_KINDS) assert.equal(protocol.STUDIO_PATCH_SET_SCHEMAS[kind].additionalProperties, false);
		// An unknown path answers with the vocabulary that does exist.
		try { protocol.validateStudioCommand({ name: "patch_elements", args: { ops: [{ target: { kind: "stage" }, set: { "keyLight.hue": 1 } }] } }); assert.fail("unknown path must be refused"); }
		catch (error) {
			assert.equal(error.code, "INVALID_ARGUMENT");
			assert.match(error.message, /stage\.keyLight\.hue/);
			for (const path of protocol.STUDIO_PATCHABLE_PATHS.stage) assert.ok(error.message.includes(path), `${path} must be listed`);
		}
		// One domain per patch, one history entry per receipt.
		rejects(() => protocol.validateStudioCommand({ name: "patch_elements", args: { ops: [{ target: { kind: "stage" }, set: { "keyLight.x": 1 } }, { target: { kind: "character", id: "char-alex" }, set: { rot: 4 } }] } }), "INVALID_ARGUMENT");
		for (const args of [
			{ ops: [] },
			{ ops: [{ target: { kind: "stage" }, set: {} }] },
			{ ops: [{ target: { kind: "stage", id: "scene-main" }, set: { "keyLight.x": 1 } }] },
			{ ops: [{ target: { kind: "character" }, set: { rot: 4 } }] },
			{ ops: [{ target: { kind: "scene", id: "scene-main" }, set: { rot: 4 } }] },
			{ ops: [{ target: { kind: "character", id: "char-alex" }, set: { scale: 9 } }] },
			{ ops: [{ target: { kind: "character", id: "char-alex" }, set: { identityImage: "https://example.test/face.png" } }] },
			{ ops: [{ target: { kind: "stage" }, set: { "keyLight.intensity": 4.5 } }] },
			{ ops: [{ target: { kind: "stage" }, set: { camera: "5:4" } }] },
		]) rejects(() => protocol.validateStudioCommand({ name: "patch_elements", args }));
		const patched = protocol.validateStudioCommand({ name: "patch_elements", args: { ops: [{ target: { kind: "shot" }, set: { targetModel: "seedance-2.5" } }] } });
		assert.deepEqual(patched.args.ops[0].target, { kind: "shot" });
	});
	test("L2 vec3 elements carry per-axis minimum/maximum, catalogue exposes matching range descriptors, and an out-of-range patch is rejected", () => {
		const scale = protocol.STUDIO_PATCH_SET_SCHEMAS.object.properties.scale;
		for (const axis of ["x", "y", "z"]) { assert.equal(scale.properties[axis].minimum, 0.01); assert.equal(scale.properties[axis].maximum, 100); }
		const objectPosition = protocol.STUDIO_PATCH_SET_SCHEMAS.object.properties.position;
		assert.deepEqual({ min: objectPosition.properties.x.minimum, max: objectPosition.properties.x.maximum }, { min: -240, max: 240 });
		assert.deepEqual({ min: objectPosition.properties.y.minimum, max: objectPosition.properties.y.maximum }, { min: 0, max: 240 });
		const charPosition = protocol.STUDIO_PATCH_SET_SCHEMAS.character.properties.position;
		for (const axis of ["x", "z"]) { assert.equal(charPosition.properties[axis].minimum, -240); assert.equal(charPosition.properties[axis].maximum, 240); }
		assert.equal(charPosition.properties.y.minimum, 0); assert.equal(charPosition.properties.y.maximum, 240);
		// The catalogue's patchable vocabulary carries the same declared ranges, not
		// just the bare path list.
		const objectDescriptor = protocol.STUDIO_PATCH_DESCRIPTORS.find(d => d.path === "object.scale");
		assert.deepEqual(objectDescriptor, { path: "object.scale", type: "vec3", min: { x: 0.01, y: 0.01, z: 0.01 }, max: { x: 100, y: 100, z: 100 } });
		const charPositionDescriptor = protocol.STUDIO_PATCH_DESCRIPTORS.find(d => d.path === "character.position");
		// The element's own range (±240 m), as arrange_characters places them: the ±4 m gizmo envelope only limits the UI
		// drag, and enforcing it here refused a pedestrian at x = -28.82 on a street set.
		assert.deepEqual(charPositionDescriptor.min, { x: -240, y: 0, z: -240 });
		assert.deepEqual(charPositionDescriptor.max, { x: 240, y: 240, z: 240 });
		assert.equal(protocol.validateStudioCommand({ name: "patch_elements", args: { ops: [{ target: { kind: "character", id: "char-alex" }, set: { position: { x: -28.82, y: 0, z: -0.4 } } }] } }).args.ops[0].set.position.x, -28.82);
		// An out-of-range patch on a vec3 axis is a structured rejection, not a
		// silent clamp.
		rejects(() => protocol.validateStudioCommand({ name: "patch_elements", args: { ops: [{ target: { kind: "object", id: "o-1" }, set: { scale: { x: 1, y: 1, z: 999 } } }] } }), "INVALID_ARGUMENT");
		rejects(() => protocol.validateStudioCommand({ name: "patch_elements", args: { ops: [{ target: { kind: "character", id: "char-alex" }, set: { position: { x: 999, y: 0, z: 0 } } }] } }), "INVALID_ARGUMENT");
		// A runtime fault in the editor is not the caller's input.
		assert.equal(protocol.refusalCode(new TypeError("Cannot read properties of undefined (reading 'current')")), "INTERNAL_ERROR");
		assert.equal(protocol.refusalCode(new Error("Invalid name")), "INVALID_ARGUMENT");
		assert.equal(protocol.refusalCode(new protocol.StudioProtocolError("STALE_TARGET", "gone")), "STALE_TARGET");
		assert.ok(protocol.STUDIO_ERROR_CODES.includes("INTERNAL_ERROR"));
		// The document range, not the ±4 m gizmo envelope of the UI drag, is what the agent path enforces: x = 5 is in.
		assert.equal(protocol.validateStudioCommand({ name: "patch_elements", args: { ops: [{ target: { kind: "character", id: "char-alex" }, set: { position: { x: 5, y: 0, z: 0 } } }] } }).args.ops[0].set.position.x, 5);
		// An out-of-range patch value names the offending path and the allowed
		// range instead of the generic union rejection: every patchOp variant
		// fails on a bad number, and the caller needs to know which path and
		// which bound, not just that no variant matched.
		try { protocol.validateStudioCommand({ name: "patch_elements", args: { ops: [{ target: { kind: "object", id: "cube-24" }, set: { scale: { x: 1, y: 0.006, z: 1 } } }] } }); assert.fail("out-of-range scale must be refused"); }
		catch (error) {
			assert.equal(error.code, "INVALID_ARGUMENT");
			assert.match(error.message, /scale\.y/);
			assert.match(error.message, /0\.01/);
			assert.match(error.message, /100/);
		}
		try { protocol.validateStudioCommand({ name: "patch_elements", args: { ops: [{ target: { kind: "character", id: "char-alex" }, set: { position: { x: 500, y: 0, z: 0 } } }] } }); assert.fail("out-of-range position must be refused"); }
		catch (error) {
			assert.equal(error.code, "INVALID_ARGUMENT");
			assert.match(error.message, /position\.x/);
			assert.match(error.message, /-240/);
			assert.match(error.message, /240/);
		}
	});
	test("D7 patch receipts report per-operation outcomes and never hide a dropped path", () => {
		const applied = receiptFixture(); applied.delta = [{ id: "char-alex", after: { patched: [{ path: "character.tint", text: "#a1b2c3" }] } }]; applied.ops = [{ index: 0, status: "applied" }];
		protocol.validateReceipt(applied);
		const partial = { ...structuredClone(applied), status: "partial", ops: [{ index: 0, status: "partial", droppedPaths: ["object.renderer"] }] };
		protocol.validateReceipt(partial);
		for (const mutate of [
			r => { r.status = "applied"; },
			r => { r.ops[0].droppedPaths = []; },
			r => { r.ops[0].index = 3; },
			r => { delete r.ops; },
		]) { const r = structuredClone(partial); mutate(r); rejects(() => protocol.validateReceipt(r), "INVALID_RECEIPT"); }
		const noop = receiptFixture("noop"); noop.ops = [{ index: 0, status: "partial", droppedPaths: ["object.renderer"] }];
		protocol.validateReceipt(noop);
		noop.ops = [{ index: 0, status: "applied" }]; rejects(() => protocol.validateReceipt(noop), "INVALID_RECEIPT");
		// Inside an agent turn the bus answers a mutation "completed" (the turn owns the undo entry);
		// a patch there still reports its ops.
		const { mutated: _mutated, ...rest } = structuredClone(applied);
		const composite = { ...rest, status: "completed", kind: "mutation", undo: { ...applied.undo, canUndoDirect: false } };
		protocol.validateReceipt(composite);
		composite.ops = [{ index: 1, status: "applied" }]; rejects(() => protocol.validateReceipt(composite), "INVALID_RECEIPT");
	});
	test("D4 context recursively rejects whole-document, credential and raw-pose payloads", () => {
		for (const mutate of [c => c.document = {}, c => c.entities[0].rawPose = [1,2,3], c => c.host.accessToken = "secret", c => c.scene.inactiveScenes = [], c => c.camera = { dataUrl: "data:image/png;base64,AA" }, c => c.entities[0].position.extra = {}, c => c.jobs.push({ id: "j", payload: {} }), c => c.assets.push({ imageId: "x", path: "/tmp/private" })]) { const c = contextFixture(); mutate(c); rejects(() => protocol.validateStudioContext(c)); }
	});
	test("D4 explicit empty and renderer-not-ready state is valid; missing state is not", () => {
		const c = contextFixture(); Object.assign(c, { selection: null, activeCharacterId: null, entities: [], entityPage: { returned: 0, total: 0, truncated: false, nextCursor: null } }); c.host.workspaceHandle = null; c.scene.frameCount = 0; c.scene.characterCount = 0; c.capabilities.rigReady = false;
		protocol.validateStudioContext(c);
		for (const key of ["selection","camera","jobs","entityPage","view","units"]) { const invalid = structuredClone(c); delete invalid[key]; rejects(() => protocol.validateStudioContext(invalid)); }
	});
	test("D4 context builder retains far selected/active/job/shot targets under truncation", () => {
		assert.equal(typeof contextTools.buildStudioContext, "function");
		const c = contextFixture();
		c.entities = Array.from({length: 80}, (_,i) => ({ id: `object-${String(i).padStart(3,"0")}`, kind: "object", name: "한".repeat(200), token: `t-${i}`, position: {x:i,y:0,z:0}, scale: { x: 1, y: 1, z: 1 } }));
		c.entities.push(contextFixture().entities[0]); c.scene.objectCount = 80;
		c.jobs = [{ id: "job-1", characterId: "char-alex", state: "generating" }];
		c.selection = {kind:"object",id:"object-079"};
		c.shot = {id:"shot-1",name:"Current",range:{startFrame:0,endFrameExclusive:144},mode:"keys",subjectIds:["object-078"]};
		c.shots = [{id:"shot-1",name:"Current",range:c.shot.range,keyCount:0}];
		const source = structuredClone(c); const result = contextTools.buildStudioContext(c);
		assert.deepEqual(c, source); assert.equal(result.entities.length,24); assert.equal(result.entityPage.total,81); assert.equal(result.entityPage.truncated,true);
		for (const id of ["object-079","char-alex","object-078"]) assert.ok(result.entities.some(e=>e.id===id));
		assert.ok(new TextEncoder().encode(contextTools.encodeStudioContext(result)).length <= protocol.STUDIO_CONTEXT_MAX_BYTES);
		assert.ok(result.entities.every(e=>!e.name || [...e.name].length <= 120)); protocol.validateStudioContext(result);
		const stale = structuredClone(result); stale.entities = stale.entities.filter(e=>e.id!=="char-alex"); stale.entityPage.returned--;
		rejects(()=>protocol.validateStudioContext(stale));
	});
	test("D4 context indexes every entity (cap 400) beside at most 24 detailed ones", () => {
		const c = contextFixture();
		c.entities = Array.from({length: 62}, (_,i) => ({ id: `object-${String(i).padStart(3,"0")}`, kind: "object", name: `Prop ${i}`, token: `t-${i}`, position: {x:i+0.123456,y:0,z:-2}, scale: { x: 1, y: 1, z: 1 } }));
		c.entities.push(contextFixture().entities[0]); c.scene.objectCount = 62; c.selection = {kind:"object",id:"object-061"};
		const result = contextTools.buildStudioContext(c);
		assert.equal(result.entities.length, 24); assert.equal(result.entityPage.total, 63);
		assert.deepEqual(result.entities.slice(0,2).map(e=>e.id), ["object-061","char-alex"], "selected, then active, lead the detail");
		assert.deepEqual(result.entityIndex.map(e=>e.id), c.entities.map(e=>e.id).sort(), "every entity is indexed in stable id order");
		assert.deepEqual(result.entityIndex.find(e=>e.id==="object-007"), { id: "object-007", kind: "object", name: "Prop 7", position: { x: 7.12, y: 0, z: -2 } });
		assert.deepEqual(result.entityIndex.find(e=>e.id==="char-alex"), { id: "char-alex", kind: "character", name: "Alex", position: { x: 0, y: 0, z: 0 } });
		protocol.validateStudioContext(result);
		const duplicate = structuredClone(result); duplicate.entityIndex.push(duplicate.entityIndex[0]); rejects(()=>protocol.validateStudioContext(duplicate), "INVALID_CONTEXT");
		const missing = structuredClone(result); missing.entityIndex = missing.entityIndex.filter(e=>e.id!=="object-061"); rejects(()=>protocol.validateStudioContext(missing), "INVALID_CONTEXT");
		const big = contextFixture();
		big.entities = Array.from({length: 450}, (_,i) => ({ id: `workshop-prop-${String(i).padStart(4,"0")}`, kind: "object", name: `Workshop prop number ${i}`, token: `t-${i}`, position: {x:i/7,y:0.25,z:-i/9}, scale: { x: 1, y: 1, z: 1 } }));
		big.entities.push(contextFixture().entities[0]); big.scene.objectCount = 450; big.selection = {kind:"object",id:"workshop-prop-0449"};
		const capped = contextTools.buildStudioContext(big);
		assert.equal(capped.entityIndex.length, 400); assert.equal(capped.entityPage.total, 451);
		for (const id of ["workshop-prop-0449","char-alex"]) assert.ok(capped.entityIndex.some(e=>e.id===id), `${id} survives the index cap`);
		assert.ok(new TextEncoder().encode(contextTools.encodeStudioContext(capped)).length <= protocol.STUDIO_CONTEXT_MAX_BYTES);
		protocol.validateStudioContext(capped);
	});
	test("D4 context assets list placeable catalogue kinds and imported scene assets", () => {
		const c = contextFixture();
		c.assets = [...["cube","sphere","capsule","cylinder","cone","plane"].map(kind => ({ kind, name: kind, type: "primitive" })), ...["text","point-light","effect"].map(kind => ({ kind, name: kind, type: "set-piece" })),
			{ id: "img-0a1b2c", name: "Poster", type: "image" }, { id: "mesh-3d4e5f", name: "Robot", type: "mesh" }];
		assert.deepEqual(contextTools.buildStudioContext(c).assets, c.assets, "no placeable asset is cut");
		protocol.validateStudioContext(c);
		for (const bad of [{ kind: "cube", id: "img-1", name: "Both", type: "primitive" }, { kind: "cube", name: "Cube", type: "bogus" }, { name: "Neither", type: "mesh" }, { imageId: "x", origin: "scene_asset" }]) {
			const invalid = contextFixture(); invalid.assets = [bad]; rejects(() => protocol.validateStudioContext(invalid), "INVALID_CONTEXT");
		}
	});
	test("D5 missing identity and each workspace/scene/epoch/token mismatch fail closed", () => {
		rejects(()=>protocol.validateTargetGuard({},{}));
		for (const key of Object.keys(guard())) { const value = guard(); delete value[key]; rejects(()=>protocol.validateTargetGuard(value,guard())); const changed = {...guard(),[key]:"other"}; rejects(()=>protocol.validateTargetGuard(changed,guard()),"STALE_TARGET"); }
		assert.equal(protocol.validateTargetGuard(guard(),guard()),true);
		const viewChange = contextFixture(); viewChange.revision.view++; assert.equal(protocol.validateTargetGuard(guard(),guard()),true);
		assert.equal(contextTools.studioCacheKey(viewChange),contextTools.studioCacheKey(contextFixture()));
	});
	test("D6 schemas are real frozen data", () => {
		for (const tool of protocol.STUDIO_CATALOGUE) { assert.equal(tool.parameters?.type,"object"); assert.equal(tool.parameters.additionalProperties,false); assert.ok(Object.isFrozen(tool.parameters)); }
	});
	test("D6 shared physical projection includes inactive IK and path timing, excludes view/names/tints", () => {
		assert.equal(typeof contextTools.physicsFingerprintInput,"function");
		const data = { objects:[{id:"prop-1",renderer:"cube",position:point(),rotationDeg:point(),scale:{x:1,y:1,z:1},footprint:{width:1,depth:1},height:1,supportY:1,parentId:null,attachment:null,path:null,hidden:false}], characters:[{id:"char-alex",incarnation:"i-1",modelId:"model-1",rigId:"rig-1",rigReady:true,hidden:false,position:point(),yawDeg:0,scale:1,takeId:null,sessionMotionId:null,motionRevision:0,calibrationRevision:0,ikRevision:0,waypoints:[]}],floor:{model:"flat",y:0}, frameCount:144 };
		data.characters.push({ ...structuredClone(data.characters[0]), id: "inactive-b", incarnation: "i-2" });
		const first = contextTools.physicsFingerprintInput(data);
		const cosmetic=structuredClone(data); cosmetic.view={frame:80}; cosmetic.characters[0].name="renamed"; cosmetic.characters[0].tint="#fff";
		assert.deepEqual(contextTools.physicsFingerprintInput(cosmetic),first);
		const ik=structuredClone(data); ik.characters[1].ikRevision++; assert.notDeepEqual(contextTools.physicsFingerprintInput(ik),first);
		const path=structuredClone(data); path.objects[0].path={points:[point(),{x:8,y:0,z:0}],speed:1,faceTravel:true,loop:false,extend:false,timing:null}; assert.notDeepEqual(contextTools.physicsFingerprintInput(path),first);
		const moved=structuredClone(path); moved.objects[0].path.speed=2; assert.notDeepEqual(contextTools.physicsFingerprintInput(moved),contextTools.physicsFingerprintInput(path));
		const timing = structuredClone(path); timing.objects[0].path.timing = { cuts: [], envelopes: [Array(24).fill(1)] };
		assert.notDeepEqual(contextTools.physicsFingerprintInput(timing), contextTools.physicsFingerprintInput(path));
		const hidden = structuredClone(data); hidden.objects[0].hidden = true;
		assert.notDeepEqual(contextTools.physicsFingerprintInput(hidden), first);
		assert.ok(Object.isFrozen(first.characters[0]));
	});
	test("D7 receipt variants require identity, revisions, actual readback and undo evidence", () => {
		for (const status of ["applied","noop","transient","installed","undone"]) protocol.validateReceipt(receiptFixture(status));
		for (const key of ["host","authored","revision","undo","checks","delta","warnings"]) { const invalid=receiptFixture(); delete invalid[key]; rejects(()=>protocol.validateReceipt(invalid)); }
		for(const mutate of [r=>r.revision.after=41,r=>r.undo.entries=2,r=>r.host.workspaceId="",r=>r.delta[0].after.rawPose=[1,2],r=>r.affectedIds=[],r=>r.undo=null]) {const r=receiptFixture();mutate(r);rejects(()=>protocol.validateReceipt(r));}
		const installed=receiptFixture("installed"); installed.installed.blocks[0].endFrameExclusive=73; rejects(()=>protocol.validateReceipt(installed));
		const noop=receiptFixture("noop");noop.undo={historyEntryId:"h",entries:1,canUndoDirect:true};rejects(()=>protocol.validateReceipt(noop));
	});
	test("D4 context selection types, shot modes and summarized ranges must agree", () => {
		const wrongKind=contextFixture();wrongKind.selection.kind="object";rejects(()=>protocol.validateStudioContext(wrongKind));
		const wrongMode=contextFixture();wrongMode.shot={id:"shot-1",name:"Shot",range:{startFrame:0,endFrameExclusive:144},mode:"bogus"};wrongMode.shots=[{id:"shot-1",name:"Shot",range:wrongMode.shot.range,keyCount:0}];rejects(()=>protocol.validateStudioContext(wrongMode));
		wrongMode.shot.mode="keys";wrongMode.shots[0].range={startFrame:0,endFrameExclusive:100};rejects(()=>protocol.validateStudioContext(wrongMode));
	});
	test("D7 receipt discriminators reject cross-variant data and require restored tokens", () => {
		const mixed=receiptFixture();mixed.view={before:1,after:2};rejects(()=>protocol.validateReceipt(mixed));
		const undo=receiptFixture("undone");delete undo.restoredTargets;rejects(()=>protocol.validateReceipt(undo));
		const fake=receiptFixture("undone");fake.restoredTargets[0].sceneEpoch="another-epoch";rejects(()=>protocol.validateReceipt(fake));
	});
	test("D4 compact fallback preserves every mandatory ID and validates stale cursors", () => {
		const c = contextFixture(); c.entities = Array.from({length:24},(_,i)=>({id:`char-${i}`,kind:"character",token:`t-${i}`,name:"<".repeat(120),position:point(),yawDeg:0,scale:1,motion:{takeId:null,frames:144,ikKeyCount:0,keyIds:Array.from({length:8},(_,j)=>`key-${j}-${"x".repeat(100)}`)}}));
		// Filler whose escaped names overflow the budget through the index alone.
		c.entities.push(...Array.from({length:376},(_,i)=>({id:`prop-${i}`,kind:"object",token:`p-${i}`,name:"<".repeat(120),position:point(),scale:{x:1,y:1,z:1}})));
		c.selection={kind:"character",id:"char-23"};c.activeCharacterId="char-22";c.scene.characterCount=24;c.scene.objectCount=376;
		const result=contextTools.buildStudioContext(c);assert.ok(result.entities.every(e=>e.detailsOmitted));assert.ok(result.entities.some(e=>e.id==="char-23"));assert.ok(result.entities.some(e=>e.id==="char-22"));
		assert.ok(result.entityIndex.length < 400 && result.entityIndex.some(e=>e.id==="char-23"),"the index sheds bystanders, never a detailed row");protocol.validateStudioContext(result);
		const cursor=contextTools.studioEntityCursor(result,10);assert.equal(contextTools.validateStudioCursor(cursor,result),10);
		const edited=structuredClone(result);edited.revision.scene++;edited.revision.physics++;edited.revision.view++;
		assert.equal(contextTools.validateStudioCursor(cursor,edited),10,"an unrelated edit keeps the cursor");
		for(const key of ["workspaceId","documentEpoch","sceneEpoch"]){const reopened=structuredClone(result);reopened.host[key]="other";rejects(()=>contextTools.validateStudioCursor(cursor,reopened),"STALE_CURSOR");}
		rejects(()=>contextTools.validateStudioCursor("pending",result),"STALE_CURSOR");
	});
	test("D3 every supported nested position/facing/object variant is executable", () => {
		for(const position of [{world:point()},{relativeTo:"ref",basis:"subject",side:"left",gapM:0.3,support:"floor"},{relativeTo:"ref",basis:"shot_camera",side:"behind",gapM:0,support:{objectId:"table"}},{between:["a","b"],fraction:0.5,support:"floor"},{onObject:"table",offsetXZ:{x:0,z:1}}]) {
			for(const facing of [{yawDeg:90},{towardId:"a"},{sameAsId:"a"},{awayFromId:"a"}]) protocol.validateStudioCommand({name:"arrange_objects",args:{ops:[{...createOp(),position,facing}]}});
		}
		for(const op of [{op:"update",id:"a",rotationDeg:point()},{op:"update",id:"a",hidden:true},{op:"remove",id:"a"},{op:"group",parentId:"a",childIds:["b"]},{op:"ungroup",childIds:["b"]}]) protocol.validateStudioCommand({name:"arrange_objects",args:{ops:[op]}});
		protocol.validateStudioCommand({name:"arrange_objects",args:{ops:[{...createOp(),position:{relativeTo:"a",basis:"world",side:"right",gapM:0.3,support:"floor"}}],collisionPolicy:"avoid"}});
		for(const op of [{op:"update",characterId:"a",scale:1.5},{op:"remove",characterId:"a"}]) protocol.validateStudioCommand({name:"arrange_characters",args:{ops:[op]}});
		protocol.validateStudioCommand({name:"frame_shot",args:{subjectIds:["a"],keyAtFrame:0,framing:{exact:{position:point(),lookAt:{x:0,y:0,z:0},focalMm:35}}}});
		for(const size of protocol.STUDIO_VARIANTS.framingSizes) for(const view of protocol.STUDIO_VARIANTS.framingViews) for(const level of protocol.STUDIO_VARIANTS.framingLevels) protocol.validateStudioCommand({name:"frame_shot",args:{subjectIds:["a"],framing:{intent:{size,view,level,side:"right"}}}});
	});
	test("D7 failure uncertainty and explicit unverified acceptance remain distinguishable", () => {
		const failure={ok:false,commandId:"cmd-1",host:receiptFixture().host,code:"UNCERTAIN_APPLY",phase:"reconcile",affectedIds:["char-alex"],expectedTargets:[guard()],currentTargets:[guard()],mutated:"unknown",preserved:{authoredState:"unknown"},recovery:{action:"reconcile",retryAllowed:false}};
		protocol.validateReceipt(failure);const unsafe=structuredClone(failure);unsafe.preserved.authoredState="unchanged";rejects(()=>protocol.validateReceipt(unsafe));
		const unverified=receiptFixture("installed");unverified.verification.status="unverified";unverified.verification.evaluatedFrames=0;
		rejects(()=>protocol.validateReceipt(unverified));unverified.explicitUnverifiedAcceptance=true;protocol.validateReceipt(unverified);
		// The install policy is the other recorded acceptor; nothing else admits an unverified take.
		const advisory=receiptFixture("installed");advisory.verification.status="unverified";advisory.explicitUnverifiedAcceptance=false;
		rejects(()=>protocol.validateReceipt(advisory));advisory.acceptance="advisory-policy";assert.equal(protocol.validateReceipt(advisory).acceptance,"advisory-policy");
		for(const acceptance of ["model","",true]){const forged=structuredClone(advisory);forged.acceptance=acceptance;rejects(()=>protocol.validateReceipt(forged));}
		const applied=receiptFixture("applied");applied.acceptance="advisory-policy";rejects(()=>protocol.validateReceipt(applied));
	});
	test("run_action names one registered action; inspect_studio scope actions discovers them", () => {
		assert.ok(protocol.STUDIO_TOOL_FAMILIES.includes("run_action"));
		assert.equal(typeof protocol.STUDIO_TOOL_LABELS.run_action, "string");
		assert.ok(protocol.STUDIO_VARIANTS.inspectionScopes.includes("actions"));
		assert.deepEqual(protocol.validateStudioCommand({ name: "inspect_studio", args: { scope: "actions" } }).args, { scope: "actions", limit: 12 });
		// The action's own schema validates its arguments in the editor; the
		// family carries them as one JSON object, detached from the caller's.
		const args = { shotId: "shot-1", range: { startFrame: 0, endFrameExclusive: 24 } };
		const command = protocol.validateStudioCommand({ name: "run_action", args: { action: "shot.setRange", args } });
		assert.deepEqual(command.args, { action: "shot.setRange", args });
		assert.notStrictEqual(command.args.args, args);
		assert.deepEqual(protocol.validateStudioCommand({ name: "run_action", args: { action: "shot.create" } }).args, { action: "shot.create" });
		for (const bad of [{}, { action: "" }, { action: "shot create" }, { action: "shot.create", args: [] }, { action: "shot.create", args: "x" }, { action: "shot.create", extra: 1 }]) {
			rejects(() => protocol.validateStudioCommand({ name: "run_action", args: bad }), "INVALID_ARGUMENT");
		}
		// A mutating action's receipt is an ordinary journal receipt that names
		// the action and what it did.
		const applied = { ...receiptFixture("applied"), action: "shot.create", summary: "Added Shot 2 at frames [48, 96)." };
		assert.equal(protocol.validateReceipt(applied).action, "shot.create");
		const noop = { ...receiptFixture("noop"), action: "shot.create", summary: "No room for a new shot." };
		assert.equal(protocol.validateReceipt(noop).summary, "No room for a new shot.");
		rejects(() => protocol.validateReceipt({ ...receiptFixture("applied"), action: "not an id" }), "INVALID_RECEIPT");
	});
	test("schema refusals name the path, what is allowed and what arrived (G3)", () => {
		const said = (name, args) => { try { protocol.validateStudioCommand({ name, args }); return "accepted"; } catch (error) { assert.equal(error.code, "INVALID_ARGUMENT"); return error.message; } };
		const exact = [
			["inspect_studio", { scope: "overview" }, '$.args.scope: "overview" is not one of: selection, scene, entities, shot, motion, catalogue, actions, document, relations.'],
			["inspect_studio", { scope: "actions", ids: '["motion.compile"]' }, "$.args.ids: expected an array of strings, got a string."],
			["inspect_studio", {}, '$.args: missing required field "scope".'],
			["inspect_studio", { scope: "actions", ids: ["a", "a"] }, '$.args.ids: items must be unique; "a" appears twice.'],
			["inspect_studio", { scope: "actions", ids: ["bad id"] }, '$.args.ids[0]: "bad id" does not match ^[A-Za-z0-9][A-Za-z0-9._:-]*$.'],
			["inspect_studio", { scope: "actions", ids: [""] }, "$.args.ids[0]: must not be empty."],
			["inspect_studio", { scope: "actions", limit: 1.5 }, "$.args.limit: expected an integer, got 1.5."],
			["inspect_studio", { scope: "actions", limit: 99 }, "$.args.limit: Expected a number within [1, 32], got 99."],
			["run_action", { action: "motion.compile", characterId: "char-a", args: {} }, '$.args has unknown field "characterId"; allowed: action, args, confirmationToken.'],
			["run_action", { action: "motion.compile", args: "{}" }, "$.args.args: expected an object, got a string."],
			["verify_result", { checks: [], targets: ["a"] }, "$.args.checks: expected 1 to 4 items, got 0."],
			["verify_result", { checks: ["motion"], targets: ["a"], range: "all" }, '$.args.range must be "whole_clip" or an object, got "all".'],
			["undo_edit", { receiptId: 3 }, "$.args.receiptId: expected a string, got a number."],
			["operate_studio", { selection: "char-a" }, '$.args.selection must be an object or null, got "char-a".'],
			["operate_studio", { playing: "yes" }, "$.args.playing: expected a boolean, got a string."],
			["arrange_objects", { ops: [{ op: "create", source: { kind: "cylinder" }, position: { world: { x: 1, y: 0, z: 0 }, extra: 1 } }] }, '$.args.ops[0].position has unknown field "extra"; allowed: world.'],
		];
		for (const [name, args, message] of exact) assert.equal(said(name, args), message);
		// A plain-value union names every form (an action input such as install: true, false or "ifClean").
		const install = { type: "object", properties: { install: { anyOf: [{ type: "boolean" }, { const: "ifClean" }] } }, required: [], additionalProperties: false };
		assert.throws(() => protocol.validateStudioSchema(install, { install: "yes" }, "INVALID_ARGUMENT", "$.args"), { message: '$.args.install must be true, false or "ifClean", got "yes".' });
		assert.deepEqual(protocol.validateStudioSchema(install, { install: "ifClean" }), { install: "ifClean" });
		// A long payload shows as a 40-character preview, never whole.
		const long = said("inspect_studio", { scope: "x".repeat(500) });
		assert.ok(long.startsWith('$.args.scope: "xxxxxxxx') && long.includes('... is not one of:') && long.length < 160, long);
	});
	test("pi tool arguments: an unknown field is named, an array sent as JSON text is parsed (G3)", () => {
		const tools = toAgentTools(["run_action", "inspect_studio"].map(name => ({ name, parameters: protocol.STUDIO_TOOL_SCHEMAS[name], handler: async () => ({}) })));
		const call = (name, args) => { const tool = tools.find(t => t.name === name); return validateToolArguments(tool, { name, arguments: tool.prepareArguments(args) }); };
		// run3 turn 2, the first motion.compile: characterId beside args, not inside it
		assert.throws(() => call("run_action", { action: "motion.compile", characterId: "char-a", args: { characterId: "char-a", base: "spec-12350683d8db", install: false } }),
			{ message: 'Validation failed for tool "run_action": root has unknown field "characterId"; allowed: action, args, confirmationToken. The action\'s own inputs go inside args: { "action": "<id>", "args": { ... } }.' });
		assert.throws(() => call("inspect_studio", { section: "selection" }),
			{ message: 'Validation failed for tool "inspect_studio": root has unknown field "section"; allowed: scope, ids, select, query, cursor, limit; missing required: scope.' });
		// run3 turn 1: ids as JSON text is taken as the array it encodes, and still validated
		assert.deepEqual(call("inspect_studio", { scope: "actions", ids: '["motion.compile", "motion.describe"]' }), { scope: "actions", ids: ["motion.compile", "motion.describe"] });
		assert.throws(() => call("inspect_studio", { scope: "actions", ids: '["bad id"]' }), /ids\.0: must match pattern/);
		assert.deepEqual(call("run_action", { action: "motion.compile", args: { characterId: "char-a" } }), { action: "motion.compile", args: { characterId: "char-a" } });
	});
	test("HTTP stale epoch/token fences use authoritative injected state before execution", async()=>{
		let executed=0;const runtime={readContext:async()=>contextFixture(),handleTurn:async(v,req,res)=>{executed++;res.writeHead(200,{"content-type":"application/json"});res.end(JSON.stringify({turnId:v.turnId}));}};
		await withHttp(async(post,calls)=>{
			const good=envelopeFixture();const result=await post(good);assert.equal(result.status,200);assert.equal(JSON.parse(result.text).turnId,good.turnId);assert.equal(executed,1);assert.equal(calls.length,0);
			for(const mutate of [v=>v.context.host.sceneEpoch="other",v=>v.context.host.workspaceId="other",v=>v.context.entities[0].token="new"]){const v=envelopeFixture();mutate(v);const r=await post(v);assert.equal(r.status,409);assert.equal(executed,1);}
			const viewOnly=envelopeFixture();viewOnly.context.revision.view++;viewOnly.context.view.frame=1;assert.equal((await post(viewOnly)).status,200);assert.equal(executed,2);
		}, {studioRuntime:runtime});
	});
	test("HTTP rejects malformed/oversized/unknown envelopes before model dispatch; legacy unchanged", async () => {
		await withHttp(async(post,calls)=> {
			for(const mutate of [v=>v.context.host.sceneEpoch="",v=>v.context.document={},v=>v.context.scene.name="a".repeat(20000),v=>v.context.revision.scene=-1,v=>v.turnId="bad",v=>v.effort="bogus",v=>v.text=1]) {const value=envelopeFixture();mutate(value);const r=await post(value);assert.equal(r.status,400);assert.equal(calls.length,0);}
			const legacy=await post({sessionId:"legacy",text:"hello"});assert.equal(legacy.status,200);assert.match(legacy.contentType,/text\/event-stream/);assert.equal(calls.length,1);
			const badLegacy=await post({sessionId:"legacy",text:1});assert.equal(badLegacy.status,400);assert.deepEqual(JSON.parse(badLegacy.text),{error:"invalid request"});
		});
	});
	test("route marks: a number or { t, bank, pitch } is accepted and passed through untouched", () => {
		const route = marks => ({ name: "patch_elements", args: { ops: [{ target: { kind: "object", id: "car" }, set: { path: { points: [{ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 9 }], marks } } }] } });
		const marks = [0.25, { t: 0.5, bank: 12, pitch: -4 }, { t: 0.75 }];
		const valid = protocol.validateStudioCommand(route(marks));
		assert.deepEqual(valid.args.ops[0].set.path.marks, marks, "the lean rides through as authored");
		assert.deepEqual(protocol.validateStudioCommand(route([0.2, 0.6])).args.ops[0].set.path.marks, [0.2, 0.6], "plain numbers still work");
		rejects(() => protocol.validateStudioCommand(route([{ t: 0.5, bank: 120 }])), "INVALID_ARGUMENT");
		rejects(() => protocol.validateStudioCommand(route([{ bank: 10 }])), "INVALID_ARGUMENT");
		rejects(() => protocol.validateStudioCommand(route([{ t: 0.5, roll: 10 }])), "INVALID_ARGUMENT");
		// the readback row echoes the marks, lean included
		const context = contextFixture();
		context.entities.push({ id: "car", kind: "object", token: "t-car", pathPointCount: 2, pathMarks: marks });
		context.entityPage = { returned: 2, total: 2, truncated: false, nextCursor: null };
		protocol.validateStudioContext(context);
		context.entities.at(-1).pathMarks = [{ t: 0.5, bank: 200 }];
		rejects(() => protocol.validateStudioContext(context));
	});
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const caseFlag=process.argv.indexOf("--case");
	if(caseFlag!==-1 && process.argv[caseFlag+1]!=="context-and-stale-target") throw new Error("Unknown case");
	registerTests();
}
