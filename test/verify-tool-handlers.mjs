#!/usr/bin/env node
/**
 * verify-tool-handlers — the MCP tool registry is usable without an MCP server.
 *
 * mcp/tool-handlers.mjs exists so a non-MCP caller (an in-process agent) can run
 * the same handlers the MCP surface registers. Two properties make that true and
 * both are checked here against the real module:
 *
 *   1. importing it costs nothing — no port, no chdir, no signal handler, no
 *      live hub. Those belong to the process that owns the server, so a plain
 *      import must leave this process exactly as it found it.
 *   2. the registry still describes the same tools, in the same order, each
 *      carrying the safety annotations tools/list publishes, and a handler that
 *      can be called directly.
 *
 * The describe_scene expectation below is the text the pre-refactor server.mjs
 * returned over real MCP stdio for the same arguments, with only the revision
 * hash (a digest of a scene id that carries a creation timestamp) normalised.
 * If the extraction had changed a report, a default, or the framing maths, this
 * would not match.
 */
import { strict as assert } from "node:assert";

const EXPECTED_TOOLS = [
	"describe_scene", "live_status", "describe_shot", "capture_frame", "set_camera",
	"frame_shot", "add_character", "place_character", "remove_character", "focus_character",
	"place_object", "import_mesh", "sculpt_object", "compare_sculpt", "group_objects",
	"update_object", "remove_object", "apply_batch", "render_prompt", "mark_camera_move",
	"describe_camera_move", "add_scene", "switch_scene", "open_project", "save_project", "studio_commands", "studio_run",
];
const ANNOTATION_KEYS = ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"];
// live_status reports the workspaces; it is the one tool that is not routed into one.
const MEMORY_ONLY_TOOLS = new Set(["live_status"]);
const REVISION = /revision: [0-9a-f]{12}/g;
const DESCRIBE_SCENE_REPORT = `Project: Untitled
Scene: SCENE 01  (1 scene in project)
previsMode: animation

CAMERA
  position   x 0  y 1.6  z 4.5
  lens       35mm  (nearest prime 35mm)
  filmback   fullFrame · 1.778:1
  framing    MEDIUM-WIDE SHOT · FRONT · EYE LEVEL · 35MM
  distance   4.51m to the subject's centre of mass

CAST (total: 1, returned: 1, truncated: false, revision: <rev>)
  Character 1 char-a  "Y Bot a"  at x 0, z 0, facing 0deg  [y-bot-tpose]  <- framed
    model: y-bot-tpose  kind: rig  pose: null  tint: null  scale: 1
    layer: {"waypoints":[]}

SET (total: 0, returned: 0, truncated: false, revision: <rev>)
  empty — add with place_object

STAGE
  shotAspect: 16:9  sensorId: fullFrame  hasCharSheet: false
  keyLight: x 6  y 9  z 4  intensity 4

TIMELINE
  currentFrame: 0  frameCount: 360  fps: 24`;

/* ------------------------- 1. import costs nothing ------------------------ */

const before = {
	cwd: process.cwd(),
	exit: process.listenerCount("exit"),
	sigint: process.listenerCount("SIGINT"),
	sigterm: process.listenerCount("SIGTERM"),
};
const registry = await import("../mcp/tool-handlers.mjs");
const after = {
	cwd: process.cwd(),
	exit: process.listenerCount("exit"),
	sigint: process.listenerCount("SIGINT"),
	sigterm: process.listenerCount("SIGTERM"),
};

assert.equal(after.cwd, before.cwd, "importing the registry changed the working directory");
assert.equal(after.exit, before.exit, "importing the registry installed an exit handler");
assert.equal(after.sigint, before.sigint, "importing the registry installed a SIGINT handler");
assert.equal(after.sigterm, before.sigterm, "importing the registry installed a SIGTERM handler");
assert.equal(registry.liveHub, null, "importing the registry connected a live editor");
console.log(`PASS import is side-effect free (cwd, exit/SIGINT/SIGTERM handlers and live hub unchanged)`);

/* ---------------------------- 2. the registry ---------------------------- */

const tools = registry.createToolHandlers({});
assert.deepEqual(tools.map((entry) => entry.name), EXPECTED_TOOLS, "the registry's tool names or order changed");
assert.deepEqual(
	registry.createToolHandlers({}).map((entry) => entry.name),
	EXPECTED_TOOLS,
	"the registry is not stable across calls",
);

for (const entry of tools) {
	assert.equal(typeof entry.title, "string", `${entry.name} has no title`);
	assert.ok(entry.title.length > 0, `${entry.name} has an empty title`);
	assert.equal(typeof entry.description, "string", `${entry.name} has no description`);
	assert.ok(entry.description.length > 20, `${entry.name} has a stub description`);
	assert.equal(typeof entry.inputSchema, "object", `${entry.name} has no input schema`);
	assert.ok(entry.inputSchema !== null, `${entry.name} has a null input schema`);
	assert.equal(typeof entry.handler, "function", `${entry.name} has no handler`);

	assert.ok(entry.annotations, `${entry.name} has no safety annotations`);
	for (const key of ANNOTATION_KEYS) {
		assert.equal(typeof entry.annotations[key], "boolean", `${entry.name} has no ${key} annotation`);
	}

	assert.equal(entry.live, !MEMORY_ONLY_TOOLS.has(entry.name), `${entry.name} has the wrong live routing flag`);
}
console.log(`PASS registry publishes ${tools.length} tools with titles, schemas, annotations and live flags`);

