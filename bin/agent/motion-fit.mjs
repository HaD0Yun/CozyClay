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
// A body is as large as its character's scale: the motion is written for one scale, and a character whose scale is
// then changed plays its take that many times as large about its place, off the floor spots and objects it was put on.
// An edit of an animated character answers with motionFit.bodies when its scale is no longer the motion's.
// Where the motion's bodies meet each object (src/lowvis/studio/contacts.js) is kept with its boxes: an edit of an
// object a body meets, and the install (installFit), answer how far each of those places is from the drawn look. The
// places are the clip's: once a body has another scale than the one that clip was built for (resized, or the take fitted
// again to another size: motion-refit.mjs), an edit answers that they were not measured.
//   rememberBoxes(key, scene, placed, floor, motion)  the boxes of one motion, the floor its feet use and, with motion
//                                             ({ clip, spec }), where its bodies meet them, per conversation
//   rememberBodies(key, list), bodiesOf(key)  the scale each animated character's motion was written for
//   bodyFitOf(body, row)                      the difference of one describe character row from that body: [text]
//   boxesOf(key), floorOf(key)                Map(<Studio id> -> box) and [[x, z], ...] floor cells, empty when none
//   fitOf(box, row, floor)                    the differences of one describe row from its box: [text]
//   usedText(boxes, travel)                   one line for the agent: the objects the motion uses and the floor the bodies cross
//   changedFit(ids, rows, boxes, floor)       the motion result's motionFit: objects changed or added while it was written
//   contactLines(key)                         one line per object a body meets: where (contacts)
//   installFit(key, hub)                      { contacts, gaps } of the motion just installed, or {} when no body meets an object
//   turnFitView({ value, env, hub })          { tools(list) }: under the lowvis engine, a tool result that changed a used
//                                             object gains motionFit
import { motionEngine } from "./motion-engine.mjs";
import { auxOf, contactLine, contactsOf, gapLine, gapsOf, probesOf } from "../../src/lowvis/studio/contacts.js";

const PLACE = 0.01, SIZE = 0.02, TURN = 0.5; // metres, metres, degrees: smaller differences are not told
const TOP = 0.02, COVER = 0.5; // a flat top within 2 cm of the box's top height, over at least half of its footprint
const FLOOR_CELL = 0.1, FOOT = 0.15; // metres: the floor cells, and a joint lower than this is a foot on the floor
const RAD = Math.PI / 180;
const bodies = new Map(); // conversation -> Map(<Studio character id> -> { id, scale, tint })
const boxes = new Map(), floors = new Map(); // conversation -> Map(<Studio id> -> { id, name, size: [w, h, d], base: [x, y, z], turn, sphere, moves?, contacts? (a body meets it) }), [[x, z]]
const touches = new Map(); // conversation -> Map(<Studio id> -> { name, rows, probes, still }): where the bodies meet each object; its .sizes: Map(<Studio character id> -> scale) of the installed clip, null for a draft
const r2 = v => Math.round(v * 100) / 100;
const finite = (v, fallback = 0) => (Number.isFinite(v) ? v : fallback);
const angle = (a, b) => Math.abs(((a - b) % 360 + 540) % 360 - 180);

/**
 * Keeps the boxes of a motion's scene ({ props: [{ id, size, at, turn?, shape?, moves? }] }) under key; placed:
 * { <prop id>: <Studio id> }; floor: the centres [x, z] of the floor cells the motion's feet touch; motion: { clip, spec }
 * the clip compiled from that scene (as the writer's tool read it) and spec, whose contacts are kept with the boxes (a
 * carrying joint's drawn part in the look COZYCLAY_FIGURE names, as the Studio draws the bodies, or motion.look).
 * -> undo(): keeps again what was kept under key before (a draft of a motion that then failed: motion-draft.mjs).
 */
