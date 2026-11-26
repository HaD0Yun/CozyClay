#!/usr/bin/env node
// The look after an action (bin/agent/action-look.mjs): a run_action of an action whose declaration names a look
// (object.sculpt: closeup, carried in the turn's action index) answers with that verify_result visual of the object as
// image content, the model's own call and a script's nested call alike; an action without a look, a call with no call
// id (quick_edit), a refusal and a failed look get none, and a failed look never fails the action. Through the real
// Studio tools and pi adapter, with a fake editor.
import assert from "node:assert/strict";
import { lookTarget } from "../bin/agent/action-look.mjs";
import { createStudioTools } from "../bin/agent/studio-tools.mjs";
import { toAgentTools } from "../bin/agent/pi-tools.mjs";
import { commandDeclarations } from "../src/commands/index.js";

const jpeg = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ==";
const receipt = (id = "obj-pot") => ({ ok: true, status: "applied", action: "object.sculpt", receiptId: "r-1", affectedIds: [id], revision: { before: 3, after: 4 }, summary: "Sculpted Pot" });

// ---- the declaration ----
const looks = commandDeclarations().filter(entry => entry.look).map(entry => [entry.id, entry.look]);
assert.deepEqual(looks, [["object.sculpt", "closeup"]], "object.sculpt declares its closeup; no other action declares a look");

// ---- the rule ----
const lookOf = id => (id === "object.sculpt" ? "closeup" : null);
const direct = { toolCallId: "call-1" }, nested = { callId: "call-1" };
assert.equal(lookTarget("run_action", { action: "object.sculpt", args: { recipe: {} } }, direct, receipt(), lookOf), "obj-pot", "a new sculpt: the receipt's first id");
assert.equal(lookTarget("run_action", { action: "object.sculpt", args: { id: "obj-vase", edits: [{}] } }, direct, receipt("obj-vase"), lookOf), "obj-vase", "edits: the sculpt named");
assert.equal(lookTarget("run_action", { action: "object.sculpt", args: {} }, nested, receipt(), lookOf), "obj-pot", "inside a script: the picture too");
assert.equal(lookTarget("run_action", { action: "object.sculpt", args: {} }, {}, receipt(), lookOf), null, "a call with no call id (quick_edit): no picture");
assert.equal(lookTarget("run_action", { action: "object.add", args: {} }, direct, receipt(), lookOf), null, "an action with no declared look");
assert.equal(lookTarget("verify_result", { action: "object.sculpt" }, direct, receipt(), lookOf), null, "another tool");
assert.equal(lookTarget("run_action", { action: "object.sculpt", args: {} }, direct, { ok: false, code: "INVALID_ARGUMENT" }, lookOf), null, "a refused sculpt");

// ---- through the tools ----
function fakeHub({ closeup = "ok" } = {}) {
	const commands = [];
	return {
		commands,
		command: async (name, payload) => {
			commands.push({ name, args: payload?.args ?? payload });
			if (name === "run_action") return receipt();
			if (name === "verify_result") {
				if (closeup === "refuse" || (closeup === "late" && commands.filter(c => c.name === "verify_result").length < 3)) return { ok: false, code: "TARGET_NOT_READY", message: 'visual "closeup": obj-pot has nothing drawn yet.' };
				return { ok: true, receiptId: "v-9", revision: 4, checks: { placement: { unsupportedIds: [] } }, visualRefs: [{ imageId: "img-1", kind: "closeup", views: ["three-quarter", "front", "top"], bounds: { size: [0.3, 0.4, 0.3] }, figure: { heightM: 1.8 } }] };
			}
			if (name === "resolve_studio_image") return payload.imageId === "img-1" && payload.receiptId === "v-9" && payload.revision === 4 ? { dataUrl: jpeg, revision: 4, receiptId: "v-9" } : null;
			throw new Error(`unexpected ${name}`);
		},
	};
}
const actionIndex = [{ id: "object.sculpt", label: "Sculpt a clay prop from a recipe", look: "closeup" }, { id: "object.add", label: "Add object" }];
async function run(hub, args, { inScript = false, call } = {}) {
	const tools = createStudioTools({ liveHub: hub, workspaceHandle: "handle-1", session: { actionIndex }, resolveImage: (id, correlation) => hub.command("resolve_studio_image", { imageId: id, ...correlation }) });
	const tool = tools.find(t => t.name === "run_action");
	if (call) return { details: await tool.handler(args, call) };
	if (inScript) return { details: await tool.handler(args, { callId: "call-7" }) };
	const [agentTool] = toAgentTools([tool]);
	return agentTool.execute("call-7", args);
}
const sculpt = { action: "object.sculpt", args: { recipe: { version: 1, parts: [{ id: "body", shape: "blob", size: [0.3, 0.4, 0.3] }] } } };

let hub = fakeHub(), out = await run(hub, sculpt);
assert.deepEqual(hub.commands.map(c => c.name), ["run_action", "verify_result", "resolve_studio_image"]);
assert.deepEqual({ ...hub.commands[1].args, frames: undefined }, { targets: ["obj-pot"], checks: ["placement"], visual: "closeup", frames: undefined });
const image = out.content.find(part => part.type === "image");
assert.deepEqual(image, { type: "image", data: "/9j/4AAQSkZJRgABAQ==", mimeType: "image/jpeg" }, "the closeup reaches the model as image content");
assert.equal(out.details.look.status, "attached");
assert.equal(out.details.dataUrl, undefined, "the text half carries no image bytes");
assert.match(out.content[0].text, /"look":\{"status":"attached","visual":"closeup","imageId":"img-1"/);

hub = fakeHub(); out = await run(hub, sculpt, { inScript: true });
assert.deepEqual(hub.commands.map(c => c.name), ["run_action", "verify_result", "resolve_studio_image"], "a script's nested sculpt: the look too");
assert.equal(out.details.dataUrl, jpeg, "the nested result carries the picture for the script to send back");

hub = fakeHub(); out = await run(hub, sculpt, { call: {} });
assert.deepEqual(hub.commands.map(c => c.name), ["run_action"], "no call id (quick_edit): no look");
assert.equal(out.details.look, undefined);

hub = fakeHub({ closeup: "refuse" }); out = await run(hub, sculpt);
assert.equal(out.content.some(part => part.type === "image"), false);
assert.equal(out.details.ok, true, "a failed look keeps the sculpt's receipt");
assert.match(out.details.look.reason, /^TARGET_NOT_READY: .*nothing drawn yet/);
assert.equal(hub.commands.filter(c => c.name === "verify_result").length, 12, "gives up after 12 tries");

hub = fakeHub({ closeup: "late" }); out = await run(hub, sculpt);
assert.deepEqual(hub.commands.map(c => c.name), ["run_action", "verify_result", "verify_result", "verify_result", "resolve_studio_image"], "not drawn yet: asked again until it is");
assert.equal(out.details.look.status, "attached");

hub = fakeHub(); out = await run(hub, { action: "object.add", args: {} });
assert.deepEqual(hub.commands.map(c => c.name), ["run_action"], "an action without a look: none");
assert.equal(out.content.some(part => part.type === "image"), false);
console.log("action look: ok");
