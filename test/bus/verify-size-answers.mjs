#!/usr/bin/env node
// The object sizes reach the model on both paths: a script's calls summary carries every entry a nested
// receipt stated (a mixed patch_elements: every domain's receipt), with the text of its SIZES_ warning; and the
// object tools' descriptions state each primitive's box at scale 1 as the object library has it.
import assert from "node:assert/strict";
import { createScriptTool, MAX_PICTURES, withoutPictures } from "../../bin/agent/script-tool.mjs";
import { createStudioTools } from "../../bin/agent/studio-tools.mjs";
import { OBJECT_LIBRARY } from "../../src/scene-objects.js";

const sizes = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`obj-${i}`, [i + 1, 0.5, 2]]));
const receipts = {
	arrange_objects: { ok: true, status: "completed", receiptId: "r1", revision: { before: 1, after: 2 }, affectedIds: Object.keys(sizes), output: { sizeM: sizes }, warnings: [] },
	patch_elements: { ok: true, status: "partial", receiptId: "r2", revision: { before: 2, after: 3 }, affectedIds: ["obj-1"], warnings: [{ code: "SIZES_INLINE", count: 1, message: "sizeM {\"obj-1\":[4,0.01,2]}" }] },
	inspect_studio: { ok: true, revision: 3, entities: [] },
	run_action: { splitByDomain: true, ok: true, status: "applied", receiptId: "r4", revision: { before: 3, after: 5 }, affectedIds: ["a", "b"], commands: [
		{ kind: "object", opIndices: [0], receipt: { ok: true, output: { sizeM: { a: [1, 1, 1] } }, warnings: [] } },
		{ kind: "shot", opIndices: [1], receipt: { ok: true, warnings: [{ code: "SIZES_TRUNCATED", count: 3, message: "sizeM lists 0 of 3 objects; inspect_studio scope entities with ids reads the others." }] } }] },
};
const tools = Object.keys(receipts).map(name => ({ name, description: name, handler: async () => receipts[name] }));
const script = createScriptTool({ tools });
const result = await script.handler({ code: "await tools.arrange_objects({}); await tools.patch_elements({}); await tools.inspect_studio({}); await tools.run_action({}); return 1;" }, {});
assert.equal(result.ok, true, JSON.stringify(result));
const [arranged, patched, inspected, split] = result.calls;
assert.equal(arranged.affectedIds.length, 12, "a row keeps every affected id its receipt lists (was cut at 8)");
assert.deepEqual(arranged.sizeM, sizes, "every size of the nested receipt, past the 8 ids");
assert.equal(arranged.sizesNote, undefined);
assert.deepEqual(patched.sizeM, undefined);
assert.equal(patched.sizesNote, "sizeM {\"obj-1\":[4,0.01,2]}", "a partial receipt's sizes line rides as the note");
assert.deepEqual(Object.keys(inspected).sort(), ["affectedIds", "code", "message", "name", "ok", "receiptId", "revision", "status"], "a call that sizes nothing gains no field");
assert.deepEqual(split.sizeM, { a: [1, 1, 1] }, "a split patch merges its receipts' sizes");
assert.match(split.sizesNote, /lists 0 of 3 objects/);
assert.match(script.description, /sizeM when its receipt states object sizes, sizesNote when it has a SIZES_ warning/);
console.log("PASS a script's calls summary carries every stated size and the note on what is missing");

