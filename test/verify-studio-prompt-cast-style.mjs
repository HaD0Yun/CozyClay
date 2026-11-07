#!/usr/bin/env node
// The Studio prompts teach the three cast styles (context scene.castStyle) and the hybrid "capsules for this shot?" proposal.
import assert from "node:assert/strict";
import { test } from "node:test";
import { STUDIO_SYSTEM_PROMPT as prompt, STUDIO_SYSTEM_PROMPT_STORYBOARD as storyboard } from "../bin/agent/studio-prompt.mjs";
import { studioSystemPrompt } from "../bin/agent/studio-motion-reference.mjs";
import { SUPERVISOR_RUBRIC } from "../bin/agent/supervisor.mjs";
import { MAIN_SYSTEM_PROMPT } from "../bin/agent/main-prompt.mjs";
import { SKILL_NAMES } from "../src/motion3/skills/index.js";
import { HYBRID_CAPSULE_HINT, HYBRID_HARD_KINDS, hybridCapsuleHint } from "../src/motion3/hybrid-hint.js";

const PROXY_SENTENCE = "so use only placement commands on it.";
const CAST_HEAD = "Cast style is context scene.castStyle. In a rig or capsule project never ask which body to use: the project already chose.";
const FALLBACK = "If scene.castStyle is absent, treat the project as hybrid.";
const PROPOSAL = "Proposal: \"This shot needs <what>. The rig path would need <cost: N compiles, still failing <group>>. Use capsule figures for this shot instead? (yes = capsules, no = keep the rig)\"";

test("the animation prompt states one rule per cast style", () => {
	assert.ok(prompt.includes(`\n${CAST_HEAD} ${FALLBACK}\n`), "an absent castStyle falls back to hybrid");
	assert.equal(prompt.split(FALLBACK).length, 2, "the fallback is stated once");
	assert.match(prompt, /\n- rig: cast only X Bot or Y Bot \(model y-bot-tpose or x-bot-tpose\)\. Never add a proxy-figure\./);
	assert.match(prompt, /\n- capsule: cast only capsule figures \(model "proxy-figure", posture stand, sit or lie\)\. [^\n]*do not call motion, pose or IK actions\./);
	assert.match(prompt, /\n- hybrid: the cast gate decides, before any rig work\. Before you add, move or compile the first rig for a request, check its moves\./);
	assert.doesNotMatch(prompt, /(^|\. )Never ask which body to use/, "hybrid projects are not told never to ask");
	for (const signal of ["If a move is not one of the skills", "hands or feet must touch a vehicle, furniture or a prop in a way no skill covers (climbing onto a car, striking with a held bat",
		"two or more rigs touch or pass something", "scale is not 1", "change nothing in the scene, end the turn with the proposal below in the user's language, and wait",
		"After a compile whose qa.ok is false and whose output carries stuck or hint, or leaves a LOAD, COLLIDE, BODY, SELF or PERSON group: stop there, do not repair, recompile or install again",
		"A stuck output whose take passes QA is no reason to ask.",
		"The user's next message is the answer.", "add the capsule figures as NEW characters (model proxy-figure; never convert a rig)",
		"hide a rig only if the user agrees, and say that hiding applies to every shot", "On no, use the rig and do not ask again for that shot.", "Ask once per shot."])
		assert.ok(prompt.includes(signal), signal);
	const gate = prompt.slice(prompt.indexOf("- hybrid: the cast gate"), prompt.indexOf("Proposal: "));
	for (const skill of SKILL_NAMES) assert.ok(gate.includes(skill), `the gate names the skill ${skill}`);
	assert.match(prompt, /\n1\. Read the request into beats:[^\n]*In a hybrid project run the cast gate \(Cast style, hybrid\) now, before step 2 places anyone\./, "the procedure runs the gate first");
	assert.ok(prompt.includes(`\n${PROPOSAL}\n`));
});

test("the cast-style block stays static: no project value is interpolated", () => {
	assert.equal(prompt.split(CAST_HEAD).length, 2);
	assert.doesNotMatch(prompt, /castStyle (is|=) "?(rig|capsule|hybrid)"?\b/);
});

