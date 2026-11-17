#!/usr/bin/env node
// What the Studio agent sees of the editor's actions (bin/agent/agent-view.mjs): under the lowvis engine the hidden
// actions leave both action indexes and the actions read, run_action refuses them, root paths are refused for a rig
// character and allowed for a capsule figure; under the old engine nothing changes; the unfiltered tools still run.
import assert from "node:assert/strict";
import { commandDeclarations } from "../../src/commands/index.js";
import { HIDDEN_ACTIONS } from "../../bin/agent/motion-engine.mjs";
import { turnAgentView } from "../../bin/agent/agent-view.mjs";

const declared = new Set(commandDeclarations().map(row => row.id));
const missing = HIDDEN_ACTIONS.filter(id => !declared.has(id));
assert.deepEqual(missing, [], "every hidden action is an editor action");
console.log(`PASS every one of the ${HIDDEN_ACTIONS.length} hidden actions exists in commandDeclarations()`);

const INDEX = [...HIDDEN_ACTIONS, "object.add", "character.addWaypoint", "character.set"].map(id => ({ id }));
const entities = [{ kind: "character", id: "rig-1", characterKind: "rig" }, { kind: "character", id: "cap-1", characterKind: "proxy" }];
function setup(env) {
	const value = { context: { actionIndex: INDEX.map(row => ({ ...row })), entities } }, current = { actionIndex: INDEX.map(row => ({ ...row })) };
	const ran = [], lookups = [];
	const raw = [
		{ name: "run_action", handler: async args => { ran.push(args.action); return { ok: true }; } },
		{ name: "arrange_characters", handler: async () => ({ ok: true }) },
		{ name: "inspect_studio", handler: async args => (args.scope === "actions" ? { actions: INDEX } : { entities: [] }) },
	];
	const invoke = async (name, args) => { lookups.push([name, args]); return { entities: [{ id: "rig-2", characterKind: "rig" }] }; };
	const view = turnAgentView({ env, value, current, invoke });
	const tools = Object.fromEntries(view.tools(raw).map(tool => [tool.name, tool]));
	return { value, current, ran, lookups, raw, tools };
}
const refused = (promise, pattern) => assert.rejects(promise, error => error.code === "NOT_AVAILABLE" && pattern.test(error.message));

// lowvis
{
	const { value, current, ran, lookups, raw, tools } = setup({});
	const hidden = new Set(HIDDEN_ACTIONS);
	assert.equal(value.context.actionIndex.filter(row => hidden.has(row.id)).length, 0, "the model's index has none");
	assert.equal(current.actionIndex.filter(row => hidden.has(row.id)).length, 0, "the authoritative index has none");
	assert.deepEqual(value.context.actionIndex.map(row => row.id), ["object.add", "character.addWaypoint", "character.set"]);
	assert.deepEqual((await tools.inspect_studio.handler({ scope: "actions" })).actions.map(row => row.id), ["object.add", "character.addWaypoint", "character.set"]);
	for (const action of HIDDEN_ACTIONS) await refused(tools.run_action.handler({ action, args: { characterId: "cap-1" } }), new RegExp(`^${action.replace(".", "\\.")} is not available to the agent; body motion is the motion tool's work$`));
	assert.deepEqual(ran, [], "no hidden action ran");
	await refused(tools.run_action.handler({ action: "character.addWaypoint", args: { characterId: "rig-1" } }), /rig character rig-1/);
	await tools.run_action.handler({ action: "character.addWaypoint", args: { characterId: "cap-1" } });
	await refused(tools.run_action.handler({ action: "character.clearWaypoints", args: { characterId: "rig-2" } }), /rig character rig-2/);
	assert.equal(lookups[0][0], "inspect_studio", "a character the context does not list is read once");
	await refused(tools.run_action.handler({ action: "character.set", args: { id: "rig-1", set: { pose: "sit" } } }), /character\.set with pose/);
	await tools.run_action.handler({ action: "character.set", args: { id: "rig-1", set: { name: "Ann" } } });
	await refused(tools.arrange_characters.handler({ ops: [{ characterId: "rig-1", pose: "wave" }] }), /arrange_characters with pose/);
	await tools.arrange_characters.handler({ ops: [{ characterId: "cap-1", pose: "sit" }] });
	assert.deepEqual(ran, ["character.addWaypoint", "character.set"]);
	// the unfiltered tool (what internal.invoke runs, for the motion tool's install) is left as it was
	await raw[0].handler({ action: "motion.compile", args: {} });
	assert.deepEqual(ran.at(-1), "motion.compile");
	console.log("PASS lowvis: hidden actions out of both indexes and the actions read, refused by run_action; root paths refused for rigs only; the internal path passes");
}

