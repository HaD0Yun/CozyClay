// Cast style (rig / capsule / hybrid) is chosen when a project is created and
// travels with it: the file, the session record, the project.new command, the
// agent context and the analytics mirror. A new project starts on an empty
// stage, so the cast guards accept zero characters.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
	CAST_STYLES, DEFAULT_CAST_STYLE, normalizeCastStyle, createProjectDocument, readProjectDocument,
	animationCopyOfStoryboard, storeProjectSession, loadProjectSession,
} from "../src/project.js";
import { createSceneDocument, PROXY_FIGURE_MODEL } from "../src/scenes.js";
import * as protocol from "../src/studio-agent-protocol.js";
import { CAST_STYLE_VALUES, sanitizeProps } from "../src/analytics.js";
import { declarations as projectDeclarations } from "../src/commands/project.js";
import { addCharacterEntries } from "../src/shell/add-character-entries.js";
import { castFixture } from "./bus/cast-fixture.mjs";
import { projectFixture } from "./bus/project-fixture.mjs";

const memoryStorage = () => {
	const values = new Map();
	return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)) };
};
const ok = receipt => { assert.equal(receipt.ok, true, JSON.stringify(receipt)); return receipt; };

test("normalizeCastStyle keeps the three styles and reads anything else as hybrid", () => {
	assert.deepEqual([...CAST_STYLES], ["rig", "capsule", "hybrid"]);
	assert.equal(DEFAULT_CAST_STYLE, "hybrid");
	for (const style of CAST_STYLES) assert.equal(normalizeCastStyle(style), style);
	for (const value of [undefined, null, "", "Rig", "proxy", 3, {}]) assert.equal(normalizeCastStyle(value), "hybrid");
});

test("the project file writes castStyle and an old file without it opens as hybrid", () => {
	const scenesDocument = createSceneDocument();
	const written = createProjectDocument({ scenesDocument, name: "Capsules", castStyle: "capsule" });
	assert.equal(written.castStyle, "capsule");
	assert.equal(readProjectDocument(JSON.stringify(written)).project.castStyle, "capsule", "castStyle survives save and open");
	const legacy = { ...written };
	delete legacy.castStyle;
	assert.equal(readProjectDocument(JSON.stringify(legacy)).project.castStyle, "hybrid", "a file from before the choice opens as hybrid");
	assert.equal(readProjectDocument(JSON.stringify({ ...written, castStyle: "giant" })).project.castStyle, "hybrid", "an unknown style reads as hybrid");
	assert.equal(createProjectDocument({ scenesDocument, name: "Default" }).castStyle, "hybrid");
	const storyboard = readProjectDocument(JSON.stringify({ ...createProjectDocument({ scenesDocument, name: "Boards", castStyle: "rig" }), previsMode: "storyboard" })).project;
	assert.equal(animationCopyOfStoryboard(storyboard).castStyle, "rig", "the animation copy of a storyboard file keeps the cast style");
});

test("the session record keeps castStyle", () => {
	const storage = memoryStorage();
	assert.equal(storeProjectSession("Boards", { castStyle: "capsule" }, storage), true);
	assert.deepEqual(({ ...loadProjectSession(storage), updatedAt: 0 }), { name: "Boards", castStyle: "capsule", updatedAt: 0 });
	assert.equal(storeProjectSession("Clips", undefined, storage), true);
	assert.equal(loadProjectSession(storage).castStyle, "hybrid", "a call without a style stores the default style");
});

test("project.new, the agent context and analytics mirror CAST_STYLES", () => {
	const fresh = projectDeclarations.find(entry => entry.id === "project.new");
	assert.deepEqual(fresh.input.properties.castStyle.enum, [...CAST_STYLES], "project.new accepts the cast style");
	const starter = projectDeclarations.find(entry => entry.id === "project.openStarter");
	assert.deepEqual(starter.input.properties.castStyle.enum, [...CAST_STYLES], "a starter opens with the cast style chosen on the start screen");
	assert.deepEqual(protocol.StudioSchemas.StudioContextV1.properties.scene.properties.castStyle.enum, [...CAST_STYLES], "protocol mirrors CAST_STYLES");
	assert.equal(protocol.StudioSchemas.StudioContextV1.properties.scene.required.includes("castStyle"), false, "castStyle is optional in the context");
	assert.deepEqual([...CAST_STYLE_VALUES], [...CAST_STYLES], "analytics mirrors CAST_STYLES");
	assert.deepEqual(sanitizeProps("scene:created", { scene_source: "new_project", previs_mode: "animation", cast_style: "capsule" }), { scene_source: "new_project", cast_style: "capsule" });
	assert.equal(sanitizeProps("scene:created", { scene_source: "new_project", cast_style: "giant" }).cast_style, undefined, "an unknown style is dropped");
});

