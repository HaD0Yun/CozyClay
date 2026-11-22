#!/usr/bin/env node
// What a long Studio chat pays again for the conversation it already sent (no model call). One long session
// (220 requests) wrote the whole earlier conversation to the prompt cache again on 14 of its first 23 new requests,
// and its budget took a 291k-token view (by the provider's count) for a 131k one. Checked here:
//   - marks: the first request of a turn marks the last block before the previous prompt (where the previous turn
//     wrote what is still shared) and before the newest one, within four marks;
//   - a small simulator of the provider's cache rules (a mark finds an earlier entry by walking back at most 20
//     positions; thinking is no position, a run of tool calls or tool results is one): with those marks every new
//     request reads everything up to the previous prompt; without the read mark a previous turn of 30 calls leaves
//     only the system prompt readable;
//   - the budget reads the provider's count from each answer's usage: on a conversation counted at 1.9 ASCII and 0.57
//     Korean characters a token, no view passes the 200k ceiling, steps stay rare and spaced; the 3.6 estimate alone
//     lets the same conversation pass it.
import assert from "node:assert/strict";
import { withAnthropicCacheBreakpoints } from "../bin/agent/anthropic-cache.mjs";
import { budgetStudioRequest } from "../bin/agent/studio-context-budget.mjs";

let failures = 0;
const check = (name, fn) => { try { fn(); console.log(`PASS ${name}`); } catch (error) { failures += 1; console.log(`FAIL ${name} — ${error.message}`); } };
const model = { api: "anthropic-messages" };
const mark = { type: "ephemeral" };

// --- an Anthropic payload of a Studio conversation, as the diet leaves it and pi-ai marks it -------------------------
// Turn t: a prompt, `calls` tool calls (each with signed thinking) and their results, then a text answer.
function conversation(turns, calls, { running = 0 } = {}) {
	const messages = [];
	for (let t = 0; t < turns; t += 1) {
		const newest = t === turns - 1;
		messages.push({ role: "user", content: [{ type: "text", text: `${newest ? `<studio-context>\n{"scene":${t}}\n</studio-context>` : "<studio-context superseded/>"}\nrequest ${t}` }] });
		const n = newest ? running : calls;
		for (let i = 0; i < n; i += 1) {
			messages.push({ role: "assistant", content: [{ type: "thinking", thinking: "", signature: `s${t}.${i}` }, { type: "text", text: `step ${t}.${i}` }, { type: "tool_use", id: `u${t}_${i}`, name: "script", input: { code: `return ${i};` } }] });
			messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: `u${t}_${i}`, content: [{ type: "text", text: `result ${t}.${i} ${"r".repeat(400)}` }] }] });
		}
		if (!newest) messages.push({ role: "assistant", content: [{ type: "text", text: `done ${t}` }] });
	}
	const last = messages.at(-1);
	last.content = last.content.map((block, j) => j === last.content.length - 1 ? { ...block, cache_control: mark } : block);
	return { system: [{ type: "text", text: `rules ${"s".repeat(4000)}`, cache_control: mark }], tools: [{ name: "script", input_schema: { type: "object" }, cache_control: mark }], messages };
}
const marked = block => Boolean(block?.cache_control);
const markedMessages = payload => payload.messages.flatMap((message, i) => message.content.some(marked) ? [i] : []);
const prompts = payload => payload.messages.flatMap((message, i) => message.role === "user" && message.content.some(block => block.type === "text" && block.text.startsWith("<studio-context")) ? [i] : []);
const marksOf = payload => [...payload.system, ...payload.tools, ...payload.messages.flatMap(message => message.content)].filter(marked).length;

// The requests of a session: turns of `calls` tool calls; each turn's requests run from its prompt to its answer.
function session(turns, calls) {
	const out = [];
	for (let t = 1; t <= turns; t += 1) for (let running = 0; running <= (t === turns ? 0 : calls); running += 1) out.push({ turn: t, running, payload: conversation(t, calls, { running }) });
	return out;
}

