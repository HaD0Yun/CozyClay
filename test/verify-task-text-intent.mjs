#!/usr/bin/env node
// The task text keeps the user's request and the visible criteria (three broken runs: a run became a walk, a vault
// gained two hands nobody asked for, a pull-up passed QA with the hands off the bar). The main agent writes the
// instructions from MAIN_SYSTEM_PROMPT rule 7; taskHeader puts them under the header and asks the task to report
// each visible criterion before it finishes.
import assert from "node:assert/strict";
import { MAIN_SYSTEM_PROMPT as main } from "../bin/agent/main-prompt.mjs";
import { STUDIO_SYSTEM_PROMPT as studio } from "../bin/agent/studio-prompt.mjs";
import { taskHeader } from "../bin/agent/studio-tasks.mjs";

const check = (name, fn) => { fn(); console.log(`ok - ${name}`); };
const REQUESTS = ["앞으로 달려가면서 장해물까지 지나가는거", "앞에 장해물 파쿠르 해서 넘어가는거", "pull up 하는거"];
const BANNED = [/24\s*프레임/, /24[- ]frames?\b/i, /1\.1\s*m\b/, /key pose만으로는/i, /key poses? (alone|only)/i, /\bgrid\b/i];
const rule7 = main.slice(main.indexOf("7. "), main.indexOf("8. "));
const header = taskHeader({ taskId: "t", scope: ["character:c"], instructions: "" });

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
check("the task report checks each visible criterion; a QA count is not done", () => {
	assert.match(header, /check each visible criterion in the instructions \(the user's words\) and report it as met, unmet or not measurable by QA, with the measured value when there is one/);
	assert.match(header, /A QA count alone never means done\./);
});
for (const request of REQUESTS) check(`the task text for "${request}" keeps the request verbatim and adds no constraint`, () => {
	const instructions = `"${request}"\nVisible criteria:\n- ${request}`;
	const text = taskHeader({ taskId: "t", scope: ["character:c:take"], instructions });
	assert.ok(text.endsWith(`\n${instructions}`), "instructions follow the header unchanged");
	if (request.includes("달려")) assert.match(text, /달려/);
	assert.doesNotMatch(text, /두 손|two hands|walk/i);
	for (const re of BANNED) assert.doesNotMatch(text, re, String(re));
});
