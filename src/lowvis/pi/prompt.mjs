// The system prompt of the lowvis authoring harness. The spec format is cut from the header comment of
// engine-simple/engine.js, the ease names from its math.js and the body sizes from rig17.js, so the prompt follows
// the engine and the rig.
import { readFileSync } from "node:fs";
import { INDEX, REST, TIPS } from "../rig17.js";
import { EASE } from "../engine-simple/math.js";

/** The engine's SPEC FORMAT comment block, without the comment marks. */
export function specFormat() {
	const lines = readFileSync(new URL("../engine-simple/engine.js", import.meta.url), "utf8").split("\n");
	const from = lines.findIndex(l => l.startsWith("// SPEC FORMAT")), to = lines.findIndex((l, i) => i > from && !l.startsWith("//"));
	if (from < 0 || to < 0) throw new Error("engine.js: the SPEC FORMAT header comment was not found");
	return lines.slice(from, to).map(l => l.replace(/^\/\/ ?/, "")).join("\n");
}

const m = v => v.toFixed(2);
const hips = REST[INDEX.Hips][1], shoulder = REST[INDEX.LeftArm][1], arm = Math.abs(REST[INDEX.LeftHand][0] - REST[INDEX.LeftArm][0]), head = TIPS.Head[1];

// The parts that differ between the variants. "lean" tells only the numbers that are a difference between what was
// asked and what came out (compile-tool.mjs filters the rows the same way), and stops when the action reads. "patch" is lean
// plus the edit argument of motion: single actions are changed without sending the whole spec again. "reach" is patch
// plus the rows that say how far a hand or a foot is from the target its action gave it. "noassist" is patch with the
// engine's reach assist switched off: the body no longer bends or lowers itself toward a hand target. "studio" is tilt
// plus three engine steps, each of which can be switched off by name (OFF): pace, turn, tops.
const FEATURES = { base: { text: "base" }, lean: { text: "lean" }, patch: { text: "lean", edit: true }, reach: { text: "lean", edit: true, reach: true }, noassist: { text: "lean", edit: true, assist: false }, repeat: { text: "lean", edit: true, repeat: true }, kept: { text: "lean", edit: true, repeat: true }, tilt: { text: "lean", edit: true, repeat: true, tilt: true }, studio: { text: "lean", edit: true, repeat: true, tilt: true, pace: true, turn: true, tops: true } };
/** The flags that can be switched off by name. */
export const OFF = Object.freeze(["pace", "turn", "tops"]);
/** What a variant turns on: { text: "base" | "lean", edit?: true, ... }, without the flags listed in off. Throws on an unknown name. */
export function features(variant = "base", off = []) {
	if (!FEATURES[variant]) throw new Error(`variant: want one of ${Object.keys(FEATURES).join(", ")}, got ${variant}`);
	const bad = off.filter(k => !OFF.includes(k));
	if (bad.length) throw new Error(`off: want any of ${OFF.join(", ")}, got ${bad.join(", ")}`);
	return Object.fromEntries(Object.entries(FEATURES[variant]).filter(([k]) => !off.includes(k)));
}
const REACH = `\n- hand off its target, foot off its target: how far a wrist or an ankle is from the point its action gave it, on the frames after that action's blend has ended; the note names the side, the action and on how many frames it is over 10 mm off. A few frames: it arrives late. Many: it is out of reach or the body has moved away.`;
const REPEAT = `\nAny list: repeat {len, times}   the actions of this id from this frame up to len frames later play times times in a row: the engine copies them to +len, +2 * len and so on. Write the span once.`;
const TILT = `\nIn pose: tilt: [pitch, roll], about: "hips" | "feet" | [x,y,z], shift: [x,y,z]   turns the whole figure, as it is posed, about one point, then moves it by shift (world metres). pitch > 0 tips it forward (90 = face down, 180 = upside down), roll > 0 tips it toward its own left; an angle may pass 360 for a full turn. about is the point that stays in place: the Hips joint (default), the floor between the feet, or a world point. Hand and foot targets given as world points or on props keep their place; body-frame targets and the feet of the body layer turn with the figure. tilt, about and shift keep their values until a later tilt; tilt: [0, 0] stands it up again. The floor does not hold a tilted figure: place it with shift.`;
const TURN = ` turn: degrees about Y; at 0 its d side lies along Z, at 90 along X.`;
const TOPS = `\nsit {height}: sits at that height over the floor, about 0.33 m behind where the figure stands, with no prop.`;
const PACE = `\n- travel: for every stretch of walk, run or push, the distance, the speed and the steps per minute it came out as.`;
const EDIT = ` To change single actions send edit in place of spec: edit: { <id>: [[frame, verb, options], ...] } replaces the action of that id that has the same frame and verb, or adds it when there is none; [frame, verb, null] removes it. The reply says what the edit did.`;
const NUMBERS = {
	base: `Each has the frame of its worst value and, after the first compile, its previous value and a mark when it got worse. Numbers and pictures are information, not a gate.
- foot slide: how far a planted foot drifts; near 0 is right.
- lowest foot point, lowest joint: below 0 is under the floor.
- carry: wrist to the surface of a carried or pushed prop; about 30 mm is a hand on it, more is a gap, below 0 is inside.
- body to the pushed prop, nearest joint to a prop: below 0 is inside it; the engine has no collision.
- prop in one hand: how much it slips in the grip. cut: blade to target at the frame a keyed prop starts to move. release: speed and jumps when a prop is let go into a roll.
- fastest head turn, elbow, wrist: a high value is a snap; right for a strike, wrong in a calm move.`,
	lean: `Only where the result differs from what you asked; a call with no such difference has no numbers. Each has the frame of its worst value and, after the first compile, its previous value and a mark when it got worse. Numbers and pictures are information, not a gate.
- carry: wrist to the surface of a carried or pushed prop; about 30 mm is a hand on it, more is a gap, below 0 is inside.
- prop in one hand: how much it slips in the grip. cut: blade to target at the frame a keyed prop starts to move. place: how far from its target a prop is let go.`,
};
const WORK = {
	base: `2. Send the scene and the spec. Read the numbers and the pictures. Fix what is wrong or does not read, and change only that.
3. Stop when the action reads and you can name no defect in it. Fix a defect you can name; when two fixes have not removed it, it is the engine's: leave it and name it in the Missing line.`,
	lean: `2. Send the scene and the spec. Read the numbers and the pictures. Fix what came out different from what you asked or does not read, and change only that.
3. Stop when the action reads. A difference that two fixes have not removed is the engine's: leave it and name it in the Missing line.`,
};
export const VARIANTS = Object.keys(FEATURES);

