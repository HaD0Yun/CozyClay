// One motion request on the lowvis engine, from the Studio's scene to installed takes.
// The flow: the editor's describe answer -> the Studio scene as a lowvis scene (src/lowvis/studio/scene.js) -> the
// request text -> the motion writer (src/lowvis/pi/harness.mjs: claude-opus-5-5 at effort medium on CLIProxyAPI with
// one tool, motion) -> the clip it ended with -> installed as scene content (src/lowvis/studio/install.js).
// The scene and spec the motion writer wrote last are kept per memoryKey, so the next request can change or continue them.
// Used by the motion tool of the Studio agent (motion-door.mjs) and by the direct key (lowvis-turn.mjs).
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { motionOff } from "./motion-engine.mjs";

export const MOTION_MODEL = "claude-opus-5-5", MOTION_EFFORT = "medium", MOTION_VARIANT = "studio";
const last = new Map(); // memoryKey -> { scene, spec } the motion writer wrote last

const stamp = () => { const d = new Date(), p = n => String(n).padStart(2, "0"); return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`; };
const failure = (code, message) => Object.assign(new Error(message), { code });

/** The request the motion writer reads: the user's words, the pictures' count, the Studio's scene and the last motion. */
function requestOf(text, pictures, studio, before, allowAdd) {
	const parts = [text];
	if (pictures) parts.push(`The user attached ${pictures} picture${pictures === 1 ? "" : "s"}.`);
	if (studio.characters.length || studio.props.length || !allowAdd) {
		parts.push(`The Studio scene already has these (the user or an earlier step put them there). Use them in your scene with the same id, size and place, and add others only when the request needs them. A prop the request does not ask to move stays where it is.${allowAdd ? "" : " Add no character and no prop: use the listed ones only."}\n${JSON.stringify(studio)}`);
	}
	if (before) {
		parts.push(`Your last scene and spec in this conversation (the Studio plays them now). When the request changes or continues that motion, start from them and keep what it does not mention.\nscene: ${JSON.stringify(before.scene)}\nspec: ${JSON.stringify(before.spec)}`);
	}
	return parts.join("\n\n");
}

/**
 * runMotion({ text, images, memoryKey, hub, workspaceHandle, invoke, signal, env, onCompile, allowAdd })
 *   -> { name, report, missing, frames, seconds, compiles, characterIds, objectIds, switched }
 * text: the user's words. images: [{ data: <base64>, mimeType }] (at most 4). hub.command("describe") reads the scene.
 * invoke(action, args): one editor action as the turn's tools run it (a refusal throws). onCompile({ n, ok, line }):
 * once per compile. allowAdd: false inside a task (the request tells the motion writer to add nothing).
 * characterIds: every Studio character the clip animated; objectIds: the objects it made or placed.
 * A motion writer that ends without a scene but with a report (it could not make the motion) answers with frames 0.
 * Throws an Error whose code is "upstream" (the model or the proxy), "studio" (the Studio refused the install) or
 * "aborted".
 */
export async function runMotion({ text, images = [], memoryKey, hub, workspaceHandle, invoke, signal = null, env = process.env, onCompile = () => {}, allowAdd = true }) {
	const [{ runScene }, { installClip }, { studioScene }] = await Promise.all([import("../../src/lowvis/pi/harness.mjs"), import("../../src/lowvis/studio/install.js"), import("../../src/lowvis/studio/scene.js")]);
	if (signal?.aborted) throw failure("aborted", "The turn was stopped.");
	const name = `agent-${stamp()}-${randomBytes(2).toString("hex")}`;
	// Bridge options another change adds (turn, tops): pass them here once studioScene takes them, and ask describe for tops.
	const studio = studioScene(await hub.command("describe", {}, workspaceHandle));
	// The request text: once the bridge answers scene.others, add the sentence about characters the engine cannot animate.
	const request = requestOf(text, images.length, studio.scene, memoryKey == null ? null : last.get(memoryKey), allowAdd);
	const record = await runScene({ name, request, model: MOTION_MODEL, effort: MOTION_EFFORT, variant: MOTION_VARIANT, off: motionOff(env), images, env, signal, log: line => {
		const call = /^\s*motion (\d+): (\w+)/.exec(line);
		if (call) try { onCompile({ n: Number(call[1]), ok: call[2] === "ok", line: line.trim() }); } catch { /* a failing view never fails the run */ }
	} });
	if (signal?.aborted) throw failure("aborted", "The turn was stopped.");
	if (record.infraError) throw failure("upstream", `The model or the proxy failed: ${record.infraError.message}`);
	const seconds = Math.round(record.wallMs / 1000), base = { name, report: record.report, missing: record.missing, seconds, compiles: record.compiles };
	if (!record.final) {
		if (record.report) return { ...base, frames: 0, characterIds: [], objectIds: [], switched: [] };
		throw failure("upstream", `The motion writer ended without a scene or a report (${record.endedBy}).`);
	}
	const clip = JSON.parse(readFileSync(record.final.clip, "utf8"));
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
	// Bridge options another change adds (turn, switched): pass them to installClip here.
	const result = await installClip(clip, run, { label: text, existing: studio.ids });
	if (!result.ok) throw failure("studio", `The motion was made (${name}) but the Studio refused to install it: ${refused?.code ? `${refused.code}: ` : ""}${refused?.message ?? "unknown reason"}`);
	if (memoryKey != null) last.set(memoryKey, { scene: record.final.scene, spec: record.final.spec });
	const animated = clip.characters.map((figure, index) => studio.ids.characters[figure.id] ?? result.characterIds.find(id => id === `lowvis-${String(figure.id ?? index).replace(/[^A-Za-z0-9_-]/g, "_")}`)).filter(Boolean);
	const placed = (clip.props ?? []).map(prop => studio.ids.props[prop.id]?.id).filter(Boolean);
	// The report: once installClip answers switched, end it with "Changed to the block figure: <ids>."
	return { ...base, frames: clip.frameCount, characterIds: animated, objectIds: [...result.objectIds, ...placed], switched: result.switched ?? [] };
}
