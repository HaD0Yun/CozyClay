#!/usr/bin/env node
// The world box sizes reach the model on both paths: a script's calls summary carries every entry a nested
// receipt stated (a mixed patch_elements: every domain's receipt), with the warning that says some were left
// out; and the object tools' descriptions state each primitive's box at scale 1 as the object library has it.
import assert from "node:assert/strict";
import { createScriptTool } from "../../bin/agent/script-tool.mjs";
import { createStudioTools } from "../../bin/agent/studio-tools.mjs";
import { OBJECT_LIBRARY } from "../../src/scene-objects.js";

const sizes = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`obj-${i}`, [i + 1, 0.5, 2]]));
const receipts = {
	arrange_objects: { ok: true, status: "completed", receiptId: "r1", revision: { before: 1, after: 2 }, affectedIds: Object.keys(sizes), output: { worldBoxSizeM: sizes }, warnings: [] },
	patch_elements: { ok: true, status: "partial", receiptId: "r2", revision: { before: 2, after: 3 }, affectedIds: ["obj-1"], warnings: [{ code: "SIZES_INLINE", count: 1, message: "worldBoxSizeM {\"obj-1\":[4,0.01,2]}" }] },
	inspect_studio: { ok: true, revision: 3, entities: [] },
	run_action: { splitByDomain: true, ok: true, status: "applied", receiptId: "r4", revision: { before: 3, after: 5 }, affectedIds: ["a", "b"], commands: [
		{ kind: "object", opIndices: [0], receipt: { ok: true, output: { worldBoxSizeM: { a: [1, 1, 1] } }, warnings: [] } },
		{ kind: "shot", opIndices: [1], receipt: { ok: true, warnings: [{ code: "SIZES_TRUNCATED", count: 3, message: "worldBoxSizeM lists 0 of 3 objects (8 KiB receipt); inspect_studio scope entities with ids has the rest." }], output: { worldBoxSizeM: {} } } }] },
};
const tools = Object.keys(receipts).map(name => ({ name, description: name, handler: async () => receipts[name] }));
const script = createScriptTool({ tools });
const result = await script.handler({ code: "await tools.arrange_objects({}); await tools.patch_elements({}); await tools.inspect_studio({}); await tools.run_action({}); return 1;" }, {});
assert.equal(result.ok, true, JSON.stringify(result));
const [arranged, patched, inspected, split] = result.calls;
assert.equal(arranged.affectedIds.length, 8, "affectedIds stay cut at 8 as before");
assert.deepEqual(arranged.worldBoxSizeM, sizes, "every size of the nested receipt, past the 8 ids");
assert.equal(arranged.sizesNote, undefined);
assert.deepEqual(patched.worldBoxSizeM, undefined);
assert.equal(patched.sizesNote, "worldBoxSizeM {\"obj-1\":[4,0.01,2]}", "a partial receipt's sizes line rides as the note");
assert.deepEqual(Object.keys(inspected).sort(), ["affectedIds", "code", "message", "name", "ok", "receiptId", "revision", "status"], "a call that sizes nothing gains no field");
assert.deepEqual(split.worldBoxSizeM, { a: [1, 1, 1] }, "a split patch merges its receipts' sizes");
assert.match(split.sizesNote, /lists 0 of 3 objects/);
assert.match(script.description, /worldBoxSizeM when the call created or resized objects/);
console.log("PASS a script's calls summary carries every stated size and the note on what is missing");

const studio = createStudioTools({ liveHub: { command: async () => ({}) }, workspaceHandle: "w" });
const library = OBJECT_LIBRARY.map(entry => `${entry.kind} [${[entry.footprint.width, entry.height, entry.footprint.depth].join(", ")}]`).join(", ");
for (const tool of studio) {
	const states = tool.description.includes(`At scale 1 a primitive's box is [x, y, z] m: ${library}; scale multiplies each axis.`);
	assert.equal(states, ["arrange_objects", "patch_elements", "run_action"].includes(tool.name), `${tool.name}: primitive sizes only on the object tools`);
	assert.equal(tool.description.includes("output.worldBoxSizeM"), states);
}
console.log("PASS the object tools state each primitive's box at scale 1 as the object library has it");
