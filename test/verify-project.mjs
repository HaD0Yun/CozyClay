// Project file envelope: create/parse round-trip, validation, and the
// boundaries that keep a project file from clobbering the session.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { webcrypto } from "node:crypto";
import {
	createProjectDocument,
	buildAnimationProjectFromStoryboard,
	readProjectDocument,
	verifyEmbeddedAsset,
	createWorkflowGraph,
	normalizeWorkflowGraph,
	isWorkflowGraph,
	PROJECT_VERSION,
	PROJECT_EXTENSION,
	PROJECT_MAX_RESOURCE_BYTES,
} from "../src/project.js";
import { createSceneDocument, createSceneStage, SCENES_VERSION } from "../src/scenes.js";
import { ASSET_MAX_SOURCE_BYTES, assetIdForBytes, meshIdForBytes, referencedAssetIds } from "../src/scene-assets.js";

// The studio source spans App.jsx and app-stage.jsx (module-level extraction); pin against both.
import { readStudioSource } from "./bus/verify-domain-modules.mjs";
const appSource = readStudioSource()
	+ readFileSync(new URL("../src/app-stage.jsx", import.meta.url), "utf8") + readFileSync(new URL("../src/project-assets.js", import.meta.url), "utf8");

// --- envelope round trip --------------------------------------------------
const projectPose = { id: "custom_1", label: "My Pose", bones: { hips: [0.1, 0, 0] } };
const scenesDocument = createSceneDocument("SCENE 01");
scenesDocument.scenes[0].stage = createSceneStage({
	characters: [{ id: "char-a", model: "x-bot-tpose", x: 1, z: -2, rot: 30, tint: "#a1b2c3", subject: "a robot", pose: projectPose }],
});
const doc = createProjectDocument({
	scenesDocument,
	workspaceLayout: { hierarchyWidth: 320, sidebarWidth: 400 },
	customPoses: [projectPose],
	name: "Demo Reel",
});
const parsed = readProjectDocument(JSON.stringify(doc));
assert.equal(parsed.ok, true);
assert.equal(buildAnimationProjectFromStoryboard({ ...parsed.project, previsMode: "storyboard" }).previsMode, "animation");
assert.equal(parsed.project.name, "Demo Reel");
assert.equal(parsed.project.scenesDocument.scenes[0].stage.characters[0].model, "x-bot-tpose");
assert.equal(parsed.project.scenesDocument.scenes[0].stage.characters[0].tint, "#a1b2c3");
assert.equal(parsed.project.workspaceLayout.hierarchyWidth, 320);
assert.equal(parsed.project.customPoses.length, 1);
assert.deepEqual(parsed.project.scenesDocument.scenes[0].stage.characters[0].pose, projectPose, "a project scene keeps its embedded pose data after a file round-trip");

// --- workflow graph envelope + migration ---------------------------------
const workflow = {
	version: 1,
	nodes: [
		{ id: "prompt", type: "Text", position: { x: 24, y: 48 }, data: { text: "a clay robot", status: "ready" } },
		{ id: "scene", type: "CozyClayScene", position: { x: 320, y: 48 }, data: { sceneId: "SCENE 01", outputUrl: "/renders/scene.mp4" } },
		{ id: "bad-duplicate", type: "Ignored", position: { x: 0, y: 0 } },
	],
	edges: [
		{ id: "prompt-scene", source: "prompt", target: "scene" },
		{ source: "missing", target: "scene" },
	],
};
const workflowDocument = createProjectDocument({ scenesDocument, workflow });
assert.equal(workflowDocument.version, PROJECT_VERSION, "project envelope version advances with workflow persistence");
assert.deepEqual(workflowDocument.workflow, normalizeWorkflowGraph(workflow), "project creation stores a sanitized workflow graph");
const workflowRoundTrip = readProjectDocument(JSON.stringify(workflowDocument));
assert.equal(workflowRoundTrip.ok, true);
assert.deepEqual(workflowRoundTrip.project.workflow, workflowDocument.workflow, "workflow graph survives a project round-trip");
assert.deepEqual(createWorkflowGraph(), { version: 1, nodes: [], edges: [] }, "new projects start with an empty workflow graph");
assert.equal(isWorkflowGraph(workflowDocument.workflow), true, "normalized graph passes schema validation");
assert.equal(isWorkflowGraph({ version: 1, nodes: [{ id: "x", position: { x: 0, y: 0 } }], edges: [] }), true, "node type/data are optional in the persisted schema");
assert.equal(isWorkflowGraph({ version: 1, nodes: [], edges: [{ source: "missing", target: "also-missing" }] }), false, "dangling workflow edges fail validation");

