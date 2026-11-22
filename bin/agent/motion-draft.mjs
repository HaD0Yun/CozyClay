// The draft of a motion written while the Studio agent works (motion-door.mjs background). When the motion writer's
// first compile goes through, each prop of it that the scene the writer read lacks enters the Studio scene as the
// stand-in the install makes (install.js addStandIn), and the boxes and the floor of that compile become the ones an edit
// is measured against (motion-fit.mjs), so the agent can give the stand-ins their look while the writer rewrites. The
// writer is told nothing of it. At the install (plan), a stand-in is untouched when its Studio record is still the one
// the draft read after making it: an untouched one is set to the final prop's place, turn and size (a new stand-in when
// the final box needs another kind of object), one changed meanwhile to the final place and turn only. A draft prop
// the final motion no longer has is removed when untouched and kept otherwise. A motion that fails or is stopped removes
// its untouched stand-ins and says what it removed and what it left (failed). Only geometry, ids and records.
//   draftOf(options)  -> { onCompiled, plan(props, standInOf), failed(error) }
//   travelOf(clip)    the floor region the bodies cross
import { boxesOf, floorCells, rememberBoxes, usedText } from "./motion-fit.mjs";
import { standInLines } from "./motion-props.mjs";

const NOTE = "A draft: the motion writer's first compiled scene. The motion is still being rewritten and is not installed. standIns are the objects added now for the props of this compile that the scene lacked, each the stand-in the install makes; used names the boxes and the floor of this compile, and an edit of one of these objects answers motionFit against its box here. At the install a stand-in is set to the final motion's place and turn, and one not changed since the draft to its size too (replaced by a new stand-in when the final box needs another kind of object); one tilted or attached to a body stays as it is beside a new stand-in; one whose prop the final motion no longer has is removed when not changed and kept otherwise. The result's propsSet says what the install changed since the draft. motion_result answers again once the motion is installed.";
const failure = (code, message) => Object.assign(new Error(message), { code });
const byId = rows => new Map((Array.isArray(rows) ? rows : []).map(row => [row?.id, row]));
const finite = v => (Number.isFinite(v) ? v : 0);
// a Studio record with its keys in one order; its flat tops are measured, not held
const recordOf = row => (row ? JSON.stringify(Object.keys(row).filter(k => k !== "tops").sort().map(k => [k, row[k]])) : null);
const named = ids => ids.join(", ");

/** The floor region every joint of every body crosses during the clip: { x: [min, max], z: [min, max] } (metres), or null. */
export function travelOf(clip) {
	const x = [Infinity, -Infinity], z = [Infinity, -Infinity];
	for (const figure of clip.characters ?? []) for (let k = 0; k + 2 < (figure.pos?.length ?? 0); k += 3) {
		x[0] = Math.min(x[0], figure.pos[k]); x[1] = Math.max(x[1], figure.pos[k]); z[0] = Math.min(z[0], figure.pos[k + 2]); z[1] = Math.max(z[1], figure.pos[k + 2]);
	}
	const r = v => Math.round(v * 100) / 100;
	return Number.isFinite(x[0]) ? { x: x.map(r), z: z.map(r) } : null;
}

/**
 * draftOf({ hold, onDraft, key, known, run, describe, readClip, addStandIn, standInOf }). hold(steps): runs editor steps
 * holding the scene under their own mark, undone when one throws (motion-door.mjs), or null: no draft is made (a call
 * that waits, the direct key). onDraft(answer): once, with the draft's answer. key: the conversation the boxes are kept
 * under; known: studioScene ids.props (the props of the scene the writer read); boxed(placed): placed without the props that
 * are no boxes (motion-run.mjs: the objects with no box of their own); run(action, args): an editor step (null
 * when refused); describe(): the Studio's describe answer.
 * onCompiled({ n, scene, clip }): the writer's harness after each compile that went through (pi/harness.mjs).
 * plan(props): inside the install, the clip's props -> null (no draft) or { drafted: { <prop>: { id, untouched, size } }
 * (install.js drafted), remove: [{ prop, id, replaced? }] (untouched stand-ins to remove after the install), kept:
 * [{ prop, id }], lost: { <prop>: { id, why } } (a draft stand-in that cannot carry the final prop), replaced:
 * { <prop>: id }, touched: [ids changed meanwhile], at: Map(id -> describe row before the install) }.
 * failed(error): a motion that ends without an install: removes the untouched stand-ins and adds to the error's message
 * what it removed and what it left; -> the error.
 */
