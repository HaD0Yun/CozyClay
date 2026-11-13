#!/usr/bin/env node
import assert from "node:assert/strict";
import { toTypeBox } from "../bin/agent/schema-to-typebox.mjs";
import { STUDIO_TOOL_SCHEMAS } from "../src/studio-agent-protocol.js";
import { createAgentTools } from "../bin/agent/agent-tools.mjs";
import { Value } from "typebox/value";

// Fakes matching the shape createAgentTools needs, same as
// test/verify-agent-routes.mjs's live/session fixtures (around line 350).
const fakeHub = { workspaceHandleDetails: () => [{ handle: "studio", meta: { commands: ["capture_framing_png", "import_asset"] } }], command: async () => ({}) };
const fakeSession = { signal: new AbortController().signal, images: new Map(), codex: {} };
const workflowTools = createAgentTools({ liveHub: fakeHub, session: fakeSession, emit: () => {} });
const WORKFLOW_NAMES = new Set(["describe_workflow", "add_workflow_node", "update_workflow_node", "remove_workflow_node", "connect_workflow_nodes", "disconnect_workflow_nodes", "run_workflow", "set_workflow_node_output", "focus_workflow_node"]);
const workflowSchemas = Object.fromEntries(workflowTools.filter((tool) => WORKFLOW_NAMES.has(tool.name)).map((tool) => [tool.name, tool.parameters]));
assert.ok(Object.keys(workflowSchemas).length >= 8, "at least 8 Workflow tool schemas are available");

const allSchemas = { ...STUDIO_TOOL_SCHEMAS, ...workflowSchemas };
let schemas = 0;
let good = 0;
let bad = 0;

// Every schema converts and round-trips its `required` array untouched.
for (const [name, schema] of Object.entries(allSchemas)) {
	const converted = toTypeBox(schema);
	schemas++;
	const requiredOf = (node) => (node && typeof node === "object" ? [...(Array.isArray(node.required) ? [node.required] : []), ...Object.values(node).flatMap((value) => (value && typeof value === "object" ? requiredOf(value) : []))] : []);
	assert.deepEqual(requiredOf(JSON.parse(JSON.stringify(converted))), requiredOf(schema), `${name}: required arrays round-trip through toTypeBox`);
}
assert.ok(Object.keys(STUDIO_TOOL_SCHEMAS).length >= 9, "at least 9 Studio tool schemas are available");

// Known-good argument fixtures per Studio family (same shapes exercised in
// test/verify-studio-agent-tools.mjs:54-81), each must Value.Check true.
const GOOD_FIXTURES = {
	inspect_studio: { scope: "scene" },
	operate_studio: { frame: 1, playing: true },
	arrange_objects: { ops: [{ op: "remove", id: "cube" }] },
	arrange_characters: { ops: [{ op: "remove", characterId: "char-alex" }] },
	patch_elements: { ops: [{ target: { kind: "stage" }, set: {} }] },
	frame_shot: { subjectIds: ["char-alex"], framing: { intent: { size: "close-up", view: "front", level: "eye", side: "left" } } },
	verify_result: { checks: ["framing"] },
	undo_edit: { receiptId: "receipt-1" },
};
for (const [name, args] of Object.entries(GOOD_FIXTURES)) {
	const converted = toTypeBox(STUDIO_TOOL_SCHEMAS[name]);
	assert.equal(Value.Check(converted, args), true, `${name}: known-good fixture validates`);
	good++;
}

// Known-bad fixtures: wrong enum value, missing required, extra property
// under additionalProperties:false, minItems violation.
const BAD_CASES = [
	["inspect_studio", { scope: "bogus" }, "wrong enum value"],
	["undo_edit", {}, "missing required receiptId"],
	["operate_studio", { frame: 1, extra: true }, "extra property under additionalProperties:false"],
	["patch_elements", { ops: [] }, "minItems violation (empty ops)"],
];
for (const [name, args, reason] of BAD_CASES) {
	const converted = toTypeBox(STUDIO_TOOL_SCHEMAS[name]);
	assert.equal(Value.Check(converted, args), false, `${name}: ${reason} must fail Value.Check`);
	bad++;
}

// A small local schema with a plain string enum, matching the QA scenario in
// the plan: {a:'y'} against enum ['x'] must fail.
{
	const local = toTypeBox({ type: "object", properties: { a: { type: "string", enum: ["x"] } }, required: ["a"], additionalProperties: false });
	assert.equal(Value.Check(local, { a: "y" }), false, "a value outside a string enum fails Value.Check");
	bad++;
}

// format is a hint, not a constraint: it must be ignored, not enforced.
{
	const emailish = toTypeBox({ type: "string", format: "email" });
	assert.equal(Value.Check(emailish, "plain text"), true, "format is ignored: a non-email string still validates");
	assert.equal(Value.Check(emailish, 42), false, "format ignored does not mean type is ignored");
	console.log("PASS format is ignored when converting a string schema");
}

// L2: the converter forwards every declared vec3 axis minimum/maximum through
// unmodified, since `rest` passes non-structural keywords straight through.
{
	const objectScale = toTypeBox(STUDIO_TOOL_SCHEMAS.patch_elements.properties.ops.items.oneOf[1].properties.set.properties.scale);
	for (const axis of ["x", "y", "z"]) { assert.equal(objectScale.properties[axis].minimum, 0.01); assert.equal(objectScale.properties[axis].maximum, 100); }
	assert.equal(Value.Check(objectScale, { x: 1, y: 1, z: 1 }), true, "a within-range vec3 patch still validates");
	assert.equal(Value.Check(objectScale, { x: 1, y: 1, z: 999 }), false, "an out-of-range vec3 axis fails Value.Check");
	console.log("PASS the TypeBox bridge preserves per-axis vec3 minimum/maximum");
}

// $ref is explicitly unsupported and must throw with the pointer in the message.
assert.throws(() => toTypeBox({ $ref: "#/x" }), /\$ref/, "$ref throws");

console.log(`schemas=${schemas} good=${good} bad=${bad}`);
console.log("PASS schema-to-typebox converts every CozyClay tool schema and enforces known-good/known-bad fixtures");
