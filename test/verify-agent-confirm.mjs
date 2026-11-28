// The Agent panel's approval card (src/workflow/agent-confirm.js): an agent export the Studio's bus refused with
// CONFIRMATION_REQUIRED (its confirmation.required event) becomes a card; Export runs that exact request through the
// host, Cancel declines it, and either answer reaches the model with the next message only.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createAgentChatStore } from "../src/workflow/agent-client.js";
import { confirmCard, withoutConfirmNote } from "../src/workflow/agent-confirm.js";

const context = { actionIndex: [{ id: "export.shotVideo", label: "Export video (mp4)" }], entityIndex: [], shots: [{ id: "shot-1", name: "Opening" }] };
const reason = "Exporting writes a video file outside the Studio.";
const asked = (args = { shotId: "shot-1", scope: "shot" }) => ({ type: "confirmation.required", id: "export.shotVideo", args, reason });

/** A Studio store whose turns answer with one line; every request's text lands in `texts`. */
function storeWith(options = {}) {
	const texts = [];
	const store = createAgentChatStore({ surface: "studio", buildContext: () => context, clock: () => 0, ...options, transport: {
		turn: async (request, on) => { texts.push(request.text); on({ type: "text.delta", text: "Press Export on the card." }); on({ type: "done" }); },
	} });
	return { store, texts, cards: () => store.getState().items.filter(item => item.kind === "confirm") };
}

test("a refused export becomes one card naming the shot", async () => {
	const { store, cards } = storeWith();
	await store.send("export the opening");
	store.askConfirmation(asked());
	store.askConfirmation(asked());
	assert.equal(cards().length, 1, "the same request asked twice is one question");
	assert.deepEqual({ ...cards()[0], id: null }, { kind: "confirm", id: null, action: "export.shotVideo", args: { shotId: "shot-1", scope: "shot" },
		subject: { kind: "shot", name: "Opening" }, reason, state: "pending" });
	store.askConfirmation(asked({ scope: "timeline" }));
	assert.deepEqual(cards().map(card => card.subject.kind), ["shot", "timeline"], "another request is another card");
});

test("Export runs the exact request, once, and the next message tells the agent", async () => {
	const calls = [];
	const { store, texts, cards } = storeWith({ runConfirmed: async (action, args) => { calls.push({ action, args }); return { ok: true, status: "completed", output: { fileName: "opening.mp4", frameCount: 48 } }; } });
	await store.send("export the opening");
	store.askConfirmation(asked());
	await store.approveAction(cards()[0].id);
	assert.deepEqual(calls, [{ action: "export.shotVideo", args: { shotId: "shot-1", scope: "shot" } }]);
	assert.equal(cards()[0].state, "done");
	assert.equal(cards()[0].fileName, "opening.mp4");
	await store.approveAction(cards()[0].id);
	assert.equal(calls.length, 1, "a done card does not export again");
	await store.send("thanks");
	assert.match(texts[1], /^thanks\n\n<studio-note>The user approved the export\.shotVideo of shot "Opening" you asked for and it ran: opening\.mp4\.<\/studio-note>$/);
	assert.equal(store.getState().items.filter(item => item.kind === "user").at(-1).text, "thanks", "the bubble shows only what the user typed");
	await store.send("and again");
	assert.equal(texts[2], "and again", "a note goes with one message only");
});

test("Cancel declines without running and the agent hears it next", async () => {
	let ran = false;
	const { store, texts, cards } = storeWith({ runConfirmed: async () => { ran = true; return { ok: true }; } });
	await store.send("export everything");
	store.askConfirmation(asked({ scope: "timeline" }));
	store.declineAction(cards()[0].id);
	await store.approveAction(cards()[0].id);
	assert.equal(ran, false);
	assert.equal(cards()[0].state, "declined");
	store.askConfirmation(asked({ scope: "timeline" }));
	assert.equal(cards().length, 2, "asked again after an answer: a new question");
	await store.send("ok");
	assert.match(texts[1], /<studio-note>The user declined the export\.shotVideo of the whole timeline you asked for; do not request it again unless they ask\.<\/studio-note>$/);
});

test("a failed export keeps the card open with the reason; no host, no run", async () => {
	const refused = storeWith({ runConfirmed: async () => ({ ok: false, code: "TARGET_NOT_READY", message: "An export is already running; wait for it to finish." }) });
	refused.store.askConfirmation(asked());
	await refused.store.approveAction(refused.cards()[0].id);
	assert.equal(refused.cards()[0].state, "failed");
	assert.equal(refused.cards()[0].error, "An export is already running; wait for it to finish.");
	const hostless = storeWith();
	hostless.store.askConfirmation(asked());
	await hostless.store.approveAction(hostless.cards()[0].id);
	assert.equal(hostless.cards()[0].state, "failed");
	await hostless.store.send("next");
	assert.equal(hostless.texts[0], "next", "a failed export is not reported as approved");
});

test("only a listed command gets a card, only in the Studio", () => {
	const id = () => "card";
	assert.equal(confirmCard([], { id: "scene.delete", args: { sceneId: "s" } }, context, id), null, "deleting a scene stays refused");
	assert.equal(confirmCard([], { id: "project.save", args: {} }, context, id), null);
	assert.deepEqual(confirmCard([], { id: "export.shotVideo" }, context, id).subject, { kind: "current" });
	assert.deepEqual(confirmCard([], { id: "export.shotVideo", args: { shotId: "gone" } }, context, id).subject, { kind: "shot", name: "gone" });
	const workflow = createAgentChatStore({ surface: "workflow", clock: () => 0, transport: { turn: async () => {} } });
	workflow.askConfirmation(asked());
	assert.equal(workflow.getState().items.length, 0);
});

test("a restored transcript shows the user's text without the note", () => {
	assert.equal(withoutConfirmNote("thanks\n\n<studio-note>The user declined it.</studio-note>"), "thanks");
	const { store } = storeWith();
	store.restore([{ kind: "user", text: "thanks\n\n<studio-note>The user declined it.</studio-note>" }, { kind: "assistant", text: "ok <studio-note>x</studio-note>" }]);
	assert.deepEqual(store.getState().items.map(item => item.text), ["thanks", "ok <studio-note>x</studio-note>"]);
});
