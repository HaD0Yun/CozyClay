// One motion request on the lowvis engine, from the Studio's scene to installed takes.
// The flow: the editor's describe answer -> the Studio scene as a lowvis scene (src/lowvis/studio/scene.js) -> the
// request text -> the motion writer (src/lowvis/pi/harness.mjs: claude-opus-5-5 at effort medium on CLIProxyAPI with
// one tool, motion) -> the clip it ended with -> installed as scene content (src/lowvis/studio/install.js).
// The scene and spec the motion writer wrote last are kept per memoryKey, so the next request can change or continue them.
// Used by the motion tool of the Studio agent (motion-door.mjs) and by the direct key (lowvis-turn.mjs).
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { motionOff } from "./motion-engine.mjs";

export const MOTION_MODEL = "claude-opus-5-5";
const MOTION_EFFORT = "medium", MOTION_VARIANT = "studio";
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

/** The request the motion writer reads: the user's words, the agent's note, the pictures' count, the Studio's scene and the last motion. */
function requestOf({ words, wordsOf, note }, pictures, studio, before, allowAdd) {
	const parts = [];
	if (words) parts.push(`${WORDS[wordsOf] ?? WORDS.turn}\n${words}`);
	if (note) parts.push(`${NOTE}\n${note}`);
	if (pictures) parts.push(`The user attached ${pictures} picture${pictures === 1 ? "" : "s"}.`);
	if (studio.characters.length || studio.props.length || !allowAdd) {
		// the scene JSON holds what a scene line holds; the flat heights go as lines of their own
		const scene = { characters: studio.characters, props: studio.props.map(({ heights, ...prop }) => prop) };
		const heights = studio.props.filter(prop => prop.heights?.length).map(prop => `${prop.id} offers these flat heights (world): ${JSON.stringify(prop.heights)}`);
		parts.push([`The Studio scene already has these (the user or an earlier step put them there). Use them in your scene with the same id, size and place, and add others only when the request needs them. A prop the request does not ask to move stays where it is.${allowAdd ? "" : " Add no character and no prop: use the listed ones only."}`, JSON.stringify(scene), ...heights].join("\n"));
	}
	if (studio.others?.length) parts.push(`These characters cannot be animated by the engine and stand as they are: ${studio.others.map(other => `${other.id} (${other.why})`).join(", ")}.`);
	if (before) {
		parts.push(`Your last scene and spec in this conversation (the Studio plays them now). When the request changes or continues that motion, start from them and keep what it does not mention.\nscene: ${JSON.stringify(before.scene)}\nspec: ${JSON.stringify(before.spec)}`);
	}
	return parts.join("\n\n");
}

/**
 * runMotion({ words, wordsOf, note, images, memoryKey, hub, workspaceHandle, invoke, signal, env, onCompile, allowAdd })
 *   -> { name, report, missing, frames, clipSeconds, tookSeconds, compiles, characterIds, objectIds, switched }
 * words: the user's message exactly as typed; wordsOf: "turn" (this turn's message, the default) or "task" (the
 * message the coordinator's task came from). note: the Studio agent's own text (the motion tool's request), or none
 * when the words go alone (the direct key). images: [{ data: <base64>, mimeType }] (at most 4). hub.command("describe") reads the scene.
 * invoke(action, args): one editor action as the turn's tools run it (a refusal throws). onCompile({ n, ok, line }):
 * once per compile. allowAdd: false inside a task: the request tells the motion writer to add nothing, and a clip that
 * still needs a character or a prop the Studio scene does not have is not installed (code "studio").
 * characterIds: every Studio character the clip animated; objectIds: the objects it made or placed.
 * A motion writer that ends without a scene but with a report (it could not make the motion) answers with frames 0.
 * frames and clipSeconds (one decimal) are the length of the clip; tookSeconds is how long making it took (wall time).
 * Throws an Error whose code is "upstream" (the model or the proxy), "studio" (the Studio refused the install) or
 * "aborted".
 * deps: { runScene, installClip, studioScene, readClip(file) } in place of the real ones (tests).
 */
export async function runMotion({ words = null, wordsOf = "turn", note = null, images = [], memoryKey, hub, workspaceHandle, invoke, signal = null, env = process.env, onCompile = () => {}, allowAdd = true, deps = null }) {
	const { runScene, installClip, studioScene, readClip } = deps ?? await realDeps();
	if (signal?.aborted) throw failure("aborted", "The turn was stopped.");
	const name = `agent-${stamp()}-${randomBytes(2).toString("hex")}`;
	const off = motionOff(env), turn = !off.includes("turn"), tops = !off.includes("tops");
	const studio = studioScene(await hub.command("describe", tops ? { tops: true } : {}, workspaceHandle), { turn, tops });
	const request = requestOf({ words, wordsOf, note }, images.length, studio.scene, memoryKey == null ? null : last.get(memoryKey), allowAdd);
	const record = await runScene({ name, request, model: MOTION_MODEL, effort: MOTION_EFFORT, variant: MOTION_VARIANT, off, images, env, signal, log: line => {
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
	if (!allowAdd) {
		const unknown = [...clip.characters.filter(figure => !Object.hasOwn(studio.ids.characters, figure.id)), ...(clip.props ?? []).filter(prop => !Object.hasOwn(studio.ids.props, prop.id))].map(item => item.id);
		if (unknown.length) throw failure("studio", `The motion needs ${unknown.join(", ")} that the scene does not have. Build them first, then call motion again.`);
	}
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
	const result = await installClip(clip, run, { label: note ?? words, existing: studio.ids, turn });
	if (!result.ok) throw failure("studio", `The motion was made (${name}) but the Studio refused to install it: ${refused?.code ? `${refused.code}: ` : ""}${refused?.message ?? "unknown reason"}`);
	if (memoryKey != null) last.set(memoryKey, { scene: record.final.scene, spec: record.final.spec });
	const animated = clip.characters.map((figure, index) => studio.ids.characters[figure.id] ?? result.characterIds.find(id => id === `lowvis-${String(figure.id ?? index).replace(/[^A-Za-z0-9_-]/g, "_")}`)).filter(Boolean);
	const placed = (clip.props ?? []).map(prop => studio.ids.props[prop.id]?.id).filter(Boolean);
	const switched = result.switched ?? [];
	const report = switched.length ? `${record.report ? `${record.report}\n\n` : ""}Changed to the block figure: ${switched.join(", ")}.` : record.report;
	return { ...base, report, frames: clip.frameCount, clipSeconds: Math.round(clip.frameCount / (clip.fps ?? 24) * 10) / 10, characterIds: animated, objectIds: [...result.objectIds, ...placed], switched };
}
