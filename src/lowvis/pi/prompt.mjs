// The system prompt of the lowvis authoring harness. The spec format is cut from the header comment of
// engine-simple/engine.js, the ease names from its math.js and the body sizes from rig17.js, so the prompt follows
// the engine and the rig.
import { readFileSync } from "node:fs";
import { INDEX, REST, TIPS } from "../rig17.js";
import { EASE } from "../engine-simple/math.js";
import { elementByPath } from "../../studio-elements.js";
import { BALANCE } from "./balance.mjs";
import { CLIP_FPS } from "../clip.js";
import { POINT } from "../studio/scene.js";
import { JUMP } from "../jumps.js";
import { bodyParts } from "../engine-simple/body-parts.js";
import { lookBody } from "../studio/figure.js";

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
// plus the rows that say how far a hand, a foot or an elbow is from the target its action gave it. "noassist" is patch with the
// engine's reach assist switched off: the body no longer bends or lowers itself toward a hand target. "studio" is tilt
// plus the reach rows and five engine steps, each of which can be switched off by name (OFF): pace, turn, tops (a prop's drawn
// parts and the rows of the gaps to them, gaps.mjs), body, balance, and the
// inside rows (inside, also in base: a body or a moving prop inside another prop, compile-tool.mjs and inside.mjs), and it is told the
// parts of a Studio request (words: the user's words and the Studio agent's note, bin/agent/motion-run.mjs). body: a
// character of the scene may have a scale and a tint (engine-simple/size.js, clip.js). balance: the row of a body at rest whose
// centre of mass lies outside its supports (balance.mjs). kinds: the Studio lists its objects with no box of their own (an
// effect, a light, a group) as small boxes with a kind (src/lowvis/studio/scene.js), which a motion moves as any prop.
const FEATURES = { base: { text: "base", inside: true }, lean: { text: "lean" }, patch: { text: "lean", edit: true }, reach: { text: "lean", edit: true, reach: true }, noassist: { text: "lean", edit: true, assist: false }, repeat: { text: "lean", edit: true, repeat: true }, kept: { text: "lean", edit: true, repeat: true }, tilt: { text: "lean", edit: true, repeat: true, tilt: true }, studio: { text: "lean", edit: true, repeat: true, tilt: true, reach: true, pace: true, turn: true, tops: true, body: true, balance: true, words: true, inside: true, kinds: true } };
/** The flags that can be switched off by name. */
export const OFF = Object.freeze(["pace", "turn", "tops", "body", "balance", "inside", "kinds"]);
/** What a variant turns on: { text: "base" | "lean", edit?: true, ... }, without the flags listed in off. Throws on an unknown name. */
export function features(variant = "base", off = []) {
	if (!FEATURES[variant]) throw new Error(`variant: want one of ${Object.keys(FEATURES).join(", ")}, got ${variant}`);
	const bad = off.filter(k => !OFF.includes(k));
	if (bad.length) throw new Error(`off: want any of ${OFF.join(", ")}, got ${bad.join(", ")}`);
	return Object.fromEntries(Object.entries(FEATURES[variant]).filter(([k]) => !off.includes(k)));
}
const REACH = `\n- hand, foot, elbow off its target: how far a wrist, an ankle or an elbow is from the point its action gave it, on the frames after that action's blend has ended, told when over 10 mm; the note names the side, the action, on how many frames it is over 10 mm off, and what holds the limb on its worst frame, from what the engine knows there, the largest part of the miss first. A reason that starts with "why:" lies in the spec (where the body, the target or the timing is, or another target of the same arm); one that starts with "engine limit:" is a miss, or most of one, that nothing the engine knows accounts for.`;
const REPEAT = `\nAny list: repeat {len, times}   the actions of this id from this frame up to len frames later play times times in a row: the engine copies them to +len, +2 * len and so on. Write the span once.`;
const TILT = `\nIn pose: tilt: [pitch, roll], about: "hips" | "feet" | [x,y,z], shift: [x,y,z]   turns the whole figure, as it is posed, about one point, then moves it by shift (world metres). pitch > 0 tips it forward (90 = face down, 180 = upside down), roll > 0 tips it toward its own left; an angle may pass 360 for a full turn. about is the point that stays in place: the Hips joint (default), the floor between the feet, or a world point. Hand and foot targets given as world points or on props keep their place; body-frame targets and the feet of the body layer turn with the figure. tilt, about and shift keep their values until a later tilt; tilt: [0, 0] stands it up again. The floor does not hold a tilted figure: place it with shift.`;
const TURN = ` turn: degrees about Y; at 0 its d side lies along Z, at 90 along X.`;
/** The sizes a body may have: the Studio's own limits of a character's scale (src/studio-elements.js). */
export const BODY_SCALE = Object.freeze({ min: elementByPath("character.scale").min, max: elementByPath("character.scale").max });
const BODY = ` A character's scale is the size of its body, from ${BODY_SCALE.min} to ${BODY_SCALE.max}; at 1 it is the figure of CONVENTIONS. The engine multiplies every length that belongs to that body by it: its joints and feet, its steps, where it sits and lies, the space between a wrist and what the hand holds, the most a hand moves per frame, every length the SPEC text gives as the engine's own. Lengths you write stay metres of the world, in the body frame too. tint is its colour, "#rrggbb". Left out, a character keeps the scale and tint it has; a new one has scale 1 and the default grey. The sheets draw each body at its scale, and in its tint when it has one (else in a colour of the sheet's own); the tool's bodies line says both.`;
/** The figure at scale 1 when the Studio's look has another body than the rig's (src/lowvis/studio/figure.js lookBody):
 *  its sizes, and that the engine's own lengths are given for the rig's body and multiplied by b too. */