export function rememberBoxes(key, scene, placed = {}, floor = [], motion = null) {
	if (key == null) return () => {};
	const was = [boxes.get(key), floors.get(key), touches.get(key)], next = new Map(), met = new Map();
	// a clip whose contacts cannot be read (no bodies or poses in it) keeps none: the boxes stand as before
	if (motion?.clip) try {
		const clip = motion.clip, aux = auxOf(scene, motion.spec, clip), look = motion.look ?? process.env.COZYCLAY_FIGURE ?? null;
		for (const [prop, rows] of contactsOf(clip, aux, look)) {
			const id = placed[prop], p = clip.props.find(x => x.id === prop);
			if (id) met.set(id, { name: prop, rows, probes: probesOf(clip, prop, rows, look), still: p.pos.length <= 3 });
		}
	} catch { met.clear(); }
	for (const prop of scene?.props ?? []) {
		const id = placed[prop.id];
		if (!id || !Array.isArray(prop.size) || !Array.isArray(prop.at)) continue;
		const sphere = prop.shape === "sphere", size = sphere ? [prop.size[0], prop.size[0], prop.size[0]] : prop.size;
		next.set(id, { id, name: String(prop.id), size: size.map(r2), base: [prop.at[0], prop.at[1] - size[1] / 2, prop.at[2]].map(r2), turn: finite(prop.turn), sphere, ...(prop.moves ? { moves: true } : {}), ...(met.has(id) ? { contacts: true } : {}) });
	}
	boxes.set(key, next);
	floors.set(key, floor);
	touches.set(key, met);
	return () => { for (const [map, value] of [[boxes, was[0]], [floors, was[1]], [touches, was[2]]]) if (value === undefined) map.delete(key); else map.set(key, value); };
}

/** One line per object a body of the conversation's last motion meets (contacts.js contactLine), [] when none. */
export const contactLines = key => [...(touches.get(key) ?? [])].map(([id, t]) => contactLine(`${t.name} (${id})`, t.rows));

/** A world point in the own frame of a describe row that stands still (its base pivot, turned by rotX, rot, rotZ in XYZ order). */
function ownOf(row, p) {
	const h = [finite(row.rotX), finite(row.rot), finite(row.rotZ)].map(v => (v * RAD) / 2), [cx, cy, cz] = h.map(Math.cos), [sx, sy, sz] = h.map(Math.sin);
	const q = [-(sx * cy * cz + cx * sy * sz), -(cx * sy * cz - sx * cy * sz), -(cx * cy * sz + sx * sy * cz), cx * cy * cz - sx * sy * sz]; // the inverse turn
	const v = [p[0] - finite(row.x), p[1] - finite(row.y), p[2] - finite(row.z)], t = [2 * (q[1] * v[2] - q[2] * v[1]), 2 * (q[2] * v[0] - q[0] * v[2]), 2 * (q[0] * v[1] - q[1] * v[0])];
	return [v[0] + q[3] * t[0] + (q[1] * t[2] - q[2] * t[1]), v[1] + q[3] * t[1] + (q[2] * t[0] - q[0] * t[2]), v[2] + q[3] * t[2] + (q[0] * t[1] - q[1] * t[0])];
}

/**
 * The gap line of each object of ids a body meets, measured on what the Studio draws now (hub.command("contact_gaps"),
 * src/lowvis/studio/gaps.js): Map(<Studio id> -> line | null (every contact within contacts.js GAP)). rows: Map(id ->
 * describe row): an object that stands still (not tracked, not attached) is read where it stands, as the Studio has it.
 */
async function gapLines(key, ids, rows, command) {
	const touched = touches.get(key) ?? new Map(), list = ids.filter(id => touched.has(id)), out = new Map();
	if (!list.length) return out;
	// each probe in the object's own frame: where it stands now when it stands still, else where the clip has it
	const framed = list.map(id => {
		const t = touched.get(id), row = rows.get(id), still = t.still && row && !row.attach, own = probe => (still ? probe.world.map(p => ownOf(row, p)) : probe.local);
		const solids = (t.probes.solids ?? []).map(s => (still ? s.world.map(pts => pts.map(p => ownOf(row, p))) : s.local).map((v, i) => ({ v, t: s.t[i] })));
		return { id, t, probes: { ...t.probes, seats: t.probes.seats.map(s => ({ ...s, local: still ? ownOf(row, s.world) : s.local })) }, points: [...t.probes.parts, ...t.probes.inside].map(own), solids };
	});
	const answer = await command("contact_gaps", { objects: framed.map(({ id, probes, points, solids }) => ({ id, points, columns: probes.seats.map(s => [s.local[0], s.local[2], s.local[1]]), ...(solids.length ? { solids } : {}) })) });
	const byId = new Map((answer?.objects ?? []).map(entry => [entry?.id, entry]));
	for (const { id, t, probes } of framed) {
		const got = byId.get(id), label = `${t.name} (${id})`, n = probes.parts.length;
		out.set(id, got?.drawn ? gapLine(label, gapsOf(t.rows, probes, { parts: got.points.slice(0, n), inside: got.points.slice(n), seats: got.columns, solids: got.solids })) : `${label}: not drawn now, so not measured`);
	}
	return out;
}