// A row carries what differs from what was asked: warnings (not the SIZES_ ones), ops that lost paths (a split patch's
// op indices mapped back), the look with the receipt's summary; a refusal's at, asked and changed, once; pictures up to MAX_PICTURES.
{
	const png = n => `data:image/png;base64,${"A".repeat(n)}`;
	const answers = {
		arrange_objects: { ok: true, status: "completed", receiptId: "r1", revision: { before: 1, after: 2 }, affectedIds: ["a"], warnings: [{ code: "FOOTPRINT_OVERLAP", id: "a", message: "A overlaps B by 0.2 m" }, { code: "SIZES_TRUNCATED", count: 1, message: "x" }] },
		patch_elements: { splitByDomain: true, ok: true, status: "partial", receiptId: "r2", revision: { before: 2, after: 3 }, affectedIds: ["a"], code: "STALE_TARGET", message: "Refused: shot (ops 0, 2): STALE_TARGET: Shot s1 is not in this scene.", commands: [
			{ kind: "object", opIndices: [1, 3], receipt: { ok: true, status: "partial", ops: [{ index: 0, status: "applied" }, { index: 1, status: "partial", droppedPaths: ["object.color"] }], warnings: [] } },
			{ kind: "shot", opIndices: [0, 2], error: { code: "STALE_TARGET", message: "Shot s1 is not in this scene." } }] },
		run_action: { ok: true, status: "completed", receiptId: "r3", revision: { before: 3, after: 4 }, affectedIds: ["p"], summary: "Sculpted P. Box check: floating (touch nothing): leg.", dataUrl: png(4), look: { status: "attached", visual: "closeup", imageId: "i", floating: ["leg"] } },
		frame_shot: { ok: true, status: "completed", receiptId: "r4", revision: { before: 4, after: 4 }, affectedIds: [], summary: "Framed the shot." },
	};
	const refuse = { verify_result: Object.assign(new Error("$.args.targets[0]: Expected an id, got 7."), { code: "INVALID_ARGUMENT" }) };
	const fakes = [...Object.keys(answers), "verify_result"].map(name => ({ name, description: name, handler: async () => { if (refuse[name]) throw refuse[name]; return answers[name]; } }));
	const tool = createScriptTool({ tools: fakes });
	const out = await tool.handler({ code: "await tools.arrange_objects({}); await tools.patch_elements({}); for (let i = 0; i < 9; i++) await tools.run_action({ action: 'object.sculpt' }); await tools.frame_shot({}); try { await tools.verify_result({ targets: [7] }); } catch (e) { text(e.message); } return 1;" }, { toolCallId: "s-1" });
	const [arranged, patched, first] = out.calls;
	assert.deepEqual(arranged.warnings, [{ code: "FOOTPRINT_OVERLAP", id: "a", message: "A overlaps B by 0.2 m" }], "warnings ride, SIZES_ ones stay in sizesNote");
	assert.deepEqual(patched.dropped, [{ index: 3, droppedPaths: ["object.color"] }], "a split patch's op index is the call's own");
	assert.deepEqual({ code: patched.code, message: patched.message, refused: patched.refused }, { code: "STALE_TARGET", message: "Refused: shot (ops 0, 2): STALE_TARGET: Shot s1 is not in this scene.", refused: undefined }, "a split patch's refused domain is told once, in the row's code and message");
	assert.deepEqual(first.look, { status: "attached", floating: ["leg"] });
	assert.equal(first.summary, "Sculpted P. Box check: floating (touch nothing): leg.", "a call that answers with its own look carries the receipt's summary beside it, as the direct call's answer does");
	assert.deepEqual(out.calls.slice(2, 11).map(row => row.picture), [1, 2, 3, 4, 5, 6, 7, 8, "left out"], `pictures up to ${MAX_PICTURES}, then left out`);
	assert.equal(out.dataUrls.length, MAX_PICTURES);
	assert.equal(out.picturesLeftOut, 1);
	assert.deepEqual(Object.keys(out.calls[11]).sort(), ["affectedIds", "code", "message", "name", "ok", "receiptId", "revision", "status"], "a call with nothing different gains no field");
	const refusedRow = out.calls[12];
	assert.deepEqual({ code: refusedRow.code, at: refusedRow.at, asked: refusedRow.asked, changed: refusedRow.changed }, { code: "INVALID_ARGUMENT", at: "targets[0]", asked: 7, changed: false });
	assert.equal(out.output[0], "INVALID_ARGUMENT: $.args.targets[0]: Expected an id, got 7.", "the script reads the code and message as before; the facts are in the row only");
	// A rolled-back script: the pictures leave, every row that named one and the count say so (agent-routes.mjs).
	const rolled = withoutPictures(out);
	assert.equal(rolled.dataUrls, undefined);
	assert.deepEqual(rolled.calls.slice(2, 11).map(row => row.picture), Array(9).fill("left out"));
	assert.equal(rolled.picturesLeftOut, MAX_PICTURES + 1);
	assert.deepEqual(withoutPictures({ ok: false, calls: [{ name: "frame_shot" }] }), { ok: false, calls: [{ name: "frame_shot" }] }, "a script without pictures stays as it is");
	console.log("PASS a script's rows carry what differs from what was asked, a refusal's facts, and up to 8 pictures");
}

