// One motion request on the lowvis engine, from the Studio's scene to installed takes.
// The flow: the editor's describe answer -> the Studio scene as a lowvis scene (src/lowvis/studio/scene.js) -> the
// request text -> the motion writer (src/lowvis/pi/harness.mjs: claude-opus-5-5 at effort medium on CLIProxyAPI with
// one tool, motion) -> the clip it ended with -> installed as scene content (src/lowvis/studio/install.js).
// The scene and spec the motion writer wrote last are kept per memoryKey, so the next request can change or continue them.
// Used by the motion tool of the Studio agent (motion-door.mjs) and by the direct key (lowvis-turn.mjs).
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { motionWriter, motionOff } from "./motion-engine.mjs";
import { boxesOf, changedFit, floorCells, rememberBodies, rememberBoxes, usedText } from "./motion-fit.mjs";
import { idOf, propsSetOf, takenBy } from "./motion-props.mjs";

const MOTION_VARIANT = "studio";
const cast = (figure, index) => `lowvis-${String(figure.id ?? index).replace(/[^A-Za-z0-9_-]/g, "_")}`;
const byId = rows => new Map((Array.isArray(rows) ? rows : []).map(row => [row?.id, row]));
const last = new Map(); // memoryKey -> { scene, spec } the motion writer wrote last

