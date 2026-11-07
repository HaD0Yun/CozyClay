#!/usr/bin/env node
// The task text keeps the user's request and the visible criteria (three broken runs: a run became a walk, a vault
// gained two hands nobody asked for, a pull-up passed QA with the hands off the bar). The main agent writes the
// instructions from MAIN_SYSTEM_PROMPT rule 7; taskHeader puts them under the header and asks the task to report
// each visible criterion before it finishes.
import assert from "node:assert/strict";
import { MAIN_SYSTEM_PROMPT as main } from "../bin/agent/main-prompt.mjs";
import { STUDIO_SYSTEM_PROMPT as studio } from "../bin/agent/studio-prompt.mjs";
import { taskHeader } from "../bin/agent/studio-tasks.mjs";
import { createRepairWatch } from "../src/motion3/repair-watch.js";

const check = (name, fn) => { fn(); console.log(`ok - ${name}`); };
const REQUESTS = ["앞으로 달려가면서 장해물까지 지나가는거", "앞에 장해물 파쿠르 해서 넘어가는거", "pull up 하는거"];
const BANNED = [/24\s*프레임/, /24[- ]frames?\b/i, /1\.1\s*m\b/, /key pose만으로는/i, /key poses? (alone|only)/i, /\bgrid\b/i];
const rule7 = main.slice(main.indexOf("7. "), main.indexOf("8. "));
const header = taskHeader({ taskId: "t", scope: ["character:c"], instructions: "" });
// the compiler's polish note on a compile after a take with 0 blocking problems (output.stuck)
const watch = createRepairWatch(), pass = { ok: true, groups: [] }, fail = { ok: false, groups: [{ kind: "FLOAT", subject: "s", severity: 1 }] };
watch.note({ characterId: "c", specId: "spec-pass", qa: pass });
const POLISH = watch.note({ characterId: "c", specId: "spec-next", base: "spec-pass", qa: fail }).say ?? "";

check("rule 7 starts the instructions with the request quoted word for word, then scene facts, then the job", () => {
	assert.match(rule7, /Start with the user's request quoted word for word in their language, then the scene facts \(ids, positions, the character\), then the job/);
});
check("rule 7 lists visible criteria in the user's terms, keeping the motion word and the named contacts", () => {
	assert.match(rule7, /"Visible criteria:", a short list in the user's terms taken only from the request/);
	assert.match(rule7, /keep their motion word \(달리기 stays running, never walking\)/);
	assert.match(rule7, /hands wrap the bar, the box follows the hands, feet land on top/);
});
check("rule 7 forbids frame budgets, stride or distance limits, grids and key-pose claims", () => {
	assert.match(rule7, /Never add frame budgets, stride or distance limits, grids, or claims that key poses cannot do it/);
});
check("rule 7 asks or marks an assumption for an open visible choice", () => {
	assert.match(rule7, /Never invent a visible choice the user left open \(one hand or two, which side, how high\)/);
	assert.match(rule7, /ask one short question before dispatching, or say the assumption in your reply and mark it "Assumption:"/);
});
check("no dispatch-path prompt states a frame budget, a 1.1 m limit, a grid or two hands", () => {
	for (const text of [main, studio, header]) {
		for (const re of BANNED) assert.doesNotMatch(text, re, String(re));
		assert.doesNotMatch(text, /두 손|two hands/i);
	}
});
check("the task report checks each visible criterion; 0 blocking problems is the QA half of done", () => {
	assert.match(header, /check each visible criterion in the instructions \(the user's words\) and report it as met, unmet or not measurable by QA, with the measured value when there is one/);
	assert.match(header, /A motion is done at its first take with 0 blocking QA problems \(qa\.blocking\), every visible criterion met, and ONE look/);
});
// #1114: the four places that say when a motion is done agree. v2 bench (30 runs): verify_result said "verified" in 1 of 139
// calls, so a rule that waited for it could not be met (84 min and 188 compiles after the first QA 0); the done rule is the
// first take with 0 blocking problems, every visible criterion met and one look at its contact sheet
check("the system prompt, rule 8, the task header and the polish note state one done rule", () => {
	const rule8 = main.slice(main.indexOf("8. "), main.indexOf("9. "));
	const studioRule = studio.slice(studio.indexOf("Done = "), studio.indexOf("When you stop"));
	assert.ok(studioRule.length > 0 && rule8.length > 0 && POLISH.length > 0);
	for (const text of [studioRule, rule8, header, POLISH]) {
		assert.match(text, /0 blocking/);
		assert.match(text, /every visible criterion/);
		assert.match(text, /verify_result \{ visual: "contact_sheet", frames: "beats" \}/);
		assert.match(text, /reads at a glance/);
		assert.match(text, /stop at once|stops at once/);
		assert.match(text, /report(s)? its warnings in one line/);
		assert.match(text, /no variants/);
		for (const old of [/QA 0 alone is not done/, /no support, contact or skin penetration fault/, /INSTALL_WORSE is expected/, /nearest the criteria/, /counts QA only/])
			assert.doesNotMatch(text, old, String(old));
	}
	// the polish note (output.stuck, read in a script's answer as well) states every clause the prompts state (review of #1114)
	for (const text of [studioRule, rule8, header, POLISH]) {
		assert.match(text, /ONE look/);
		assert.match(text, /the defining move is there, held poses are locked, contacts look like contacts, effort matches the load/);
		assert.match(text, /verify_result physics findings are reported, never a reason to go on/);
		assert.match(text, /no variants or comparison scripts/);
	}
	// the system prompt, the task header and the polish note say it in the same words, from ONE look to the end of the rule
	const said = text => text.slice(text.indexOf("ONE look: "), text.indexOf("comparison scripts") + "comparison scripts".length);
	assert.ok(said(studioRule).length > 300, said(studioRule));
	for (const text of [header, POLISH]) assert.equal(said(text), said(studioRule));
	for (const text of [studioRule, rule8]) assert.match(text, /4 or fewer blocking problems/);
	for (const text of [studio, main]) {
		assert.match(text, /install: "ifClean"/);
		assert.doesNotMatch(text, /\(true if it fails QA\)/);
	}
	for (const text of [studio, main, POLISH]) assert.doesNotMatch(text, /QA reports 0 problems, (you are|the task is) done|no variants\)|after a clean compile|stop unless the user asked/);
});
for (const request of REQUESTS) check(`the task text for "${request}" keeps the request verbatim and adds no constraint`, () => {
	const instructions = `"${request}"\nVisible criteria:\n- ${request}`;
	const text = taskHeader({ taskId: "t", scope: ["character:c:take"], instructions });
	assert.ok(text.endsWith(`\n${instructions}`), "instructions follow the header unchanged");
	if (request.includes("달려")) assert.match(text, /달려/);
	assert.doesNotMatch(text, /두 손|two hands|walk/i);
	for (const re of BANNED) assert.doesNotMatch(text, re, String(re));
});