/**
 * The contacts and gaps of the motion just installed (after delayMs: the Studio draws an install on its next frames):
 * { contacts: [line], gaps: [line] } (gaps [] when every contact is within contacts.js GAP of the drawn look; { status:
 * "unavailable", reason } when the Studio could not measure), or {} when no body meets an object. hub: { command(name, args) }.
 */
export async function installFit(key, hub, delayMs = 300) {
	const contacts = contactLines(key);
	if (!contacts.length) return {};
	try {
		await wait(delayMs);
		const rows = new Map(((await hub.command("describe", {}))?.objects ?? []).map(row => [row?.id, row]));
		return { contacts, gaps: [...(await gapLines(key, [...touches.get(key).keys()], rows, (name, args) => hub.command(name, args))).values()].filter(Boolean) };
	} catch (error) {
		return { contacts, gaps: { status: "unavailable", reason: error?.message ?? String(error) } };
	}
}

/** Keeps the bodies of a motion ([{ id: <Studio character id>, scale, tint }]) under key: the sizes its contacts were read at. */
export function rememberBodies(key, list = []) {
	if (key == null) return;
	bodies.set(key, new Map(list.map(body => [body.id, body])));
	if (touches.has(key)) touches.get(key).sizes = new Map(list.map(body => [body.id, body.scale]));
}
export const bodiesOf = key => bodies.get(key) ?? new Map();
/** What differs between a describe character row and the body its motion was written for, as short texts. */
export function bodyFitOf(body, row) {
	const scale = finite(row?.scale, 1);
	return row && Math.abs(scale - body.scale) > 1e-6 ? [`scale ${r2(scale)}, the motion's ${r2(body.scale)}: the take plays ${r2(scale / body.scale)} times as large about the character's place`] : [];
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
		// a box a body meets: with the difference, which is how far its sides went from the contacts
		const over = k => (box.contacts ? `${r2(Math.abs(size[k] - box.size[k]))} m ${size[k] > box.size[k] ? "over" : "under"} ` : "");
		out.push(...["width (x)", "height", "depth (z)"].map((label, k) => Math.abs(size[k] - box.size[k]) > SIZE ? `${label} ${r2(size[k])} m, ${over(k)}the box's ${box.size[k]} m` : null).filter(Boolean));
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

/** Where an object the motion does not use stands on floor the feet use: [text], or [] (a hidden, attached or flat-as-floor object, under 0.03 m, stands nowhere). */
function onFeetOf(row, floor) {
	const size = [finite(row.footprint?.width, 1) * finite(row.scaleX, 1), finite(row.height, 1) * finite(row.scaleY, 1), finite(row.footprint?.depth, 1) * finite(row.scaleZ, 1)];
	if (row.hidden || row.attach || size[1] < 0.03) return [];
	const cells = floor.filter(p => inside(p, [finite(row.x), finite(row.z)], finite(row.rot), [size[0] / 2, size[2] / 2])).length;
	return cells ? [`footprint ${r2(size[0])} x ${r2(size[2])} m, ${r2(size[1])} m tall, at [${r2(finite(row.x))}, ${r2(finite(row.z))}] stands on floor the feet use (${cells} cell${cells === 1 ? "" : "s"} of ${FLOOR_CELL} m); the motion was written without it`] : [];
}

/**
 * The objects that other calls changed or added while a motion was written (ids), as the Studio now has them (rows:
 * describe objects with flat tops), against the boxes the motion used and the floor its feet use: motionFit
 * { fits: false, objects: [{ id, name, differs }], note } as turnFitView answers it, or null when none differs there.
 */
export function changedFit(ids, rows, used, floor) {
	const byId = new Map(rows.map(row => [row?.id, row])), objects = [];
	for (const id of ids) {
		const row = byId.get(id), box = used.get(id);
		const differs = box ? fitOf(box, row, floor) : row ? onFeetOf(row, floor) : [];
		if (differs.length) objects.push({ id, name: box?.name ?? String(row?.name ?? id), differs });
	}
	return objects.length ? { fits: false, objects, note: noteOf(objects, used) } : null;
}

const NOTE = "The motion was written against these boxes. Where the body meets an object (its top, the floor around it, a prop the hands hold), its look should match its box: fit the look to the box there.";
// when a body meets one of the objects named (a box with contacts: rememberBoxes)
const CONTACT_NOTE = "The motion was written against these boxes and meets them at its contacts. Fit the look so a drawn part is at each contact (gaps: how far each is off), or call motion again: it is written for the objects as they then are.";
const noteOf = (objects, used) => (objects.some(entry => used.get(entry.id)?.contacts) ? CONTACT_NOTE : NOTE);
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * turnFitView({ value, env, hub, delayMs }) -> { tools(list) }. Under the lowvis engine, a tool whose result names in
 * affectedIds an object the conversation's last motion uses answers with motionFit: { fits: true, ids } or
 * { fits: false, objects: [{ id, name, differs: [text], gaps?: line }], note } (gaps: an object a body meets whose drawn
 * look is off its contacts; motionFit.gaps "not measured (why)" when they could not be measured); one that names an
 * animated character whose scale is no longer its motion's answers with motionFit: { fits: false, bodies: [{ id,
 * differs: [text] }] } (beside objects and note when an object differs too). The scene is read again with flat tops after delayMs
 * (the Studio draws an edit on its next frame), or at once when a closeup was attached (it waited for the drawing).
 */
