// The v4 qa tool: the motion.compile compiler's QA (src/motion3) on the current raw take (src/motion-v4/qa/run.js), as
// information only. It returns no ok and no gate, and nothing waits on it: the model reads it as hints
// and checks them with measure and render.
import { runV4Qa } from "../../../src/motion-v4/qa/run.js";

const DESCRIPTION = [
	"The QA of the motion.compile compiler (src/motion3). On the bench it agreed with the owner on 1 of 10 tasks and went the other way on 5. Read it as hints and check what it says with measure and render.",
	"It runs on the current track (call track set first; no commit needed) and never blocks anything.",
	"It reports: QA groups (kind, subject, frames, worst value and its frame);",
	"impacts: POP frames that end a ballistic air run (the hips fall at g within 15%, a sole, palm, knee or the buttocks within 5 cm of a surface), a landing and not a pop;",
	"air: air runs of 4+ frames whose hips fall under 0.8 g or over 1.25 g on average (1 g is free fall);",
	"hand checks that need no spec: HAND_PEN (palm centre, a finger tip or the hand more than 1 cm inside a box or the floor),",
	"PALM_TILT (a hand touching a surface with its palm more than 35 deg off it), WRIST_LIMIT (wrist flex, deviation or twist more than 5 deg past its limit, any frame),",
	"HAND_SLIDE (a touching palm travels more than 3 cm on a still surface).",
	"Arguments: from and to (0-based frames, inclusive) keep what overlaps that range; kinds keeps those group kinds (IMPACT and AIR name the impact and air rows);",
	"maxGroups (default 12) caps the groups listed in the text; hands false skips the hand checks.",
	"From js, await qa(args) returns all rows as data: { total, groups, impacts, air, hands, ms }.",
].join(" ");

const INPUT_SCHEMA = {
	type: "object", additionalProperties: false, required: [],
	properties: {
		from: { type: "integer", minimum: 0 }, to: { type: "integer", minimum: 0 },
		kinds: { type: "array", items: { type: "string" } },
		maxGroups: { type: "integer", minimum: 1, maximum: 50 },
		hands: { type: "boolean" },
	},
};

const TEXT_LIMIT = 4000, MAX_GROUPS = 12;
const HEAD = "QA (information only; it never blocks).";

const isCount = (v, lo, hi = Infinity) => Number.isInteger(v) && v >= lo && v <= hi;

/** Checks what the schema cannot (or what a js call skipped) and returns the range to read. */
function checkArgs(args, frames) {
	for (const key of Object.keys(args)) if (!(key in INPUT_SCHEMA.properties)) throw new Error(`qa: unknown argument "${key}" (use from, to, kinds, maxGroups, hands).`);
	for (const key of ["from", "to"]) if (args[key] !== undefined && !isCount(args[key], 0)) throw new Error(`qa: ${key} must be a frame number >= 0.`);
	if (args.kinds !== undefined && !(Array.isArray(args.kinds) && args.kinds.every(k => typeof k === "string"))) throw new Error("qa: kinds must be a list of kind names.");
	if (args.maxGroups !== undefined && !isCount(args.maxGroups, 1, 50)) throw new Error("qa: maxGroups must be an integer from 1 to 50.");
	if (args.hands !== undefined && typeof args.hands !== "boolean") throw new Error("qa: hands must be true or false.");
	const last = frames - 1, from = args.from ?? 0, to = Math.min(args.to ?? last, last);
	if (from > last) throw new Error(`qa: from ${from} is past the last frame ${last}.`);
	if (from > to) throw new Error(`qa: from ${from} is after to ${to}.`);
	return { from, to };
}

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const num = v => (typeof v === "number" ? String(+v.toPrecision(3)) : String(v));
const groupLine = g => `${g.kind} ${g.subject}: frames ${g.first}-${g.last}, worst ${num(g.worst)} at ${g.worstFrame}`;

/** One line per landing frame: the joints whose POP it was and the air run it ends. */
function impactLines(impacts) {
	const byFrame = new Map();
	for (const r of impacts) byFrame.set(r.frame, [...(byFrame.get(r.frame) ?? []), r]);
	return [...byFrame].map(([f, rows]) => `IMPACT f${f}: ${rows.map(r => r.joint).join(", ")} stop after air f${rows[0].run[0]}-f${rows[0].run[1]} (hips fall at ${rows[0].gRatio.toFixed(2)} g): a ballistic landing, not a POP`);
}

/** The model's text (<= TEXT_LIMIT chars): the head line, a summary, then groups, impacts, air rows and hand groups. */
function qaText(data, maxGroups, { from, to }) {
	const lines = [HEAD, `f${from}-f${to}: ${plural(data.groups.length, "group")}, ${plural(data.hands.length, "hand group")}, ${plural(data.total, "frame issue")}; ${plural(new Set(data.impacts.map(r => r.frame)).size, "landing")} moved out of POP; ${plural(data.air.length, "air row")}; ${data.ms} ms.`];
	const capped = (rows, more) => [...rows.slice(0, maxGroups), ...(rows.length > maxGroups ? [`... ${rows.length - maxGroups} more ${more} (call qa from js for all)`] : [])];
	lines.push(...capped(data.groups.map(groupLine), "groups"), ...impactLines(data.impacts));
	lines.push(...data.air.map(r => `AIR f${r.from}-f${r.to}: hips fall at ${r.g.toFixed(2)} g on average (free fall is 1.00)`));
	lines.push(...capped(data.hands.map(groupLine), "hand groups"));
	if (data.groups.length + data.impacts.length + data.air.length + data.hands.length === 0) lines.push("Nothing to report in this range.");
	let text = "";
	for (let i = 0; i < lines.length; i++) {
		const tail = `\n... ${lines.length - i} more lines (call qa from js for all)`;
		if (text.length + lines[i].length + 1 + tail.length > TEXT_LIMIT) return text + tail;
		text += (i ? "\n" : "") + lines[i];
	}
	return text;
}

/** createQaTool(ctx) -> V4Tool "qa"; reads ctx.track.out() at call time. */
export function createQaTool(ctx) {
	return {
		name: "qa",
		description: DESCRIPTION,
		inputSchema: INPUT_SCHEMA,
		async run(args, call = {}) {
			call.signal?.throwIfAborted?.();
			const input = args ?? {};
			if (typeof input !== "object" || Array.isArray(input)) throw new Error("qa: arguments must be an object.");
			const out = await ctx.track.out();
			if (!out) throw new Error("No track yet: call track set first.");
			const range = checkArgs(input, out.frames.length);
			const data = runV4Qa(out, { ...range, kinds: input.kinds, hands: input.hands !== false });
			return { data, text: qaText(data, input.maxGroups ?? MAX_GROUPS, range) };
		},
	};
}