/* -------------------- 3. a handler runs without a server ------------------ */

const describeScene = tools.find((entry) => entry.name === "describe_scene");
const result = await describeScene.handler({ character_cursor: 0, object_cursor: 0, limit: 50 });

assert.deepEqual(Object.keys(result), ["content"], "describe_scene returned an unexpected result shape");
assert.equal(result.content.length, 1, "describe_scene returned more than one content block");
assert.equal(result.content[0].type, "text", "describe_scene returned a non-text content block");
assert.equal(result.isError, undefined, `describe_scene reported an error: ${result.content[0].text}`);

const report = result.content[0].text;
assert.match(report, /revision: [0-9a-f]{12}/, "describe_scene lost its state revision digest");
assert.equal(
	report.replaceAll(REVISION, "revision: <rev>"),
	DESCRIBE_SCENE_REPORT,
	"describe_scene no longer reports what the MCP server reported before the extraction",
);
console.log("PASS describe_scene invoked directly returns the report the MCP server returns");

/* ------------- 4. arguments still reach the handler that owns them -------- */

const paged = await describeScene.handler({ character_cursor: 0, object_cursor: 0, limit: 1 });
assert.match(
	paged.content[0].text,
	/CAST \(total: 1, returned: 1, truncated: false, revision: [0-9a-f]{12}\)/,
	"describe_scene ignored its paging arguments",
);

const liveStatus = tools.find((entry) => entry.name === "live_status");
assert.deepEqual(
	await liveStatus.handler({}),
	{ content: [{ type: "text", text: "No live editor connected; using in-memory state." }] },
	"live_status no longer reports a memory-only session",
);
console.log("PASS handler arguments and the memory-only live path behave as they do over MCP");

/* ------------- 5. a character without a subject (#1212) ------------------- */
// The name shown is built from the model (the report above: "Y Bot a"). A prompt
// still needs a description, so it gets the neutral phrase, never an empty one,
// and a second character without a subject is still the prompt's second subject.

const renderPrompt = tools.find((entry) => entry.name === "render_prompt");
const promptArgs = { mode: "video", environment: "an empty stage", style: "plain", camera_move: "hold", pose_phrase: "", pose2_phrase: "" };
const solo = (await renderPrompt.handler(promptArgs)).content[0].text;
assert.match(solo, /Subject: a person,/, `render_prompt left a subject-less character without a description:\n${solo}`);
const addCharacter = tools.find((entry) => entry.name === "add_character");
const added = await addCharacter.handler({ subject: "", x: 1.2, z: 0, facing: 0 });
assert.equal(added.isError, undefined, `add_character refused a character without a subject: ${added.content[0].text}`);
const duo = (await renderPrompt.handler(promptArgs)).content[0].text;
assert.match(duo, /Two subjects\. Subject 1: a person\. Subject 2: a person\./, `render_prompt dropped the second subject-less character:\n${duo}`);
console.log("PASS render_prompt describes subject-less characters with the neutral phrase and keeps both");

/* ------------- 6. update_object keeps a travel path with no editor ------- */
// Without a live editor the memory branch must store the path it answered
// "Updated" for, and null must clear it again (read back through describe_scene).

const call = (name, args) => tools.find((entry) => entry.name === name).handler(args);
const placed = (await call("place_object", { kind: "cube", x: 0, z: 0 })).content[0].text;
const objectId = placed.match(/ as (\S+)\.\n/)?.[1];
assert.ok(objectId, `place_object returned no object id:\n${placed}`);
const route = { points: [{ x: 0, z: 0 }, { x: 3, z: 1 }], speed: 1.5 };
const updated = await call("update_object", { id: objectId, path: route });
assert.equal(updated.isError, undefined, `update_object refused a path: ${updated.content[0].text}`);
const objectLine = async () => (await describeScene.handler({ character_cursor: 0, object_cursor: 0, limit: 50 })).content[0].text;
assert.match(await objectLine(), /path: 2 pts {2}\(0,0\) → \(3,1\) {2}speed: 1\.5/, "update_object answered success but dropped the travel path in memory mode");
await call("update_object", { id: objectId, path: null });
assert.doesNotMatch(await objectLine(), /path: \d+ pts/, "update_object path: null did not clear the travel path in memory mode");
console.log("PASS update_object stores and clears a travel path without a live editor");

console.log(`\nPASS tool handler registry (${tools.length} tools, importable without an MCP server)`);

/* ------------- 7. render_prompt invents no look (#1238) ------------------- */
// The agent names the look. When it names none, the prompt must not carry one
// the tool made up; the size words still close the sentence.

const defaultStyle = renderPrompt.inputSchema.style.parse(undefined);
assert.equal(defaultStyle, "", `render_prompt fills in a look the caller did not give: "${defaultStyle}"`);
const unstyled = (await renderPrompt.handler({ ...promptArgs, style: defaultStyle })).content[0].text;
assert.doesNotMatch(unstyled, /cinematic film still, natural light/, `render_prompt wrote an invented look into the prompt:\n${unstyled}`);
console.log("PASS render_prompt adds no look when the caller gives none");