const legacyWithoutWorkflow = { ...doc, version: 2 };
delete legacyWithoutWorkflow.workflow;
const migratedLegacy = readProjectDocument(JSON.stringify(legacyWithoutWorkflow));
assert.equal(migratedLegacy.ok, true, "pre-workflow project files remain readable");
assert.deepEqual(migratedLegacy.project.workflow, createWorkflowGraph(), "legacy files migrate to an empty workflow graph");
const malformedWorkflow = readProjectDocument(JSON.stringify({ ...doc, workflow: { version: 99, nodes: "bad", edges: [] } }));
assert.equal(malformedWorkflow.ok, true, "malformed workflow data does not block opening the scene project");
assert.deepEqual(malformedWorkflow.project.workflow, createWorkflowGraph(), "unsupported workflow data falls back to the safe default");

// --- embedded scene assets -------------------------------------------------
const renderedBytes = new Uint8Array([1, 2, 3]);
const sourceBytes = new Uint8Array([4, 5, 6]);
const matteBytes = new Uint8Array([7, 8, 9]);
const orphanBytes = new Uint8Array([10]);
const [renderedAssetId, sourceAssetId, matteAssetId, orphanAssetId] = await Promise.all([
	assetIdForBytes(renderedBytes, webcrypto.subtle),
	assetIdForBytes(sourceBytes, webcrypto.subtle),
	assetIdForBytes(matteBytes, webcrypto.subtle),
	assetIdForBytes(orphanBytes, webcrypto.subtle),
]);
const assetScenesDocument = createSceneDocument("CUTOUTS");
assetScenesDocument.scenes[0].objects = [{
	id: "matted-cutout",
	renderer: "cutout",
	assetId: renderedAssetId,
	sourceAssetId,
	matteAssetId,
}];
const fakeAssets = [
	{ id: renderedAssetId, type: "image/png", width: 80, height: 60, name: "rendered.png", bytes: renderedBytes },
	{ id: sourceAssetId, type: "image/jpeg", width: 80, height: 60, name: "source.jpg", bytes: sourceBytes },
	{ id: matteAssetId, type: "image/png", width: 80, height: 60, name: "matte.png", bytes: matteBytes },
	{ id: orphanAssetId, type: "image/png", width: 80, height: 60, name: "orphan.png", bytes: orphanBytes },
];
const assetDocument = createProjectDocument({ scenesDocument: assetScenesDocument, assets: fakeAssets });
const embeddedAssetIds = assetDocument.resources.assets.map((asset) => asset.id).sort();
assert.deepEqual(embeddedAssetIds, [...referencedAssetIds(assetScenesDocument.scenes)].sort(), "only the matted cutout asset closure is embedded");
assert.equal(assetDocument.version, PROJECT_VERSION, "asset-bearing documents use the current envelope version");
assert.equal("assets" in assetDocument, false, "v4 documents carry images only under resources, never at the top level");
assert.ok(assetDocument.resources.assets.every((asset) => typeof asset.bytes === "string" && !asset.bytes.startsWith("data:")), "asset bytes are bare base64");
const parsedAssets = readProjectDocument(JSON.stringify(assetDocument));
assert.equal(parsedAssets.ok, true);
assert.deepEqual(parsedAssets.problems, [], "a clean document reports no resource problems");
assert.deepEqual(
	parsedAssets.project.assets.map(({ id: assetId, type, width, height, name, bytes }) => ({ assetId, type, width, height, name, bytes: [...new Uint8Array(bytes)] })),
	assetDocument.resources.assets.map(({ id: assetId, type, width, height, name, bytes }) => ({
		assetId,
		type,
		width,
		height,
		name,
		bytes: [...Buffer.from(bytes, "base64")],
	})),
	"embedded asset records round-trip byte-for-byte",
);
const workflowAssetDocument = createProjectDocument({
	scenesDocument: createSceneDocument("WORKFLOW ONLY"),
	workflow: {
		version: 1,
		nodes: [{
			id: "scene-output",
			type: "scene",
			position: { x: 0, y: 0 },
			data: { resultUrl: { assetRef: sourceAssetId } },
		}],
		edges: [],
	},
	assets: fakeAssets,
});
assert.deepEqual(
	workflowAssetDocument.resources.assets.map((asset) => asset.id),
	[sourceAssetId],
	"workflow assetRefs are included even without a scene-object reference",
);
const workflowAssetRoundTrip = readProjectDocument(JSON.stringify(workflowAssetDocument));
assert.deepEqual(
	workflowAssetRoundTrip.project.assets.map((asset) => asset.id),
	[sourceAssetId],
	"workflow-only embedded assets round-trip through the project reader",
);

