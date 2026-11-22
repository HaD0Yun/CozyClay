// One motion request on the lowvis engine, from the Studio's scene to installed takes.
// The flow: the editor's describe answer -> the Studio scene as a lowvis scene (src/lowvis/studio/scene.js) -> the
// request text -> the motion writer (src/lowvis/pi/harness.mjs: claude-opus-5-5 at effort medium on CLIProxyAPI with
// one tool, motion) -> the clip it ended with -> installed as scene content (src/lowvis/studio/install.js).
// The scene and spec the motion writer wrote last are kept per memoryKey, so the next request can change or continue them:
// while the Studio scene still plays them (beforeOf), the next writer's tool starts from them (harness.mjs kept) and
// takes a change as an edit of their actions.
// Used by the motion tool of the Studio agent (motion-door.mjs) and by the direct key (lowvis-turn.mjs).
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { motionWriter, motionOff } from "./motion-engine.mjs";
import { draftOf, travelOf } from "./motion-draft.mjs";
import { figureStature } from "../../src/lowvis/studio/figure.js";
import { boxesOf, changedFit, floorCells, rememberBodies, rememberBoxes, usedText } from "./motion-fit.mjs";
import { propsSetOf } from "./motion-props.mjs";

const MOTION_VARIANT = "studio";
const cast = (figure, index) => `lowvis-${String(figure.id ?? index).replace(/[^A-Za-z0-9_-]/g, "_")}`;
const byId = rows => new Map((Array.isArray(rows) ? rows : []).map(row => [row?.id, row]));
const last = new Map(); // "<Studio scene id> <memoryKey>" -> { scene, spec, name, cast } the motion writer wrote last for that scene, its run and the Studio characters it animated
const takes = new Map(); // "<Studio scene id> <Studio character id>" -> the run whose motion was installed on that character last
const openScene = read => read?.document?.activeSceneId ?? null;
const near = (a, b, by) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, k) => Math.abs(v - b[k]) <= by);
const NEAR = 0.006; // m: the install leaves an object that stands within 5 mm of the clip's place (install.js), and the Studio scene is told in mm

/**
 * The motion before this request, while the Studio scene still plays it: { scene, spec, differs }, else null (the
 * request is then a first one). entry: this conversation's last motion in the open scene (open: its id). It counts
 * when the scene still lists a character it animated, none of which got a later motion (of any conversation).
 * A motion taken out in the Studio itself (an undo) is not seen here.
 * differs: where the Studio scene (scene.js studioScene) is no longer the motion's scene, one text per id: a character
 * that is not in it or has another scale or tint; a prop with another size or turn, and, unless the motion moves it,
 * one that is not in it or stands elsewhere. Not compared: a character's place (the take holds the motion's own) and
 * what the Studio has that the motion's scene lacks.
 */
function beforeOf(entry, open, studio) {
	const listed = new Set(Object.values(studio.ids.characters)), still = (entry?.cast ?? []).filter(id => listed.has(id));
	if (!still.length || still.some(id => takes.get(`${open} ${id}`) !== entry.name)) return null;
	const differs = [], tell = (id, fields) => { if (fields.length) differs.push(`${id}: ${fields.join(", ")}`); };
	for (const c of entry.scene.characters) {
		const now = studio.scene.characters.find(o => o.id === c.id);
		tell(c.id, !now ? ["not in it"] : [Math.abs((c.scale ?? 1) - (now.scale ?? 1)) <= 1e-6 ? null : "scale", String(c.tint ?? "").toLowerCase() === String(now.tint ?? "").toLowerCase() ? null : "tint"].filter(Boolean));
	}
	for (const p of entry.scene.props ?? []) {
		const now = studio.scene.props.find(o => o.id === p.id);
		tell(p.id, !now ? (p.moves ? [] : ["not in it"]) : [near(p.size, now.size, NEAR) ? null : "size", Math.abs((p.turn ?? 0) - (now.turn ?? 0)) <= 0.5 ? null : "turn", p.moves || near(p.at, now.at, NEAR) ? null : "place"].filter(Boolean));
	}
	return { scene: entry.scene, spec: entry.spec, differs };
}

