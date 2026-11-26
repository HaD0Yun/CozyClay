#!/usr/bin/env node
import assert from "node:assert/strict";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { createAgentTools } from "../bin/agent/agent-tools.mjs";
import { createStudioTools } from "../bin/agent/studio-tools.mjs";
import { STUDIO_TOOLS, STUDIO_TOOL_SCHEMAS } from "../src/studio-agent-protocol.js";
import { toAgentTools } from "../bin/agent/pi-tools.mjs";

const liveHub = {
	command: async () => ({ ok: true, receiptId: "receipt-1" }),
};
const studioTools = createStudioTools({ liveHub, workspaceHandle: "workspace-1", session: { admission: null } });
const workflowTools = createAgentTools({
	liveHub,
	handlers: [
		{ name: "describe_scene", description: "Describe the scene.", handler: async () => ({ scene: "fixture" }) },
		{ name: "describe_shot", description: "Describe the shot.", handler: async () => ({ shot: "fixture" }) },
	],
	session: { signal: new AbortController().signal, images: new Map(), codex: {}, workspaceHandle: null, workflowHandle: null },
	emit: () => {},
});
const studioAdapterInputs = studioTools.map((tool) => ({ ...tool, handler: async () => ({ ok: true }) }));
const allTools = toAgentTools([...studioAdapterInputs, ...workflowTools]);
assert.equal(studioTools.map((tool) => tool.name).join(","), STUDIO_TOOLS.join(","));
assert.ok(allTools.length >= 17);
assert.ok(allTools.every((tool) => typeof tool.execute === "function" && tool.parameters));
assert.equal(allTools.find((tool) => tool.name === "inspect_studio").label, "Read the scene");

const imageTool = toAgentTools([{
	name: "verify_result",
	description: "Verify a result.",
	parameters: STUDIO_TOOL_SCHEMAS.verify_result,
	handler: async () => ({ ok: true, dataUrl: "data:image/png;base64,AAAA", imageId: "x", width: 2, height: 3, prompt: "fixture" }),
}])[0];
const imageResult = await imageTool.execute("call-image", { checks: ["framing"] });
assert.equal(imageResult.content.filter((part) => part.type === "image").length, 1);
assert.equal(imageResult.content[1].type, "image");
assert.equal(imageResult.content[1].mimeType, "image/png");
assert.equal(imageResult.content[1].data, "AAAA");
assert.equal(Object.hasOwn(imageResult.details, "dataUrl"), false);
assert.equal(Object.hasOwn(imageResult.details, "image"), false, "details.image must not exist: structuredClone drops the non-enumerable seam, so pi's harness never sees it");
assert.equal(Object.hasOwn(JSON.parse(JSON.stringify(imageResult.details)), "dataUrl"), false);

const failingTool = toAgentTools([{
	name: "patch_elements",
	description: "Patch elements.",
	parameters: STUDIO_TOOL_SCHEMAS.patch_elements,
	handler: async () => { throw Object.assign(new Error("stale target"), { code: "STALE_TARGET", receipt: { recovery: { action: "inspect", retryAllowed: false } } }); },
}])[0];
// One refusal form (bin/agent/refusal.mjs): the code and message, then the facts; no constant "(inspect, do not retry)".
await assert.rejects(failingTool.execute("call-failure", { ops: [{ target: { kind: "stage" }, set: {} }] }), error => {
	const [line, facts] = error.message.split("\n");
	assert.equal(line, "STALE_TARGET: stale target");
	assert.deepEqual(JSON.parse(facts), { tool: "patch_elements", changed: "unknown" }, "a receipt that says nothing of a change: unknown");
	return true;
});
const refusedTool = toAgentTools([{ name: "patch_elements", description: "Patch elements.", parameters: STUDIO_TOOL_SCHEMAS.patch_elements,
	handler: async () => { throw Object.assign(new Error("$.args.ops[0].target: missing required field \"id\"."), { code: "INVALID_ARGUMENT", receipt: { mutated: false, recovery: { action: "inspect", retryAllowed: false } } }); } }])[0];
await assert.rejects(refusedTool.execute("call-refused", { ops: [{ target: { kind: "stage" }, set: {} }] }), error => {
	assert.deepEqual(JSON.parse(error.message.split("\n")[1]), { tool: "patch_elements", at: "ops[0].target", asked: { kind: "stage" }, changed: false });
	return true;
});
const transientTool = toAgentTools([{ name: "patch_elements", description: "Patch elements.", parameters: STUDIO_TOOL_SCHEMAS.patch_elements,
	handler: async () => { throw Object.assign(new Error("rig loading"), { code: "TARGET_NOT_READY", receipt: { mutated: false, recovery: { action: "retry", retryAllowed: true } } }); } }])[0];
await assert.rejects(transientTool.execute("call-transient", { ops: [{ target: { kind: "stage" }, set: {} }] }), error => {
	assert.deepEqual(JSON.parse(error.message.split("\n")[1]), { tool: "patch_elements", changed: false, retry: "allowed" }, "retry only where the editor marks the cause transient");
	return true;
});