// --- embedded hash verification -------------------------------------------
assert.equal(await verifyEmbeddedAsset(fakeAssets[0], webcrypto.subtle), true, "matching embedded bytes verify against their content address");
assert.equal(await verifyEmbeddedAsset({ ...fakeAssets[0], id: sourceAssetId }, webcrypto.subtle), false, "mismatched embedded bytes fail content-address verification");
assert.deepEqual(
	fakeAssets.filter((asset) => referencedAssetIds(assetScenesDocument.scenes).has(asset.id)).map((asset) => asset.id).sort(),
	[renderedAssetId, sourceAssetId, matteAssetId].sort(),
	"the referenced closure excludes unrelated embedded ids",
);

// --- embedded mesh assets --------------------------------------------------
// A GLB shares the resources.assets bag with pictures but lives under mesh-
// ids. verifyEmbeddedAsset has to hash with meshIdForBytes or a round-trip
// would look like a mismatched image id.
const meshSourceBytes = new Uint8Array(readFileSync(new URL("./fixtures/unit-cube.glb", import.meta.url)));
const meshAssetId = await meshIdForBytes(meshSourceBytes, webcrypto.subtle);
const meshAssetRecord = {
	id: meshAssetId,
	type: "model/gltf-binary",
	name: "unit-cube.glb",
	bytes: meshSourceBytes,
};
assert.equal(await verifyEmbeddedAsset(meshAssetRecord, webcrypto.subtle), true, "matching embedded mesh bytes verify against their mesh- content address");
const objSourceBytes = new Uint8Array(readFileSync(new URL("./fixtures/unit-cube.obj", import.meta.url)));
const objAssetId = await meshIdForBytes(objSourceBytes, webcrypto.subtle);
const objAssetRecord = {
	id: objAssetId,
	type: "model/obj",
	name: "unit-cube.obj",
	bytes: objSourceBytes,
};
assert.equal(await verifyEmbeddedAsset(objAssetRecord, webcrypto.subtle), true, "matching embedded OBJ bytes verify against their mesh- content address");
const fbxSourceBytes = new Uint8Array(readFileSync(new URL("./fixtures/unit-cube.fbx", import.meta.url)));
const fbxAssetId = await meshIdForBytes(fbxSourceBytes, webcrypto.subtle);
const fbxAssetRecord = {
	id: fbxAssetId,
	type: "model/fbx",
	name: "unit-cube.fbx",
	bytes: fbxSourceBytes,
};
assert.equal(await verifyEmbeddedAsset(fbxAssetRecord, webcrypto.subtle), true, "matching embedded FBX bytes verify against their mesh- content address");
assert.ok(assetDocument.resources.assets.every((asset) => asset.id.startsWith("img-")), "a picture-only project still embeds only image ids");