check("the first request of a turn marks the last block before the previous prompt and before the newest, within four marks", () => {
	for (const turns of [2, 3, 6]) {
		const payload = withAnthropicCacheBreakpoints(conversation(turns, 30), model) ?? conversation(turns, 30);
		const [previous, newest] = prompts(payload).slice(-2);
		assert.deepEqual(markedMessages(payload), [...new Set([previous - 1, newest - 1, payload.messages.length - 1])].filter(i => i > 0), `turns ${turns}`);
		assert.ok(marksOf(payload) <= 4, `${marksOf(payload)} marks`);
		assert.ok(marked(payload.system.at(-1)), "the system prompt stays marked (it covers the tools before it)");
		assert.equal(payload.messages[newest - 1].content.at(-1).cache_control.type, "ephemeral", "the mark sits on the last block that takes one");
	}
});
check("within a turn only the newest prompt's mark is added, and the tool mark stays when there is room", () => {
	const payload = withAnthropicCacheBreakpoints(conversation(4, 30, { running: 5 }), model);
	const newest = prompts(payload).at(-1);
	assert.deepEqual(markedMessages(payload), [newest - 1, payload.messages.length - 1]);
	assert.ok(marked(payload.tools[0]), "tool mark kept");
});
check("two prompts with no answer between them: the read mark goes before the prompt the last answer belonged to", () => {
	const base = conversation(3, 30), extra = { role: "user", content: [{ type: "text", text: "<studio-context>\n{}\n</studio-context>\nmore" }] };
	base.messages.at(-1).content = [{ type: "text", text: "<studio-context superseded/>\nrequest 2" }];
	const payload = withAnthropicCacheBreakpoints({ ...base, messages: [...base.messages, extra] }, model);
	const [answered, , newest] = prompts(payload).slice(-3);
	assert.deepEqual(markedMessages(payload).filter(i => i < newest), [answered - 1, newest - 1]);
});
check("a conversation with no Studio prompt is marked as before: only the last block before the newest prompt", () => {
	const payload = { system: [{ type: "text", text: "s" }], tools: [{ name: "a" }], messages: [{ role: "user", content: [{ type: "text", text: "a" }] }, { role: "assistant", content: [{ type: "text", text: "b" }] }, { role: "user", content: [{ type: "text", text: "c" }] }, { role: "assistant", content: [{ type: "text", text: "d" }] }, { role: "user", content: [{ type: "text", text: "e" }] }] };
	const out = withAnthropicCacheBreakpoints(payload, model);
	assert.deepEqual(markedMessages(out), [3]);
	assert.ok(marked(out.tools[0]) && marked(out.system[0]));
});

// --- the provider's cache rules, from its prompt-caching documentation ----------------------------------------------
// Blocks in order (tools, system, messages); an entry is stored at each marked block under its prefix; a request reads
// the longest stored prefix one of its marks finds walking back at most 20 positions; written: from there to the last
// mark. Tokens: a block's text length / 4 (the simulator compares requests, not exact counts).
const strip = ({ cache_control: _mark, ...block }) => block;
function blocks(payload) {
	const out = [];
	let position = 0, key = "";
	const add = (block, step) => { position += step; key += JSON.stringify(strip(block)); out.push({ key, position, tokens: JSON.stringify(strip(block)).length / 4, marked: marked(block) }); };
	for (const block of [...payload.tools, ...payload.system]) add(block, 1);
	for (const message of payload.messages) {
		key += `|${message.role}`;
		message.content.forEach((block, j) => add(block, block.type === "thinking" || (j && ["tool_use", "tool_result"].includes(block.type) && message.content[j - 1].type === block.type) ? 0 : 1));
	}
	return out;
}
function simulate(payloads) {
	const entries = new Set();
	return payloads.map(payload => {
		const list = blocks(payload), cum = []; let total = 0;
		list.forEach((block, i) => { total += block.tokens; cum[i] = total; });
		const marks = list.flatMap((block, i) => block.marked ? [i] : []);
		let hit = -1;
		for (const j of marks) for (let i = j; i >= 0 && list[i].position >= list[j].position - 20; i -= 1) if (entries.has(list[i].key)) { hit = Math.max(hit, i); break; }
		for (const j of marks) entries.add(list[j].key);
		const read = hit < 0 ? 0 : cum[hit];
		return { read, write: cum[marks.at(-1)] - read, total };
	});
}
// The prefix a turn's first request shares with the turn before: everything before the previous prompt.
const stable = payload => { const list = blocks(payload); const before = prompts(payload).at(-2); let n = 0, total = 0; payload.messages.slice(0, before).forEach(message => { n += message.content.length; }); n += payload.tools.length + payload.system.length; for (let i = 0; i < n; i += 1) total += list[i].tokens; return total; };