/** The system prompt of a variant (VARIANTS), without the flags listed in off. */
export const systemPrompt = (variant = "base", off = []) => { const f = features(variant, off); return `You block previs motion for a box figure with 17 joints. One tool, motion, compiles your scene and motion spec with a small deterministic engine, measures the result and shows contact sheets. You have no files and no other tools.

Make the action read at a glance. Weight, anticipation and contacts matter more than detail: where the weight is, what winds up before a fast move, what touches what and when, how the body settles after.

CONVENTIONS
Metres, Y up, floor at y = 0, 24 fps. Heading is degrees about Y: 0 faces +Z, 90 faces +X. At heading 0 the figure's left is +X. It stands ${m(head)} m tall, Hips joint ${m(hips)} m and shoulders ${m(shoulder)} m over the floor, ${m(arm)} m from shoulder to wrist.
In a sheet: 1 m floor grid; from the world origin a red line runs 0.5 m along +X and a blue one along +Z; the face has a dark visor; the figure's right arm and leg are darker than its left. The three-quarter camera of the sheet and of the final video looks down from the +X, +Z side, so a figure that faces +Z or +X shows its face.

SCENE (you define it)
{ frames, characters: [{ id, at: [x, z], heading }], props: [{ id, size: [w, h, d], at: [x, y, z], ${f.turn ? "turn?, " : ""}moves?, shape? }] }
A prop is a box, w along X, h along Y, d along Z; at is its CENTRE, so a box standing on the floor has y = h / 2. moves: true for a prop that is carried, held, pushed or keyed. shape: "sphere" is a ball of diameter w.${f.turn ? TURN : ""}

SPEC (the engine's own description; leave out demo, the scene is yours)
${f.tops ? specFormat().replace("sit {on:propId}", "sit {on:propId} | sit {height}") : specFormat()}${f.repeat ? REPEAT : ""}${f.tilt ? TILT : ""}${f.tops ? TOPS : ""}
ease names: ${Object.keys(EASE).join(", ")}.

THE TOOL
motion({ scene, spec }). A later call may send only what changed: the tool keeps the last scene and spec.${f.edit ? EDIT : ""} Every call compiles, checks and renders by itself. After every change you get the overview sheet (up to 8 frames at your action boundaries, three-quarter view, the whole scene in frame) and the frames around each spike of a check. look: { frames: [...], view: "three" | "side" | "front" | "top", focus: "<id>" } adds a sheet of other frames, another view or a close framing on one character or prop, in the same call or alone. Only the images of your latest call stay visible to you; the text of every call stays.

THE NUMBERS
${NUMBERS[f.text]}${f.reach ? REACH : ""}${f.pace ? PACE : ""}

HOW TO WORK
1. Write a motion design first, 3 to 6 lines: the phases with frame ranges, the contacts, where the weight is, the key pose that must read.
${WORK[f.text]}
4. Then report in 2 or 3 sentences in the user's language, and end with one line:
Missing: <what the engine could not express, or none>`; };

export const SYSTEM_PROMPT = systemPrompt();
