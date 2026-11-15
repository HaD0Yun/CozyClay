#!/usr/bin/env node
import assert from "node:assert/strict";
import { createAppContext } from "../src/app-context.js";
import { createCommandBus } from "../src/command-bus.js";
import { createDocumentStore } from "../src/document-store.js";
import { createStudioCommandJournal } from "../src/studio-agent-commands.js";

const host = { workspaceId: "workspace", documentEpoch: "document", sceneId: "scene", sceneEpoch: "epoch" };
const revision = { current: 0 };
let previsMode = "storyboard";
const app = createAppContext();
const castStore = createDocumentStore({ owned: { characters: [] }, dev: false });
const objectStore = createDocumentStore({ owned: { objects: [] }, dev: false });
const cast = {
	documentStore: castStore,
	beginAction: targetId => castStore.beginAction("characters", targetId),
	write(update) {
		const before = castStore.read("characters");
		const next = typeof update === "function" ? update(before) : update;
		castStore.write("characters", next);
		if (next !== before) revision.current++;
		return next;
	},
	read: () => castStore.read("characters"),
};
const objects = {
	documentStore: objectStore,
	beginAction: targetId => objectStore.beginAction("objects", targetId),
	write(update) {
		const before = objectStore.read("objects");
		const next = typeof update === "function" ? update(before) : update;
		objectStore.write("objects", next);
		if (next !== before) revision.current++;
		return next;
	},
	read: () => objectStore.read("objects"),
};
app.registerStoreDomain("cast", cast);
app.registerStoreDomain("objects", objects);
app.updatePorts({ revision });

const actions = {
	"character.add": {
		id: "character.add", kind: "mutation", undoDomain: "cast", exposure: "public",
	},
	"object.add": {
		id: "object.add", kind: "mutation", undoDomain: "objects", exposure: "public",
	},
};
const registry = {
	state: () => ({}),
	prepare(id, args) { return { entry: actions[id], args }; },
	invoke(entry, args) {
		if (entry.id === "character.add") {
			cast.write(rows => [...rows, args.character]);
			return { affectedIds: [args.character.id], summary: "Added character" };
		}
		objects.write(rows => [...rows, args.object]);
		return { affectedIds: [args.object.id], summary: "Added object" };
	},
};
const journal = createStudioCommandJournal({ host });
const receipts = new Map();
const ports = {
	read: () => ({
		host, revision: revision.current, previsMode, busy: false,
		domainRevisions: { cast: revision.current, objects: revision.current },
	}),
	journal: () => journal,
	recordAction: (...args) => app.recordAction(...args),
	beginAction: (...args) => app.beginAction(...args),
	revision,
	isRetained: receipt => Boolean(app.storeDomainForReceipt(receipt)),
	canUndo: receipt => Boolean(app.storeDomainForReceipt(receipt)?.canUndo(receipt.undo.historyEntryId)),
	undo: () => app.nextStoreHistory(false)?.stepHistory(false),
	redo: () => app.nextStoreHistory(true)?.stepHistory(true),
	history: redo => app.historyEntry(redo),
	receipt: id => receipts.get(id),
	readTarget: id => id,
	remember: receipt => { receipts.set(receipt.receiptId, receipt); return receipt; },
};
const bus = createCommandBus({ registry, ports });
const request = (name, args, extra = {}) => ({
	origin: "agent", name, args, commandId: crypto.randomUUID(),
	host, expectedRevision: revision.current, ...extra,
});
const turnId = crypto.randomUUID();
const begin = bus.run("agent.turn.begin", { turnId }, request("run_action", { action: "agent.turn.begin", args: { turnId } }, { turnId }));
assert.equal(begin.ok, true, JSON.stringify(begin));

const character = bus.run("character.add", { character: { id: "character-1" } }, request("run_action", { action: "character.add", args: { character: { id: "character-1" } } }, { turnId }));
assert.equal(character.ok, true, JSON.stringify(character));
assert.deepEqual(character.undo, { historyEntryId: turnId, entries: 1, canUndoDirect: false });
const object = bus.run("object.add", { object: { id: "object-1" } }, request("run_action", { action: "object.add", args: { object: { id: "object-1" } } }, { turnId }));
assert.equal(object.ok, true, JSON.stringify(object));
assert.deepEqual(object.undo, { historyEntryId: turnId, entries: 1, canUndoDirect: false });

const finish = bus.run("agent.turn.finish", { turnId }, request("run_action", { action: "agent.turn.finish", args: { turnId } }, { turnId }));
assert.equal(finish.ok, true, JSON.stringify(finish));
assert.equal(finish.authored, true);
assert.equal(finish.undo.entries, 1);
assert.equal(typeof finish.undo.historyEntryId, "string");
assert.deepEqual(cast.read(), [{ id: "character-1" }]);
assert.deepEqual(objects.read(), [{ id: "object-1" }]);

const undone = bus.run("edit.undo", {}, request("run_action", { action: "edit.undo", args: {} }));
assert.equal(undone.ok, true, JSON.stringify(undone));
assert.equal(undone.status, "undone");
assert.deepEqual(cast.read(), []);
assert.deepEqual(objects.read(), []);

