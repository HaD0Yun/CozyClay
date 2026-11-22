// The Agent box's queue (src/workflow/agent-queue.js) over the real chat store (agent-client.js) and a scripted
// transport: messages typed while a turn runs wait in order with what they were typed with; edit and remove; Send now
// hands a row to the running turn and it joins the transcript only when the turn says the model's context took it; a
// turn that ends done sends the first row as the next turn by itself, then the next; Stop holds the queue; a steer the
// turn never read comes back as a queued row; a reload brings the rows back held; another conversation has its own.
import { createAgentChatStore } from "../src/workflow/agent-client.js";
import { createMessageQueue } from "../src/workflow/agent-queue.js";

let failures = 0;
const expect = (name, condition, detail = "") => {
	console.log(`${condition ? "PASS" : "FAIL"} ${name}${condition ? "" : ` — ${detail}`}`);
	if (!condition) failures += 1;
};
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function memoryStorage() {
	const map = new Map();
	return { getItem: (key) => map.get(key) ?? null, setItem: (key, value) => map.set(key, String(value)), removeItem: (key) => map.delete(key), map };
}

/** A transport whose turns the test ends: turns[i] = { request, emit(event), end() }. steer answers by `steerAnswer`. */
function scriptedTransport() {
	const turns = [], steers = [];
	let steerAnswer = () => ({ ok: true, queued: true });
	return {
		turns, steers,
		answerSteer(fn) { steerAnswer = fn; },
		turn(request, onEvent, signal) {
			request.onTurnId?.(`wire-${turns.length + 1}`);
			return new Promise((resolve) => {
				const turn = { request, emit: onEvent, end: () => { onEvent({ type: "done" }); resolve(); } };
				signal?.addEventListener("abort", () => resolve(), { once: true });
				turns.push(turn);
			});
		},
		async steer(turnId, body) { steers.push({ turnId, body }); const answer = steerAnswer(); if (answer instanceof Error) throw answer; return answer; },
		async stop() { return { ok: true }; },
	};
}

function setup(storage = memoryStorage()) {
	const transport = scriptedTransport();
	let queue = null, n = 0;
	const store = createAgentChatStore({ transport, surface: "workflow", newId: () => `id-${++n}`, onSteer: (event) => queue?.steered(event) });
	const sent = [];
	queue = createMessageQueue({ store, storage, newId: () => `row-${++n}`, send: (row) => { sent.push(row); store.send(row.text, { ...row.options, queued: true }); } });
	const unsubscribe = queue.subscribe(() => {});
	return { transport, store, queue, sent, storage, unsubscribe };
}
const userTexts = (store) => store.getState().items.filter((item) => item.kind === "user").map((item) => `${item.steered ? "steer:" : ""}${item.text}`);
const rowTexts = (queue) => queue.getState().rows.map((row) => `${row.status}:${row.text}`);