const meshScenesDocument = createSceneDocument("MESH");
meshScenesDocument.scenes[0].objects = [{
	id: "cooker",
	renderer: "mesh",
	assetId: meshAssetId,
	height: 1,
	footprint: { width: 1, depth: 1 },
	clay: false,
}];
const meshDocument = createProjectDocument({ scenesDocument: meshScenesDocument, assets: [meshAssetRecord] });
assert.deepEqual(meshDocument.resources.assets.map((asset) => asset.id), [meshAssetId], "a referenced mesh blob is embedded");
assert.equal(meshDocument.resources.assets[0].type, "model/gltf-binary");
assert.ok(typeof meshDocument.resources.assets[0].bytes === "string" && !meshDocument.resources.assets[0].bytes.startsWith("data:"), "mesh bytes are bare base64 like pictures");
const parsedMesh = readProjectDocument(JSON.stringify(meshDocument));
assert.equal(parsedMesh.ok, true);
assert.deepEqual(parsedMesh.problems, [], "a clean mesh document reports no resource problems");
const roundTrippedMesh = parsedMesh.project.assets.find((asset) => asset.id === meshAssetId);
assert.ok(roundTrippedMesh, "the mesh id survives a project round-trip");
assert.deepEqual([...new Uint8Array(roundTrippedMesh.bytes)], [...meshSourceBytes], "embedded mesh bytes round-trip byte-for-byte");

const mixedScenesDocument = createSceneDocument("MIXED");
mixedScenesDocument.scenes[0].objects = [
	{ id: "cooker", renderer: "mesh", assetId: meshAssetId, height: 1, footprint: { width: 1, depth: 1 } },
	{ id: "card", renderer: "cutout", assetId: sourceAssetId, sourceAssetId, matteAssetId: "" },
];
const mixedDocument = createProjectDocument({
	scenesDocument: mixedScenesDocument,
	assets: [meshAssetRecord, ...fakeAssets],
});
assert.deepEqual(
	mixedDocument.resources.assets.map((asset) => asset.id).sort(),
	[meshAssetId, sourceAssetId].sort(),
	"mesh- and img- ids may sit together in resources.assets",
);
const parsedMixed = readProjectDocument(JSON.stringify(mixedDocument));
assert.equal(parsedMixed.ok, true);
assert.equal(parsedMixed.project.assets.some((asset) => asset.id === meshAssetId), true);
assert.equal(parsedMixed.project.assets.some((asset) => asset.id === sourceAssetId), true);

// --- validation boundaries ------------------------------------------------
assert.equal(readProjectDocument("{broken").ok, false, "corrupt JSON rejected");
assert.equal(readProjectDocument("{broken").reason, "corrupt");
assert.equal(readProjectDocument(JSON.stringify({ app: "cozyclay", kind: "project", version: PROJECT_VERSION + 1 })).reason, "future", "a newer file version never loads");
assert.equal(readProjectDocument(JSON.stringify({ app: "other", kind: "project", version: 1 })).reason, "not-a-project");
assert.equal(
	readProjectDocument(JSON.stringify({ app: "cozyclay", kind: "project", version: 1, scenes: { version: SCENES_VERSION + 1, scenes: [] } })).reason,
	"scenes-invalid",
	"a project holding future scenes stays sealed",
);

// name fallback + pose filtering
const unnamed = readProjectDocument(JSON.stringify(createProjectDocument({ scenesDocument, name: "  " })));
assert.equal(unnamed.project.name, "Untitled");
const dirtyPoses = readProjectDocument(JSON.stringify({ ...doc, poseLibrary: [{ id: "ok", bones: {} }, { nope: true }, null, { id: 3, bones: {} }] }));
assert.equal(dirtyPoses.project.customPoses.length, 1, "pose library entries without id+bones are dropped");