test("the block sits after the proxy sentence and before the motion reference", async () => {
	const full = await studioSystemPrompt();
	const proxy = full.indexOf(PROXY_SENTENCE), head = full.indexOf(CAST_HEAD), proposal = full.indexOf(PROPOSAL), reference = full.indexOf("\n\n<motion-reference>\n");
	assert.ok(proxy > 0 && head > proxy, "after the proxy sentence");
	assert.equal(full.slice(proxy + PROXY_SENTENCE.length, head), "\n", "right after it");
	assert.ok(proposal > head && reference > proposal, "before <motion-reference>");
	assert.ok(full.indexOf("Previs procedure") > full.indexOf("Ask concise questions only when"), "the procedure still follows the rules");
});

test("the storyboard prompt, supervisor rubric and coordinator read the cast style", () => {
	assert.ok(storyboard.endsWith("Cast style is context scene.castStyle; in a capsule project add only proxy-figure characters."));
	assert.doesNotMatch(storyboard, /- hybrid:/);
	assert.match(SUPERVISOR_RUBRIC, /In a hybrid project \(castStyle hybrid, or no castStyle given\), capsule figures the user approved in place of rigs for a shot \(previousExchange holds the proposal the request answers\) are not a coverage miss\./);
	assert.match(MAIN_SYSTEM_PROMPT, /Carry the project's cast style \(context scene\.castStyle: rig, capsule or hybrid\)/);
});

test("motion.compile hints a hybrid project to propose capsules when the rig take is stuck or left a hard group", () => {
	const failing = kind => ({ ok: false, groups: [{ kind: "GOAL" }, { kind }, { kind: "LOAD" }] });
	assert.equal(hybridCapsuleHint("hybrid", { stuck: "spec-1 stopped paying", qa: failing("LIMIT") }), HYBRID_CAPSULE_HINT, "stuck in hybrid");
	for (const kind of HYBRID_HARD_KINDS) assert.equal(hybridCapsuleHint("hybrid", { qa: failing(kind) }), HYBRID_CAPSULE_HINT, `top ${kind} in hybrid`);
	assert.equal(hybridCapsuleHint("hybrid", { qa: failing("LIMIT") }), null, "a soft top group alone does not hint");
	assert.equal(hybridCapsuleHint("hybrid", { stuck: "x", qa: { ok: true, groups: [] } }), null, "a clean take does not hint");
	// The repair watch's polish note: another variant after a passing take is stuck, and passes QA too.
	assert.equal(hybridCapsuleHint("hybrid", { stuck: "spec-a already passed QA: stop only when every visible criterion is met and verify_result shows no support, contact or skin penetration fault past tolerance; else keep fixing up to the flat-round limit.", qa: { ok: true, groups: [{ kind: "COLLIDE" }] } }), null, "a stuck output whose take passes QA gets no hint");
	assert.equal(hybridCapsuleHint("hybrid", { stuck: "x", qa: { groups: [{ kind: "COLLIDE" }] } }), null, "no hint without a failing QA verdict");
	for (const style of ["rig", "capsule", undefined]) assert.equal(hybridCapsuleHint(style, { stuck: "x", qa: failing("COLLIDE") }), null, `no hint for ${style}`);
	assert.ok(prompt.includes("qa.ok is false and whose output carries stuck or hint"), "the prompt tells the agent what the hint means, on a failing take only");
});

// Box QA 2026-11-04, track A: the cup went in the middle of a 0.9-1.0 m table between the two, and "the man picks it up"
// could not reach it (shoulder 0.71 m from the grip, arm 0.69 m). Measured offline: in the middle of a 0.6 m deep table
// (0.3 m from his edge) the same take grips it.
test("both prompts stage a handled prop within reach: a shared table at most 0.6 m deep between the two", () => {
	assert.match(MAIN_SYSTEM_PROMPT, /11\. Staging what people handle: unless the user places or sizes it, a prop someone may pick up, drink from or pass \(a cup, a glass, a phone, a plate\) sits within about 0\.3 m of the table or counter edge its user stands at, and a table between two people is at most 0\.6 m deep along the line between them/);
	assert.match(MAIN_SYSTEM_PROMPT, /Write the size and the spot in the assumption\./, "the coordinator writes it into the task's assumption");
	assert.match(prompt, /2\. Staging first: [^\n]*Unless the user places or sizes it, a prop someone handles \(a cup, a phone\) sits within 0\.3 m of its user's edge; a table between two people is at most 0\.6 m deep between them\./, "a task that sizes the table itself follows the same rule");
});