const SIZES = b => `It stands ${m(head * b)} m tall, Hips joint ${m(hips * b)} m and shoulders ${m(shoulder * b)} m over the floor, ${m(arm * b)} m from shoulder to wrist. That is the engine's reference figure (${m(head)} m tall) times ${b}: every length the SPEC text and the tool's lines give as the engine's own is the reference figure's, and the engine multiplies it by ${b}, as it does every length of the body.`;
// tops: the Studio tells a prop's drawn shape (src/lowvis/studio/scene.js parts), which the tool keeps set (shapes.mjs)
const PARTS = ` parts (told by the Studio's scene and the tool, not written by you): the shape the Studio draws for a prop when it is not its box, as boxes { name, at: centre from the prop's centre, size, turn?: [x, y, z] degrees } in the prop's own frame; the tool sets them on your scene on every call and tells you when they change.`;
/** The SPEC text without the words for a prop's or a body's parts (tops off: no prop or body is told with parts). */
const noParts = text => text.replace(/\n {4}A prop with parts \(its drawn shape\)[^\n]*\n[^\n]*/, "").replace(/\n {19}\| \{on:propId, part, at\?\}[^\n]*\n[^\n]*/, "").replace(/\n {19}\| \{on:characterId, part, at\?\}[^\n]*\n[^\n]*\n[^\n]*/, "").replace("{on, part?, at?, pitch:deg} (a place on a prop or a body as for a hand)", "{on, at?, pitch:deg} (a place on a prop as for a hand)").replace("ride {on:propId, part?}", "ride {on:propId}");
// tops: a body's drawn parts (engine-simple/body-parts.js) of the look the Studio draws, at scale 1 (b: that look's body)
const r3 = v => Number((Math.abs(v) < 5e-4 ? 0 : v).toFixed(3));
const BODY_PARTS = look => {
	const list = bodyParts(look), b = lookBody(look), box = p => `[${p.c.map(v => r3(v * b)).join(", ")}] [${p.h.map(v => r3(2 * v * b)).join(", ")}]`;
	const mirror = p => { const l = list.find(q => q.name === p.name.replace(/^Right/, "Left")); return l && p.name.startsWith("Right") && [0, 1, 2].every(k => Math.abs(l.c[k] * (k ? 1 : -1) - p.c[k]) * b < 5e-4 && Math.abs(l.h[k] - p.h[k]) * b < 5e-4); };
	const told = list.filter(p => !mirror(p)), mirrored = told.length < list.length;
	return ` A body's drawn parts, each named for its joint, as its centre from the joint in the joint's frame (as {joint, at}) and its size [w, h, d], at scale 1 (times the body's scale; hands are no parts): ${told.map(p => `${p.name} ${box(p)}`).join("; ")}${mirrored ? "; a Right part is its Left one with x negated" : ""}.`;
};
const TOPS = `\nsit {height}: sits at that height over the floor, about 0.33 m behind where the figure stands, with no prop; with on as well: at that height instead of the prop's top.`;
// The inside and the at rest rows: what the writer needs before its first spec. What a row measures in full and what it
// leaves out is said by the tool once, in the answer where such a line first appears (inside.mjs insideText, balance.mjs BALANCE_TEXT).
/** The least time an inside pair must be past its limit, in frames, to be told (inside.mjs; here because the manual
 *  states it and the sidecar imports this file without three.js): a tenth of a second. The eye sums the light of about
 *  that long into one impression (the critical duration of temporal summation), so a part that is through a prop for
 *  less blends with the frames around it, as the one- and two-frame smears of hand-drawn animation do at 24 fps. The
 *  count is the fewest whole frames that last that long at the clip's rate: 3 at 24 fps (0.125 s). It is a count over
 *  the whole clip, not of frames in a row: a pair that comes back again and again is on screen that long in all. */
