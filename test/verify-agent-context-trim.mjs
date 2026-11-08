#!/usr/bin/env node
// The Studio request's budget at model-call time (bin/agent/studio-context-budget.mjs). A 28-turn session reached
// 969k context tokens a call because every old receipt, script and image went back to the model whole, final replies
// to Korean users came back in English 9 times in 36, and the top-view plan image rode every turn of a staged scene.
// Checked here: nothing shrinks while the view's estimate is under the limit; past it, one step shrinks every older
// result and image (ids kept, the newest whole) and the next step waits for room, so the cached prefix holds between
// steps (#1115: shrinking 8 results at a time cost 84 cache rewrites in 30 bench sessions); no view passes the ceiling:
// past it the oldest turns leave the view, then the running turn's oldest calls, and the newest inspect result's context
// counts; earlier turns' scripts shrink at a turn start, the running turn's calls never; the stored
// history is untouched; each prompt carries its reply language; the plan comes on a staging request or once per
// session; a restored transcript never shows an observation label as the user's words. Plus one Studio session through
// the real runner and a scripted model.
import assert from "node:assert/strict";
import { budgetStudioRequest, wantsPlan } from "../bin/agent/studio-context-budget.mjs";
import { createAgentRunner } from "../bin/agent/agent-runner.mjs";
import { transcriptFromHistory } from "../bin/agent/session-store.mjs";
import { encodeStudioContext } from "../src/studio-agent-context.js";
import { createFakeModel } from "./fixtures/fake-model.mjs";
import { contextFixture } from "./verify-studio-agent-protocol.mjs";

let failures = 0;
const check = (name, fn) => { try { fn(); console.log(`PASS ${name}`); } catch (error) { failures += 1; console.log(`FAIL ${name} — ${error.message}`); } };
const uuid = n => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const spec = n => `spec-${String(n).padStart(12, "0")}`;
const prompt = text => ({ role: "user", content: [{ type: "text", text: `<studio-context>\n${JSON.stringify({ scene: { name: "운전석 세트" } })}\n</studio-context>` }, { type: "text", text }] });
const call = (i, code, thinking = `plan ${i}`) => ({ role: "assistant", content: [{ type: "thinking", thinking, thinkingSignature: `sig-${i}` }, { type: "toolCall", id: `c${i}`, name: "script", arguments: { code } }] });
const result = (i, extra = [], pad = 3000) => ({ role: "toolResult", toolCallId: `c${i}`, toolName: "script", isError: false, content: [{ type: "text", text: `{"ok":true,"receipt":"${uuid(i)}","specId":"${spec(i)}","summary":"step ${i}","qa":{"total":${i}},"pad":"${"x".repeat(pad)}"}` }, ...extra] });
const image = i => ({ type: "image", data: `iVBORw0KGgo${i}`, mimeType: "image/png" });
// Two turns: the first with 12 scripted calls, the second (running) with n of its own; every result carries an image.
function history(n, pad = 3000) {
	const out = [prompt("의자를 끌어와서 앉아줘")];
	for (let i = 0; i < 12; i++) out.push(call(i, `// earlier turn ${i}\n${"const a = 1;\n".repeat(200)}`), result(i, [image(i)], pad));
	out.push({ role: "assistant", content: [{ type: "text", text: "done" }] }, prompt("이제 카메라를 레일로 바꿔줘"));
	for (let i = 12; i < 12 + n; i++) out.push(call(i, `// running turn ${i}\n${"const b = 2;\n".repeat(200)}`), result(i, [image(i)], pad));
	return out;
}
const run = messages => budgetStudioRequest({ messages, systemPrompt: "rules" }).messages;
const text = message => message.content.filter(part => part.type === "text").map(part => part.text).join("\n");
const isShort = message => text(message).includes("more characters left out of this request");
// The budget's estimate: text, thinking and call arguments at 3.6 characters a token, an image at 1600.
const tokens = view => view.flatMap(m => m.content ?? []).reduce((sum, p) => sum + (p.type === "image" ? 1600 : (p.type === "text" ? p.text.length : p.type === "thinking" ? p.thinking.length : p.type === "toolCall" ? p.name.length + JSON.stringify(p.arguments).length : 0) / 3.6), 0);
// The requests of a growing history whose view changed an earlier message: the prompt cache rewrites from there.
const prefixChanges = views => views.flatMap((view, k) => k && views[k - 1].some((m, i) => JSON.stringify(m) !== JSON.stringify(view[i])) ? [k] : []);
// A running turn growing by about 5.7k estimated tokens a request (12k-character results, each with an image).
const growing = Array.from({ length: 40 }, (_, n) => run(history(n + 1, 12000)));
const firstStep = growing.findIndex(view => view.some(m => m.role === "toolResult" && isShort(m)));