export function turnFitView({ value, env = process.env, hub, delayMs = 300 }) {
	if (motionEngine(env) !== "lowvis" || value?.main) return { tools: list => list };
	const key = value.task?.parentId ?? value.sessionId, handle = value.context?.host?.workspaceHandle;
	const fit = async result => {
		const used = boxesOf(key), cast = bodiesOf(key), named = [...new Set(Array.isArray(result?.affectedIds) ? result.affectedIds : [])];
		const ids = named.filter(id => used.has(id)), people = named.filter(id => cast.has(id));
		if ((!ids.length && !people.length) || result?.ok === false) return result;
		try {
			if (result.look?.status !== "attached") await wait(delayMs);
			const scene = await hub.command("describe", { tops: true }, handle), rows = new Map((scene?.objects ?? []).map(row => [row?.id, row]));
			// where a body meets an edited object: how far its drawn look now is from each of those places. The places are the
			// clip's: once a body has another scale than that clip's (resized, or fitted again to another size) they are not
			// measured, and gaps says so instead of a number
			let gaps = new Map(), why = null;
			const met = touches.get(key), scaleOf = id => finite((scene?.characters ?? []).find(row => row?.id === id)?.scale, 1);
			if ([...(met?.sizes ?? [])].some(([id, scale]) => Math.abs(scaleOf(id) - scale) > 1e-6)) why = "a body's scale is not the one these contacts were read at";
			else try { gaps = await gapLines(key, ids, rows, (name, args) => hub.command(name, args, handle)); } catch (error) { why = error?.message ?? String(error); }
			const untold = why && ids.some(id => met?.has(id)) ? { gaps: `not measured (${why})` } : {};
			const objects = ids.map(id => ({ id, name: used.get(id).name, differs: fitOf(used.get(id), rows.get(id), floorOf(key)), ...(gaps.get(id) ? { gaps: gaps.get(id) } : {}) })).filter(entry => entry.differs.length || entry.gaps);
			const sized = people.map(id => ({ id, differs: bodyFitOf(cast.get(id), (scene?.characters ?? []).find(row => row?.id === id)) })).filter(entry => entry.differs.length);
			if (!sized.length) return ids.length ? { ...result, motionFit: objects.length ? { fits: false, objects, note: noteOf(objects, used), ...untold } : { fits: true, ids, ...untold } } : result;
			return { ...result, motionFit: { fits: false, ...(objects.length ? { objects, note: noteOf(objects, used) } : {}), ...untold, bodies: sized } };
		} catch (error) {
			return { ...result, motionFit: { status: "unavailable", reason: error?.message ?? String(error) } };
		}
	};
	return { tools: list => list.map(tool => ({ ...tool, handler: async (args, call) => fit(await tool.handler(args, call)) })) };
}
