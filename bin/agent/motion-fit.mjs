// What the motion was written against, and how far a later edit took an object from it (rule 6). The motion writer's
// last scene holds a box per object the body uses; installClip says which Studio object each box is. An edit of such an
// object (a look given in place, a move) answers with motionFit: the differences between the object as the Studio now
// draws it (its place, turn, measured size and flat tops: src/lowvis/studio/tops.js) and the box, in metres and degrees.
// Only geometry: no object kinds or names.
//   rememberBoxes(key, scene, placed)   the boxes of one motion, per conversation (motion-run.mjs)
//   boxesOf(key)                        Map(<Studio id> -> box), empty when none
//   fitOf(box, row)                     the differences of one describe row from its box: [text]
//   usedText(boxes, travel)             one line for the agent: the objects the motion uses and the floor the bodies cross
//   turnFitView({ value, env, hub })    { tools(list) }: under the lowvis engine, a tool result that changed a used
//                                       object gains motionFit
import { motionEngine } from "./motion-engine.mjs";

const PLACE = 0.01, SIZE = 0.02, TURN = 0.5; // metres, metres, degrees: smaller differences are not told
const boxes = new Map(); // conversation -> Map(<Studio id> -> { id, name, size: [w, h, d], base: [x, y, z], turn, sphere, moves? })
const r2 = v => Math.round(v * 100) / 100;
const finite = (v, fallback = 0) => (Number.isFinite(v) ? v : fallback);
const angle = (a, b) => Math.abs(((a - b) % 360 + 540) % 360 - 180);

/** Keeps the boxes of a motion's scene ({ props: [{ id, size, at, turn?, shape?, moves? }] }) under key; placed: { <prop id>: <Studio id> }. */
export function rememberBoxes(key, scene, placed = {}) {
	if (key == null) return;
	const next = new Map();
	for (const prop of scene?.props ?? []) {
		const id = placed[prop.id];
		if (!id || !Array.isArray(prop.size) || !Array.isArray(prop.at)) continue;
		const sphere = prop.shape === "sphere", size = sphere ? [prop.size[0], prop.size[0], prop.size[0]] : prop.size;
		next.set(id, { id, name: String(prop.id), size: size.map(r2), base: [prop.at[0], prop.at[1] - size[1] / 2, prop.at[2]].map(r2), turn: finite(prop.turn), sphere, ...(prop.moves ? { moves: true } : {}) });
	}
	boxes.set(key, next);
}

export const boxesOf = key => boxes.get(key) ?? new Map();

/** What differs between a describe row ({ x, y, z, rot, footprint, height, scaleX.., tops, hidden }) and its box, as short texts. */
export function fitOf(box, row) {
	if (!row) return ["removed: the motion uses it"];
	if (row.hidden) return ["hidden: the motion uses it"];
	const out = [], base = [finite(row.x), finite(row.y), finite(row.z)], d = base.map((v, k) => v - box.base[k]);
	// a prop that moves is where its track has it: only its size and tops are the box's
	if (!box.moves && Math.hypot(...d) > PLACE) out.push(`base at [${base.map(r2).join(", ")}], the box's at [${box.base.join(", ")}]`);
	if (!box.sphere && !box.moves && angle(finite(row.rot), box.turn) > TURN) out.push(`turn ${r2(finite(row.rot))}°, the box's ${r2(box.turn)}°`);
	const size = [finite(row.footprint?.width, 1) * finite(row.scaleX, 1), finite(row.height, 1) * finite(row.scaleY, 1), finite(row.footprint?.depth, 1) * finite(row.scaleZ, 1)];
	const axes = ["width (x)", "height", "depth (z)"].map((label, k) => Math.abs(size[k] - box.size[k]) > SIZE ? `${label} ${r2(size[k])} m, the box's ${box.size[k]} m` : null).filter(Boolean);
	out.push(...axes);
	const tops = Array.isArray(row.tops) ? row.tops : [];
	if (!box.sphere && tops.length && Math.abs(tops[0].y - box.size[1]) > SIZE) {
		out.push(`widest flat top ${r2(tops[0].y)} m over its base, the box's top ${box.size[1]} m; its flat tops (height over its base: width x depth m): ${tops.map(t => `${r2(t.y)}: ${r2(t.x1 - t.x0)} x ${r2(t.z1 - t.z0)}`).join(", ")}`);
	}
	return out;
}

/** The objects a motion uses and the floor region its bodies cross, as one line ([] boxes and no travel: null). */
export function usedText(used, travel) {
	const parts = [];
	if (used.size) parts.push(`The motion uses these objects as boxes (id: width x height x depth m, base [x, y, z], turn): ${[...used.values()].map(b => `${b.id} (${b.name}): ${b.size.join(" x ")}, [${b.base.join(", ")}]${b.turn ? `, ${r2(b.turn)}°` : ""}`).join("; ")}.`);
	if (travel) parts.push(`The bodies cross the floor within x ${travel.x.join(" to ")}, z ${travel.z.join(" to ")}.`);
	return parts.length ? parts.join(" ") : null;
}

const NOTE = "The motion was written against these boxes. Where the body meets an object, its look should match its box: fit the look to the box.";
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * turnFitView({ value, env, hub, delayMs }) -> { tools(list) }. Under the lowvis engine, a tool whose result names in
 * affectedIds an object the conversation's last motion uses answers with motionFit: { fits: true, ids } or
 * { fits: false, objects: [{ id, name, differs: [text] }], note }. The scene is read again with flat tops after delayMs
 * (the Studio draws an edit on its next frame), or at once when a closeup was attached (it waited for the drawing).
 */
export function turnFitView({ value, env = process.env, hub, delayMs = 300 }) {
	if (motionEngine(env) !== "lowvis" || value?.main) return { tools: list => list };
	const key = value.task?.parentId ?? value.sessionId, handle = value.context?.host?.workspaceHandle;
	const fit = async result => {
		const used = boxesOf(key), ids = [...new Set((Array.isArray(result?.affectedIds) ? result.affectedIds : []).filter(id => used.has(id)))];
		if (!ids.length || result?.ok === false) return result;
		try {
			if (result.look?.status !== "attached") await wait(delayMs);
			const rows = new Map(((await hub.command("describe", { tops: true }, handle))?.objects ?? []).map(row => [row?.id, row]));
			const objects = ids.map(id => ({ id, name: used.get(id).name, differs: fitOf(used.get(id), rows.get(id)) })).filter(entry => entry.differs.length);
			return { ...result, motionFit: objects.length ? { fits: false, objects, note: NOTE } : { fits: true, ids } };
		} catch (error) {
			return { ...result, motionFit: { status: "unavailable", reason: error?.message ?? String(error) } };
		}
	};
	return { tools: list => list.map(tool => ({ ...tool, handler: async (args, call) => fit(await tool.handler(args, call)) })) };
}