test("Add > Character always offers the rig figure (in the default cube look) and Capsule figure; the cast style picks the first", () => {
	const order = style => addCharacterEntries(style).map(entry => entry.model);
	assert.deepEqual(order("rig"), ["x-bot-tpose", PROXY_FIGURE_MODEL]);
	assert.deepEqual(order("hybrid"), ["x-bot-tpose", PROXY_FIGURE_MODEL]);
	assert.deepEqual(order("capsule"), [PROXY_FIGURE_MODEL, "x-bot-tpose"]);
	assert.deepEqual(addCharacterEntries("rig").map(entry => entry.add), ["character", "capsule"], "the rig figure entry keeps data-add=character");
	assert.equal(addCharacterEntries("rig")[0].label(), "Cube figure", "a launch that names no look draws the cube figure");
});

test("the last character can be removed: the scene reads an empty cast and the agent context still validates", () => {
	const f = castFixture();
	try {
		ok(f.run("character.remove", { characterId: "actor-b" }));
		const last = ok(f.run("character.remove", { characterId: "actor-a" }));
		assert.equal(f.cast.read().length, 0, "the cast is empty");
		const context = f.binding.context();
		assert.equal(context.scene.characterCount, 0);
		assert.equal(context.entities.some(entity => entity.kind === "character"), false);
		assert.equal(protocol.validateStudioContext({ ...context, scene: { ...context.scene, castStyle: "capsule" } }).scene.castStyle, "capsule", "an empty-stage context carries castStyle");
		assert.throws(() => protocol.validateStudioContext({ ...context, scene: { ...context.scene, castStyle: "giant" } }), "an unknown cast style is refused");
		ok(f.run("edit.undo", { receiptId: last.receiptId }));
		assert.deepEqual(f.cast.read().map(row => row.id), ["actor-a"], "undo brings the last character back");
		ok(f.run("character.add", { character: { id: "actor-c", model: PROXY_FIGURE_MODEL, subject: "a stand-in" } }));
		assert.equal(f.cast.read().length, 2);
	} finally { f.dispose?.(); }
});

test("project.new and project.openStarter carry the chosen cast style; a starter keeps its own otherwise, hybrid when it has none", async () => {
	const starterFile = castStyle => JSON.stringify(createProjectDocument({ scenesDocument: createSceneDocument({ seedCharacter: true }), name: "Starter", ...(castStyle ? { castStyle } : {}) }));
	const files = { "/scenes/rig-starter.cclayproject": starterFile("rig"), "/scenes/old-starter.cclayproject": starterFile(null).replace(/"castStyle":"hybrid",/, "") };
	const previousFetch = globalThis.fetch;
	globalThis.fetch = async url => (files[url] ? { ok: true, text: async () => files[url] } : { ok: false, text: async () => "" });
	const f = projectFixture();
	try {
		const style = () => f.project.metadata().castStyle;
		ok(await f.run("project.new", { name: "Capsules", castStyle: "capsule" }));
		assert.equal(style(), "capsule", "project.new keeps the chosen style");
		assert.deepEqual(f.project.read()[0].stage.characters, [], "project.new starts on an empty stage");
		ok(await f.run("project.openStarter", { id: "/scenes/rig-starter.cclayproject", name: "Picked", castStyle: "capsule" }));
		assert.equal(style(), "capsule", "the style chosen on the start screen overrides the starter's");
		ok(await f.run("project.openStarter", { id: "/scenes/rig-starter.cclayproject", name: "Own" }));
		assert.equal(style(), "rig", "with no choice the starter keeps its own style");
		assert.equal(files["/scenes/old-starter.cclayproject"].includes("castStyle"), false);
		ok(await f.run("project.openStarter", { id: "/scenes/old-starter.cclayproject", name: "Old" }));
		assert.equal(style(), "hybrid", "a starter written before the choice opens as hybrid");
	} finally { f.dispose(); globalThis.fetch = previousFetch; }
});