const stamp = () => { const d = new Date(), p = n => String(n).padStart(2, "0"); return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`; };
const failure = (code, message) => Object.assign(new Error(message), { code });
// loaded on a call only: they read src/
async function realDeps() {
	const [{ runScene }, { installClip, addStandIn, standInOf }, { studioScene }] = await Promise.all([import("../../src/lowvis/pi/harness.mjs"), import("../../src/lowvis/studio/install.js"), import("../../src/lowvis/studio/scene.js")]);
	return { runScene, installClip, addStandIn, standInOf, studioScene, readClip: file => JSON.parse(readFileSync(file, "utf8")) };
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

/** The request the motion writer reads: the user's words, the agent's note, the pictures' count, the Studio's scene and the last motion. */
function requestOf({ words, wordsOf, note }, pictures, studio, before, body = false, start = 1) {
	const parts = [];
	if (words) parts.push(`${WORDS[wordsOf] ?? WORDS.turn}\n${words}`);
	if (note) parts.push(`${NOTE}\n${note}`);
	if (pictures) parts.push(`The user attached ${pictures} picture${pictures === 1 ? "" : "s"}.`);
	if (studio.characters.length || studio.props.length) {
		// the scene JSON holds what a scene line holds; the flat heights go as lines of their own. A new character starts at
		// another scale than 1 (start), so every listed one states its own, 1 too
		const characters = start === 1 ? studio.characters : studio.characters.map(c => ({ id: c.id, at: c.at, heading: c.heading, scale: c.scale ?? 1, ...c }));
		const scene = { characters, props: studio.props.map(({ heights, ...prop }) => prop) };
		const heights = studio.props.filter(prop => prop.heights?.length).map(prop => `${prop.id} offers these flat heights (world): ${JSON.stringify(prop.heights)}`);
		parts.push([`The Studio scene already has these (the user or an earlier step put them there). Use them in your scene with the same id, size and place, and add others only when the request needs them. A prop the request does not ask to move stays where it is.`, JSON.stringify(scene), ...heights].join("\n"));
	}
	if (studio.others?.length) parts.push(`These characters cannot be animated by the engine and stand as they are: ${studio.others.map(other => `${other.id} (${other.why})`).join(", ")}.`);
	parts.push(`${ADDED}${body ? ` ${BODIES}` : ""}${note ? ` ${DRESSED}` : ""}`);
	if (before) {
		// the tool starts from them (harness.mjs kept); from the spec alone where the Studio scene is no longer that scene
		const held = before.differs.length ? `The motion tool already holds the spec, as if you had sent it, but not the scene: the Studio scene above differs from it (${before.differs.join("; ")}).` : "The motion tool already holds them, as if you had sent them.";
		parts.push(`Your last scene and spec in this conversation (the Studio plays them now). ${held} When the request changes or continues that motion, start from them and keep what it does not mention.\nscene: ${JSON.stringify(before.scene)}\nspec: ${JSON.stringify(before.spec)}`);
	}
	return parts.join("\n\n");
}

/**
 * runMotion({ words, wordsOf, note, images, memoryKey, hub, workspaceHandle, invoke, signal, env, onCompile })
 *   -> { name, report, missing, frames, clipSeconds, tookSeconds, compiles, characterIds, objectIds, switched, used, propsSet?, bodies?, bodiesSet? }
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
 * drafting(steps), onDraft(answer): the draft (motion-draft.mjs), made only when drafting is given (the motion door's
 * plain turn): the stand-ins of the writer's first compile enter the scene then, the install takes them as the props,
 * and propsSet says per object what the install changed since the draft (motion-props.mjs). The writer is told nothing of it.
 * deps: { runScene, installClip, addStandIn, standInOf, studioScene, readClip(file) } in place of the real ones (tests).
 */
export async function runMotion({ words = null, wordsOf = "turn", note = null, images = [], memoryKey, hub, workspaceHandle, invoke, signal = null, env = process.env, onCompile = () => {}, onScene = () => {}, changed = () => [], onBodies = () => {}, exclusive = install => install(), drafting = null, onDraft = () => {}, deps = null }) {
	const { runScene, installClip, addStandIn, standInOf, studioScene, readClip } = deps ?? await realDeps();
	if (signal?.aborted) throw failure("aborted", "The turn was stopped.");
	const name = `agent-${stamp()}-${randomBytes(2).toString("hex")}`, key = memoryKey ?? name;
	const off = motionOff(env), turn = !off.includes("turn"), tops = !off.includes("tops"), body = !off.includes("body");
	const read = await hub.command("describe", tops ? { tops: true } : {}, workspaceHandle), studio = studioScene(read, { turn, tops, body }), start = byId(read?.objects);
	// what each listed character already has: the motion writer's scene may leave it out (compile-tool.mjs)
	const has = Object.fromEntries(studio.scene.characters.filter(c => c.scale !== undefined || c.tint !== undefined).map(c => [c.id, { scale: c.scale, tint: c.tint }]));
	// new figures start at the size of the look the Studio draws them in (src/lowvis/studio/figure.js): every listed
	// character keeps its own scale, so the start size reaches only a character the motion makes
	const stature = figureStature(env.COZYCLAY_FIGURE ?? null);
	if (body && stature !== 1) { for (const c of studio.scene.characters) has[c.id] = { ...has[c.id], scale: c.scale ?? 1 }; has["*"] = { scale: stature }; studio.ids.start = stature; }
	onScene(studio.ids);
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
	const draft = draftOf({ hold: drafting, onDraft, key, known: studio.ids.props, run, describe: () => hub.command("describe", {}, workspaceHandle), readClip, addStandIn, standInOf });
	const open = openScene(read), before = memoryKey == null ? null : beforeOf(last.get(`${open} ${memoryKey}`), open, studio), request = requestOf({ words, wordsOf, note }, images.length, studio.scene, before, body, has["*"]?.scale ?? 1);
	// the writer's tool starts from the motion before (the request shows it), so a change is sent as an edit of it
	const record = await runScene({ name, request, ...motionWriter(env), variant: MOTION_VARIANT, off, images, ...(Object.keys(has).length ? { bodies: has } : {}), ...(before ? { kept: before.differs.length ? { spec: before.spec } : { scene: before.scene, spec: before.spec } } : {}), env, signal, log: line => {
		const call = /^\s*motion (\d+): (\w+)/.exec(line);
		if (call) try { onCompile({ n: Number(call[1]), ok: call[2] === "ok", line: line.trim() }); } catch { /* a failing view never fails the run */ }
	}, onCompiled: draft.onCompiled });
	const tookSeconds = Math.round(record.wallMs / 1000), base = { name, report: record.report, missing: record.missing, tookSeconds, compiles: record.compiles };
	let clip, result;
	try {
		if (signal?.aborted) throw failure("aborted", "The turn was stopped.");
		if (record.infraError) throw failure("upstream", `The model or the proxy failed: ${record.infraError.message}`);
		if (!record.final) {
			if (record.report) return { ...base, frames: 0, clipSeconds: 0, characterIds: [], objectIds: [], switched: [] };
			throw failure("upstream", `The motion writer ended without a scene or a report (${record.endedBy}).`);
		}
		clip = readClip(record.final.clip);
		result = await exclusive(async () => {
			if (signal?.aborted) throw failure("aborted", "The turn was stopped.");
			const plan = await draft.plan(clip.props ?? []);
			const done = await installClip(clip, run, { label: note ?? words, existing: studio.ids, turn, ...(plan ? { drafted: plan.drafted } : {}) });
			if (!done.ok) throw failure("studio", `The motion was made (${name}) but the Studio refused to install it: ${refused?.code ? `${refused.code}: ` : ""}${refused?.message ?? "unknown reason"}`);
			// an untouched draft stand-in the final motion does not use goes once the install is in (a removal the Studio refuses is told)
			if (plan?.remove.length) await run("object.remove", { ids: plan.remove.map(entry => entry.id) });
			// what the install itself left, read before any other call holds the scene (propsSet)
			let after = null;
			if (plan) try { after = byId((await hub.command("describe", {}, workspaceHandle))?.objects); } catch { /* no propsSet */ }
			return { ...done, plan, after };
		});
	} catch (error) { throw await draft.failed(error); }
	const studioId = (figure, index) => studio.ids.characters[figure.id] ?? result.characterIds.find(id => id === cast(figure, index));
	const animated = clip.characters.map(studioId).filter(Boolean);
	if (memoryKey != null) last.set(`${open} ${memoryKey}`, { scene: record.final.scene, spec: record.final.spec, name, cast: animated });
	for (const id of animated) takes.set(`${open} ${id}`, name);
	rememberBoxes(key, record.final.scene, result.placed ?? {}, floorCells(clip));
	// what other calls changed or added while the motion was written (and the draft's stand-ins changed meanwhile, read
	// from the scene), against the boxes and the floor it used; with a draft, what the install changed since it
	const plan = result.plan;
	let motionFit = null, propsSet = null, now = null, unread = null;
	const readTops = async () => { try { now = (await hub.command("describe", { tops: true }, workspaceHandle))?.objects ?? []; } catch (error) { unread = error; } };
	// with a draft, the calls that waited for the install (edits of its stand-ins) run first: the ids they changed and
	// the scene after them are motionFit's
	if (plan) await drafting(readTops).catch(error => { unread = error; });
	const meanwhile = [...new Set([...changed(), ...(plan?.touched ?? [])])];
	if (meanwhile.length && !now && !unread) await readTops();
	if (meanwhile.length) motionFit = now ? changedFit(meanwhile, now, boxesOf(key), floorCells(clip)) : { status: "unavailable", reason: unread?.message ?? String(unread) };
	if (result.after) propsSet = propsSetOf({ props: clip.props ?? [], placed: result.placed ?? {}, done: result, plan, start, at: plan.at, now: result.after });
	const placed = (clip.props ?? []).map(prop => studio.ids.props[prop.id]?.id ?? plan?.drafted[prop.id]?.id).filter(Boolean);
	const switched = result.switched ?? [];
	// the body each animated character now has; the next edit of one is measured against it (motion-fit.mjs)
	const got = clip.characters.map((figure, k) => ({ id: studioId(figure, k), scale: figure.scale ?? 1, tint: figure.tint ?? null })).filter(b => b.id);
	rememberBodies(key, got);
	if (result.bodies?.length) try { onBodies(result.bodies); } catch { /* a failing view never fails the run */ }
	const report = switched.length ? `${record.report ? `${record.report}\n\n` : ""}Changed to the block figure: ${switched.join(", ")}.` : record.report;
	return { ...base, report, frames: clip.frameCount, clipSeconds: Math.round(clip.frameCount / (clip.fps ?? 24) * 10) / 10, characterIds: animated, objectIds: [...result.objectIds, ...placed], switched, used: usedText(boxesOf(key), travelOf(clip)), ...(motionFit ? { motionFit } : {}), ...(propsSet ? { propsSet } : {}), ...(got.some(b => b.scale !== 1 || b.tint) ? { bodies: got } : {}), ...(result.bodies?.length ? { bodiesSet: result.bodies } : {}) };
}
