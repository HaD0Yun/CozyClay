#!/usr/bin/env node
// The look after a sculpt (bin/agent/sculpt-look.mjs): a run_action object.sculpt the model calls itself answers with
// a verify_result closeup of that object as image content; a script's nested call, another action, a refusal and a
// failed look get none, and a failed look never fails the sculpt. Through the real Studio tools and pi adapter, with a
// fake editor.
import assert from "node:assert/strict";
import { sculptLookTarget } from "../bin/agent/sculpt-look.mjs";
import { createStudioTools } from "../bin/agent/studio-tools.mjs";
import { toAgentTools } from "../bin/agent/pi-tools.mjs";

const jpeg = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ==";
const receipt = (id = "obj-pot") => ({ ok: true, status: "applied", action: "object.sculpt", receiptId: "r-1", affectedIds: [id], revision: { before: 3, after: 4 }, summary: "Sculpted Pot" });

// ---- the rule ----
const direct = { toolCallId: "call-1" }, nested = { callId: "call-1" };
assert.equal(sculptLookTarget("run_action", { action: "object.sculpt", args: { recipe: {} } }, direct, receipt()), "obj-pot", "a new sculpt: the receipt's first id");
assert.equal(sculptLookTarget("run_action", { action: "object.sculpt", args: { id: "obj-vase", edits: [{}] } }, direct, receipt("obj-vase")), "obj-vase", "edits: the sculpt named");
assert.equal(sculptLookTarget("run_action", { action: "object.sculpt", args: {} }, nested, receipt()), null, "inside a script: no picture");
assert.equal(sculptLookTarget("run_action", { action: "object.sculpt", args: {} }, {}, receipt()), null, "a call with no model call id (quick_edit): no picture");
assert.equal(sculptLookTarget("run_action", { action: "object.add", args: {} }, direct, receipt()), null, "another action");
assert.equal(sculptLookTarget("verify_result", { action: "object.sculpt" }, direct, receipt()), null, "another tool");
assert.equal(sculptLookTarget("run_action", { action: "object.sculpt", args: {} }, direct, { ok: false, code: "INVALID_ARGUMENT" }), null, "a refused sculpt");

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
async function run(hub, args, { inScript = false } = {}) {
	const tools = createStudioTools({ liveHub: hub, workspaceHandle: "handle-1", resolveImage: (id, correlation) => hub.command("resolve_studio_image", { imageId: id, ...correlation }) });
	const tool = tools.find(t => t.name === "run_action");
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
assert.deepEqual(hub.commands.map(c => c.name), ["run_action"], "a script's nested sculpt: no look");
assert.equal(out.details.dataUrl, undefined);

hub = fakeHub({ closeup: "refuse" }); out = await run(hub, sculpt);
assert.equal(out.content.some(part => part.type === "image"), false);
assert.equal(out.details.ok, true, "a failed look keeps the sculpt's receipt");
assert.match(out.details.look.reason, /^TARGET_NOT_READY: .*nothing drawn yet/);
assert.equal(hub.commands.filter(c => c.name === "verify_result").length, 12, "gives up after 12 tries");

hub = fakeHub({ closeup: "late" }); out = await run(hub, sculpt);
assert.deepEqual(hub.commands.map(c => c.name), ["run_action", "verify_result", "verify_result", "verify_result", "resolve_studio_image"], "not drawn yet: asked again until it is");
assert.equal(out.details.look.status, "attached");

hub = fakeHub(); out = await run(hub, { action: "object.add", args: {} });
assert.deepEqual(hub.commands.map(c => c.name), ["run_action"], "another action: no look");
assert.equal(out.content.some(part => part.type === "image"), false);
console.log("sculpt look: ok");