// --- typed twice during a turn, edited, removed, Send now mid-turn, the rest after the turn -------------------------
{
	const { transport, store, queue, sent } = setup();
	void store.send("make a walk", { model: "p/one", effort: "high" });
	expect("a turn runs", store.getState().streaming === true && transport.turns.length === 1);
	store.setDraft("still typing");
	queue.add("first", { model: "p/one", effort: "high", attachFrame: true, attachments: [{ dataUrl: "data:image/png;base64,AA", name: "a.png", id: "x" }] });
	queue.add("second", { model: "p/two", effort: "low" });
	queue.add("third", { model: "p/one" });
	queue.add("   ", {});
	expect("three rows, in the order they were typed; an empty message is no row", JSON.stringify(rowTexts(queue)) === JSON.stringify(["queued:first", "queued:second", "queued:third"]), JSON.stringify(rowTexts(queue)));
	expect("a row keeps what it was typed with: model, effort, frame switch and pictures (data only)", JSON.stringify(queue.getState().rows[0].options) === JSON.stringify({ model: "p/one", effort: "high", attachFrame: true, attachments: [{ dataUrl: "data:image/png;base64,AA", name: "a.png" }] }), JSON.stringify(queue.getState().rows[0].options));
	const [first, second, third] = queue.getState().rows;
	queue.beginEdit(second.id);
	queue.edit(second.id, "second, edited");
	queue.remove(third.id);
	expect("edit changes a row's text in place; remove takes a row out", JSON.stringify(rowTexts(queue)) === JSON.stringify(["queued:first", "queued:second, edited"]), JSON.stringify(rowTexts(queue)));

	const pending = queue.sendNow(first.id);
	expect("Send now mid-turn: the row reads sending", queue.getState().rows[0].status === "sending");
	const result = await pending;
	expect("the steer goes to the running turn with the row's id, text and pictures", result.ok === true && transport.steers.length === 1 && transport.steers[0].turnId === "wire-1"
		&& transport.steers[0].body.id === first.id && transport.steers[0].body.text === "first" && transport.steers[0].body.attachments?.length === 1, JSON.stringify(transport.steers));
	expect("accepted is not received: the row stays, the transcript does not show it", queue.getState().rows[0].status === "sending" && JSON.stringify(userTexts(store)) === JSON.stringify(["make a walk"]));
	expect("the composer is left alone by a queued row's steer", store.getState().draft === "still typing");
	transport.turns[0].emit({ type: "steer.received", id: first.id });
	expect("once the turn says the model's context took it: the row leaves and the message joins the transcript there", JSON.stringify(rowTexts(queue)) === JSON.stringify(["queued:second, edited"])
		&& JSON.stringify(userTexts(store)) === JSON.stringify(["make a walk", "steer:first"]), `${JSON.stringify(rowTexts(queue))} ${JSON.stringify(userTexts(store))}`);
	expect("nothing went as a new turn while the turn ran", sent.length === 0 && transport.turns.length === 1);

	transport.turns[0].end();
	await tick(); await tick();
	expect("the turn ended done: the first row went as the next turn by itself", sent.length === 1 && sent[0].text === "second, edited" && transport.turns.length === 2 && store.getState().streaming === true, JSON.stringify(sent));
	expect("it went with what it was typed with, and the composer kept what is being typed now", transport.turns[1].request.model === "p/two" && transport.turns[1].request.effort === "low" && store.getState().draft === "still typing",
		JSON.stringify({ model: transport.turns[1].request.model, effort: transport.turns[1].request.effort, draft: store.getState().draft }));
	expect("the queue is empty", queue.getState().rows.length === 0);
}

// --- several rows go one after another; a failed turn moves on too ---------------------------------------------------
{
	const { transport, store, queue, sent } = setup();
	void store.send("one", {});
	queue.add("two", {}); queue.add("three", {});
	transport.turns[0].emit({ type: "error", code: "upstream", message: "boom" });
	transport.turns[0].end();
	await tick(); await tick();
	expect("after a failed turn the first row goes", sent.map((row) => row.text).join() === "two" && transport.turns.length === 2);
	transport.turns[1].end();
	await tick(); await tick();
	expect("when that turn ends, the next row goes", sent.map((row) => row.text).join() === "two,three" && transport.turns.length === 3 && queue.getState().rows.length === 0);
	transport.turns[2].end();
	await tick();
}

// --- Stop holds the queue; Send now starts the held row; the rest follow after it --------------------------------------
{
	const { transport, store, queue, sent } = setup();
	void store.send("long job", {});
	queue.add("after stop A", {}); queue.add("after stop B", {});
	const steering = queue.getState().rows[1];
	await queue.sendNow(steering.id);
	store.stop();
	await tick(); await tick();
	expect("Stop sends nothing by itself and holds the queue", sent.length === 0 && queue.getState().held === true && transport.turns.length === 1);
	expect("a steer the stopped turn never answered comes back as a queued row, in its place, not shown as said", JSON.stringify(rowTexts(queue)) === JSON.stringify(["queued:after stop A", "queued:after stop B"])
		&& !store.getState().items.some((item) => item.steered), JSON.stringify(rowTexts(queue)));
	await queue.sendNow(queue.getState().rows[1].id);
	expect("Send now on a held row starts it as a new turn and lifts the hold", sent.map((row) => row.text).join() === "after stop B" && transport.turns.length === 2 && queue.getState().held === false);
	transport.turns[1].end();
	await tick(); await tick();
	expect("the rows after it follow on their own once that turn ends", sent.map((row) => row.text).join() === "after stop B,after stop A" && queue.getState().rows.length === 0);
	transport.turns[2].end();
	await tick();
}

