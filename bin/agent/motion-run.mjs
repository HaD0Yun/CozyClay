// One motion request on the lowvis engine, from the Studio's scene to installed takes.
// The flow: the editor's describe answer -> the Studio scene as a lowvis scene (src/lowvis/studio/scene.js) -> the
// request text -> the motion writer (src/lowvis/pi/harness.mjs with one tool, motion, on the model and sign-in
// motion-writer.mjs chose; writer, its label in the answer) -> the clip it ended with -> installed as scene content (src/lowvis/studio/install.js).
// The scene and spec the motion writer wrote go with the takes they installed (install.js source, motion-kept.mjs), so
// the next request can change or continue the motion that plays: the next writer's tool starts from them (harness.mjs
// kept) and takes a change as an edit of their actions, in any conversation, after a reload and after an undo.
// Used by the motion tool of the Studio agent (motion-door.mjs) and by the direct key (lowvis-turn.mjs).
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { motionWriter, motionOff } from "./motion-engine.mjs";
import { draftOf, travelOf } from "./motion-draft.mjs";
import { lookBody, scaleOf } from "../../src/lowvis/studio/figure.js";
import { boxesOf, changedFit, floorCells, rememberBodies, rememberBoxes, usedText } from "./motion-fit.mjs";
import { propsSetOf } from "./motion-props.mjs";
import { attachedBefore, keptMotion, keptTakes } from "./motion-kept.mjs";

const MOTION_VARIANT = "studio";
const cast = (figure, index) => `lowvis-${String(figure.id ?? index).replace(/[^A-Za-z0-9_-]/g, "_")}`;
const byId = rows => new Map((Array.isArray(rows) ? rows : []).map(row => [row?.id, row]));
const last = new Map(); // "<Studio scene id> <memoryKey>" -> the name of the run whose motion this conversation installed last in that scene
const openScene = read => read?.document?.activeSceneId ?? null;
const near = (a, b, by) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, k) => Math.abs(v - b[k]) <= by);
const NEAR = 0.006; // m: the install leaves an object that stands within 5 mm of the clip's place (install.js), and the Studio scene is told in mm

/**
 * The motion before this request: { scene, spec, differs } of `entry`, the motion a take of the open scene plays now
 * (motion-kept.mjs keptMotion), or null (the request is then a first one).
 * differs: where the Studio scene (scene.js studioScene) is no longer the motion's scene, one text per id: a character
 * that is not in it or has another scale or tint; a prop with another size or turn, and, unless the motion moves it,
 * one that is not in it or stands elsewhere. Not compared: a character's place (the take holds the motion's own) and
 * what the Studio has that the motion's scene lacks.
 */