const { resources: _v4Resources, ...v1Document } = { ...doc, version: 1 };
const parsedV1 = readProjectDocument(JSON.stringify(v1Document));
assert.equal(parsedV1.ok, true, "v1 documents without assets remain readable");
assert.deepEqual(parsedV1.project.assets, [], "v1 documents produce no assets to hydrate");
assert.equal(parsedV1.project.motions, undefined, "a project carries no embedded motion clips");
const malformedAssets = readProjectDocument(JSON.stringify({
	...assetDocument,
	resources: {
		...assetDocument.resources,
		assets: [
			{ ...assetDocument.resources.assets[0], id: "junk" },
			{ ...assetDocument.resources.assets[1], bytes: "not base64!" },
			{ ...assetDocument.resources.assets[2], bytes: "A".repeat(Math.ceil((ASSET_MAX_SOURCE_BYTES + 1) / 3) * 4) },
			assetDocument.resources.assets[0],
			assetDocument.resources.assets[0],
		],
	},
}));
assert.equal(malformedAssets.ok, true, "malformed embedded assets never reject a project");
assert.deepEqual(malformedAssets.project.assets.map((asset) => asset.id), [assetDocument.resources.assets[0].id], "malformed and repeated embedded assets are skipped");
assert.equal(malformedAssets.warnings.length, 4, "each skipped embedded asset is warned about");
assert.deepEqual(
	malformedAssets.problems.map(({ kind, id, code }) => ({ kind, id, code })),
	[
		{ kind: "image", id: "junk", code: "bad-id" },
		{ kind: "image", id: assetDocument.resources.assets[1].id, code: "bad-base64" },
		{ kind: "image", id: assetDocument.resources.assets[2].id, code: "too-large" },
		{ kind: "image", id: assetDocument.resources.assets[0].id, code: "duplicate" },
	],
	"each skipped embedded asset is reported as a structured problem",
);
assert.ok(malformedAssets.problems.every((problem) => typeof problem.message === "string" && problem.message), "every problem carries a message");

// --- v3 compatibility: top-level assets ------------------------------------
const { resources: v3Resources, ...v3Document } = { ...assetDocument, version: 3, assets: assetDocument.resources.assets };
const parsedV3 = readProjectDocument(JSON.stringify(v3Document));
assert.equal(parsedV3.ok, true, "v3 documents with top-level assets remain readable");
assert.deepEqual(parsedV3.project.assets.map((asset) => asset.id).sort(), v3Resources.assets.map((asset) => asset.id).sort(), "v3 top-level assets hydrate as before");

const v4IgnoresTopLevel = readProjectDocument(JSON.stringify({ ...assetDocument, resources: { assets: [], motions: [] }, assets: assetDocument.resources.assets }));
assert.deepEqual(v4IgnoresTopLevel.project.assets, [], "a v4 document reads images from resources only");

// --- CozyClay 3: a take travels as its spec, never as embedded clip bytes --
{
	const legacy = readProjectDocument(JSON.stringify({ ...doc, resources: { ...doc.resources, motions: [{ motionId: "a".repeat(64), encoding: "base64", data: "AAAA", bytes: 3 }] } }));
	assert.equal(legacy.ok, true, "a 2.x file with embedded motions still opens");
	assert.equal(legacy.project.motions, undefined, "its embedded npz clips are ignored, not hydrated");
	assert.deepEqual(Object.keys(createProjectDocument({ scenesDocument }).resources), ["assets"], "a saved project embeds images and meshes only");
	assert.deepEqual(Object.keys(createProjectDocument({ scenesDocument, motions: [{ motionId: "a".repeat(64), bytes: new ArrayBuffer(8) }] }).resources), ["assets"], "motion records passed by an old caller are not embedded");
}

// --- handle re-authorization (#51) -----------------------------------------
// Chromium demotes a persisted handle's permission to "prompt" on the next
// visit; requestHandlePermission escalates it back inside a user gesture.
import { requestHandlePermission } from "../src/project.js";