// --- a steer the turn did not read before it ended comes back and goes as the next turn ------------------------------
{
	const { transport, store, queue, sent } = setup();
	void store.send("short", {});
	queue.add("late", {});
	await queue.sendNow(queue.getState().rows[0].id);
	transport.turns[0].emit({ type: "steer.dropped", id: queue.getState().rows[0].id });
	expect("steer.dropped puts the row back as queued", queue.getState().rows[0]?.status === "queued");
	transport.turns[0].end();
	await tick(); await tick();
	expect("then it goes as the next turn, and the transcript shows it once, as a turn", sent.map((row) => row.text).join() === "late" && JSON.stringify(userTexts(store)) === JSON.stringify(["short", "late"]), JSON.stringify(userTexts(store)));
	transport.turns[1].end();
	await tick();
}

// --- a refused Send now keeps the row --------------------------------------------------------------------------------
{
	const { transport, store, queue } = setup();
	void store.send("busy", {});
	queue.add("too late", {});
	transport.answerSteer(() => Object.assign(new Error("409"), { status: 409, code: "NO_ACTIVE_TURN" }));
	const result = await queue.sendNow(queue.getState().rows[0].id);
	expect("a refused steer answers its code and the row stays queued", result.ok === false && result.code === "NO_ACTIVE_TURN" && queue.getState().rows[0].status === "queued" && result.message.length > 0, JSON.stringify(result));
	transport.turns[0].end();
	await tick(); await tick();
	expect("and goes when the turn ends", transport.turns.length === 2 && transport.turns[1].request.text === "too late");
	transport.turns[1].end();
	await tick();
}

// --- a row open for editing waits, and the rows behind it ------------------------------------------------------------
{
	const { transport, store, queue, sent } = setup();
	void store.send("go", {});
	queue.add("being edited", {}); queue.add("behind it", {});
	queue.beginEdit(queue.getState().rows[0].id);
	transport.turns[0].end();
	await tick(); await tick();
	expect("nothing goes while the first row is open for editing", sent.length === 0 && store.getState().streaming === false);
	queue.edit(queue.getState().rows[0].id, "edited before it went");
	await tick();
	expect("saving it lets it go, edited", sent.map((row) => row.text).join() === "edited before it went");
	transport.turns[1].end();
	await tick(); await tick();
	transport.turns[2]?.end();
	await tick();
}

// --- reload and another conversation ---------------------------------------------------------------------------------
{
	const storage = memoryStorage();
	const first = setup(storage);
	void first.store.send("running", {});
	first.queue.add("kept over a reload", { model: "p/one" });
	const sessionId = first.store.getState().sessionId;
	first.unsubscribe();
	// the reloaded page: a new store restores the same conversation, a new queue over the same storage
	const transport = scriptedTransport();
	const store = createAgentChatStore({ transport, surface: "workflow" });
	store.restore([{ kind: "user", text: "running" }], sessionId);
	const sent = [];
	const queue = createMessageQueue({ store, storage, send: (row) => { sent.push(row); store.send(row.text, { ...row.options, queued: true }); } });
	queue.subscribe(() => {});
	expect("a reload brings the conversation's rows back, held", JSON.stringify(rowTexts(queue)) === JSON.stringify(["queued:kept over a reload"]) && queue.getState().held === true
		&& queue.getState().rows[0].options.model === "p/one", JSON.stringify(queue.getState()));
	store.newSession();
	expect("another conversation shows its own rows (none)", queue.getState().rows.length === 0 && queue.getState().held === false);
	store.restore([], sessionId);
	expect("back in the first conversation, its rows are there again", queue.getState().rows.length === 1);
	expect("nothing was sent on its own", sent.length === 0);
}

if (failures) { console.error(`${failures} FAILURES`); process.exit(1); }
console.log("all agent queue checks PASS");
