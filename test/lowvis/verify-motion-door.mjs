#!/usr/bin/env node
// The motion tool of the Studio agent (bin/agent/motion-door.mjs): it answers the motion run's report and Missing line
// unchanged, passes the user's pictures only when asked and only those of the latest user turn, and rolls the turn back
// once when the Studio refused the install. turnMotionDoor runs against a local stand-in for CLIProxyAPI's model list.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { createMotionDoor, turnMotionDoor } from "../../bin/agent/motion-door.mjs";
import { createTaskBoard } from "../../bin/agent/studio-tasks.mjs";
import { mainContextText } from "../../bin/agent/main-agent.mjs";

const DONE = { report: "She waves.\nMissing: the wave has no wrist.", missing: "the wave has no wrist.", frames: 72, seconds: 31, compiles: 2, characterIds: ["c1"], objectIds: [], switched: [] };
const door = ({ run = async () => DONE, images = () => [] } = {}) => {
	const calls = { mark: 0, rollback: 0, runs: [] };
	const tool = createMotionDoor({ run: async args => { calls.runs.push(args); return run(args); }, mark: async () => { calls.mark++; return null; }, rollback: async () => { calls.rollback++; return null; }, images });
	return { tool, calls };
};

// the answer is the run's, unchanged
{
	const { tool, calls } = door({ run: async ({ onCompile }) => { onCompile({ n: 1, ok: false, line: "motion 1: problems" }); onCompile({ n: 2, ok: true, line: "motion 2: ok" }); return DONE; } });
	assert.equal(tool.name, "motion");
	assert.deepEqual(tool.parameters.required, ["request"]);
	const frames = [];
	const answer = await tool.handler({ request: "she waves" }, { toolCallId: "call-1", emit: frame => frames.push(frame) });
	assert.equal(answer.report, DONE.report);
	assert.equal(answer.missing, DONE.missing);
	assert.deepEqual({ ...answer }, { ok: true, report: DONE.report, missing: DONE.missing, frames: 72, seconds: 31, compiles: 2, characters: ["c1"], objects: [], switched: [] });
	assert.equal(calls.mark, 1);
	assert.equal(calls.runs[0].request, "she waves");
	assert.deepEqual(frames.map(f => [f.type, f.callId, f.index, f.status]), [["tool.progress", "call-1", 1, "failed"], ["tool.progress", "call-1", 2, "done"]]);
	console.log("PASS motion door: report and Missing line unchanged, one progress frame per compile");
}

// pictures only when asked
{
	const pictures = [{ data: "AAAA", mimeType: "image/png" }];
	const { tool, calls } = door({ images: () => pictures });
	await tool.handler({ request: "like this", images: true });
	await tool.handler({ request: "like this" });
	assert.deepEqual(calls.runs.map(r => r.images), [pictures, []]);
	console.log("PASS motion door: images true passes the stored pictures, absent passes none");
}

// a studio refusal rolls back once; other failures do not
{
	const { tool, calls } = door({ run: async () => { throw Object.assign(new Error("refused"), { code: "studio" }); } });
	await assert.rejects(tool.handler({ request: "x" }), error => error.code === "studio");
	assert.equal(calls.rollback, 1);
	const upstream = door({ run: async () => { throw Object.assign(new Error("proxy down"), { code: "upstream" }); } });
	await assert.rejects(upstream.tool.handler({ request: "x" }), error => error.code === "upstream");
	assert.equal(upstream.calls.rollback, 0);
	console.log("PASS motion door: a studio failure calls rollback once");
}

// turnMotionDoor: the pictures of an earlier turn do not go with a later request
{
	const proxy = createServer((req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ data: [{ id: "claude-opus-5-5" }] })); });
	proxy.listen(0, "127.0.0.1"); await once(proxy, "listening");
	const env = { CLIPROXY_BASE_URL: `http://127.0.0.1:${proxy.address().port}`, CLIPROXY_API_KEY: "test" };
	const seen = [];
	const deps = {
		studioScene: () => ({ scene: { characters: [], props: [], others: [] }, ids: { characters: {}, props: {}, switch: [] } }),
		runScene: async options => { seen.push(options.images); return { wallMs: 0, compiles: 0, report: "Nothing to do.\nMissing: everything.", missing: "everything.", final: null }; },
		readClip: () => null, installClip: async () => ({ ok: true }),
	};
	const turn = (extra = {}) => turnMotionDoor({ value: { sessionId: "conv-1", context: { host: { workspaceHandle: "ws" } }, ...extra }, env, hub: { command: async () => ({}) },
		tools: { internal: { invoke: async () => ({}) } }, transaction: { mark: async () => null, rollback: async () => null }, signal: new AbortController().signal, deps });
	try {
		const first = await turn({ attachments: [{ dataUrl: "data:image/png;base64,QUJD", name: "pose.png" }] });
		assert.ok(first, "the door is there while the proxy lists the motion writer's model");
		await first.handler({ request: "like the picture", images: true });
		const task = await turn({ sessionId: "task-session", task: { parentId: "conv-1" } });
		await task.handler({ request: "like the picture", images: true });
		const later = await turn();
		await later.handler({ request: "now jump", images: true });
		assert.deepEqual(seen, [[{ data: "QUJD", mimeType: "image/png" }], [{ data: "QUJD", mimeType: "image/png" }], []], "a task reads its main session's pictures; a later turn without pictures passes none");
		assert.equal(await turn({ main: {} }), null, "the coordinator gets no motion tool");
		assert.equal(await turnMotionDoor({ value: { sessionId: "x", context: { host: {} } }, env: { ...env, COZYCLAY_MOTION_ENGINE: "old" } }), null, "nor the old engine");
	} finally { proxy.close(); }
	console.log("PASS turnMotionDoor: pictures of an earlier turn are not passed after a turn without pictures");
}

// a task whose run called the motion tool: its Missing text reaches the coordinator under a fixed label
{
	const events = [];
	const board = createTaskBoard({ limits: { staggerMs: 0 }, emit: event => events.push(event), run: async () => ({ status: "done", reply: "The motion is in.", receipts: [], missing: "the hands do not hold the table edge." }) });
	const { taskId } = board.dispatch({ title: "lean", instructions: "he leans on the table", scope: ["stage"] });
	for (let i = 0; i < 50 && board.board().find(t => t.taskId === taskId)?.status !== "done"; i++) await new Promise(resolve => setTimeout(resolve, 10));
	const task = board.board().find(t => t.taskId === taskId);
	assert.equal(task.summary.missing, "Missing: the hands do not hold the table edge.");
	assert.ok(mainContextText(board, events).includes("\"missing\":\"Missing: the hands do not hold the table edge.\""), "the coordinator's context carries it");
	console.log("PASS a task's done summary carries the motion tool's Missing line for the coordinator");
}