const stamp = () => { const d = new Date(), p = n => String(n).padStart(2, "0"); return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`; };
const failure = (code, message) => Object.assign(new Error(message), { code });
// loaded on a call only: they read src/
async function realDeps() {
	const [{ runScene }, { installClip }, { studioScene }] = await Promise.all([import("../../src/lowvis/pi/harness.mjs"), import("../../src/lowvis/studio/install.js"), import("../../src/lowvis/studio/scene.js")]);
	return { runScene, installClip, studioScene, readClip: file => JSON.parse(readFileSync(file, "utf8")) };
}

// The labels of the two texts of a request. The user's words come as typed; the Studio agent's note is its own text.
const WORDS = {
	turn: "USER'S WORDS (the user's message of this turn, exactly as typed):",
	task: "USER'S WORDS (the user's last message to the Studio, exactly as typed; this task may do only part of it):",
};
const NOTE = "STUDIO AGENT'S NOTE (the Studio agent's own text: which characters and objects, what to keep):";
// What becomes of what the motion writer adds; DRESSED only when the Studio agent called (it dresses the set after)
const ADDED = "What your scene adds becomes Studio content: a new character a block figure, a new prop a plain object named by its id, at the place, size and turn you give.";
// said while the body step is on (motion-engine.mjs motionOff): what a character's scale and tint are in the Studio
const BODIES = "A character's scale and tint are the Studio character's own scale and tint: the ones your scene gives are set on it, one it leaves out stays as the Studio has it.";
const DRESSED = "After you, the Studio agent gives your props a look over the same box and adds what the body does not touch (background, light, camera); it keeps their place, size and turn.";
// said when the Studio agent names the objects it builds while the motion is written (the motion tool's building)
const BUILDING = ids => `While you write, the Studio agent builds these objects, each with its own look: ${ids.join(", ")}. When your scene needs one of them, use its name as that prop's id: at the install the object takes the place and turn your scene gives that prop, in place of a stand-in, and keeps the size the agent made it. Their size and place are yours to choose for the motion.`;

/** The floor region every joint of every body crosses during the clip: { x: [min, max], z: [min, max] } (metres), or null. */
function travelOf(clip) {
	const x = [Infinity, -Infinity], z = [Infinity, -Infinity];
	for (const figure of clip.characters ?? []) for (let k = 0; k + 2 < (figure.pos?.length ?? 0); k += 3) {
		x[0] = Math.min(x[0], figure.pos[k]); x[1] = Math.max(x[1], figure.pos[k]); z[0] = Math.min(z[0], figure.pos[k + 2]); z[1] = Math.max(z[1], figure.pos[k + 2]);
	}
	const r = v => Math.round(v * 100) / 100;
	return Number.isFinite(x[0]) ? { x: x.map(r), z: z.map(r) } : null;
}

/** The request the motion writer reads: the user's words, the agent's note, the pictures' count, the Studio's scene and the last motion. */
function requestOf({ words, wordsOf, note, building }, pictures, studio, before, body = false) {
	const parts = [];
	if (words) parts.push(`${WORDS[wordsOf] ?? WORDS.turn}\n${words}`);
	if (note) parts.push(`${NOTE}\n${note}`);
	if (pictures) parts.push(`The user attached ${pictures} picture${pictures === 1 ? "" : "s"}.`);
	if (studio.characters.length || studio.props.length) {
		// the scene JSON holds what a scene line holds; the flat heights go as lines of their own
		const scene = { characters: studio.characters, props: studio.props.map(({ heights, ...prop }) => prop) };
		const heights = studio.props.filter(prop => prop.heights?.length).map(prop => `${prop.id} offers these flat heights (world): ${JSON.stringify(prop.heights)}`);
		parts.push([`The Studio scene already has these (the user or an earlier step put them there). Use them in your scene with the same id, size and place, and add others only when the request needs them. A prop the request does not ask to move stays where it is.`, JSON.stringify(scene), ...heights].join("\n"));
	}
	if (studio.others?.length) parts.push(`These characters cannot be animated by the engine and stand as they are: ${studio.others.map(other => `${other.id} (${other.why})`).join(", ")}.`);
	parts.push(`${ADDED}${body ? ` ${BODIES}` : ""}${note ? ` ${DRESSED}` : ""}`);
	if (building.length) parts.push(BUILDING(building));
	if (before) {
		parts.push(`Your last scene and spec in this conversation (the Studio plays them now). When the request changes or continues that motion, start from them and keep what it does not mention.\nscene: ${JSON.stringify(before.scene)}\nspec: ${JSON.stringify(before.spec)}`);
	}
	return parts.join("\n\n");
}

/**
 * runMotion({ words, wordsOf, note, images, memoryKey, hub, workspaceHandle, invoke, signal, env, onCompile })
 *   -> { name, report, missing, frames, clipSeconds, tookSeconds, compiles, characterIds, objectIds, switched, used, bodies?, bodiesSet? }
 * words: the user's message exactly as typed; wordsOf: "turn" (this turn's message, the default) or "task" (the
 * message the coordinator's task came from). note: the Studio agent's own text (the motion tool's request), or none
 * when the words go alone (the direct key). images: [{ data: <base64>, mimeType }] (at most 4). hub.command("describe") reads the scene.
 * invoke(action, args): one editor action as the turn's tools run it (a refusal throws). onCompile({ n, ok, line }):
 * once per compile. What the clip has that the Studio scene lacks is added, in a task too (the motion task goes first:
 * main-prompt.mjs rule 8). The boxes of the props it used are kept per memoryKey for the fit lines (motion-fit.mjs).
 * characterIds: every Studio character the clip animated; objectIds: the objects it made or placed. used: one line
 * naming the objects the motion uses as boxes and the floor region the bodies cross (motion-fit.mjs usedText), or null.
 * bodies (only when a body the clip animated has another scale than 1, or a tint): [{ id, scale, tint }], the scale and
 * tint each animated Studio character has after the install (tint null: the default colour). bodiesSet (only when the
 * install set a scale or a tint): [{ id, scale?, tint? }], the fields it set (install.js); onBodies(bodiesSet): once, then.
 * A motion writer that ends without a scene but with a report (it could not make the motion) answers with frames 0.
 * frames and clipSeconds (one decimal) are the length of the clip; tookSeconds is how long making it took (wall time).
 * Throws an Error whose code is "upstream" (the model or the proxy), "studio" (the Studio refused the install) or
 * "aborted".
 * onScene(ids): once the Studio scene is read, with the ids of the characters and objects the motion is written against
 * (scene.js studioScene ids). exclusive(install): runs the install (the editor steps, up to the "studio" failure) and
 * answers what it answers; the motion door holds the scene for it there while other work goes on (motion-door.mjs).
 * changed(): the ids other calls changed while the motion was written; the objects among them that differ where the
 * body goes are the answer's motionFit (motion-fit.mjs changedFit).
 * building: the names of the objects the Studio agent builds while the motion is written; the writer is told them as
 * prop ids it may use (those the scene it read does not have). At the install, a prop the writer added is taken by the
 * one object named in building and made since the scene was read whose name is its id (motion-props.mjs takenBy):
 * set to its place and turn; it keeps its own size, and motionFit names every measure where it differs from the prop's
 * box (motion-fit.mjs rememberBoxes, whole), on the result and on every later edit. Nothing is taken when building names nothing (the direct key). propsSet (only
 * when there is one): what the install set on each object, read from the scene after it (motion-props.mjs propsSetOf).
 * deps: { runScene, installClip, studioScene, readClip(file) } in place of the real ones (tests).
 */
export async function runMotion({ words = null, wordsOf = "turn", note = null, building = [], images = [], memoryKey, hub, workspaceHandle, invoke, signal = null, env = process.env, onCompile = () => {}, onScene = () => {}, changed = () => [], onBodies = () => {}, exclusive = install => install(), deps = null }) {
	const { runScene, installClip, studioScene, readClip } = deps ?? await realDeps();
	if (signal?.aborted) throw failure("aborted", "The turn was stopped.");
	const name = `agent-${stamp()}-${randomBytes(2).toString("hex")}`;
	const off = motionOff(env), turn = !off.includes("turn"), tops = !off.includes("tops"), body = !off.includes("body");
	const read = await hub.command("describe", tops ? { tops: true } : {}, workspaceHandle), studio = studioScene(read, { turn, tops, body });
	const start = byId(read?.objects), said = (Array.isArray(building) ? building : []).map(name => String(name ?? "").trim()).filter(Boolean);
	const names = [...new Set(said.map(idOf).filter(id => id && !studio.ids.props[id]))]; // a prop of the scene read is that object
	// what each listed character already has: the motion writer's scene may leave it out (compile-tool.mjs)
	const has = Object.fromEntries(studio.scene.characters.filter(c => c.scale !== undefined || c.tint !== undefined).map(c => [c.id, { scale: c.scale, tint: c.tint }]));
	onScene(studio.ids);
	const request = requestOf({ words, wordsOf, note, building: names }, images.length, studio.scene, memoryKey == null ? null : last.get(memoryKey), body);
	const record = await runScene({ name, request, ...motionWriter(env), variant: MOTION_VARIANT, off, images, ...(Object.keys(has).length ? { bodies: has } : {}), env, signal, log: line => {
		const call = /^\s*motion (\d+): (\w+)/.exec(line);
		if (call) try { onCompile({ n: Number(call[1]), ok: call[2] === "ok", line: line.trim() }); } catch { /* a failing view never fails the run */ }
	} });
	if (signal?.aborted) throw failure("aborted", "The turn was stopped.");
	if (record.infraError) throw failure("upstream", `The model or the proxy failed: ${record.infraError.message}`);
	const tookSeconds = Math.round(record.wallMs / 1000), base = { name, report: record.report, missing: record.missing, tookSeconds, compiles: record.compiles };
	if (!record.final) {
		if (record.report) return { ...base, frames: 0, clipSeconds: 0, characterIds: [], objectIds: [], switched: [] };
		throw failure("upstream", `The motion writer ended without a scene or a report (${record.endedBy}).`);
	}
	const clip = readClip(record.final.clip);
	let refused = null;
	// A scene that changed while the motion was written (a build task finished, the user moved something) answers
	// STALE_SCENE once: the tools re-admit at the live revision, and the same step is sent again.
	const run = async (action, args) => {
		for (let tries = 0; ; tries++) {
			try { return await invoke(action, args); } catch (error) {
				if (error?.code === "STALE_SCENE" && tries < 2) continue;
				refused = error;
				return null;
			}
		}
	};
	// a prop the writer added is taken by an object made meanwhile of its name: read the scene as it is at the install
	const props = clip.props ?? [], fresh = said.length > 0;
	let take = { made: {}, twins: {}, idle: [] }, at = new Map();
	const result = await exclusive(async () => {
		if (signal?.aborted) throw failure("aborted", "The turn was stopped.");
		if (fresh) try {
			at = byId((await hub.command("describe", {}, workspaceHandle))?.objects);
			// an id another call changed meanwhile may be a new object: the Studio gives a removed object's id to the next of its kind
			const touched = new Set(changed());
			take = takenBy({ props, known: studio.ids.props, before: new Set([...start.keys()].filter(id => !touched.has(id))), rows: [...at.values()], building: said });
		} catch { /* unread: every added prop is a stand-in */ }
		const done = await installClip(clip, run, { label: note ?? words, existing: studio.ids, turn, made: take.made });
		if (!done.ok) throw failure("studio", `The motion was made (${name}) but the Studio refused to install it: ${refused?.code ? `${refused.code}: ` : ""}${refused?.message ?? "unknown reason"}`);
		return done;
	});
	if (memoryKey != null) last.set(memoryKey, { scene: record.final.scene, spec: record.final.spec });
	// an object that took a prop is told whole, here and on every later edit (motion-fit.mjs fitOf)
	const whole = new Set(result.fitted ?? []);
	rememberBoxes(memoryKey ?? name, record.final.scene, result.placed ?? {}, floorCells(clip), whole);
	// what other calls changed or added while the motion was written, against the boxes and the floor it used; what the install set on each object
	// an object that took a prop is measured against the prop's box whether or not a call changed it (a call that waits passes none)
	const meanwhile = [...new Set([...changed(), ...whole])], set = fresh && [result.objectIds, result.fitted, result.moved, take.idle].some(list => list?.length);
	let motionFit = null, propsSet = null, now = null;
	if (meanwhile.length || set) try { now = (await hub.command("describe", { tops: true }, workspaceHandle))?.objects ?? []; } catch (error) { if (meanwhile.length) motionFit = { status: "unavailable", reason: error?.message ?? String(error) }; }
	if (now && meanwhile.length) motionFit = changedFit(meanwhile, now, boxesOf(memoryKey ?? name), floorCells(clip));
	if (now && set) propsSet = propsSetOf({ props, placed: result.placed ?? {}, done: result, take, start, at, now: byId(now) });
	const studioId = (figure, index) => studio.ids.characters[figure.id] ?? result.characterIds.find(id => id === cast(figure, index));
	const animated = clip.characters.map(studioId).filter(Boolean);
	const placed = (clip.props ?? []).map(prop => studio.ids.props[prop.id]?.id).filter(Boolean);
	const switched = result.switched ?? [];
	// the body each animated character now has; the next edit of one is measured against it (motion-fit.mjs)
	const got = clip.characters.map((figure, k) => ({ id: studioId(figure, k), scale: figure.scale ?? 1, tint: figure.tint ?? null })).filter(b => b.id);
	rememberBodies(memoryKey ?? name, got);
	if (result.bodies?.length) try { onBodies(result.bodies); } catch { /* a failing view never fails the run */ }
	const report = switched.length ? `${record.report ? `${record.report}\n\n` : ""}Changed to the block figure: ${switched.join(", ")}.` : record.report;
	return { ...base, report, frames: clip.frameCount, clipSeconds: Math.round(clip.frameCount / (clip.fps ?? 24) * 10) / 10, characterIds: animated, objectIds: [...result.objectIds, ...(result.fitted ?? []), ...placed], switched, used: usedText(boxesOf(memoryKey ?? name), travelOf(clip)), ...(motionFit ? { motionFit } : {}), ...(propsSet ? { propsSet } : {}), ...(got.some(b => b.scale !== 1 || b.tint) ? { bodies: got } : {}), ...(result.bodies?.length ? { bodiesSet: result.bodies } : {}) };
}