export function draftOf({ hold = null, onDraft = () => {}, key, known = {}, boxed = placed => placed, run, describe, readClip, addStandIn, standInOf }) {
	let job = null; // the draft: Promise of { made: { <prop>: { id, kind, size } }, records: Map(id -> record), undo } or null
	// the scene read before and after each call of the agent (motion-door.mjs), at the install and at a failure: the
	// Studio gives a removed id to the next object of its kind, so an id seen missing is the draft's again only under a
	// record it had as the draft's (a removal undone); under another record it is another object (gone)
	const gone = new Set(), records = new Map(); // id -> the records the draft's stand-in had
	const see = (draft, rows) => {
		for (const { id } of Object.values(draft.made)) {
			const row = rows.get(id), record = recordOf(row), had = records.get(id) ?? records.set(id, new Set([draft.records.get(id)])).get(id);
			if (!row) gone.add(id);
			else if (had.has(record)) gone.delete(id);
			else if (!gone.has(id)) had.add(record);
		}
	};
	const watch = async () => {
		const draft = job && await job;
		if (draft) see(draft, byId((await describe())?.objects));
	};
	const onCompiled = ({ n, scene, clip: file }) => {
		if (!hold || job) return;
		let clip;
		try { clip = readClip(file); } catch { return; } // the next compile that goes through is the draft then
		job = hold(async () => {
			const made = {};
			for (const prop of clip.props ?? []) {
				if (known[prop.id]) continue;
				const id = await addStandIn(prop, run);
				if (!id) throw failure("studio", "The Studio refused a stand-in of the draft.");
				const { kind, size } = standInOf(prop);
				made[prop.id] = { id, kind, size };
			}
			const rows = byId((await describe())?.objects), ids = Object.values(made).map(entry => entry.id);
			const placed = Object.fromEntries([...Object.entries(known).map(([prop, entry]) => [prop, entry.id]), ...Object.entries(made).map(([prop, entry]) => [prop, entry.id])]);
			const undo = rememberBoxes(key, scene, placed, floorCells(clip));
			const answer = { ok: true, draft: true, installed: false, compile: n, standIns: standInLines(made, rows), used: usedText(boxesOf(key), travelOf(clip)), note: NOTE };
			return { made, records: new Map(ids.map(id => [id, recordOf(rows.get(id))])), undo, answer };
		}).then(draft => { try { onDraft(draft.answer, watch); } catch { /* a failing view never fails the run */ } return draft; }, () => null);
	};
	const plan = async props => {
		const draft = job && await job;
		if (!draft) return null;
		const at = byId((await describe())?.objects), final = new Map(props.map(prop => [prop.id, prop]));
		see(draft, at);
		const out = { drafted: {}, remove: [], kept: [], lost: {}, replaced: {}, touched: [], at };
		for (const [prop, entry] of Object.entries(draft.made)) {
			const row = gone.has(entry.id) ? null : at.get(entry.id), untouched = Boolean(row) && recordOf(row) === draft.records.get(entry.id), next = final.get(prop);
			if (row && !untouched) out.touched.push(entry.id);
			if (!next) { if (untouched) out.remove.push({ prop, id: entry.id }); else if (row) out.kept.push({ prop, id: entry.id }); continue; }
			const why = !row ? "gone" : finite(row.rotX) || finite(row.rotZ) ? "tilted" : row.attach ? "attached to a body" : null;
			if (why) out.lost[prop] = { id: entry.id, why };
			else if (untouched && standInOf(next).kind !== entry.kind) { out.replaced[prop] = entry.id; out.remove.push({ prop, id: entry.id, replaced: true }); }
			else out.drafted[prop] = { id: entry.id, untouched, size: entry.size, place: { x: finite(row.x), y: finite(row.y), z: finite(row.z), rot: finite(row.rot) } };
		}
		return out;
	};
	const failed = async error => {
		const draft = job && await job;
		if (!draft) return error;
		draft.undo();
		const all = Object.values(draft.made).map(entry => entry.id);
		let ids = all.filter(id => !gone.has(id)), text;
		try {
			text = await hold(async () => {
				const at = byId((await describe())?.objects);
				see(draft, at);
				ids = all.filter(id => !gone.has(id));
				const here = ids.filter(id => at.has(id)), untouched = here.filter(id => recordOf(at.get(id)) === draft.records.get(id));
				if (untouched.length) await run("object.remove", { ids: untouched });
				const now = byId((await describe())?.objects), removed = untouched.filter(id => !now.has(id)), stays = untouched.filter(id => now.has(id)), changed = here.filter(id => !untouched.includes(id));
				const parts = [removed.length ? `removed ${named(removed)} (not changed since the draft)` : "", stays.length ? `could not remove ${named(stays)}` : "", changed.length ? `left ${named(changed)} (changed meanwhile)` : ""].filter(Boolean);
				return parts.length ? `The draft's stand-ins: ${parts.join("; ")}.` : "";
			});
		} catch (cause) { text = `The draft's stand-ins ${named(ids)} were left as they are (${cause?.message ?? String(cause)}).`; }
		if (text) error.message = `${error.message.replace(/\.?$/, ".")} ${text}`;
		return error;
	};
	return { onCompiled, plan, failed };
}