const animationRevision = revision.current;
const animation = bus.run("character.add", { character: { id: "character-2" } }, {
	origin: "agent", name: "run_action", args: { action: "character.add", args: { character: { id: "character-2" } } },
	commandId: crypto.randomUUID(), host, expectedRevision: animationRevision,
});
assert.equal(animation.ok, true, JSON.stringify(animation));
assert.equal(animation.undo.entries, 1);
assert.notEqual(animation.undo.historyEntryId, finish.undo.historyEntryId);
console.log("PASS agent turn composes cast and object mutations into one undo entry");
console.log(`PASS ordinary agent command remains per-command undo: ${animation.undo.entries} entry`);

// #715: an animation project opens the same turn transaction. Every mutation of
// one user message lands as exactly one history entry, undone by one edit.undo.
previsMode = "animation";
const preTurn = { cast: cast.read(), objects: objects.read(), entry: app.historyEntry(false) };
const animationTurnId = crypto.randomUUID();
const control = (action, id) => bus.run(action, { turnId: id }, request("run_action", { action, args: { turnId: id } }, { turnId: id }));
const opened = control("agent.turn.begin", animationTurnId);
assert.equal(opened.ok, true, `an animation project opens a turn transaction: ${JSON.stringify(opened)}`);
const turnMutations = [
	["character.add", { character: { id: "character-3" } }],
	["object.add", { object: { id: "object-2" } }],
	["object.add", { object: { id: "object-3" } }],
];
for (const [action, args] of turnMutations) {
	const mutation = bus.run(action, args, request("run_action", { action, args }, { turnId: animationTurnId }));
	assert.equal(mutation.ok, true, JSON.stringify(mutation));
	assert.deepEqual(mutation.undo, { historyEntryId: animationTurnId, entries: 1, canUndoDirect: false });
}
const refusedUndo = bus.run("edit.undo", {}, request("run_action", { action: "edit.undo", args: {} }));
assert.equal(refusedUndo.code, "TARGET_BUSY", "history traversal waits for the open turn");
const closed = control("agent.turn.finish", animationTurnId);
assert.equal(closed.ok, true, JSON.stringify(closed));
assert.equal(closed.authored, true);
assert.equal(closed.undo.entries, 1);
assert.equal(app.historyEntry(false), closed.undo.historyEntryId, "the turn is the newest history entry");
assert.deepEqual(cast.read(), [...preTurn.cast, { id: "character-3" }]);
assert.deepEqual(objects.read(), [...preTurn.objects, { id: "object-2" }, { id: "object-3" }]);
const undoneTurn = bus.run("edit.undo", { receiptId: closed.receiptId }, request("run_action", { action: "edit.undo", args: { receiptId: closed.receiptId } }));
assert.equal(undoneTurn.ok, true, JSON.stringify(undoneTurn));
assert.equal(undoneTurn.status, "undone");
assert.deepEqual({ cast: cast.read(), objects: objects.read(), entry: app.historyEntry(false) }, preTurn, "one edit.undo restores the pre-turn document and history frontier");
console.log(`PASS animation agent turn composes ${turnMutations.length} mutations into one history entry undone by one edit.undo`);

// #735: "undo the last thing" arrives inside the next turn's transaction, before that turn
// has authored anything. Traversal must be allowed then, and refused again once the turn
// has its first authored edit.
{
	const redoneTurn = bus.run("edit.redo", { receiptId: closed.receiptId }, request("run_action", { action: "edit.redo", args: { receiptId: closed.receiptId } }));
	assert.equal(redoneTurn.ok, true, JSON.stringify(redoneTurn));
	assert.deepEqual(objects.read(), [...preTurn.objects, { id: "object-2" }, { id: "object-3" }], "redo puts the turn back so the next turn has something to undo");
	const undoTurnId = crypto.randomUUID();
	assert.equal(control("agent.turn.begin", undoTurnId).ok, true);
	const undoInsideTurn = bus.run("edit.undo", { receiptId: closed.receiptId }, request("run_action", { action: "edit.undo", args: { receiptId: closed.receiptId } }, { turnId: undoTurnId }));
	assert.equal(undoInsideTurn.ok, true, `an unauthored turn may traverse history: ${JSON.stringify(undoInsideTurn)}`);
	assert.equal(undoInsideTurn.status, "undone");
	assert.deepEqual({ cast: cast.read(), objects: objects.read() }, { cast: preTurn.cast, objects: preTurn.objects }, "the previous turn is undone from inside the new turn");
	const laterEdit = bus.run("object.add", { object: { id: "object-4" } }, request("run_action", { action: "object.add", args: { object: { id: "object-4" } } }, { turnId: undoTurnId }));
	assert.equal(laterEdit.ok, true, JSON.stringify(laterEdit));
	const refusedAfterEdit = bus.run("edit.undo", {}, request("run_action", { action: "edit.undo", args: {} }, { turnId: undoTurnId }));
	assert.equal(refusedAfterEdit.code, "TARGET_BUSY", "once the turn authored something, traversal waits again");
	const closedUndoTurn = control("agent.turn.finish", undoTurnId);
	assert.equal(closedUndoTurn.ok, true, JSON.stringify(closedUndoTurn));
	assert.equal(closedUndoTurn.authored, true, "the later edit still lands as the turn's own entry");
	assert.deepEqual(objects.read(), [...preTurn.objects, { id: "object-4" }]);
	console.log("PASS #735 an unauthored agent turn may undo the previous turn; traversal is refused again after its first edit");
}