let called = false;
const validationTool = toAgentTools([{
	name: "patch_elements",
	description: "Patch elements.",
	parameters: STUDIO_TOOL_SCHEMAS.patch_elements,
	handler: async () => { called = true; return { ok: true }; },
}])[0];
await assert.rejects(validationTool.execute("call-invalid", { ops: [] }), /minItems/);
assert.equal(called, false);
// The same check runs in prepareArguments, before pi's own: a refused call reads in the refusal form there too.
assert.throws(() => validationTool.prepareArguments({ ops: [] }), error => {
	const [line, facts] = error.message.split("\n");
	assert.match(line, /^INVALID_ARGUMENT: Invalid arguments for patch_elements: minItems/);
	assert.deepEqual(JSON.parse(facts), { tool: "patch_elements", at: "ops", asked: [], changed: false });
	return true;
});
assert.throws(() => validationTool.prepareArguments({ ops: [{ target: { kind: "stage" }, set: {} }], extra: 1 }), error => {
	assert.match(error.message, /^INVALID_ARGUMENT: root has unknown field "extra"; allowed: /);
	assert.deepEqual(JSON.parse(error.message.split("\n")[1]), { tool: "patch_elements", at: "extra", asked: 1, changed: false });
	return true;
});
// What no tool accepts leaves the text: detailCursor.
const cursorTool = toAgentTools([{ name: "inspect_studio", description: "x", parameters: { type: "object", properties: {}, additionalProperties: false }, handler: async () => ({ ok: true, affectedIds: ["a"], detailCursor: "c-1", commands: [{ receipt: { detailCursor: "c-2" } }] }) }])[0];
const cursorResult = await cursorTool.execute("call-cursor", {});
assert.equal(cursorResult.content[0].text.includes("detailCursor"), false);
assert.equal(cursorResult.details.detailCursor, "c-1", "the panel keeps the whole result");
// Several pictures: dataUrls each become image content, and leave the text.
const manyTool = toAgentTools([{ name: "script", description: "x", parameters: { type: "object", properties: {}, additionalProperties: false }, handler: async () => ({ ok: true, dataUrls: ["data:image/png;base64,AAAA", "data:image/jpeg;base64,BBBB"] }) }])[0];
const many = await manyTool.execute("call-many", {});
assert.deepEqual(many.content.slice(1), [{ type: "image", data: "AAAA", mimeType: "image/png" }, { type: "image", data: "BBBB", mimeType: "image/jpeg" }]);
assert.equal(many.content[0].text.includes("data:image"), false);

// The check before pi's own refuses what pi refuses, no more: an optional field sent as null and a value sent as text
// pass (pi leaves the null out and converts the text), as they did before the refusal form.
const tool = name => toAgentTools([{ name, description: name, parameters: STUDIO_TOOL_SCHEMAS[name], handler: async () => ({ ok: true }) }])[0];
const piRuns = (agentTool, args) => validateToolArguments(agentTool, { name: agentTool.name, arguments: agentTool.prepareArguments(args) });
assert.deepEqual(piRuns(tool("inspect_studio"), { scope: "entities", ids: null, query: null, cursor: null }), { scope: "entities" });
assert.deepEqual(piRuns(tool("operate_studio"), { frame: "3", playing: "false" }), { frame: 3, playing: false });
const refusedAs = (name, args) => { try { tool(name).prepareArguments(args); } catch (error) { const [line, facts] = error.message.split("\n"); return { line, ...JSON.parse(facts) }; } return assert.fail(`${name} accepted ${JSON.stringify(args)}`); };
// Several forms (anyOf): the rule told is of the form the call named, never the first form's constant.
assert.deepEqual(refusedAs("patch_elements", { ops: [{ target: { kind: "object", id: "cube" }, set: { "no.such.path": 1, name: "x" } }] }),
	{ line: 'INVALID_ARGUMENT: Invalid arguments for patch_elements: unknown field "no.such.path"', tool: "patch_elements", at: "ops[0].set.no.such.path", asked: 1,
		allowed: Object.keys(STUDIO_TOOL_SCHEMAS.patch_elements.properties.ops.items.oneOf.find(form => form.properties.target.properties.kind.const === "object").properties.set.properties), changed: false });
assert.deepEqual(refusedAs("arrange_objects", { ops: [{ op: "create", source: { kind: "cube" }, name: "A", position: { world: { x: 0, y: 0, z: 0 } } }, { op: "update", id: "cube", position: null }] }),
	{ line: "INVALID_ARGUMENT: Invalid arguments for arrange_objects: type: must be object (the nearest of 4 forms)", tool: "arrange_objects", at: "ops[1].position", asked: null, changed: false });
assert.deepEqual(refusedAs("arrange_objects", { ops: [{ op: "remove" }] }), { line: "INVALID_ARGUMENT: Invalid arguments for arrange_objects: missing required field id", tool: "arrange_objects", at: "ops[0].id", changed: false });
assert.deepEqual(refusedAs("operate_studio", { frame: "three" }), { line: "INVALID_ARGUMENT: Invalid arguments for operate_studio: type: must be integer", tool: "operate_studio", at: "frame", asked: "three", changed: false });
// A surface whose tools are not the Studio's (plain): its errors read as they did, without the refusal form.
const plainTool = toAgentTools([{ name: "describe_shot", description: "x", parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false }, handler: async () => { throw Object.assign(new Error("no shot"), { code: "STALE_TARGET" }); } }], { plain: true })[0];
await assert.rejects(plainTool.execute("call-plain", { id: "s" }), { message: "STALE_TARGET: no shot" });
assert.throws(() => plainTool.prepareArguments({ id: "s", extra: 1 }), { message: 'Validation failed for tool "describe_shot": root has unknown field "extra"; allowed: id.' });
assert.deepEqual(plainTool.prepareArguments({ id: 7 }), { id: 7 }, "a schema failure is left to pi's own check and wording");

console.log(`tools=${allTools.length}`);