export function beforeOf(entry, studio) {
	if (!entry) return null;
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

const INSTALL_NO = /^\s*Install:\s*no\b/im; // the writer's report line that keeps its last compile out of the Studio (prompt.mjs)
/** Why the writer's last compiled motion (`what`) is not installed: { text, offer } (offer: it can still be installed on
 *  request), or null when the writer answered for it with its report. A run that ended before its report (a safety
 *  limit, a stop, a model or proxy error) did not; nor did a report with the line "Install: no"; and a motion whose
 *  scene and spec are the ones the Studio plays already is nothing to install. */
function notInstalled(record, before, stopped, what) {
	if (record.finished === false || record.infraError) { // the harness says false for a run that did not end on the model's report
		const how = stopped ? "was stopped on request" : record.infraError ? `failed (${record.infraError.message})` : `ended at ${record.endedBy}`;
		return { text: `The motion writer ${how} before its report, so ${what} is not installed.`, offer: true };
	}
	if (INSTALL_NO.test(record.report ?? "")) return { text: `The motion writer's report says not to install ${what} (Install: no).`, offer: true };
	const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
	if (before && same(record.final?.scene, before.scene) && same(record.final?.spec, before.spec)) return { text: "The motion writer ended with the scene and spec the Studio plays already: nothing new was installed.", offer: false };
	return null;
}

const stamp = () => { const d = new Date(), p = n => String(n).padStart(2, "0"); return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`; };
const failure = (code, message) => Object.assign(new Error(message), { code });
// loaded on a call only: they read src/
async function realDeps() {
	const [{ runScene }, { installClip, addStandIn, standInOf, placeSetLater }, { studioScene }, { eulerXYZ }, { sceneShapes }] = await Promise.all([import("../../src/lowvis/pi/harness.mjs"), import("../../src/lowvis/studio/install.js"), import("../../src/lowvis/studio/scene.js"), import("../../src/lowvis/studio/attach.js"), import("../../src/lowvis/pi/shapes.mjs")]);
	return { runScene, installClip, addStandIn, standInOf, studioScene, placeSetLater, eulerXYZ, sceneShapes, readClip: file => JSON.parse(readFileSync(file, "utf8")) };
}

// The labels of the two texts of a request. The user's words come as typed; the Studio agent's note is its own text.
const WORDS = {
	turn: "USER'S WORDS (the user's message of this turn, exactly as typed):",
	task: "USER'S WORDS (the user's last message to the Studio, exactly as typed; this task may do only part of it):",
};
const NOTE = "STUDIO AGENT'S NOTE (the Studio agent's own text: which characters and objects, what to keep):";
// What becomes of what the motion writer adds; DRESSED only when the Studio agent called (it dresses the set after)
const ADDED = "What your scene adds becomes Studio content: a new character a block figure, a new prop a plain object named by its id, at the place, size and turn you give.";
// said while the kinds step is on: what the Studio does with a new prop (it never makes an object of another kind)
const PLAIN = "A new prop is only ever a plain box or ball, never an object of another kind: when the request needs one the scene does not list with its kind, say so in the Missing line.";
// said while the body step is on (motion-engine.mjs motionOff): what a character's scale and tint are in the Studio
const BODIES = "A character's scale and tint are the Studio character's own scale and tint: the ones your scene gives are set on it, one it leaves out stays as the Studio has it.";
const DRESSED = "After you, the Studio agent gives your props a look over the same box and adds what the body does not touch (background, light, camera); it keeps their place, size and turn.";

/** The request the motion writer reads: the user's words, the agent's note, the pictures' count, the Studio's scene and the last motion. */
function requestOf({ words, wordsOf, note }, pictures, studio, before, body = false, kinds = false) {
	const parts = [];
	if (words) parts.push(`${WORDS[wordsOf] ?? WORDS.turn}\n${words}`);
	if (note) parts.push(`${NOTE}\n${note}`);
	if (pictures) parts.push(`The user attached ${pictures} picture${pictures === 1 ? "" : "s"}.`);
	if (studio.characters.length || studio.props.length) {
		// the scene JSON holds what a scene line holds, a prop's drawn parts too (scene.js)
		parts.push([`The Studio scene already has these (the user or an earlier step put them there). Use them in your scene with the same id, size and place, and add others only when the request needs them. A prop the request does not ask to move stays where it is.`, JSON.stringify({ characters: studio.characters, props: studio.props })].join("\n"));
	}
	if (studio.attached?.length) parts.push(`These objects ride a bone of a character (attached in the Studio, so they go with that bone and are not props above), each with the size of its box or, when it has no box of its own, its kind: ${studio.attached.map(a => `${a.id} (${a.kind ?? `size ${JSON.stringify(a.size)}`}) on ${a.on}'s ${a.bone}${a.place ? ` ${a.place}` : ""}`).join(", ")}. A prop of your scene with such an id is that object: one bone carrying it the whole clip keeps it attached, anything else takes it off the body.${studio.attached.some(a => a.place) ? " One set by hand keeps that place and turn while your clip keeps it on that bone: your clip's place for it is not drawn." : ""}`);
	if (studio.studioIds) parts.push(`The objects a take already moves or a bone carries, as your ids and the Studio's: ${Object.entries(studio.studioIds).map(([id, studioId]) => `${id} = ${studioId}${studio.tilted?.includes(id) ? " (tilted in the Studio, upright here about the same centre)" : ""}`).join(", ")}.`);
	if (studio.others?.length) parts.push(`These characters cannot be animated by the engine and stand as they are: ${studio.others.map(other => `${other.id} (${other.why})`).join(", ")}.`);
	parts.push(`${ADDED}${kinds ? ` ${PLAIN}` : ""}${body ? ` ${BODIES}` : ""}${note ? ` ${DRESSED}` : ""}`);
	if (before) {
		// the tool starts from them (harness.mjs kept); from the spec alone where the Studio scene is no longer that scene
		const held = before.differs.length ? `The motion tool already holds the spec, as if you had sent it: a call may send edit in place of spec. It does not hold the scene: the Studio scene above differs from it (${before.differs.join("; ")}).` : "The motion tool already holds them, as if you had sent them: a call may send only edit, scene or look.";
		// a prop's parts are told once: by the Studio scene above for a prop it lists, here for one a bone carries (no prop above);
		// the look the tool keeps with a scene whose spec names a body's part (parts.js withFigure) is the tool's, not a word of the scene
		const onBone = new Set((studio.attached ?? []).map(a => a.id)), scene = { ...before.scene, figure: undefined, props: before.scene.props?.map(({ parts: drawn, ...prop }) => (drawn && onBone.has(prop.id) ? { ...prop, parts: drawn } : prop)) };
		parts.push(`Your last scene and spec (the Studio plays them now). ${held} When the request changes or continues that motion, start from them and keep what it does not mention.\nscene: ${JSON.stringify(scene)}\nspec: ${JSON.stringify(before.spec)}`);
	}
	return parts.join("\n\n");
}

/**
 * runMotion({ words, wordsOf, note, images, memoryKey, hub, workspaceHandle, invoke, signal, env, onCompile })
 *   -> { name, report, missing, frames, clipSeconds, tookSeconds, compiles, characterIds, objectIds, switched, used, carried?, attached?, propsSet?, bodies?, bodiesSet?, kept?, keptNone? }
 * kept: { name, characters }, the motion that played (its scene and spec kept with its takes) the writer started from;
 * keptNone (when there is none): the listed characters that play a take that keeps no spec, so the motion was written new.
 * words: the user's message exactly as typed; wordsOf: "turn" (this turn's message, the default) or "task" (the
 * message the coordinator's task came from). note: the Studio agent's own text (the motion tool's request), or none
 * when the words go alone (the direct key). images: [{ data: <base64>, mimeType }] (at most 4). hub.command("describe") reads the scene.
 * invoke(action, args): one editor action as the turn's tools run it (a refusal throws). onCompile({ n, ok, line }):
 * once per compile. What the clip has that the Studio scene lacks is added, in a task too (the motion task goes first:
 * main-prompt.mjs rule 8). The boxes of the props it used are kept per memoryKey for the fit lines (motion-fit.mjs).
 * characterIds: every Studio character the clip animated; objectIds: the objects it made or placed. used: one line
 * naming the objects the motion uses as boxes and the floor region the bodies cross (motion-fit.mjs usedText), or null.
 * carried (only when there is one): [{ id, kind }], the Studio objects with no box of their own (scene.js kinds: an
 * effect, a light, a group) that the motion moves, each the object itself with its kind. attached (only when there is
 * one): [{ id, characterId, bone }], the objects the install attached to a bone because that bone carries them the whole
 * clip (install.js); object.detach takes one off.
 * bodies (only when a body the clip animated has another scale than 1, or a tint): [{ id, scale, tint }], the scale and
 * tint each animated Studio character has after the install (tint null: the default colour). bodiesSet (only when the
 * install set a scale or a tint): [{ id, scale?, tint? }], the fields it set (install.js); onBodies(bodiesSet): once, then.
 * A motion writer that ends without a scene but with a report (it could not make the motion) answers with frames 0.
 * frames and clipSeconds (one decimal) are the length of the clip; tookSeconds is how long making it took (wall time).
 * installed: true when the clip went in; undo then holds the receipt ids of the install's own edits, newest first (the
 * steps that changed the scene: in the same message undo_edit of each in that order takes exactly that install back).
 * installed false: nothing went in; notInstalled says why (the writer compiled none; a run that ended before the
 * writer's report; a report with the line "Install: no"; the motion that plays already; a stop on request before the
 * install; another scene open than the motion's), with what exists and what became of the draft's stand-ins, and
 * install() (when there is one) installs that last compiled motion on request, answering as above.
 * Throws an Error whose code is "upstream" (the model or the proxy), "studio" (the Studio refused the install) or
 * "aborted" (signal: the motion was stopped on request before it compiled one).
 * onScene(ids): once the Studio scene is read, with the ids of the characters and objects the motion is written against
 * (scene.js studioScene ids). exclusive(install): runs the install (the editor steps, up to the "studio" failure) and
 * answers what it answers; the motion door holds the scene for it there while other work goes on (motion-door.mjs).
 * changed(): the ids other calls changed while the motion was written; the objects among them that differ where the
 * body goes are the answer's motionFit (motion-fit.mjs changedFit).
 * drafting(steps), onDraft(answer): the draft (motion-draft.mjs), made only when drafting is given (the motion door's
 * plain turn): the stand-ins of the writer's first compile enter the scene then, the install takes them as the props,
 * and propsSet says per object what the install changed since the draft (motion-props.mjs). The writer is told nothing of it.
 * inbox: a steer inbox (steer-inbox.mjs) for what the user sends while the motion writer works (the direct key).
 * deps: { runScene, installClip, addStandIn, standInOf, studioScene, readClip(file) } in place of the real ones (tests).
 */
export async function runMotion({ words = null, wordsOf = "turn", note = null, images = [], memoryKey, hub, workspaceHandle, invoke, signal = null, env = process.env, onCompile = () => {}, onScene = () => {}, changed = () => [], onBodies = () => {}, exclusive = install => install(), drafting = null, onDraft = () => {}, inbox = null, writer = null, deps = null }) {
	const { runScene, installClip, addStandIn, standInOf, studioScene, readClip, placeSetLater = () => false, eulerXYZ = null, sceneShapes = () => ({}) } = deps ?? await realDeps();
	if (signal?.aborted) throw failure("aborted", "The turn was stopped.");
	const name = `agent-${stamp()}-${randomBytes(2).toString("hex")}`, key = memoryKey ?? name;
	const off = motionOff(env), turn = !off.includes("turn"), tops = !off.includes("tops"), body = !off.includes("body"), kinds = !off.includes("kinds"), look = lookBody(env.COZYCLAY_FIGURE || null);
	const read = await hub.command("describe", tops ? { parts: true } : {}, workspaceHandle), studio = studioScene(read, { turn, tops, body, kinds }), start = byId(read?.objects);
	// the drawn shape of each prop the Studio lists (null: drawn as its box; none for a prop it could not measure), now and
	// before each motion call: a stand-in given its look while the writer works is told to it then (compile-tool.mjs)
	// (a stand-in of the draft is the writer's prop it was made for, whatever name the Studio agent gives it with its look)
	const standIns = new Map(), shapesOf = s => Object.fromEntries(s.scene.props.filter(prop => !s.ids.unmeasured?.includes(prop.id)).map(prop => [standIns.get(s.ids.props[prop.id]?.id) ?? prop.id, s.ids.shapes?.[prop.id] ?? null]));
	const reshape = tops ? async () => shapesOf(studioScene(await hub.command("describe", { parts: true }, workspaceHandle), { turn, tops, body, kinds })) : null;
	// the objects with no box of their own are no boxes the body meets: no fit line measures them (motion-fit.mjs)
	const boxed = placed => Object.fromEntries(Object.entries(placed).filter(([prop]) => !studio.ids.props[prop]?.point));
	// what each listed character already has: the motion writer's scene may leave it out (compile-tool.mjs)
	const has = Object.fromEntries(studio.scene.characters.filter(c => c.scale !== undefined || c.tint !== undefined).map(c => [c.id, { scale: c.scale, tint: c.tint }]));
	onScene(studio.ids);
	let refused = null, receipts = null;
	// A scene that changed while the motion was written (a build task finished, the user moved something) answers
	// STALE_SCENE once: the tools re-admit at the live revision, and the same step is sent again. During the install each
	// receipt of a step that changed the scene is kept (receipts: the turn's edits, src/agent-turn-mark.js), so the answer
	// can name what undoes exactly that install.
	const run = async (action, args) => {
		for (let tries = 0; ; tries++) {
			try { const receipt = await invoke(action, args); if (receipts && receipt?.authored === true && receipt.receiptId) receipts.push(receipt.receiptId); return receipt; } catch (error) {
				if (error?.code === "STALE_SCENE" && tries < 2) continue;
				refused = error;
				return null;
			}
		}
	};
	const draft = draftOf({ hold: drafting, onDraft, key, known: studio.ids.props, boxed, run, describe: () => hub.command("describe", {}, workspaceHandle), readClip, addStandIn: async (prop, step) => { const id = await addStandIn(prop, step); if (id) standIns.set(id, prop.id); return id; }, standInOf });
	// the motion a take plays now, with the writer's scene and spec kept with it; this conversation's last one first
	const open = openScene(read), takes = keptTakes(read), playing = memoryKey == null ? null : keptMotion(takes.kept, studio.ids.characters, last.get(`${open} ${memoryKey}`) ?? null);
	// an attached object whose place on its bone was set by hand (install.js placeSetLater) is told with that place and
	// turn, as the Studio has them: the clip's own place for it is not drawn while the clip keeps it on that bone
	const r = (v, by) => Math.round(v * by) / by, onBone = attachedBefore(takes), told = studio.scene.attached ? { ...studio.scene, attached: studio.scene.attached.map(a => {
		const p = studio.ids.props[a.id];
		if (!p || !placeSetLater(onBone, p.id, p)) return a;
		const turned = p.quat && eulerXYZ ? `, turned [${Object.values(eulerXYZ(p.quat)).map(v => r(v, 10)).join(", ")}] degrees` : "";
		return { ...a, place: `at [${[p.x, p.y, p.z].map(v => r(v, 1000)).join(", ")}] m${turned} in that bone's frame (set by hand)` };
	}) } : studio.scene;
	const before = beforeOf(playing, studio), request = requestOf({ words, wordsOf, note }, images.length, told, before, body, kinds);
	// the shape the motion before was compiled with stays for an object a bone carries: the Studio lists it as no prop and measures no parts of it
	const held = Object.fromEntries(Object.entries(sceneShapes(before?.scene)).filter(([id]) => studio.ids.props[id]?.attach));
	// what the agent is told it started from: that motion, or the listed characters whose take keeps no spec to start from
	const listed = new Set(Object.values(studio.ids.characters)), bare = takes.bare.filter(id => listed.has(id));
	const from = playing ? { kept: { name: playing.name, characters: playing.cast } } : bare.length ? { keptNone: bare } : {};
	// the writer's tool starts from the motion before (the request shows it), so a change is sent as an edit of it
	// the writer's route (motion-writer.mjs): its model and effort, and on a sign-in the Studio's provider registry
	const asked = writer ? { model: writer.model, effort: writer.effort, ...(writer.piModel ? { writer: { models: writer.models, model: writer.piModel, provider: writer.provider, via: writer.via, secrets: writer.secrets } } : {}) } : motionWriter(env);
	const record = await runScene({ name, request, ...asked, variant: MOTION_VARIANT, off, images, shapes: tops ? { ...held, ...shapesOf(studio) } : {}, reshape, ...(Object.keys(has).length ? { bodies: has } : {}), ...(before ? { kept: before.differs.length ? { spec: before.spec } : { scene: before.scene, spec: before.spec } } : {}), env, signal, inbox, log: line => {
		const call = /^\s*motion (\d+): (\w+)/.exec(line);
		if (call) try { onCompile({ n: Number(call[1]), ok: call[2] === "ok", line: line.trim() }); } catch { /* a failing view never fails the run */ }
	}, onCompiled: draft.onCompiled });
	// the answer names the writer: the route's label, and the name the provider gave what it served when that is another one
	const servedAs = writer ? (record.served?.models ?? []).filter(id => !String(id).startsWith(writer.model)) : [];
	const tookSeconds = Math.round(record.wallMs / 1000), base = { name, report: record.report, missing: record.missing, tookSeconds, compiles: record.compiles, ...(writer ? { writer: servedAs.length ? `${writer.label}; the provider names what it served ${servedAs.join(", ")}` : writer.label } : {}), ...from }, none = { characterIds: [], objectIds: [], switched: [] };
	if (!record.final) {
		try {
			if (signal?.aborted) throw failure("aborted", "The motion writer was stopped before it compiled a motion.");
			// with a route the failure names the writer, so the agent can say which sign-in or proxy to look at
			if (record.infraError) throw failure("upstream", `The model or the proxy failed: ${record.infraError.message}${writer ? ` (the motion writer: ${writer.label})` : ""}`);
			if (record.report) return { ...base, frames: 0, clipSeconds: 0, ...none, installed: false, notInstalled: "The motion writer compiled no motion." };
			throw failure("upstream", `The motion writer ended without a scene or a report (${record.endedBy}).`);
		} catch (error) { throw await draft.failed(error); }
	}
	const clip = readClip(record.final.clip), length = { frames: clip.frameCount, clipSeconds: Math.round(clip.frameCount / (clip.fps ?? 24) * 10) / 10 };
	const what = `its last compiled motion (compile ${(record.calls?.shots ?? []).findLast(shot => shot.status === "ok")?.n ?? "?"}, ${record.final.frames ?? clip.frameCount} frames)`;
	// a motion kept out of the Studio (rule 7): told with what exists and what became of the draft's stand-ins, and its
	// last compiled motion can still be installed on request (install), unless it is the motion that plays already
	const keptOut = async (text, offer = true) => ({ ...base, ...length, ...none, installed: false, notInstalled: (await draft.failed(failure("kept", text))).message, ...(offer ? { install: () => install(false) } : {}) });
	// first: the install the writer's report asks for; a stop on request that came before it keeps the motion out
	const install = async first => {
		let result;
		try {
			result = await exclusive(async () => {
				if (first && signal?.aborted) throw failure("kept", `The motion was stopped on request before its install, so ${what} is not installed.`);
				receipts = [];
				const plan = await draft.plan(clip.props ?? []);
				const done = await installClip(clip, run, { label: note ?? words, existing: { ...studio.ids, attachedBefore: onBone }, turn, body: look, source: { name, scene: record.final.scene, spec: record.final.spec }, ...(plan ? { drafted: plan.drafted } : {}) });
				if (!done.ok) throw failure("studio", `The motion was made (${name}) but the Studio refused to install it: ${refused?.code ? `${refused.code}: ` : ""}${refused?.message ?? "unknown reason"}`);
				// an untouched draft stand-in the final motion does not use goes once the install is in (a removal the Studio refuses is told)
				if (plan?.remove.length) await run("object.remove", { ids: plan.remove.map(entry => entry.id) });
				const undo = receipts.reverse();
				receipts = null;
				// what the install itself left, read before any other call holds the scene (propsSet)
				let after = null;
				if (plan) try { after = byId((await hub.command("describe", {}, workspaceHandle))?.objects); } catch { /* no propsSet */ }
				return { ...done, plan, after, undo };
			});
		} catch (error) {
			receipts = null;
			// kept out, not failed: stopped before the install, or another scene is open than the motion's (motion-door.mjs)
			if (error?.code === "kept") return keptOut(error.message);
			if (error?.code === "scene") return keptOut(`${error.message}, so ${what} is not installed.`);
			throw await draft.failed(error);
		}
		return answered(result);
	};
	const why = notInstalled(record, before, signal?.aborted, what);
	return why ? keptOut(why.text, why.offer) : install(true);

	// the answer of an install that went through
	async function answered(result) {
		const studioId = (figure, index) => studio.ids.characters[figure.id] ?? result.characterIds.find(id => id === cast(figure, index));
		const animated = clip.characters.map(studioId).filter(Boolean);
		if (memoryKey != null) last.set(`${open} ${memoryKey}`, name);
		rememberBoxes(key, record.final.scene, boxed(result.placed ?? {}), floorCells(clip), { clip, spec: record.final.spec });
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
		const onBone = new Map((result.attached ?? []).map(entry => [entry.id, entry]));
		const carried = (clip.props ?? []).map(prop => studio.ids.props[prop.id]).filter(entry => entry?.point && ((result.moving ?? []).includes(entry.id) || onBone.has(entry.id))).map(entry => ({ id: entry.id, kind: entry.kind }));
		const attached = [...onBone.values()].map(entry => ({ id: entry.id, characterId: entry.characterId, bone: entry.bone, ...(entry.kept ? { kept: true } : {}) }));
		// the body each animated character now has, its scale the Studio character's (the clip's size over the look's body);
		// the next edit of one is measured against it (motion-fit.mjs)
		const got = clip.characters.map((figure, k) => ({ id: studioId(figure, k), scale: scaleOf(figure.scale ?? 1, look), tint: figure.tint ?? null })).filter(b => b.id);
		rememberBodies(key, got);
		if (result.bodies?.length) try { onBodies(result.bodies); } catch { /* a failing view never fails the run */ }
		const report = switched.length ? `${record.report ? `${record.report}\n\n` : ""}Changed to the block figure: ${switched.join(", ")}.` : record.report;
		return { ...base, report, frames: clip.frameCount, clipSeconds: Math.round(clip.frameCount / (clip.fps ?? 24) * 10) / 10, characterIds: animated, objectIds: [...result.objectIds, ...placed], switched, used: usedText(boxesOf(key), travelOf(clip)), ...(carried.length ? { carried } : {}), ...(attached.length ? { attached } : {}), ...(motionFit ? { motionFit } : {}), ...(propsSet ? { propsSet } : {}), ...(got.some(b => b.scale !== 1 || b.tint) ? { bodies: got } : {}), ...(result.bodies?.length ? { bodiesSet: result.bodies } : {}), installed: true, undo: result.undo };
	}
}