export const seenFrames = (fps = CLIP_FPS) => Math.ceil(0.1 * fps - 1e-9);
const INSIDE = `\n- inside: how deep a body (its drawn parts, the hands left out) or a prop with moves: true is inside another prop, told when deeper than 25 mm (times the body's scale) on ${seenFrames()} frames or more, or on the clip's first or last frame. The first answer with such a line says what it measures and leaves out.`;
const GAPS = `\n- to the drawn: a hand, a foot, standing feet or a seat your spec puts on a prop with parts, told when it ends more than 30 mm (times the body's scale) from the nearest part on ${seenFrames()} frames or more, with that part; a seat floats over or sinks into the part top under the hips.
- on a drawn body: a hand or foot your spec puts on a body ({joint} or {on, part}) or a prop riding its joint, inside a drawn part past 25 mm or off past 30 mm, and an arm through its own body or a body through another (a limb by the line of its joints) past 25 mm (times the body's scale), on ${seenFrames()} frames or more, with the part.`;
const HOLLOW = ` hollow: true marks a prop that things may be inside: it is left out of the inside numbers.`;
const KINDS = ` A prop the Studio lists with kind is a Studio object that has no box of its own (an effect, a light, a group of objects; kind says which): a ${POINT} m box centred on its place, hollow. A motion moves it as any prop (a hand holds it, ride puts it on a joint or a prop, keys move it) and the Studio object goes with the box's centre on every frame, keeping its kind and its own turn against the box. Every prop you add is a plain box or ball.`;
const BAL = `\n- at rest: centre of mass outside its supports: on the frames where a body is at rest, how far its centre of mass, dropped to the floor, lies outside the area its supports span, told when over ${Math.round(BALANCE.outside * 1000)} mm times its scale. The first answer with such a line says what counts as rest and as a support.`;
const JUMPS = `\n- jump between two frames: a body's Hips joint or a moving prop, within a frame of a key (its frame or the frame its over ends), steps far from its steps before and after (a stop of one frame inside a move, a hop): told over ${JUMP * 100} cm (times the body's scale), not for a key of its own with over 0 or 1.`;
const PACE = `\n- travel: for every stretch of walk, run or push, the distance, the speed and the steps per minute it came out as.`;
const WORDS = `\n\nTHE REQUEST\nIt starts with two marked texts. USER'S WORDS is the user's message exactly as they typed it: the user judges the motion against it. STUDIO AGENT'S NOTE is from the agent that called you: which characters and objects, what to keep. Either may be missing. The lines after them come from the Studio itself: pictures, the scene, your last motion.`;
const EDIT = ` To change single actions send edit in place of spec: edit: { <id>: [[frame, verb, options], ...] } replaces the action of that id that has the same frame and verb, or adds it when there is none; [frame, verb, null] removes it. Where an id has several actions with one frame and verb, the edit's entries with that frame and verb name them in their order. The reply says what the edit did.`;
const NUMBERS = {
	base: `Each has the frame of its worst value and, after the first compile, its previous value and a mark when it got worse; a spike (a value past the check's own limit) that was a spike before also says for how many compiles in a row it has been one (a call that only looks, with the scene and spec unchanged, does not count). Numbers and pictures are information, not a gate.
- foot slide: how far a planted foot drifts; near 0 is right.
- lowest foot point, lowest joint: below 0 is under the floor.
- carry: wrist to the surface of a carried or pushed prop; about 30 mm is a hand on it, more is a gap, below 0 is inside.
- prop in one hand: how much it slips in the grip. cut: blade to target at the frame a keyed prop starts to move. release: speed and jumps when a prop is let go into a roll.
- fastest head turn, elbow, wrist: a high value is a snap; right for a strike, wrong in a calm move.`,
	lean: `Only where the result differs from what you asked; a call with no such difference has no numbers. Each has the frame of its worst value and, after the first compile, its previous value and a mark when it got worse; a spike (a value past the check's own limit) that was a spike before also says for how many compiles in a row it has been one (a call that only looks, with the scene and spec unchanged, does not count). Numbers and pictures are information, not a gate.
- carry: wrist to the surface of a carried or pushed prop; about 30 mm is a hand on it, more is a gap, below 0 is inside.
- prop in one hand: how much it slips in the grip. cut: blade to target at the frame a keyed prop starts to move. place: how far from its target a prop is let go.`,
};
const WORK = {
	base: `2. Send the scene and the spec. Read the numbers and the pictures. Fix what is wrong or does not read, and change only that.
3. Stop when the action reads and you can name no defect in it. Fix a defect you can name; when two fixes have not removed it, it is the engine's: leave it and name it in the Missing line.`,
	lean: `2. Send the scene and the spec. Read the numbers and the pictures. Fix what came out different from what you asked or does not read, and change only that.
3. Stop when the action reads. A difference that two fixes have not removed (a spike says 3 compiles in a row) is the engine's: leave it and name it in the Missing line.`,
};
export const VARIANTS = Object.keys(FEATURES);
// The Studio variant only (bin/agent/motion-run.mjs installs the last compile of a run that ends on its report): the
// report line that keeps it out.
const INSTALL = "\nYour last compile is installed once you report; to keep it out, put the line Install: no before the Missing line and say why.";