check("under the limit nothing shrinks but earlier turns' scripts: every result and image reaches the model whole", () => {
	const out = run(history(14));
	assert.ok(tokens(out) > 60_000 && tokens(out) < 120_000, `${Math.round(tokens(out))} tokens`);
	assert.ok(out.filter(m => m.role === "toolResult").every(m => !isShort(m) && text(m).length > 3000), "every result whole");
	assert.equal(out.flatMap(m => m.content ?? []).filter(p => p.type === "image").length, 26, "every image whole");
});
check("past the limit one step shrinks every older result and image to its opening and ids; the newest 10 and 3 stay whole", () => {
	assert.ok(firstStep > 0, "a growing turn reaches the limit");
	const before = growing[firstStep - 1], out = growing[firstStep], results = out.filter(m => m.role === "toolResult");
	assert.deepEqual(results.map(isShort), results.map((_, i) => i < results.length - 10), "all but the newest 10 results shrink");
	for (const m of results.filter(isShort)) assert.match(text(m), new RegExp(`ids: ${uuid(Number(m.toolCallId.slice(1)))}, ${spec(Number(m.toolCallId.slice(1)))}`));
	const parts = out.flatMap(m => m.content ?? []);
	assert.equal(parts.filter(p => p.type === "image").length, 3, "the newest 3 images stay images");
	assert.equal(parts.filter(p => p.type === "text" && p.text.startsWith("[An earlier image")).length, results.length - 3);
	assert.ok(tokens(before) > 110_000 && tokens(out) < tokens(before) - 40_000, `${Math.round(tokens(before))} -> ${Math.round(tokens(out))} tokens`);
});
check("between steps the cached prefix holds: a 40-request turn rewrites an earlier message only at its steps, with room between", () => {
	const changes = prefixChanges(growing);
	assert.ok(changes.length >= 2 && changes.length <= 4, `rewrites at requests ${changes}`);
	assert.equal(changes[0], firstStep);
	for (const k of changes) assert.ok(tokens(growing[k]) < tokens(growing[k - 1]), `request ${k} shrinks the view`);
	for (let i = 1; i < changes.length; i++) assert.ok(changes[i] - changes[i - 1] >= 8, `steps at ${changes[i - 1]} and ${changes[i]}`);
});
check("only earlier turns' scripts shrink; the running turn's calls (next to signed thinking) stay whole, past the limit too", () => {
	for (const out of [run(history(14)), growing.at(-1)]) {
		const calls = out.filter(m => m.role === "assistant" && m.content.some(p => p.type === "toolCall"));
		const earlier = calls.filter(m => m.content[1].arguments.code.startsWith("// earlier")), running = calls.filter(m => m.content[1].arguments.code.startsWith("// running"));
		assert.ok(earlier.length === 12 && earlier.every(m => m.content[1].arguments.code.includes("left out of this request")), "earlier scripts shrink");
		assert.ok(running.every(m => m.content[1].arguments.code.length > 2000), "running-turn scripts stay whole");
		assert.ok(calls.every(m => m.content[0].type === "thinking" && m.content[0].thinkingSignature), "thinking blocks are kept as they are");
	}
});
check("under the ceiling a newest prompt's studio context and a newest inspect result's context move no step: the diet drops both later", () => {
	const h = history(firstStep - 1, 12000), at = h.findLastIndex(m => m.role === "user");
	h[at] = { role: "user", content: [{ type: "text", text: `<studio-context>\n${JSON.stringify({ pad: "s".repeat(100_000) })}\n</studio-context>\n이제 카메라를 레일로 바꿔줘` }] };
	h.push({ role: "assistant", content: [{ type: "toolCall", id: "ci", name: "inspect_studio", arguments: {} }] }, { role: "toolResult", toolCallId: "ci", toolName: "inspect_studio", isError: false, content: [{ type: "text", text: JSON.stringify({ ok: true, context: { pad: "z".repeat(100_000) } }) }] });
	const out = run(h);
	assert.ok(tokens(out) > 150_000, `${Math.round(tokens(out))} tokens sent`);
	assert.ok(out.every(m => m.role !== "toolResult" || !isShort(m)), "no result shrinks");
});
check("past the ceiling the oldest turns leave the view, down to the limit, with a note; no view passes 200k; calls keep their results", () => {
	// Eight turns of ten calls, each call next to 20k characters of thinking: shortening cannot hold them, leaving turns out does.
	const h = [];
	for (let t = 0; t < 8; t++) {
		h.push(prompt(`장면 ${t}`));
		for (let i = 0; i < 10; i++) h.push(call(t * 10 + i, `return ${t * 10 + i};`, "x".repeat(20_000)), result(t * 10 + i));
		h.push({ role: "assistant", content: [{ type: "text", text: "done" }] });
	}
	const views = h.flatMap((m, k) => m.role === "assistant" ? [run(h.slice(0, k))] : []);
	assert.ok(views.every(view => tokens(view) <= 200_000), `largest view ${Math.round(Math.max(...views.map(tokens)))} tokens`);
	const last = views.at(-1);
	assert.equal(last[0].role, "user");
	assert.match(last[0].content[0].text, /^\[The first \d+ messages of this session are left out of this request/);
	const left = Number(/\d+/.exec(last[0].content[0].text)[0]);
	assert.equal(last[0].content[1].text, h[left].content[0].text, "the view starts at a prompt, after the messages the note counts");
	assert.equal(last.length + left, h.length - 1, "nothing after it is left out");
	for (const view of views) {
		const ids = new Set(view.flatMap(m => m.role === "assistant" ? m.content.filter(p => p.type === "toolCall").map(p => p.id) : []));
		assert.ok(view.every(m => m.role !== "toolResult" || ids.has(m.toolCallId)), "every result keeps its call");
	}
	const changes = prefixChanges(views);
	assert.ok(changes.length <= 8, `${changes.length} rewrites in ${views.length} requests`);
	for (const k of changes) assert.ok(tokens(views[k]) < tokens(views[k - 1]), `request ${k} shrinks the view`);
});
// A view's calls all keep their results, and it starts with a prompt.
const wellFormed = view => {
	const ids = new Set(view.flatMap(m => m.role === "assistant" ? m.content.filter(p => p.type === "toolCall").map(p => p.id) : []));
	assert.ok(view.every(m => m.role !== "toolResult" || ids.has(m.toolCallId)), "every result keeps its call");
	assert.ok(view[0].role === "user" && view[0].content.some(p => p.text?.startsWith("<studio-context")), "the view starts with a prompt");
};
check("one long turn past the ceiling leaves its own oldest calls out, down to the limit, with a note on its prompt; no view passes 200k", () => {
	// One turn of 90 calls, each next to 20k characters of thinking: no earlier turn is left to leave, so the turn's oldest calls go.
	const h = [prompt("의자를 끌어와서 앉아줘")];
	for (let i = 0; i < 90; i++) h.push(call(i, `return ${i};`, "x".repeat(20_000)), result(i));
	const views = [...h.flatMap((m, k) => m.role === "assistant" ? [run(h.slice(0, k))] : []), run(h)];
	assert.ok(views.every(view => tokens(view) <= 200_000), `largest view ${Math.round(Math.max(...views.map(tokens)))} tokens`);
	views.forEach(wellFormed);
	const last = views.at(-1), note = /^\[The (\d+) messages after this one, this turn's earlier calls and their results, are left out/.exec(last[0].content.at(-1).text);
	assert.ok(note, "the prompt carries the note");
	const left = Number(note[1]);
	assert.ok(left >= 100 && left % 2 === 0, `${left} messages left out, whole calls with their results`);
	assert.deepEqual(last.slice(1).map(m => m.toolCallId ?? m.content[1].id), h.slice(1 + left).map(m => m.toolCallId ?? m.content[1].id), "the rest of the turn follows, nothing else left out");
	assert.deepEqual(last.at(-2), h.at(-2), "the newest call stays as it was, its signed thinking too");
	const changes = prefixChanges(views);
	assert.ok(changes.length >= 3 && changes.length <= 8, `rewrites at requests ${changes}`);
	for (const k of changes) assert.ok(tokens(views[k]) < tokens(views[k - 1]) && tokens(views[k]) <= 121_000, `request ${k} takes the view down to the limit`);
	for (let i = 1; i < changes.length; i++) assert.ok(changes[i] - changes[i - 1] >= 8, `steps at ${changes[i - 1]} and ${changes[i]}`);
});
check("the ceiling counts the newest inspect result's re-embedded context: no view passes 200k with it", () => {
	const h = [];
	for (let t = 0; t < 8; t++) {
		h.push(prompt(`장면 ${t}`));
		for (let i = 0; i < 10; i++) h.push(call(t * 10 + i, `return ${t * 10 + i};`, "x".repeat(20_000)), result(t * 10 + i));
		h.push({ role: "assistant", content: [{ type: "text", text: "done" }] });
	}
	// At every request after a result, that newest result is an inspect_studio one carrying a 60k-character context.
	const views = h.flatMap((m, k) => m.role === "assistant" && h[k - 1].role === "toolResult"
		? [run([...h.slice(0, k - 1), { ...h[k - 1], toolName: "inspect_studio", content: [{ type: "text", text: JSON.stringify({ ok: true, context: { pad: "z".repeat(60_000) } }) }] }])] : []);
	assert.ok(views.every(view => tokens(view) <= 200_000), `largest view ${Math.round(Math.max(...views.map(tokens)))} tokens`);
	views.forEach(wellFormed);
});
check("a newest result too big for the ceiling on its own shrinks as well, its ids kept", () => {
	const out = run([prompt("의자를 끌어와서 앉아줘"), call(0, "return 0;"), result(0, [], 900_000)]);
	assert.ok(tokens(out) <= 200_000, `${Math.round(tokens(out))} tokens`);
	assert.ok(isShort(out[2]) && text(out[2]).includes(uuid(0)) && text(out[2]).includes(spec(0)));
});
check("a newest inspect result too big on its own shrinks first; the turn's earlier calls stay", () => {
	const h = [prompt("의자를 끌어와서 앉아줘")];
	for (let i = 0; i < 20; i++) h.push(call(i, `return ${i};`, "x".repeat(20_000)), result(i));
	h.push(call(20, "return 20;"), { ...result(20), toolName: "inspect_studio", content: [{ type: "text", text: JSON.stringify({ ok: true, context: { pad: "z".repeat(900_000) } }) }] });
	const out = run(h);
	assert.ok(tokens(out) <= 200_000, `${Math.round(tokens(out))} tokens`);
	assert.equal(out.length, h.length, "no call is left out");
});
check("the stored history is never edited", () => {
	const h = history(14), before = JSON.stringify(h);
	run(h);
	assert.equal(JSON.stringify(h), before);
});
check("a short history passes through as the same array", () => {
	const h = [prompt("hello"), call(0, "x"), result(0)];
	assert.equal(budgetStudioRequest({ messages: h, systemPrompt: "" }).messages.length, 3);
});
check("each Studio prompt ends with its reply-language reminder; English text and Korean scene names get none", () => {
	const out = run([prompt("의자를 끌어와서 앉아줘"), { role: "assistant", content: [{ type: "text", text: "ok" }] }, prompt("now pull the chair")]);
	assert.match(out[0].content.at(-1).text, /^\[Reply in Korean\. /);
	assert.equal(out[2].content.at(-1).text, "now pull the chair", "an English message carries no reminder, though its scene name is Korean");
	assert.match(run([prompt("椅子に座って")])[0].content.at(-1).text, /^\[Reply in Japanese\. /);
});
check("a long turn repeats the reply language on every 8th tool result, at fixed places", () => {
	const out = run(history(17)), turn = out.slice(out.findLastIndex(m => m.role === "user")).filter(m => m.role === "toolResult");
	const reminded = turn.map((m, i) => /^\[Reply in Korean\. /.test(m.content.at(-1).text ?? "") ? i + 1 : 0).filter(Boolean);
	assert.deepEqual(reminded, [8, 16], "9240db36 wrote an English note 17 results into a Korean turn");
	assert.deepEqual(run(history(18)).slice(0, out.length - 2).map(text), out.slice(0, out.length - 2).map(text), "the reminders stay where they were as the turn grows");
});
check("the plan comes on a staging request, or once on a staged scene's first turn", () => {
	assert.equal(wantsPlan({ text: "의자에 앉아줘", characterCount: 2, shots: 1, planSeen: false }), true, "first turn of a staged scene");
	assert.equal(wantsPlan({ text: "의자에 앉아줘", characterCount: 2, shots: 1, planSeen: true }), false, "not again on a plain turn");
	assert.equal(wantsPlan({ text: "카메라 각도 바꿔줘", characterCount: 1, shots: 1, planSeen: true }), true, "a camera request always");
	assert.equal(wantsPlan({ text: "walk 3 m", characterCount: 1, shots: 0, planSeen: false }), false, "an unstaged scene never");
});
check("a restored transcript shows an observation's image, never its label as the user's words", () => {
	const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
	for (const label of ["Studio plan observation (top view) revision 41 receipt unavailable", "Studio plan observation (top view) at scene revision 41", "Studio frame observation at scene revision 7, receipt r-1"]) {
		const transcript = transcriptFromHistory([{ role: "user", content: [{ type: "text", text: label }, { type: "image", data: png, mimeType: "image/png" }] }]);
		assert.ok(transcript.every(entry => !String(entry.text ?? "").includes("observation")), JSON.stringify(transcript).slice(0, 200));
	}
});

// The real runner: a Korean Studio prompt and a scripted model calling a bulky tool 18 times in one turn (40k characters,
// about 11k estimated tokens a result, so the turn passes the limit once).
const fake = createFakeModel();
fake.script([...Array.from({ length: 18 }, (_, i) => [{ type: "toolCall", id: `t${i}`, name: "script", arguments: { code: `return ${i};` } }]), [{ type: "text", text: "완료" }]]);
const stored = [];
const tools = [{ name: "script", parameters: { type: "object", properties: { code: { type: "string" } }, required: ["code"], additionalProperties: false },
	handler: async ({ code }) => ({ ok: true, receipt: uuid(Number(code.match(/\d+/)[0])), specId: spec(Number(code.match(/\d+/)[0])), pad: "y".repeat(40_000) }) }];
const runner = createAgentRunner({ models: fake.models, fauxProvider: fake.fauxProvider, sessionStore: { read: () => null, append: async (_id, messages) => { stored.push(...messages); } } });
const session = await runner.openSession("context-trim", { surface: "studio" });
const frames = [];
for await (const frame of session.start({ surface: "studio", model: "faux/scripted", text: "의자 끌어오는 장면 만들어줘", contextText: encodeStudioContext(contextFixture()), tools })) frames.push(frame);
await runner.close();
check("through the runner: the turn ends with done; one step shrinks the oldest results with their ids, and only that request moves the prefix", () => {
	assert.equal(frames.at(-1)?.type, "done");
	const results = fake.calls.at(-1).messages.filter(m => m.role === "toolResult");
	const short = results.filter(isShort);
	assert.equal(results.length, 18);
	assert.ok(short.length >= 1 && results.length - short.length >= 10, `${short.length} shrunk`);
	assert.ok(short.every(m => text(m).includes("spec-")));
	const changes = prefixChanges(fake.calls.map(request => request.messages));
	assert.equal(changes.length, 1, `the requests that changed an earlier message: ${changes}`);
	assert.ok(fake.calls[changes[0]].messages.some(m => m.role === "toolResult" && isShort(m)) && !fake.calls[changes[0] - 1].messages.some(m => m.role === "toolResult" && isShort(m)), "that request is the step");
});
check("through the runner: the Korean prompt reaches the model with its language reminder", () => {
	const user = fake.calls.at(-1).messages.find(m => m.role === "user");
	assert.match(user.content.at(-1).text, /^\[Reply in Korean\. /);
	assert.ok(stored.filter(m => m.role === "user").every(m => !JSON.stringify(m).includes("Reply in ")), "the stored prompt has no reminder");
});

if (failures) { console.error(`${failures} context trim check(s) failed`); process.exit(1); }
console.log("agent context trim: all checks passed");
