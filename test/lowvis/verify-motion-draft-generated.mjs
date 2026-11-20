#!/usr/bin/env node
// Many generated turns of the draft (bin/agent/motion-draft.mjs) on the real door, runMotion, installClip and the Studio's
// own reducers: boxes, boxes under 0.05 m and balls; later compiles that resize, move, turn, drop and add props; the agent
// leaves a stand-in, shapes it in several parts (with and without a flat top), moves, scales, hides, renames or removes it.
// After the install, checked by this test's own arithmetic on the clip and the records: every final prop is one object at
// its frame-0 base and turn; an untouched stand-in has the final size, a changed one its own; a dropped untouched one is
// gone, a dropped changed one stays as it was; nothing else is added or removed; every propsSet line is the one this
// test builds from the records before and after the install.
import assert from "node:assert/strict";
import { part, prop, recipe, scriptedWriter, shapeOf, stage, studioEditor, turn, written } from "./studio-draft-harness.mjs";

const r2 = v => Math.round(v * 100) / 100;
const list = v => `[${v.map(r2).join(", ")}]`;
const box = v => `${v.map(r2).join(" x ")} m`;
const angle = (a, b) => Math.abs(((a - b) % 360 + 540) % 360 - 180);
let seed = 7;
const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
const pick = items => items[Math.floor(rnd() * items.length)];
const frame0 = p => { const h = p.shape === "sphere" ? p.size[0] : p.size[1]; return { base: [p.pos[0], p.pos[1] - h / 2, p.pos[2]], turn: 2 * Math.atan2(p.quat[1], p.quat[3]) * 180 / Math.PI }; };
const sizeOf = p => (p.shape === "sphere" ? [p.size[0], p.size[0], p.size[0]] : p.size);
const kindOf = p => (p.shape === "sphere" ? "sphere" : p.size[1] < 0.05 ? "cube" : "sculpt");
const placeText = s => `${box(s.size)}, base ${list(s.base)}${r2(s.turn) ? `, turn ${r2(s.turn)}°` : ""}`;
function changes(was, now) {
	const out = [];
	if (Math.hypot(...now.base.map((v, k) => v - was.base[k])) > 0.01) out.push(`base ${list(now.base)} (was ${list(was.base)})`);
	if (angle(now.turn, was.turn) > 0.5) out.push(`turn ${r2(now.turn)}° (was ${r2(was.turn)}°)`);
	if (now.size.some((v, k) => Math.abs(v - was.size[k]) > 0.01)) out.push(`size ${box(now.size)} (was ${box(was.size)})`);
	return out;
}
const randomProp = (id, k) => {
	const kind = pick(["box", "box", "thin", "ball"]), x = (k % 3) * 1.5 - 1.5 + r2(rnd() * 0.4), z = 1 + Math.floor(k / 3) * 1.5 + r2(rnd() * 0.4);
	if (kind === "ball") return prop(id, [r2(0.15 + rnd() * 0.4)], [x, 0, z], { shape: "sphere" });
	return prop(id, [r2(0.2 + rnd()), kind === "thin" ? 0.02 + r2(rnd() * 0.02) : r2(0.1 + rnd()), r2(0.2 + rnd() * 0.6)], [x, 0, z], rnd() < 0.5 ? { turn: Math.round(rnd() * 90) } : {});
};
const vary = p => {
	const roll = rnd();
	if (roll < 0.25) return p;
	if (roll < 0.5) return { ...p, at: [p.at[0] + 0.3, p.at[1], p.at[2] - 0.2], ...(p.shape ? {} : { turn: (p.turn ?? 0) + 15 }) };
	if (roll < 0.75) { const size = p.shape === "sphere" ? [r2(p.size[0] + 0.1)] : [r2(p.size[0] + 0.1), pick([p.size[1], r2(p.size[1] + 0.2), 0.03]), p.size[2]]; return { ...p, size, at: [p.at[0], (p.shape === "sphere" ? size[0] : size[1]) / 2, p.at[2]] }; }
	return null;
};