/** The system prompt of a variant (VARIANTS), without the flags listed in off. body: the figure at scale 1 as a share of
 *  the rig's own body (src/lowvis/studio/figure.js lookBody: the body of the look the Studio draws; any value that is not
 *  over 0 is 1, the text of the rig's own body). look: the look the Studio draws (its drawn parts, with tops; none: the
 *  block look's). */
export const systemPrompt = (variant = "base", off = [], body = 1, look = null) => { const f = features(variant, off), b = Number.isFinite(body) && body > 0 ? body : 1; return `You block previs motion for a box figure with 17 joints. One tool, motion, compiles your scene and motion spec with a small deterministic engine, measures the result and shows contact sheets. You have no files and no other tools.

Make the action read at a glance. Weight, anticipation and contacts matter more than detail: where the weight is, what winds up before a fast move, what touches what and when, how the body settles after.${f.words ? WORDS : ""}

CONVENTIONS
Metres, Y up, floor at y = 0, 24 fps. Heading is degrees about Y: 0 faces +Z, 90 faces +X. At heading 0 the figure's left is +X. ${b === 1 ? `It stands ${m(head)} m tall, Hips joint ${m(hips)} m and shoulders ${m(shoulder)} m over the floor, ${m(arm)} m from shoulder to wrist.` : SIZES(b)}
In a sheet: 1 m floor grid; from the world origin a red line runs 0.5 m along +X and a blue one along +Z; the face has a dark visor; the figure's right arm and leg are darker than its left. The three-quarter camera of the sheet and of the final video looks down from the +X, +Z side, so a figure that faces +Z or +X shows its face.

SCENE (you define it)
{ frames, characters: [{ id, at: [x, z], heading${f.body ? ", scale?, tint?" : ""} }], props: [{ id, size: [w, h, d], at: [x, y, z], ${f.turn ? "turn?, " : ""}moves?, shape?${f.inside ? ", hollow?" : ""} }] }
A prop is a box, w along X, h along Y, d along Z; at is its CENTRE, so a box standing on the floor has y = h / 2. moves: true for a prop that is carried, held, pushed or keyed. shape: "sphere" is a ball of diameter w.${f.inside ? HOLLOW : ""}${f.turn ? TURN : ""}${f.body ? BODY : ""}${f.kinds ? KINDS : ""}${f.tops ? PARTS + BODY_PARTS(look) : ""}

SPEC (the engine's own description; leave out demo, the scene is yours)
${f.tops ? specFormat().replace("sit {on:propId}", "sit {on:propId} | sit {height}") : noParts(specFormat())}${f.repeat ? REPEAT : ""}${f.tilt ? TILT : ""}${f.tops ? TOPS : ""}
ease names: ${Object.keys(EASE).join(", ")}.

THE TOOL
motion({ scene, spec }). A later call may send only what changed: the tool keeps the last scene and spec.${f.edit ? EDIT : ""} Every call compiles, checks and renders by itself. After every change you get the overview sheet (up to 8 frames at your action boundaries, three-quarter view, the whole scene in frame) and the frames around each spike of a check. look: { frames: [...], view: "three" | "side" | "front" | "top", focus: "<id>" | { joint, of: "<characterId>" }, props: "outline" } adds a sheet of other frames, another view, a close framing on one character, prop or joint (joints as for a hand target), or every prop drawn as its edges alone (a body inside or behind it shows), in the same call or alone. Only the images of your latest call stay visible to you; the text of every call stays.

THE NUMBERS
${NUMBERS[f.text]}${JUMPS}${f.reach ? REACH : ""}${f.inside ? INSIDE : ""}${f.tops ? GAPS : ""}${f.pace ? PACE : ""}${f.balance ? BAL : ""}

HOW TO WORK
1. Write a motion design first, 3 to 6 lines: the phases with frame ranges, the contacts, where the weight is, the key pose that must read.
${WORK[f.text]}
4. Then report in 2 or 3 sentences in the user's language, and end with one line:
Missing: <what the engine could not express, or none>${variant === "studio" ? INSTALL : ""}`; };

export const SYSTEM_PROMPT = systemPrompt();