// lowvis: block figures only; the agent cannot cast a capsule figure, and what it reads has none
{
	const decl = Object.fromEntries(commandDeclarations().map(row => [row.id, row]));
	const rows = ["character.add", "character.update", "character.set", "project.new"].map(id => decl[id]);
	const { value, ran } = setup({});
	value.context.scene = { name: "s", castStyle: "hybrid" };
	const env = {}, current = { actionIndex: rows };
	const view = turnAgentView({ env, value, current, invoke: async () => ({}) });
	assert.equal("castStyle" in value.context.scene, false, "the context has no cast style");
	assert.doesNotMatch(JSON.stringify(current.actionIndex), /proxy-figure|posture|castStyle/, "the actions read have no capsule model, posture or cast style");
	assert.match(JSON.stringify(current.actionIndex), /x-bot-tpose \(the default\) or the model id of a rig imported/);
	assert.match(JSON.stringify(rows), /proxy-figure/, "the editor's declarations stay whole");
	const viewed = Object.fromEntries(view.tools([{ name: "run_action", handler: async args => { ran.push(args.action); return { ok: true }; } }, { name: "patch_elements", handler: async () => ({ ok: true }) }]).map(tool => [tool.name, tool]));
	const BLOCK = /^This version has block figures only: the agent cannot add a capsule figure \(model proxy-figure\) or change a character into one\.$/;
	await refused(viewed.run_action.handler({ action: "character.add", args: { character: { model: "proxy-figure" } } }), BLOCK);
	await refused(viewed.run_action.handler({ action: "character.update", args: { characterId: "rig-1", patch: { model: "proxy-figure" } } }), BLOCK);
	await refused(viewed.run_action.handler({ action: "character.set", args: { ops: [{ id: "rig-1", set: { model: "proxy-figure" } }] } }), BLOCK);
	await refused(viewed.patch_elements.handler({ ops: [{ target: { kind: "character", id: "rig-1" }, set: { model: "proxy-figure" } }] }), BLOCK);
	assert.deepEqual(ran, [], "none ran");
	await viewed.run_action.handler({ action: "character.add", args: { character: { model: "x-bot-tpose" } } });
	await viewed.run_action.handler({ action: "character.update", args: { characterId: "cap-1", patch: { x: 1 } } });
	assert.deepEqual(ran, ["character.add", "character.update"], "a block figure is added; a capsule figure already there is still moved");
	const old = { context: { scene: { castStyle: "hybrid" } } };
	turnAgentView({ env: { COZYCLAY_MOTION_ENGINE: "old" }, value: old, current: {} });
	assert.equal(old.context.scene.castStyle, "hybrid", "the old engine keeps the cast style");
	console.log("PASS lowvis: the agent cannot add or make a capsule figure; the actions read and the context have no capsule fields");
}

// old engine: nothing filtered
{
	const { value, current, ran, tools } = setup({ COZYCLAY_MOTION_ENGINE: "old" });
	assert.equal(value.context.actionIndex.length, INDEX.length);
	assert.equal(current.actionIndex.length, INDEX.length);
	assert.equal((await tools.inspect_studio.handler({ scope: "actions" })).actions.length, INDEX.length);
	await tools.run_action.handler({ action: "motion.compile", args: {} });
	await tools.run_action.handler({ action: "character.addWaypoint", args: { characterId: "rig-1" } });
	assert.deepEqual(ran, ["motion.compile", "character.addWaypoint"]);
	console.log("PASS old engine: nothing is filtered");
}
