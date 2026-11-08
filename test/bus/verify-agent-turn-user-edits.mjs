// The user's own edits during an agent turn (command-bus.js, agent-turn-hold.js). Before the turn has authored, an Add
// and a drag go through as their own history entries, and the agent's command during the drag answers the gesture
// TARGET_BUSY the sidecar waits out (bin/agent/studio-busy-wait.mjs). Once the turn has authored, the user's edit is
// refused with a message that names the agent and Stop, never silently; the turn still lands as one entry.
import assert from "node:assert/strict";
import { createAppContext } from "../../src/app-context.js";
import { createCommandBus } from "../../src/command-bus.js";
import { createDocumentStore } from "../../src/document-store.js";
import { createStudioCommandJournal } from "../../src/studio-agent-commands.js";

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
const receipts = new Map(), shown = [];
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
	showRefusal: message => shown.push(message),
};
const bus = createCommandBus({ registry, ports });
const request = (name, args, extra = {}) => ({
	origin: "agent", name, args, commandId: crypto.randomUUID(),
	host, expectedRevision: revision.current, ...extra,
});
previsMode = "animation";
const turnId = crypto.randomUUID();
const agent = (action, args) => bus.run(action, args, request("run_action", { action, args }, { turnId }));
assert.equal(agent("agent.turn.begin", { turnId }).ok, true);

const added = bus.run("object.add", { object: { id: "user-1" } });
assert.equal(added.ok, true, `before the turn authors, the user's Add goes through: ${JSON.stringify(added)}`);
assert.notEqual(added.undo?.historyEntryId, turnId, "as its own history entry, not the turn's");

const tx = bus.run("run.begin", { id: "object.add", args: { object: { id: "user-2" } } });
assert.equal(tx.ok, true, `the user's drag opens its transaction: ${JSON.stringify(tx)}`);
const waited = agent("object.add", { object: { id: "agent-1" } });
assert.equal(waited.code, "TARGET_BUSY");
assert.match(waited.message, /editor gesture/, "the agent's edit meets the gesture refusal the sidecar waits out");
assert.equal(bus.run("run.update", { txId: tx.txId, args: { object: { id: "user-2" } } }).ok, true);
assert.equal(bus.run("run.commit", { txId: tx.txId }).ok, true, "the drag commits");
console.log("PASS before the turn authors: the user's Add and drag land, and the agent waits for the drag");

const authored = agent("object.add", { object: { id: "agent-1" } });
assert.equal(authored.ok, true, `the agent edits once the drag is over: ${JSON.stringify(authored)}`);
assert.equal(agent("character.add", { character: { id: "agent-cast" } }).ok, true, "a turn of two owners (the composed entry)");
const refused = bus.run("object.add", { object: { id: "user-3" } });
assert.equal(refused.ok, false, "once the turn authored, the user's Add waits for it");
const drag = bus.run("run.begin", { id: "object.add", args: { object: { id: "user-4" } } });
assert.equal(drag.code, "TARGET_BUSY", "and so does a drag");
assert.equal(shown.length, 2, `both refusals are shown to the user: ${JSON.stringify(shown)}`);
for (const message of shown) assert.match(message, /agent is editing.*Stop/i, "naming the agent and Stop");
console.log("PASS once the turn authors: the user's Add and drag are refused with a message naming the agent and Stop");

const finished = agent("agent.turn.finish", { turnId });
assert.equal(finished.ok && finished.undo.entries, 1, JSON.stringify(finished));
assert.deepEqual(objects.read().map(row => row.id), ["user-1", "user-2", "agent-1"]);
{ const undone = bus.run("edit.undo", {}, request("run_action", { action: "edit.undo", args: {} })); assert.equal(undone.ok, true, JSON.stringify(undone)); }
assert.deepEqual(objects.read().map(row => row.id), ["user-1", "user-2"], "undo takes back the turn and keeps the user's edits");
assert.deepEqual(cast.read(), [], "all of the turn");
console.log("PASS the turn still lands as one entry; its undo keeps the user's edits");