const requests = session(6, 30);
const withMarks = requests.map(r => withAnthropicCacheBreakpoints(r.payload, model) ?? r.payload);
const sim = simulate(withMarks);
check("every new request reads everything up to the previous prompt; within a turn every request reads all but its newest call", () => {
	requests.forEach((r, k) => {
		if (r.turn >= 2 && r.running === 0) assert.ok(sim[k].read >= stable(withMarks[k]) - 1e-6, `turn ${r.turn}: read ${sim[k].read} of ${stable(withMarks[k])}`);
		// one call and its result: about 140 simulated tokens
		if (r.running >= 2) assert.ok(sim[k].write < 300, `turn ${r.turn} call ${r.running}: wrote ${Math.round(sim[k].write)} of ${Math.round(sim[k].total)}`);
	});
});
check("without the read mark a previous turn of 30 calls leaves only the system prompt readable at the next prompt", () => {
	const withoutRead = withMarks.map((payload, k) => {
		if (requests[k].running || requests[k].turn < 3) return payload;
		const previous = prompts(payload).at(-2) - 1;
		return { ...payload, messages: payload.messages.map((message, i) => i === previous ? { ...message, content: message.content.map(strip) } : message) };
	});
	const old = simulate(withoutRead);
	const system = blocks(withMarks[0]).slice(0, 2).reduce((sum, block) => sum + block.tokens, 0);
	requests.forEach((r, k) => { if (r.turn >= 3 && !r.running) assert.ok(old[k].read <= system + 1e-6 && sim[k].read > 4 * system, `turn ${r.turn}: ${Math.round(old[k].read)} without, ${Math.round(sim[k].read)} with`); });
	const written = list => list.reduce((sum, x) => sum + x.write, 0);
	console.log(`  simulated writes over ${requests.length} requests: ${Math.round(written(old))} tokens without the read mark, ${Math.round(written(sim))} with it`);
});

