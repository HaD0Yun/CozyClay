// When the automatic review judges the scene (bin/agent/studio-review.mjs): a plain turn once its own work has stopped, a
// Tasks-mode request once all of its tasks are done, never a scene a sibling task is still building, and a repair that
// leaves the very same failures ends the loop and tells the user what is left.
import assert from "node:assert/strict";
import { test } from "node:test";
import { reviewedStart, settledEdits } from "../bin/agent/studio-review.mjs";

const edit = (callId, id) => [{ type: "tool.start", callId, name: "run_action", args: { action: "object.add" } }, { type: "tool.done", callId, ok: true, result: { authored: true, affectedIds: [id] } }];
async function drain(gen) { const out = []; for await (const frame of gen) out.push(frame); return out; }
/** A model whose runs are the given frame lists, in order; it records each input it was started with. */
function model(runs) {
	const inputs = [];
	return { inputs, start: input => { inputs.push(input); const frames = runs[inputs.length - 1] ?? []; return (async function* () { yield* frames; yield { type: "done", usage: { input: 1 } }; })(); } };
}

test("a plain turn is reviewed once, after the model's last edit, not after each tool call", async () => {
	const m = model([[...edit("a", "table"), ...edit("b", "cup"), { type: "text.delta", text: "Built." }]]), reviews = [];
	const frames = await drain(reviewedStart({ start: m.start, review: async edits => { reviews.push(edits.ids); return { findings: [], content: null, images: 0 }; } })({ text: "a cup on a table" }));
	assert.deepEqual(reviews, [["table", "cup"]]);
	assert.equal(m.inputs.length, 1);
	assert.equal(frames.filter(f => String(f.callId).startsWith("review-")).length, 2, "one review: its start and done frames");
});

test("a repair that leaves the same failures ends the loop and tells the user what is left", async () => {
	const m = model([edit("a", "cup"), edit("b", "cup"), edit("c", "cup")]), finding = ["placement: base over 1 cm above what is under it: cup"];
	const frames = await drain(reviewedStart({ start: m.start, review: async () => ({ findings: finding, content: [{ type: "text", text: "fix" }], images: 0 }) })({ text: "x" }));
	assert.equal(m.inputs.length, 2, "one repair run, then the same findings stop it");
	assert.match(frames.filter(f => f.type === "text.delta").map(f => f.text).join(""), /Still failing after a repair[\s\S]*above what is under it: cup/);
});

test("Tasks mode: no review while a sibling task still runs; one review of the whole request when all are done", async () => {
	const changed = new Set(["object:table"]), board = [{ status: "done" }, { status: "running" }], reviews = [];
	const settled = { take: () => settledEdits(board, changed), note: ids => ids.forEach(id => changed.add(id)) };
	const review = async edits => { reviews.push(edits.ids); return { findings: ["placement: base over 1 cm above what is under it: cup"], content: [{ type: "text", text: "x" }], images: 0 }; };
	// the coordinator's turn after the first task ended: the table is built, the cup's task still runs
	const first = model([[{ type: "text.delta", text: "table done" }]]);
	await drain(reviewedStart({ start: first.start, review, settled })({ text: "", contextText: "<board/>" }));
	assert.deepEqual(reviews, [], "half a scene is not judged");
	assert.equal(first.inputs[0].contextText, "<board/>");
	// the cup's task ends: the next coordinator turn reviews everything the request changed, once, before it answers
	board[1].status = "done"; changed.add("object:cup");
	const second = model([[{ type: "text.delta", text: "all done" }]]);
	await drain(reviewedStart({ start: second.start, review, settled })({ text: "", contextText: "<board/>" }));
	assert.deepEqual(reviews, [["table", "cup"]]);
	assert.match(second.inputs[0].contextText, /<scene-review>[\s\S]*above what is under it: cup[\s\S]*<\/scene-review>/, "the coordinator hears the failures");
	assert.equal(changed.size, 0, "what was reviewed is not reviewed again");
	const third = model([[{ type: "text.delta", text: "ok" }]]);
	await drain(reviewedStart({ start: third.start, review, settled })({ text: "", contextText: "" }));
	assert.equal(reviews.length, 1);
});
