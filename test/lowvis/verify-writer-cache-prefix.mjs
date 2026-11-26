#!/usr/bin/env node
// The motion writer's requests on the anthropic-messages wire (src/lowvis/pi/harness.mjs wireForCache): no block a
// request sent changes in a later one up to each of its cache marks, so wherever the provider puts a mark of its own on
// the last message, the next request reads all that went before its newest result. Scripted writers on a local provider
// in the proxy's place, real compiles: six calls of every form (scene+spec, edit, edit+look, spec, look, a rejected
// call, two calls in one message), with the latest pictures (the default) and with all of them. Also: the model reads
// each result's text as the tool's, the newest result's pictures right after it, and an older one's note in their place.
//   node test/lowvis/verify-writer-cache-prefix.mjs
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scriptedProvider, wireBlocks } from "./writer-wire.mjs";
import { writerRoute } from "../../bin/agent/motion-writer.mjs";
import { runScene } from "../../src/lowvis/pi/harness.mjs";
import { DEMOS } from "../../src/lowvis/demos.js";
import push from "../../src/lowvis/engine-simple/demos/push.js";

const DROPPED = "[the sheet images of this call are no longer shown: only the latest call's images are kept]";
const { beats: _beats, ...scene } = DEMOS.push;
const SCRIPTS = {
	"six calls, one per message": [
		{ scene, spec: { a: push.a } },
		{ edit: { a: [[84, "pose", { hip: [0, -0.04, 0.08], over: 9, ease: "out" }]] } },
		{ edit: { a: [[96, "pose", { hip: [0, 0, 0], over: 14 }]] }, look: { view: "side" } },
		{ spec: { a: push.a.map(a => (a[0] === 309 ? [309, "pose", { R: [0.05, 0.6, 0.17], over: 8 }] : a)) } },
		{ look: { frames: [50, 120, 200] } },
		{ edit: { a: [[292, "pose", null]] } },
	],
	"a rejected call and two calls in one message": [
		{ scene, spec: { a: push.a } },
		{ edit: { a: [[84, "nosuchverb", {}]] } },
		[{ edit: { a: [[96, "pose", { hip: [0, 0, 0], over: 14 }]] } }, { look: { view: "top" } }],
		{},
		{ look: { frames: [10, 20] }, edit: { a: [[262, "pose", { hands: "rest", look: "fwd", over: 20 }]] } },
	],
};
for (const k of ["CLIPROXY_BASE_URL", "CLIPROXY_API_KEY"]) delete process.env[k];
for (const [label, calls] of Object.entries(SCRIPTS)) for (const keepImages of ["latest", "all"]) {
	const provider = await scriptedProvider({ calls });
	Object.assign(process.env, { CLIPROXY_BASE_URL: provider.base, CLIPROXY_API_KEY: "test-key" });
	let record;
	try { record = await runScene({ name: "cache-prefix", request: "a pushes the crate.", variant: "studio", model: "claude-opus-5-5", effort: "medium", keepImages, env: process.env, outDir: mkdtempSync(join(tmpdir(), "cache-prefix-")) }); } finally { provider.close(); }
	assert.equal(record.infraError, null, JSON.stringify(record.infraError));
	assert.equal(record.modelCalls, calls.length + 1);
	const wires = provider.requests.map(wireBlocks), parsed = provider.requests.map(body => JSON.parse(body));
	wires.forEach((wire, n) => {
		assert.ok(wire.marks.length <= 4, `request ${n + 1}: at most four marks`);
		assert.ok(wire.marks.some(m => wire.blocks[m].includes(n ? ".user:" : "0.user:")), `request ${n + 1}: a mark in the conversation`);
		const next = wires[n + 1];
		if (!next) return;
		for (const mark of wire.marks) for (let j = 0; j <= mark; j++) assert.equal(next.blocks[j], wire.blocks[j], `request ${n + 2} block ${j} is request ${n + 1}'s, up to its mark at ${mark}`);
		// and past its marks: the first block the next request changes, if any, is a picture (the newest ones, dropped)
		const changed = wire.blocks.findIndex((block, j) => next.blocks[j] !== block);
		assert.ok(changed < 0 || (keepImages === "latest" && /^\d+\.user:\{"type":"image"/.test(wire.blocks[changed])), `request ${n + 2} changes nothing of request ${n + 1} before its newest pictures (first changed: ${wire.blocks[changed]?.slice(0, 60)})`);
	});
	// what the model reads: each result's text is the tool's text; pictures follow the newest result only (latest) or
	// every result that had them (all); an older result's dropped pictures leave the note in their place, once
	const shots = record.calls.shots.filter(s => s.toolCallId);
	parsed.forEach((request, n) => {
		const users = request.messages.filter(m => m.role === "user" && Array.isArray(m.content) && m.content.some(b => b.type === "tool_result"));
		const shotOf = r => shots.find(s => s.toolCallId === r.tool_use_id);
		const latest = users.findLast(m => m.content.some(b => b.type === "tool_result" && shotOf(b).images > 0));
		for (const message of users) {
			const results = message.content.filter(b => b.type === "tool_result"), rest = message.content.slice(results.length);
			assert.ok(message.content.slice(0, results.length).every(b => b.type === "tool_result"), "the tool results come first");
			for (const result of results) {
				const shot = shots.find(s => s.toolCallId === result.tool_use_id), text = typeof result.content === "string" ? result.content : result.content.map(c => c.text).join("\n");
				assert.ok(text === shot.text || text === `${shot.text}\n${DROPPED}`, `request ${n + 1}: the result of ${result.tool_use_id} reads as the tool's text`);
			}
			const newest = message === latest, pictured = results.filter(r => shots.find(s => s.toolCallId === r.tool_use_id).images > 0);
			const images = rest.filter(b => b.type === "image").length, notes = rest.filter(b => b.type === "text" && b.text === DROPPED).length;
			const shown = keepImages === "all" ? pictured : newest ? pictured.slice(-1) : [];
			assert.equal(images, shown.reduce((k, r) => k + shotOf(r).images, 0), `request ${n + 1}: the pictures of ${shown.map(r => r.tool_use_id)}`);
			assert.equal(notes + results.filter(r => String(typeof r.content === "string" ? r.content : "").endsWith(DROPPED)).length, pictured.length - shown.length, `request ${n + 1}: one note per result whose pictures are dropped`);
		}
	});
	console.log(`PASS ${label}, ${keepImages} pictures: ${wires.length} requests, each repeats the one before up to every mark (${wires.map(w => w.marks.length).join(", ")} marks); results read as the tool's text`);
}
// the Studio's shapes asked before each compile (reshape): their time is in the record, outside the compile's own ms
{
	const provider = await scriptedProvider({ calls: SCRIPTS["six calls, one per message"].slice(0, 2) });
	Object.assign(process.env, { CLIPROXY_BASE_URL: provider.base, CLIPROXY_API_KEY: "test-key" });
	let record;
	try { record = await runScene({ name: "cache-prefix-reshape", request: "a pushes the crate.", variant: "studio", model: "claude-opus-5-5", effort: "medium", shapes: {}, reshape: async () => { await new Promise(resolve => setTimeout(resolve, 40)); return {}; }, env: process.env, outDir: mkdtempSync(join(tmpdir(), "cache-prefix-")) }); } finally { provider.close(); }
	const asked = record.calls.shots.map(s => s.reshapeMs);
	assert.ok(asked.length === 2 && asked.every(ms => ms >= 35), JSON.stringify(asked));
	assert.equal(record.reshape.ms, asked.reduce((a, b) => a + b, 0));
	assert.equal(record.reshape.ok, 2);
	console.log(`PASS the reshape time is recorded: ${asked.join(", ")} ms per call, ${record.reshape.ms} ms in all`);
}
// the proxy's model list: the run reads the one its route was chosen by (motion-writer.mjs writerRoute, proxyListed);
// a list request that failed is asked again by the next run, which does not fail on it
{
	const run = name => runScene({ name, request: "a pushes the crate.", variant: "studio", model: "claude-opus-5-5", effort: "medium", env: process.env, outDir: mkdtempSync(join(tmpdir(), "cache-prefix-")) });
	const once = await scriptedProvider({ calls: [] });
	Object.assign(process.env, { CLIPROXY_BASE_URL: once.base, CLIPROXY_API_KEY: "test-key", COZYCLAY_MOTION_MODEL: "claude-opus-5-5" });
	try {
		assert.equal((await writerRoute({ env: process.env }))?.via, "environment");
		assert.equal((await run("cache-prefix-list")).infraError, null);
	} finally { once.close(); }
	assert.equal(once.lists.asked, 1, "the route and its run ask the model list once");
	const down = await scriptedProvider({ calls: [], listFails: 1 });
	Object.assign(process.env, { CLIPROXY_BASE_URL: down.base, CLIPROXY_API_KEY: "test-key" });
	try {
		assert.equal(await writerRoute({ env: process.env }), null, "no route through a proxy whose list request failed");
		assert.equal((await run("cache-prefix-list")).infraError, null, "the run asks the list again");
	} finally { down.close(); }
	assert.equal(down.lists.asked, 2);
	console.log("PASS the model list is asked once for a route and its run; a failed list request is asked again by the run");
}