// --- the budget against the provider's count -------------------------------------------------------------------------
const nonAscii = text => [...text].filter(ch => ch.charCodeAt(0) > 127).length;
// The provider's count of a text: 1.9 ASCII characters a token, 0.57 non-ASCII ones (the long session's own ratios).
const counted = text => (text.length - nonAscii(text)) / 1.9 + nonAscii(text) / 0.57;
const SYSTEM = "rules ".repeat(2000);
const viewCount = view => counted(SYSTEM) + view.flatMap(m => m.content ?? []).reduce((sum, p) => sum + (p.type === "image" ? 1600 : p.type === "text" ? counted(p.text) : p.type === "toolCall" ? counted(p.name + JSON.stringify(p.arguments)) : 0), 0);
const prompt = (text, live) => ({ role: "user", content: [{ type: "text", text: `${live ? `<studio-context>\n${JSON.stringify({ scene: { name: "운전석 세트", pad: "c".repeat(6000) } })}\n</studio-context>` : "<studio-context superseded/>"}\n${text}` }] });
// A session of `turns` turns of 10 calls; each result 5k characters (half Korean when `korean`), every third with an image.
function run(turns, { korean = false, usage = true } = {}) {
	const history = [], views = [];
	const send = () => {
		const newest = history.findLastIndex(m => m.role === "user" && m.content[0].text.startsWith("<studio-context"));
		const dieted = history.map((m, i) => m.role === "user" && i !== newest && m.content[0].text.startsWith("<studio-context>") ? prompt(m.content[0].text.split("\n").at(-1), false) : m);
		const view = budgetStudioRequest({ messages: dieted, systemPrompt: SYSTEM }).messages;
		views.push(view);
		return usage ? { input: Math.round(viewCount(view)), cacheRead: 0, cacheWrite: 0 } : undefined;
	};
	for (let t = 0; t < turns; t += 1) {
		history.push(prompt(korean ? `장면 ${t}: 의자를 끌어와서 앉아줘` : `scene ${t}: pull the chair and sit`, true));
		for (let i = 0; i < 10; i += 1) {
			const id = `c${t}_${i}`;
			history.push({ role: "assistant", content: [{ type: "toolCall", id, name: "script", arguments: { code: `return ${i}; // ${korean ? "의자" : "chair"}` } }], usage: send() });
			const body = korean ? `${"결과 ".repeat(500)}${"x".repeat(2500)}` : "x".repeat(5000);
			history.push({ role: "toolResult", toolCallId: id, toolName: "script", isError: false, content: [{ type: "text", text: `{"ok":true,"specId":"spec-${String(t * 10 + i).padStart(12, "0")}","pad":"${body}"}` }, ...(i % 3 ? [] : [{ type: "image", data: `iVBOR${id}`, mimeType: "image/png" }])] });
		}
		history.push({ role: "assistant", content: [{ type: "text", text: "done" }], usage: send() });
	}
	return views;
}
// The requests that change a message the request before them sent before its newest prompt (the diet itself changes
// only that prompt): each one writes the conversation to the cache again.
const newestPrompt = view => view.findLastIndex(m => m.role === "user" && m.content.some(p => p.type === "text" && p.text.startsWith("<studio-context")));
const rewrites = views => views.flatMap((view, k) => k && views[k - 1].slice(0, newestPrompt(views[k - 1])).some((m, i) => JSON.stringify(m) !== JSON.stringify(view[i])) ? [k] : []);
for (const korean of [false, true]) {
	const label = korean ? "half-Korean results" : "ASCII results";
	check(`${label}: no view passes the ceiling by the provider's count; steps are rare and spaced`, () => {
		const views = run(14, { korean });
		const largest = Math.max(...views.map(viewCount));
		if (process.env.CTXCOST_DEBUG) console.log(views.map(v => `${Math.round(viewCount(v) / 1000)}:${v.length}`).join(" "));
		assert.ok(largest <= 200_000, `largest view ${Math.round(largest)} tokens by the provider's count`);
		const changes = rewrites(views), steps = views.flatMap((view, k) => k && viewCount(view) < viewCount(views[k - 1]) ? [k] : []);
		assert.deepEqual(changes, steps, "only the requests that shrink the view change what an earlier request sent");
		assert.ok(steps.length >= 2 && steps.length <= 12, `steps at requests ${steps} of ${views.length}`);
		for (let i = 1; i < steps.length; i += 1) assert.ok(steps[i] - steps[i - 1] >= 8, `steps at ${steps[i - 1]} and ${steps[i]}`);
	});
	check(`${label}: the 3.6 estimate alone (no usage) lets the same conversation pass the ceiling`, () => {
		const largest = Math.max(...run(14, { korean, usage: false }).map(viewCount));
		assert.ok(largest > 200_000, `largest view ${Math.round(largest)} tokens`);
	});
}

if (failures) { console.error(`${failures} context cost check(s) failed`); process.exit(1); }
console.log("agent context cost: all checks passed");
