// A size change keeps the motion: the motion tool called without a request (motion-door.mjs) compiles each motion that
// plays again for the scale its characters have now, with no model: the engine builds the kept scene (with the Studio's
// scales and tints) and spec (motion-kept.mjs: they go with the takes), the clip replaces the takes (install.js; the
// props on its bones are attached again, the tracked ones get their new tracks), and the agent is told what came out
// different from the compile at the old size, in the engine's own rows (rule 6): only the rows that are new or worse.
// The spec states intent (targets, holds, rides); a number in it that was right only for the old size stays as written
// and its miss is told: nothing is rescaled by a rule of its own.
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { motionOff } from "./motion-engine.mjs";
import { keptTakes, playingMotions } from "./motion-kept.mjs";
import { beforeOf } from "./motion-run.mjs";
import { lookBody } from "../../src/lowvis/studio/figure.js";

const VARIANT = "studio";
const stamp = () => { const d = new Date(), p = n => String(n).padStart(2, "0"); return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`; };
const failure = (code, message) => Object.assign(new Error(message), { code });
// loaded on a call only: they read src/
async function realDeps() {
	const [{ createCompileTool }, { installClip }, { studioScene }] = await Promise.all([import("../../src/lowvis/pi/compile-tool.mjs"), import("../../src/lowvis/studio/install.js"), import("../../src/lowvis/studio/scene.js")]);
	return { createCompileTool, installClip, studioScene, readClip: file => JSON.parse(readFileSync(file, "utf8")) };
}

/** True when every difference of the Studio scene from the motion's (motion-run.mjs beforeOf differs) is a character's
 *  scale or tint: the only ones a refit takes over (any other is the writer's: a prop moved, a character gone). */
const bodiesOnly = (differs, characters) => differs.every(text => { const [id, fields] = text.split(": "); return characters.has(id) && fields.split(", ").every(f => f === "scale" || f === "tint"); });

/**
 * refitMotion({ hub, workspaceHandle, invoke, env, deps }) -> { ok: true, refit: [...], kept: [...], skipped: [...], keptNone? }
 * refit: [{ name, from, characters, sizes: [{ id, was, now }], frames, rows }] per motion compiled again and installed:
 * from, the motion it replaced; rows, the engine's lines that are new or worse than in the compile of the kept scene at
 * the old size (empty: nothing came out different). kept: [{ name, characters }] the motions that already fit (no body
 * changed). skipped: [{ name, characters, why }], a motion the refit cannot take over (the scene changed otherwise, or
 * the engine refused): the writer is needed for it. keptNone: the listed characters whose take keeps no spec (made
 * before specs were kept, or by another tool): they keep their take as it is.
 * Throws an Error with code "studio" when the Studio refused a step of an install.
 */
export async function refitMotion({ hub, workspaceHandle, invoke, env = process.env, deps = null }) {
	const { createCompileTool, installClip, studioScene, readClip } = deps ?? await realDeps();
	const off = motionOff(env), turn = !off.includes("turn"), tops = !off.includes("tops"), body = !off.includes("body"), kinds = !off.includes("kinds");
	const read = await hub.command("describe", tops ? { tops: true } : {}, workspaceHandle), studio = studioScene(read, { turn, tops, body, kinds });
	const takes = keptTakes(read), listed = new Set(Object.values(studio.ids.characters)), figure = env.COZYCLAY_FIGURE || null;
	const out = { ok: true, refit: [], kept: [], skipped: [] }, bare = takes.bare.filter(id => listed.has(id));
	if (bare.length) out.keptNone = bare;
	let refused = null;
	const run = async (action, args) => {
		for (let tries = 0; ; tries++) {
			try { return await invoke(action, args); } catch (error) {
				if (error?.code === "STALE_SCENE" && tries < 2) continue;
				refused = error;
				return null;
			}
		}
	};
	for (const motion of playingMotions(takes.kept, studio.ids.characters)) {
		const { differs } = beforeOf(motion, studio), ids = new Set(motion.scene.characters.map(c => c.id)), who = { name: motion.name, characters: motion.cast };
		if (!differs.length) { out.kept.push(who); continue; }
		if (!body || !bodiesOnly(differs, ids)) { out.skipped.push({ ...who, why: `the Studio scene differs from the motion's in more than a body's size or tint (${differs.join("; ")}): the motion writer is needed` }); continue; }
		// the kept scene with each body the Studio has now; nothing else of it changes
		const now = c => { const id = studio.ids.characters[c.id], b = id && studio.ids.bodies?.[id]; return b ? { scale: b.scale, tint: b.tint } : { scale: c.scale ?? 1, tint: c.tint ?? null }; };
		const scene = { ...motion.scene, characters: motion.scene.characters.map(({ scale: _s, tint: _t, ...c }) => { const b = now(c); return { ...c, ...(b.scale !== 1 ? { scale: b.scale } : {}), ...(b.tint ? { tint: b.tint } : {}) }; }) };
		const name = `agent-${stamp()}-${randomBytes(2).toString("hex")}`, tool = createCompileTool({ name, variant: VARIANT, off, figure, kept: { scene: motion.scene, spec: motion.spec } });
		const was = tool.call({}), got = was.status === "ok" ? tool.call({ scene }) : was;
		if (got.status !== "ok") { out.skipped.push({ ...who, why: `the engine did not compile it: ${got.error}` }); continue; }
		const clip = readClip(tool.clipFile);
		const done = await installClip(clip, run, { label: `refit of ${motion.name}`, existing: studio.ids, turn, body: lookBody(figure), source: { name, scene, spec: motion.spec } });
		if (!done.ok) throw failure("studio", `The motion was compiled again (${name}) but the Studio refused to install it: ${refused?.code ? `${refused.code}: ` : ""}${refused?.message ?? "unknown reason"}`);
		const sizes = motion.scene.characters.map(c => ({ id: studio.ids.characters[c.id], was: c.scale ?? 1, now: now(c).scale })).filter(s => s.id && s.was !== s.now);
		out.refit.push({ name, from: motion.name, characters: motion.cast, sizes, frames: clip.frameCount, rows: got.told.filter(t => !t.was || t.worse).map(t => t.line) });
	}
	return out;
}