let turns = 0, lines = 0, untouchedResized = 0, shaped = 0, dropped = 0, added = 0, replaced = 0;
for (let n = 0; n < 150; n++) {
	const studio = studioEditor(), count = 1 + Math.floor(rnd() * 4);
	const props = Array.from({ length: count }, (_, k) => randomProp(`p${k}`, k));
	const finalProps = props.map(vary).filter(Boolean);
	if (rnd() < 0.4) finalProps.push(randomProp("extra", 7));
	const first = written(stage(props), { a1: [[0, "idle"]] }), last = written(stage(finalProps), { a1: [[0, "idle"]] });
	const writer = scriptedWriter(rnd() < 0.3 ? [null, first, last] : [first, last]), t = turn({ studio, writer, key: `gen-${n}` });
	await t.call;
	await writer.step();
	if (writer.requests.length && studio.rows().length === 0) await writer.step();
	const draft = await t.result();
	assert.equal(draft.draft, true, `${n}: draft`);
	const ids = Object.fromEntries(first.clip.props.map(p => [p.id, studio.named(p.id)[0].id]));
	const acts = {};
	for (const p of first.clip.props) {
		const id = ids[p.id], act = pick(["none", "none", "sculpt", "sculptHigh", "move", "scale", "hide", "rename", "remove"]);
		acts[p.id] = act;
		const w = sizeOf(p)[0], d = sizeOf(p)[2], h = sizeOf(p)[1];
		if (act === "sculpt") await t.tools.sculpt({ id, recipe: recipe(part("top", [w, 0.04, d], [0, Math.max(0.05, h) - 0.04, 0]), part("leg", [0.05, Math.max(0.05, h) - 0.04, 0.05], [0, 0, 0])) });
		if (act === "sculptHigh") await t.tools.sculpt({ id, recipe: recipe(part("body", [w * 0.6, Math.max(0.05, h), d * 0.6], [0, 0, 0]), part("mast", [0.04, 0.6, 0.04], [0, Math.max(0.05, h), 0])) });
		if (act === "move") await t.tools.update({ id, patch: { x: 4, z: 4 } });
		if (act === "scale") await t.tools.update({ id, patch: { scaleX: 1.5 } });
		if (act === "hide") await t.tools.update({ id, patch: { hidden: true } });
		if (act === "rename") await t.tools.update({ id, patch: { name: `${p.id} look` } });
		if (act === "remove") await t.tools.remove({ ids: [id] });
	}
	const at = new Map(studio.rows().map(row => [row.id, structuredClone(row)]));
	await writer.step(); await writer.step();
	const done = await t.result();
	const now = new Map(studio.rows().map(row => [row.id, row]));
	const finals = new Map(last.clip.props.map(p => [p.id, p])), want = [], wantRows = new Set();
	for (const p of last.clip.props) {
		const draftId = ids[p.id], act = acts[p.id], f0 = frame0(p);
		const drafted = draftId && act !== "remove" && !(act === "none" && kindOf(first.clip.props.find(q => q.id === p.id)) !== kindOf(p));
		// a new stand-in: the object of that name that is not a draft stand-in still in the scene (a removed one's id is given again)
		const live = new Set(Object.entries(ids).filter(([pid]) => acts[pid] !== "remove").map(([, id]) => id));
		const row = drafted ? now.get(draftId) : [...now.values()].find(r => r.name === p.id && !live.has(r.id));
		assert.ok(row, `${n}: ${p.id} has an object`);
		wantRows.add(row.id);
		const s = shapeOf(row);
		assert.ok(Math.hypot(...s.base.map((v, k) => v - f0.base[k])) < 1e-4, `${n}: ${p.id} at the final base`);
		if (p.shape !== "sphere") assert.ok(angle(s.turn, f0.turn) < 0.01, `${n}: ${p.id} at the final turn`);
		if (!drafted || act === "none") assert.ok(s.size.every((v, k) => Math.abs(v - sizeOf(p)[k]) < 1e-6), `${n}: ${p.id} has the final size`);
		else { assert.ok(s.size.every((v, k) => Math.abs(v - shapeOf(at.get(draftId)).size[k]) < 1e-9), `${n}: ${p.id} keeps the agent's size`); assert.deepEqual(row.recipe, at.get(draftId).recipe); shaped++; }
		if (drafted) {
			const differs = changes(shapeOf(at.get(draftId)), s);
			if (act === "none" && differs.some(text => text.startsWith("size"))) untouchedResized++;
			if (differs.length) want.push(`${row.name} (${row.id}), the draft's stand-in of ${p.id}${act === "none" ? "" : ", changed meanwhile and keeping its look"}: ${differs.join(", ")}.`);
		} else {
			const why = !draftId ? "the draft did not have it" : act === "remove" ? `the draft's stand-in ${draftId} is no longer in the scene` : `it replaces the draft's stand-in ${draftId}, removed: the final box needs another kind of object`;
			if (draftId && act === "none") replaced++;
			if (!draftId) added++;
			want.push(`${p.id} (${row.id}): the motion added it as a stand-in, ${placeText(s)}; ${why}.`);
		}
	}
	for (const p of first.clip.props) {
		if (finals.has(p.id)) continue;
		dropped++;
		if (acts[p.id] === "none") { assert.equal(now.has(ids[p.id]), false, `${n}: a dropped untouched stand-in is removed`); want.push(`${p.id} (${ids[p.id]}): the final motion does not have this prop; the draft's stand-in was removed.`); }
		else if (acts[p.id] !== "remove") { assert.deepEqual(now.get(ids[p.id]), at.get(ids[p.id]), `${n}: a dropped changed stand-in stays as it was`); wantRows.add(ids[p.id]); want.push(`${now.get(ids[p.id]).name} (${ids[p.id]}): the final motion does not have the draft's prop ${p.id}; it stays as it was changed meanwhile, and the motion does not use it.`); }
	}
	assert.deepEqual([...now.keys()].sort(), [...wantRows].sort(), `${n}: no other object added or left`);
	assert.deepEqual([...(done.propsSet ?? [])].sort(), want.sort(), `${n}: propsSet`);
	lines += want.length; turns++;
}
console.log(`PASS draft, generated: ${turns} turns, ${lines} propsSet lines equal to this test's arithmetic; ${shaped} changed stand-ins kept their look at the final place, ${untouchedResized} untouched ones took a new size, ${replaced} replaced by another kind, ${dropped} dropped, ${added} added`);
