// What the motion was written against, and how far a later edit took an object from it where the body meets it (rule
// 6). The motion writer's last scene holds a box per object the body uses; installClip says which Studio object each box
// is. An edit of such an object (a look given in place, a move) answers with motionFit: the differences between the
// object as the Studio now draws it (its place, turn, measured size and flat tops: src/lowvis/studio/tops.js) and the
// box, in metres and degrees, only where the body meets the object:
//   - an object that stays put: its place and turn; the box's flat top must still be there, at the box's height within
//     TOP and over at least COVER of the box's footprint; its footprint must not grow past the box onto floor the feet use
//     (the floor cells the motion's feet touch). A part that rises above the box elsewhere is no difference here; a body
//     passing through a drawn part is the final review's finding (src/solid-contact.js).
//   - a prop that moves (carried, pushed): where its track has it, so only its size, held by the hands, against the box's.
// Only geometry: no object kinds or names.
//   rememberBoxes(key, scene, placed, floor)  the boxes of one motion and the floor its feet use, per conversation
//   boxesOf(key), floorOf(key)                Map(<Studio id> -> box) and [[x, z], ...] floor cells, empty when none
//   fitOf(box, row, floor)                    the differences of one describe row from its box: [text]
//   usedText(boxes, travel)                   one line for the agent: the objects the motion uses and the floor the bodies cross
//   turnFitView({ value, env, hub })          { tools(list) }: under the lowvis engine, a tool result that changed a used
//                                             object gains motionFit
import { motionEngine } from "./motion-engine.mjs";

const PLACE = 0.01, SIZE = 0.02, TURN = 0.5; // metres, metres, degrees: smaller differences are not told
const TOP = 0.02, COVER = 0.5; // a flat top within 2 cm of the box's top height, over at least half of its footprint
const FLOOR_CELL = 0.1, FOOT = 0.15; // metres: the floor cells, and a joint lower than this is a foot on the floor
const RAD = Math.PI / 180;
const boxes = new Map(), floors = new Map(); // conversation -> Map(<Studio id> -> { id, name, size: [w, h, d], base: [x, y, z], turn, sphere, moves? }), [[x, z]]
const r2 = v => Math.round(v * 100) / 100;
const finite = (v, fallback = 0) => (Number.isFinite(v) ? v : fallback);
const angle = (a, b) => Math.abs(((a - b) % 360 + 540) % 360 - 180);

/**
 * Keeps the boxes of a motion's scene ({ props: [{ id, size, at, turn?, shape?, moves? }] }) under key; placed:
 * { <prop id>: <Studio id> }; floor: the centres [x, z] of the floor cells the motion's feet touch.
 */
export function rememberBoxes(key, scene, placed = {}, floor = []) {
	if (key == null) return;
	const next = new Map();
	for (const prop of scene?.props ?? []) {
		const id = placed[prop.id];
		if (!id || !Array.isArray(prop.size) || !Array.isArray(prop.at)) continue;
		const sphere = prop.shape === "sphere", size = sphere ? [prop.size[0], prop.size[0], prop.size[0]] : prop.size;
		next.set(id, { id, name: String(prop.id), size: size.map(r2), base: [prop.at[0], prop.at[1] - size[1] / 2, prop.at[2]].map(r2), turn: finite(prop.turn), sphere, ...(prop.moves ? { moves: true } : {}) });
	}
	boxes.set(key, next);
	floors.set(key, floor);
}

export const boxesOf = key => boxes.get(key) ?? new Map();
export const floorOf = key => floors.get(key) ?? [];

/** Whether world point [x, z] lies in a rectangle of half sizes [hw, hd] centred at [cx, cz], turned by deg about Y. */
function inside([x, z], [cx, cz], deg, [hw, hd]) {
	const a = deg * RAD, dx = x - cx, dz = z - cz, u = dx * Math.cos(a) - dz * Math.sin(a), v = dx * Math.sin(a) + dz * Math.cos(a);
	return Math.abs(u) <= hw && Math.abs(v) <= hd;
}
const overlap = (a0, a1, b0, b1) => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));

