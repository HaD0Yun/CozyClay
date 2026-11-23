#!/usr/bin/env node
// A patch_elements whose ops span domains: the editor refuses it whole (one domain per command); the sidecar
// now runs one command per domain and answers each one's receipt or error with the op indices it carried.
import assert from "node:assert/strict";
import { validateStudioCommand } from "../src/studio-agent-protocol.js";
import { createStudioTools } from "../bin/agent/studio-tools.mjs";
import { patchDomainGroups } from "../bin/agent/patch-domains.mjs";

const at = (x) => ({ position: { x, y: 0, z: 0 } });
const mixed = { ops: [
	{ target: { kind: "object", id: "cube" }, set: at(1) },
	{ target: { kind: "character", id: "char-a" }, set: at(2) },
	{ target: { kind: "object", id: "cone" }, set: at(3) },
] };

// Before: the editor's own check refuses the whole call.
assert.throws(() => validateStudioCommand({ name: "patch_elements", args: mixed }), /One domain per patch/);
assert.equal(patchDomainGroups({ ops: [mixed.ops[0], mixed.ops[2]] }), null, "one domain is not split");
assert.deepEqual(patchDomainGroups(mixed).map((group) => [group.kind, group.indices]), [["object", [0, 2]], ["character", [1]]]);

const sent = [];
const tools = (refuse = () => null) => createStudioTools({ workspaceHandle: "w", liveHub: { command: async (name, args) => {
	sent.push({ name, kinds: args.ops.map((op) => op.target.kind), ids: args.ops.map((op) => op.target.id) });
	const code = refuse(args);
	return code ? { ok: false, code, message: `${code} for ${args.ops[0].target.kind}` } : { ok: true, status: "applied", receiptId: `r-${sent.length}`, affectedIds: args.ops.map((op) => op.target.id) };
} } });
const patch = (set) => set.find((tool) => tool.name === "patch_elements");

// Now: two commands, one per domain, each validated alone; both receipts answered.
const both = await patch(tools()).handler(mixed, { callId: "c1" });
assert.deepEqual(sent.map((row) => [row.kinds, row.ids]), [[["object", "object"], ["cube", "cone"]], [["character"], ["char-a"]]]);
assert.equal(both.splitByDomain, true);
assert.deepEqual(both.commands.map((row) => [row.kind, row.opIndices, row.receipt.receiptId]), [["object", [0, 2], "r-1"], ["character", [1], "r-2"]]);
assert.match(both.note, /spanned 2 domains \(object, character\).*2 patch_elements commands.*all applied/);

// One domain refused: the other still lands, and the refusal is named with its ops.
sent.length = 0;
const part = await patch(tools((args) => (args.ops[0].target.kind === "character" ? "STALE_TARGET" : null))).handler(mixed, { callId: "c2" });
assert.equal(part.commands[0].receipt.status, "applied");
assert.deepEqual(part.commands[1], { kind: "character", opIndices: [1], error: { code: "STALE_TARGET", message: "STALE_TARGET for character" } });
assert.match(part.note, /1 refused \(character\), the others applied/);

// Every domain refused: the call fails, naming each.
await assert.rejects(patch(tools(() => "STALE_TARGET")).handler(mixed, { callId: "c3" }), (error) => error.code === "STALE_TARGET" && /object: STALE_TARGET.*character: STALE_TARGET/.test(error.message));

// The script path (tools.internal.invoke) splits the same way.
sent.length = 0;
const nested = await tools().internal.invoke("patch_elements", mixed, "c4");
assert.equal(nested.commands.length, 2);

// The consumers read receipt fields at the top level: the split answer folds them over its commands.
let scene = 11;
const revisedTools = (refuse = () => null) => createStudioTools({ workspaceHandle: "w", liveHub: { command: async (name, args) => {
	if (name !== "patch_elements") return { ok: false, code: "INVALID_ARGUMENT", message: "$.args: missing required field" };
	const code = refuse(args);
	if (code) return { ok: false, code, message: `${code} for ${args.ops[0].target.kind}` };
	scene++;
	return { ok: true, status: "applied", authored: true, receiptId: `rev-${scene}`, revision: { before: scene - 1, after: scene }, affectedIds: args.ops.map((op) => op.target.id), summary: `Moved ${args.ops[0].target.kind}` };
} } });
const folded = await patch(revisedTools()).handler(mixed, { callId: "c5" });
assert.deepEqual([folded.status, folded.receiptId, folded.receiptIds, folded.revision, folded.affectedIds, folded.authored, folded.code],
	["applied", "rev-13", ["rev-12", "rev-13"], { before: 11, after: 13 }, ["cube", "cone", "char-a"], true, undefined]);
assert.equal(folded.summary, "Moved object Moved character");

const { createScriptTool, scriptEditedBeforeFailing } = await import("../bin/agent/script-tool.mjs");
const { turnEdits } = await import("../bin/agent/studio-review.mjs");
const scriptOver = (set) => createScriptTool({ tools: set.filter((tool) => ["patch_elements", "run_action"].includes(tool.name)) });
const mixedSource = JSON.stringify(mixed);

// (a) A script that edits with a split patch and then fails is rolled back, as a one-domain patch is.
scene = 11;
const failing = await scriptOver(revisedTools()).handler({ code: `await tools.patch_elements(${mixedSource}); await tools.run_action({ action: "x", args: {} }); return 1;` });
assert.equal(failing.ok, false);
assert.deepEqual(failing.calls[0].revision, { before: 11, after: 13 });
assert.equal(failing.calls[0].receiptId, "rev-13");
assert.equal(scriptEditedBeforeFailing(failing), true, "the rollback gate sees the split patch's edits");

// (b) A refused domain inside a script reaches the calls summary: status partial with its code and message.
scene = 11;
const partly = await scriptOver(revisedTools((args) => (args.ops[0].target.kind === "character" ? "STALE_TARGET" : null))).handler({ code: `await tools.patch_elements(${mixedSource}); return "placed";` });
assert.equal(partly.ok, true);
assert.deepEqual([partly.calls[0].ok, partly.calls[0].status, partly.calls[0].code, partly.calls[0].revision], [true, "partial", "STALE_TARGET", { before: 11, after: 12 }]);
assert.match(partly.calls[0].message, /^Refused: character \(ops 1\): STALE_TARGET: STALE_TARGET for character/);
assert.deepEqual(partly.calls[0].affectedIds, ["cube", "cone"], "only the applied domain's ids");

// (c) turnEdits counts a split patch's edits, direct and nested in a script.
const frames = (result) => [{ type: "tool.start", callId: "t", name: "patch_elements", args: mixed }, { type: "tool.done", callId: "t", ok: true, result }];
assert.deepEqual(turnEdits(frames(folded)).ids, ["cube", "cone", "char-a"]);
assert.equal(turnEdits(frames(folded)).edited, true);
assert.deepEqual(turnEdits(frames(partly)).ids, ["cube", "cone"]);

console.log("verify-patch-domains: all checks passed");