// A rolled-back turn restores every owner it touched and leaves no entry.
const preRollback = { cast: cast.read(), objects: objects.read(), entry: app.historyEntry(false) };
const rollbackTurnId = crypto.randomUUID();
assert.equal(control("agent.turn.begin", rollbackTurnId).ok, true);
for (const [action, args] of turnMutations) assert.equal(bus.run(action, args, request("run_action", { action, args }, { turnId: rollbackTurnId })).ok, true);
assert.equal(cast.read().length, preRollback.cast.length + 1);
const cancelled = control("agent.turn.cancel", rollbackTurnId);
assert.equal(cancelled.ok, true, JSON.stringify(cancelled));
assert.equal(cancelled.authored, false);
assert.equal(cancelled.undo, null);
assert.deepEqual({ cast: cast.read(), objects: objects.read(), entry: app.historyEntry(false) }, preRollback, "agent.turn.cancel restores the pre-turn document without a history entry");
const afterRollback = bus.run("character.add", { character: { id: "character-4" } }, request("run_action", { action: "character.add", args: { character: { id: "character-4" } } }, { turnId: rollbackTurnId }));
assert.equal(afterRollback.code, "STALE_TARGET", "a cancelled turn admits no more mutations");
console.log("PASS agent.turn.cancel rolls the whole turn back with no history entry");

// 9240db36: the agent reverts its own edit inside its turn with undo_edit { receiptId }. The newest
// edit of the turn rolls back to the savepoint before it, the turn stays open and still lands as one
// entry; an older edit is refused with what to do instead.
{
	const preOwn = { cast: cast.read(), objects: objects.read() };
	const ownTurnId = crypto.randomUUID();
	const add = (action, args) => bus.run(action, args, request("run_action", { action, args }, { turnId: ownTurnId }));
	const undo = receiptId => bus.run("edit.undo", { receiptId }, request("run_action", { action: "edit.undo", args: { receiptId } }, { turnId: ownTurnId }));
	assert.equal(control("agent.turn.begin", ownTurnId).ok, true);
	const first = add("object.add", { object: { id: "object-5" } }), second = add("character.add", { character: { id: "character-5" } });
	assert.equal(first.ok && second.ok, true);
	const older = undo(first.receiptId);
	assert.equal(older.code, "UNDO_CONFLICT", JSON.stringify(older));
	assert.match(older.message, new RegExp(second.receiptId), "the refusal names the later edit to undo first");
	const own = undo(second.receiptId);
	assert.equal(own.ok, true, `the turn's newest edit is undone inside the turn: ${JSON.stringify(own)}`);
	assert.equal(own.status, "completed");
	assert.equal(own.output.undoneReceiptId, second.receiptId);
	assert.deepEqual(own.affectedIds, ["character-5"]);
	assert.deepEqual(cast.read(), preOwn.cast, "the character the turn added is gone");
	assert.deepEqual(objects.read(), [...preOwn.objects, { id: "object-5" }], "the earlier edit of the turn stays");
	assert.match(undo(second.receiptId).message, new RegExp(`now ${first.receiptId}`), "an edit is undone once; the refusal names the newest one");
	assert.equal(undo(first.receiptId).ok, true, "then the next older edit is the newest");
	const third = add("object.add", { object: { id: "object-6" } });
	assert.equal(third.ok, true);
	assert.equal(control("agent.turn.mark", ownTurnId).ok, true);
	assert.equal(undo(third.receiptId).ok, true, "the newest edit is undone even when a script's mark came after it");
	const inScript = add("object.add", { object: { id: "object-7" } });
	assert.equal(undo(inScript.receiptId).ok, true, "an edit made inside the script is undone");
	add("object.add", { object: { id: "object-8" } });
	assert.equal(control("agent.turn.rollback", ownTurnId).ok, true, "the script's rollback still finds its mark");
	assert.deepEqual(objects.read(), preOwn.objects, "the rollback removes the script's edits and nothing before them");
	add("object.add", { object: { id: "object-6" } });
	const refused = bus.run("edit.undo", {}, request("run_action", { action: "edit.undo", args: {} }, { turnId: ownTurnId }));
	assert.equal(refused.code, "TARGET_BUSY");
	assert.match(refused.message, /undo_edit with the receiptId/, "the refusal says how to revert the turn's own edit");
	const closedOwn = control("agent.turn.finish", ownTurnId);
	assert.equal(closedOwn.ok && closedOwn.undo.entries, 1, JSON.stringify(closedOwn));
	assert.deepEqual({ cast: cast.read(), objects: objects.read() }, { cast: preOwn.cast, objects: [...preOwn.objects, { id: "object-6" }] }, "only the kept edit lands");
	console.log("PASS an agent turn undoes its own newest edit by receipt and still lands as one entry");
}