/** What differs between a describe row ({ x, y, z, rot, footprint, height, scaleX.., tops, hidden }) and its box where the body meets it, as short texts. */
export function fitOf(box, row, floor = []) {
	if (!row) return ["removed: the motion uses it"];
	if (row.hidden) return ["hidden: the motion uses it"];
	const out = [], base = [finite(row.x), finite(row.y), finite(row.z)], d = base.map((v, k) => v - box.base[k]);
	const size = [finite(row.footprint?.width, 1) * finite(row.scaleX, 1), finite(row.height, 1) * finite(row.scaleY, 1), finite(row.footprint?.depth, 1) * finite(row.scaleZ, 1)];
	if (box.moves) {
		out.push(...["width (x)", "height", "depth (z)"].map((label, k) => Math.abs(size[k] - box.size[k]) > SIZE ? `${label} ${r2(size[k])} m, the box's ${box.size[k]} m` : null).filter(Boolean));
		return out;
	}
	if (Math.hypot(...d) > PLACE) out.push(`base at [${base.map(r2).join(", ")}], the box's at [${box.base.join(", ")}]`);
	if (!box.sphere && angle(finite(row.rot), box.turn) > TURN) out.push(`turn ${r2(finite(row.rot))}°, the box's ${r2(box.turn)}°`);
	const tops = Array.isArray(row.tops) ? row.tops : [], [w, h, dd] = box.size;
	if (!box.sphere && tops.length) {
		const covers = t => Math.abs(t.y - h) <= TOP && overlap(t.x0, t.x1, -w / 2, w / 2) * overlap(t.z0, t.z1, -dd / 2, dd / 2) >= COVER * w * dd;
		if (!tops.some(covers)) out.push(`no flat top at the box's top (${h} m over its base, within ${TOP} m) over half its footprint; its flat tops (height over its base: width x depth m): ${tops.map(t => `${r2(t.y)}: ${r2(t.x1 - t.x0)} x ${r2(t.z1 - t.z0)}`).join(", ")}`);
	}
	const onFeet = floor.filter(p => inside(p, [base[0], base[2]], finite(row.rot), [size[0] / 2, size[2] / 2]) && !inside(p, [box.base[0], box.base[2]], box.turn, [w / 2, dd / 2]));
	if (onFeet.length) out.push(`footprint ${r2(size[0])} x ${r2(size[2])} m reaches past the box (${w} x ${dd} m) onto floor the feet use (${onFeet.length} cell${onFeet.length === 1 ? "" : "s"} of ${FLOOR_CELL} m)`);
	return out;
}

/** The floor cells the feet touch: the centres [x, z] of FLOOR_CELL squares under any joint lower than FOOT over the clip. */
export function floorCells(clip) {
	const cells = new Map();
	for (const figure of clip?.characters ?? []) for (let k = 0; k + 2 < (figure.pos?.length ?? 0); k += 3) {
		if (figure.pos[k + 1] >= FOOT) continue;
		const i = Math.floor(figure.pos[k] / FLOOR_CELL), j = Math.floor(figure.pos[k + 2] / FLOOR_CELL);
		cells.set(`${i},${j}`, [r2((i + 0.5) * FLOOR_CELL), r2((j + 0.5) * FLOOR_CELL)]);
	}
	return [...cells.values()];
}

/** The objects a motion uses and the floor region its bodies cross, as one line ([] boxes and no travel: null). */
export function usedText(used, travel) {
	const parts = [];
	if (used.size) parts.push(`The motion uses these objects as boxes (id: width x height x depth m, base [x, y, z], turn): ${[...used.values()].map(b => `${b.id} (${b.name}): ${b.size.join(" x ")}, [${b.base.join(", ")}]${b.turn ? `, ${r2(b.turn)}°` : ""}`).join("; ")}.`);
	if (travel) parts.push(`The bodies cross the floor within x ${travel.x.join(" to ")}, z ${travel.z.join(" to ")}.`);
	return parts.length ? parts.join(" ") : null;
}

const NOTE = "The motion was written against these boxes. Where the body meets an object (its top, the floor around it, a prop the hands hold), its look should match its box: fit the look to the box there.";
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
			const objects = ids.map(id => ({ id, name: used.get(id).name, differs: fitOf(used.get(id), rows.get(id), floorOf(key)) })).filter(entry => entry.differs.length);
			return { ...result, motionFit: objects.length ? { fits: false, objects, note: NOTE } : { fits: true, ids } };
		} catch (error) {
			return { ...result, motionFit: { status: "unavailable", reason: error?.message ?? String(error) } };
		}
	};
	return { tools: list => list.map(tool => ({ ...tool, handler: async (args, call) => fit(await tool.handler(args, call)) })) };
}
