// The Studio agent's `plan` tool: a short step checklist the Agent panel shows at the top of a long turn ("수레 몸체 ✓ →
// 진열 소품 ● → 자전거 → 풀밭 → 조명·카메라"), so the user always sees what is under way and what comes next. It is
// side-effect free: it never reaches the editor, so the scene, undo history and document stay as they are, and it answers
// at once. Every change goes to the panel as one plan.update frame with the whole list ({ steps: [{ text, status }] }).
//
// One plan per turn (agent-routes.mjs makes one for each Studio turn). A script calls it too, as tools.plan, at no model
// turn of its own (`nested`): there a refusal is returned rather than thrown, so a bookkeeping slip never fails the
// script or rolls its edits back. The tool a plan change happened in carries the list in its result (`track`), which is
// how the persisted session history (session-store.mjs transcriptFromHistory) brings the card back after a reload.

import { isRecord } from "./tool-arguments.mjs";

const MIN_STEPS = 2, MAX_STEPS = 8, STEP_CHARS = 60;
const FIELDS = ["steps", "done", "active", "add"];

const DESCRIPTION = [
	"Show the user a short step checklist in the Agent panel. It changes nothing in the scene, undo history or document, and answers at once.",
	"For any request with 3 or more visible stages (building a set or several props, a multi-shot sequence), call plan first with short steps, in the same message as your first real call; then mark each step done right after its tool call — inside your script when you use one. Inside a script, tools.plan costs no extra turn.",
	`{ steps: [${MIN_STEPS}-${MAX_STEPS} labels of a few words, in the user's language] } sets the list (again: replaces it) and step 0 is active; { done: i or [i, …], active?: i } updates it (indexes from 0; after done without active, the next step becomes active); { add: [labels] } appends steps.`,
].join("\n");

const PARAMETERS = {
	type: "object",
	properties: {
		steps: { type: "array", items: { type: "string" }, description: `${MIN_STEPS}-${MAX_STEPS} short step labels; replaces the plan` },
		done: { anyOf: [{ type: "integer" }, { type: "array", items: { type: "integer" } }], description: "index or indexes (from 0) of the steps now done" },
		active: { type: "integer", description: "index of the step now under way" },
		add: { type: "array", items: { type: "string" }, description: "labels appended as pending steps" },
	},
	required: [],
	additionalProperties: false,
};

const refusal = message => Object.assign(new Error(message), { code: "INVALID_ARGUMENT" });

/** Labels from `field`, trimmed to one line each, or a refusal that says which one is wrong. */
function labels(field, value, min) {
	if (!Array.isArray(value) || value.some(text => typeof text !== "string")) throw refusal(`${field} must be an array of short strings (a few words each).`);
	const texts = value.map(text => text.replace(/\s+/g, " ").trim());
	const empty = texts.findIndex(text => !text);
	if (empty !== -1) throw refusal(`${field}[${empty}] is empty.`);
	const long = texts.findIndex(text => text.length > STEP_CHARS);
	if (long !== -1) throw refusal(`${field}[${long}] is ${texts[long].length} characters; keep each step under ${STEP_CHARS} (a few words).`);
	if (texts.length < min) throw refusal(`${field} has ${texts.length} item${texts.length === 1 ? "" : "s"}; a plan has ${MIN_STEPS}-${MAX_STEPS} steps (skip plan for a small request).`);
	return texts;
}

/** A step index from `field`, or a refusal naming the plan's range. */
function index(field, value, count) {
	if (Number.isInteger(value) && value >= 0 && value < count) return value;
	throw refusal(`${field} is ${JSON.stringify(value)}; the plan has ${count} steps, so a step index is 0-${count - 1}.`);
}

/**
 * The plan after one call: `steps` replaces the list, `add` appends, `done` checks steps off and `active` names the
 * one under way (any other active step goes back to pending). With no active step left, the step after the last one
 * just done (else the first pending one) becomes active, so a new plan starts at step 0.
 */
function nextPlan(current, args) {
	if (!isRecord(args)) throw refusal("plan takes an object: { steps: [...] } to set the plan, or { done, active } to update it.");
	const unknown = Object.keys(args).filter(key => !FIELDS.includes(key));
	if (unknown.length) throw refusal(`plan has unknown field${unknown.length > 1 ? "s" : ""} ${unknown.map(key => JSON.stringify(key)).join(", ")}; allowed: ${FIELDS.join(", ")}.`);
	if (!FIELDS.some(key => args[key] !== undefined)) throw refusal(`plan needs steps (${MIN_STEPS}-${MAX_STEPS} short labels) to set the plan, or done/active/add to update it.`);
	let steps = args.steps === undefined ? current : labels("steps", args.steps, MIN_STEPS).map(text => ({ text, status: "pending" }));
	if (!steps.length) throw refusal("There is no plan yet: set one with { steps: [...] } first.");
	if (args.add !== undefined) steps = [...steps, ...labels("add", args.add, 1).map(text => ({ text, status: "pending" }))];
	if (steps.length > MAX_STEPS) throw refusal(`That makes ${steps.length} steps; a plan has at most ${MAX_STEPS}: merge some.`);
	const done = args.done === undefined ? [] : Array.isArray(args.done) ? args.done.map((value, i) => index(`done[${i}]`, value, steps.length)) : [index("done", args.done, steps.length)];
	const active = args.active === undefined ? null : index("active", args.active, steps.length);
	if (done.includes(active)) throw refusal(`Step ${active} cannot be both done and active.`);
	steps = steps.map((step, i) => i === active ? { ...step, status: "active" } : done.includes(i) ? { ...step, status: "done" } : active !== null && step.status === "active" ? { ...step, status: "pending" } : step);
	if (!steps.some(step => step.status === "active")) {
		const from = done.length ? Math.max(...done) + 1 : 0;
		const next = steps.findIndex((step, i) => i >= from && step.status === "pending");
		const advance = next !== -1 ? next : steps.findIndex(step => step.status === "pending");
		if (advance !== -1) steps = steps.map((step, i) => i === advance ? { ...step, status: "active" } : step);
	}
	return steps;
}

/**
 * createPlanTool({ emit }) -> the model-facing `plan` tool (bin/agent/pi-tools.mjs toAgentTools shape), plus
 * `nested` (the same plan for a script's tools.plan: never throws, adds no call to the script's summary or progress)
 * and `track(tool)` (that tool's result carries `plan` when the plan changed during its call, and `planRefused`
 * when a nested call was refused).
 */
export function createPlanTool({ emit } = {}) {
	let steps = [], version = 0;
	const refused = [];
	const apply = args => {
		const next = nextPlan(steps, args);
		if (JSON.stringify(next) !== JSON.stringify(steps)) {
			steps = next; version += 1;
			// a failing view never fails the call
			try { emit?.({ type: "plan.update", steps }); } catch { /* advisory */ }
		}
		return { ok: true, plan: steps };
	};
	const tool = { name: "plan", label: "Plan", description: DESCRIPTION, parameters: PARAMETERS, handler: async args => apply(args) };
	return {
		...tool,
		nested: { ...tool, quiet: true, handler: async args => {
			try { return apply(args); } catch (error) {
				refused.push(error.message);
				return { ok: false, code: error.code ?? "INVALID_ARGUMENT", message: error.message };
			}
		} },
		track: inner => ({ ...inner, handler: async (...args) => {
			const seen = version, result = await inner.handler(...args);
			const notes = refused.splice(0);
			if (!isRecord(result) || (seen === version && !notes.length)) return result;
			return { ...result, ...(seen === version ? {} : { plan: steps }), ...(notes.length ? { planRefused: notes } : {}) };
		} }),
	};
}