{
	const calls = [];
	const handle = (query, request) => ({
		async queryPermission(options) {
			calls.push(["query", options?.mode]);
			if (query instanceof Error) throw query;
			return query;
		},
		async requestPermission(options) {
			calls.push(["request", options?.mode]);
			if (request instanceof Error) throw request;
			return request;
		},
	});

	calls.length = 0;
	assert.equal(await requestHandlePermission(handle("granted", "granted")), "granted", "a granted handle stays granted");
	assert.deepEqual(calls, [["query", "readwrite"]], "a granted handle never re-prompts");

	calls.length = 0;
	assert.equal(await requestHandlePermission(handle("prompt", "granted")), "granted", "a demoted handle is re-requested");
	assert.deepEqual(calls, [["query", "readwrite"], ["request", "readwrite"]], "a demoted handle escalates through requestPermission");

	assert.equal(await requestHandlePermission(handle("prompt", "denied")), "denied", "a refused prompt reports denied");
	assert.equal(await requestHandlePermission(handle(new Error("boom"), "granted")), "denied", "a throwing queryPermission reports denied, never throws");
	assert.equal(await requestHandlePermission(handle("prompt", new Error("boom"))), "denied", "a throwing requestPermission reports denied, never throws");
}

const browserSource = readFileSync(new URL("../src/project-browser.jsx", import.meta.url), "utf8");
assert.match(appSource, /requestHandlePermission/, "opening a stored handle re-authorizes it inside the click gesture (#51)");
assert.match(browserSource, /requestHandlePermission/, "the projects folder offers one-click re-authorization (#51)");

// --- App wiring ------------------------------------------------------------
assert.match(appSource, /createProjectDocument/, "App builds the project envelope");
assert.match(appSource, /readProjectDocument/, "App parses project files");
assert.match(appSource, /pickProjectFileForSave/, "Save uses the FS Access picker");
assert.match(appSource, /downloadProjectFallback/, "non-FS-Access browsers get a download fallback");
// The store itself happens inside project.js (openProjectFile/pickProjectFileForSave
// call storeProjectHandle); App's side of the contract is restoring it. The old pin
// on appSource was satisfied by a dead import, not by a call.
assert.match(readFileSync(new URL("../src/project.js", import.meta.url), "utf8"), /await storeProjectHandle\(/, "the last handle is remembered for auto-restore");
assert.match(appSource, /loadStoredProjectHandle/, "App restores the remembered handle on boot");
assert.match(appSource, /queryHandlePermission/, "auto-restore only with a granted handle");
assert.match(appSource, /referencedAssetIds/, "export finds the complete referenced asset closure");
assert.match(appSource, /getAsset/, "export reads referenced asset records from IndexedDB");
assert.match(appSource, /putAsset/, "open restores embedded asset records to IndexedDB");
assert.match(appSource, /verifyEmbeddedAsset\(asset\)/, "project open verifies mesh blobs with mesh- ids, not as img-");
assert.match(appSource, /meshBoundsFromAsset\(/, "shelf spawn measures OBJ, FBX and GLB through one helper, not parseGlbBounds alone");
assert.doesNotMatch(appSource, /type:\s*mimeOk\s*\?\s*mime\s*:\s*"model\/gltf-binary"/, "MCP mesh File type is not coerced onto glTF-binary");
assert.match(appSource, /data:model\/fbx/, "MCP mesh import accepts a model/fbx data URL");
assert.match(appSource, /nameLower\.endsWith\("\.fbx"\)/, "MCP mesh import accepts text/plain ASCII FBX by filename");
assert.doesNotMatch(
	appSource,
	/placeAs === "mesh"[\s\S]{0,400}add_character|placeAs === "mesh"[\s\S]{0,400}createCharacterEntry/,
	"MCP mesh import does not stand the file up as a character",
);
assert.match(appSource, /internWorkflowOutputs\(/, "project save interns workflow image outputs");
assert.match(appSource, /resolveWorkflowOutputs\(/, "project open restores runtime workflow output URLs");
assert.match(appSource, /resourceManifest\(/, "App computes project resource status");
assert.match(appSource, /<ResourceStatus\b/, "the project menu shows resource status");
assert.match(appSource, /<SaveBlockedDialog\b/, "missing or oversized resources have a save-blocked dialog");
assert.match(appSource, /__cozyclayProject/, "browser QA can exercise the production project export/open path");
assert.match(appSource, /projectDirty/, "unsaved changes surface as a dirty marker");
assert.ok(PROJECT_EXTENSION.length > 1, "project files carry an extension");

console.log("embedded asset round-trip and compatibility checks PASS");
console.log("all project file checks PASS");