// The first refusal of an action's arguments in a turn carries the action's input schema, read from the editor; not a
// second time, not for an action whose declaration the turn already read, not for another code, not for an action
// the turn's index does not list. A nested refusal: the schema is in the script's row, once.
{
	const input = { type: "object", properties: { name: { type: "string" } }, required: ["name"], additionalProperties: false };
	const reads = [];
	const hub = { command: async (name, payload) => {
		if (name === "inspect_studio") { reads.push(payload.ids); return { actions: (payload.ids ?? []).map(id => ({ id, input })) }; }
		const code = payload.args?.code ?? "INVALID_ARGUMENT";
		return { ok: false, code, message: code === "INVALID_ARGUMENT" ? "$.args.name: expected a string, got a number." : "Object ghost is not in this scene.", mutated: false, recovery: { action: "inspect", retryAllowed: false } };
	} };
	const index = ["a.one", "a.two", "a.three"].map(id => ({ id }));
	const made = () => Object.fromEntries(createStudioTools({ liveHub: hub, workspaceHandle: "w", session: { actionIndex: index } }).map(tool => [tool.name, tool]));
	const schemaOf = (tools, action, args = { name: 5 }) => tools.run_action.handler({ action, args }, { toolCallId: "c" }).then(() => assert.fail("refused"), error => error.schema);
	let tools = made();
	assert.deepEqual(await schemaOf(tools, "a.one"), input, "the first refusal of its arguments carries the input schema");
	assert.equal(await schemaOf(tools, "a.one"), undefined, "the second does not");
	assert.equal(await schemaOf(tools, "a.two", { code: "STALE_TARGET" }), undefined, "another code carries none");
	assert.deepEqual(await schemaOf(tools, "a.two"), input, "and does not use up the action's one schema");
	await tools.inspect_studio.handler({ scope: "actions", ids: ["a.three"] }, { toolCallId: "c" });
	assert.equal(await schemaOf(tools, "a.three"), undefined, "an action whose declaration this turn read gets no second copy");
	assert.equal(await schemaOf(tools, "a.unlisted"), undefined, "an action the turn's index does not list: none");
	assert.deepEqual(reads, [["a.one"], ["a.two"], ["a.three"]], "one editor read per schema sent, none otherwise");
	tools = made();
	const nested = createScriptTool({ tools: Object.values(tools) });
	const failed = await nested.handler({ code: "await tools.run_action({ action: 'a.one', args: { name: 5 } });" }, { toolCallId: "s-2" });
	assert.equal(failed.error.message, "INVALID_ARGUMENT: $.args.name: expected a string, got a number.");
	assert.deepEqual({ at: failed.calls[0].at, asked: failed.calls[0].asked, changed: failed.calls[0].changed, schema: failed.calls[0].schema }, { at: "args.name", asked: 5, changed: false, schema: input });
	assert.equal(JSON.stringify(failed).split('"additionalProperties"').length - 1, 1, "the schema is in the result once");
	console.log("PASS the first refusal of an action's arguments in a turn carries its input schema, once");
}

const studio = createStudioTools({ liveHub: { command: async () => ({}) }, workspaceHandle: "w" });
const library = OBJECT_LIBRARY.map(entry => `${entry.kind} [${[entry.footprint.width, entry.height, entry.footprint.depth].join(", ")}]`).join(", ");
for (const tool of studio) {
	const states = tool.description.includes(`At scale 1 a primitive's box is [x, y, z] m: ${library}; scale multiplies each axis.`);
	assert.equal(states, ["arrange_objects", "patch_elements", "run_action"].includes(tool.name), `${tool.name}: primitive sizes only on the object tools`);
	assert.equal(tool.description.includes("output.sizeM"), states);
}
console.log("PASS the object tools state each primitive's box at scale 1 as the object library has it");
