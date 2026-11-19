#!/usr/bin/env node
// Objects made while the motion is written take the motion's props (bin/agent/motion-props.mjs, install.js made):
//  1. a scripted turn on the real door, runMotion, studioScene and installClip, with a fake motion writer and an
//     in-memory editor: the agent makes and re-shapes an object the motion uses between motion and motion_result, it is
//     not refused, and after the install it has the prop's place and turn and keeps its own size; propsSet says so with
//     the scene's numbers; one of another size is taken too, and motionFit names the difference;
//  2. the motion writer reads the same request whether or not objects were made meanwhile;
//  3. many generated scenes: every prop taken by the one object made meanwhile of its name ends at the prop's base and
//     turn with its own size, nothing else is taken, and every number of every propsSet line is the scene's own.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createMotionDoor } from "../../bin/agent/motion-door.mjs";
import { runMotion } from "../../bin/agent/motion-run.mjs";
import { idOf, propsSetOf, takenBy } from "../../bin/agent/motion-props.mjs";
import { installClip } from "../../src/lowvis/studio/install.js";
import { studioScene } from "../../src/lowvis/studio/scene.js";

const SIT = JSON.parse(readFileSync(new URL("../../public/lowvis/clips/simple/sit.json", import.meta.url), "utf8"));
const DEG = Math.PI / 180, yawQ = deg => [0, Math.sin(deg * DEG / 2), 0, Math.cos(deg * DEG / 2)];
const prop = (id, size, at, turn = 0, extra = {}) => ({ id, size, pos: [at[0], at[1] + (extra.shape === "sphere" ? size[0] : size[1]) / 2, at[2]], quat: yawQ(turn), ...extra });

/** An in-memory editor: describe rows as the Studio gives them, and the actions the install and the agent use. */
function editor(objects = [], characters = []) {
	const rows = new Map(objects.map(row => [row.id, { scaleX: 1, scaleY: 1, scaleZ: 1, rot: 0, ...row }])), cast = new Map(characters.map(row => [row.id, row]));
	let n = 0;
	const bounds = recipe => { let w = 0, d = 0, h = 0; for (const p of recipe.parts) { w = Math.max(w, 2 * (Math.abs(p.position[0]) + p.size[0] / 2)); d = Math.max(d, 2 * (Math.abs(p.position[2]) + p.size[2] / 2)); h = Math.max(h, p.position[1] + p.size[1] / 2); } return { footprint: { width: w, depth: d }, height: h }; };
	const run = async (action, args) => {
		if (action === "object.sculpt" && args.id) { Object.assign(rows.get(args.id), bounds(args.recipe)); return { ok: true, affectedIds: [args.id] }; }
		if (action === "object.sculpt" || action === "object.add") {
			const id = `${action === "object.add" ? args.kind : "sculpt"}-${++n}`, size = action === "object.add" ? { footprint: { width: 1, depth: 1 }, height: 1 } : bounds(args.recipe);
			rows.set(id, { id, name: args.name, renderer: action === "object.add" ? args.kind : "sculpt", ...args.placement, rot: args.placement?.rot ?? 0, scaleX: 1, scaleY: 1, scaleZ: 1, ...size, parent: args.parent ?? null });
			return { ok: true, affectedIds: [id] };
		}
		if (action === "object.update") { Object.assign(rows.get(args.id), args.patch); return { ok: true, affectedIds: [args.id] }; }
		if (action === "character.add") { cast.set(args.character.id, { ...args.character }); return { ok: true, affectedIds: [args.character.id] }; }
		return { ok: true, affectedIds: [args.characterId] };
	};
	// a sculpt's flat top in its own frame: the top of its one centred box
	const tops = row => (row.renderer === "sculpt" ? { tops: [{ y: row.height, x0: -row.footprint.width / 2, x1: row.footprint.width / 2, z0: -row.footprint.depth / 2, z1: row.footprint.depth / 2 }] } : {});
	const describe = () => ({ characters: [...cast.values()].map(row => ({ ...row })), objects: [...rows.values()].map(row => ({ ...row, footprint: { ...row.footprint }, ...tops(row) })) });
	return { run, describe, rows };
}
const shape = row => ({ base: [row.x, row.y, row.z], size: [row.footprint.width * row.scaleX, row.height * row.scaleY, row.footprint.depth * row.scaleZ], turn: row.rot });
const close = (a, b, eps, what) => assert.ok(a.every((v, k) => Math.abs(v - b[k]) <= eps), `${what}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
const boxRecipe = size => ({ version: 1, parts: [{ id: "seat", shape: "box", size, position: [0, size[1] / 2, 0] }] });

/** One turn: motion { request, building }, then the agent's calls while the writer works, then motion_result. */
async function turn({ clip, build = async () => {}, building = [], objects = [] }) {
	const studio = editor(objects, [{ id: "a1", model: "x-bot-tpose", x: 0, z: 0, rot: 0, scale: 1 }]), requests = [];
	let release;
	const gate = new Promise(resolve => { release = resolve; });
	const runScene = async ({ request }) => { requests.push(request); await gate; return { wallMs: 1000, compiles: 1, report: "She sits.\nMissing: nothing.", missing: "nothing.", final: { clip: "clip.json", scene: { characters: [{ id: "a", at: [0, 0], heading: 0 }], props: clip.props.map(p => ({ id: p.id, size: p.size, at: p.pos.slice(0, 3), turn: Math.round(2 * Math.atan2(p.quat[1], p.quat[3]) / DEG * 100) / 100, ...(p.shape ? { shape: p.shape } : {}) })) }, spec: { a: [[0, "sit", { on: clip.props[0].id }]] } } }; };
	const deps = { runScene, installClip, studioScene, readClip: () => clip };
	const hub = { command: async () => studio.describe() };
	const tx = { mark: async () => ({}), rollback: async () => ({ receiptId: "r" }) };
	const door = createMotionDoor({ run: options => runMotion({ ...options, words: "she sits", note: options.request, memoryKey: null, hub, workspaceHandle: "ws", invoke: studio.run, env: {}, deps }), ...tx, background: true });
	const sculpt = { name: "sculpt", handler: async args => studio.run("object.sculpt", args) };
	const [agentSculpt, , resultTool] = door.with([sculpt]);
	assert.deepEqual(await door.handler({ request: "a1 sits on the chair", building }), { ok: true, started: true });
	const made = await build(agentSculpt, studio);
	release();
	return { answer: await resultTool.handler(), studio, requests, made };
}

// 1 and 2: a chair made and re-shaped meanwhile takes the motion's chair; the mat nobody made is a stand-in
{
	const clip = { ...SIT, props: [prop("chair", [0.5, 0.46, 0.42], [1, 0, 2], 30), prop("mat", [0.9, 0.1, 2], [2, 0, 1.6])] };
	const build = async (agentSculpt, studio) => {
		const first = await agentSculpt.handler({ name: "chair", placement: { x: 5, y: 0, z: 5, rot: 0 }, recipe: boxRecipe([0.6, 1.0, 0.55]) });
		assert.equal(first.ok, true, "making the chair meanwhile is not refused");
		const id = first.affectedIds[0];
		assert.equal((await agentSculpt.handler({ id, recipe: boxRecipe([0.62, 0.46, 0.5]) })).ok, true, "re-shaping it meanwhile is not refused");
		assert.equal((await agentSculpt.handler({ name: "lamp post", placement: { x: -3, y: 0, z: -3, rot: 0 }, recipe: boxRecipe([0.2, 2.5, 0.2]) })).ok, true);
		return { id, was: shape(studio.rows.get(id)) };
	};
	const built = await turn({ clip, build, building: ["chair", "lamp post"] });
	const row = built.studio.rows.get(built.made.id), now = shape(row);
	close(now.size, [0.62, 0.46, 0.5], 1e-3, "the chair keeps its own size");
	close(now.base, [1, 0, 2], 1e-6, "the chair stands at the prop's base");
	assert.ok(Math.abs(now.turn - 30) < 0.01, `the chair has the prop's turn (${now.turn})`);
	const names = [...built.studio.rows.values()].map(r => r.name);
	assert.deepEqual(names.filter(name => /chair/i.test(name)), ["chair"], "no second chair: the install made no stand-in for it");
	assert.ok(names.includes("mat"), "the mat nobody made is a stand-in");
	const set = built.answer.propsSet, r2 = v => Math.round(v * 100) / 100, list = v => `[${v.map(r2).join(", ")}]`, box = v => `${v.map(r2).join(" x ")} m`;
	assert.equal(set[0], `chair (${built.made.id}), made meanwhile, took the motion's prop chair: base ${list(now.base)} (was ${list(built.made.was.base)}), turn 30° (was 0°).`);
	const mat = [...built.studio.rows.values()].find(r => r.name === "mat");
	assert.equal(set[1], `mat (${mat.id}): the motion added it as a stand-in, ${box(shape(mat).size)}, base ${list(shape(mat).base)}; no object made meanwhile took it.`);
	assert.match(set[2], /^lamp post \(sculpt-\d+\), made meanwhile: the motion does not use it\.$/);
	assert.ok(built.answer.objects.includes(built.made.id), "objects names the chair it placed");
	assert.match(built.requests[0], /While you write, the Studio agent builds these objects, each with its own look: chair, lamp_post\. When your scene needs one of them, use its name as that prop's id:/);
	const bare = await turn({ clip, building: ["chair", "lamp post"] });
	assert.equal(bare.requests[0], built.requests[0], "the writer reads the same request whether or not objects were made meanwhile");
	assert.match(bare.answer.propsSet[0], /^chair \(sculpt-\d+\): the motion added it as a stand-in, 0\.5 x 0\.46 x 0\.42 m, base \[1, 0, 2\], turn 30°; no object made meanwhile took it\.$/);
	// a chair whose top is not at the prop's top is taken too: it keeps its size, and motionFit names the top
	const tall = await turn({ clip, building: ["chair"], build: async agentSculpt => (await agentSculpt.handler({ name: "chair", placement: { x: 5, y: 0, z: 5, rot: 0 }, recipe: boxRecipe([0.5, 0.9, 0.42]) })).affectedIds[0] });
	close(shape(tall.studio.rows.get(tall.made)).base, [1, 0, 2], 1e-9, "the taller chair stands at the prop's base");
	close(shape(tall.studio.rows.get(tall.made)).size, [0.5, 0.9, 0.42], 1e-9, "and keeps its size");
	assert.match(tall.answer.propsSet[0], /^chair \(sculpt-\d+\), made meanwhile, took the motion's prop chair: /);
	assert.deepEqual(tall.answer.motionFit.objects, [{ id: tall.made, name: "chair", differs: ["no flat top at the box's top (0.46 m over its base, within 0.02 m) over its footprint (0.5 x 0.42 m, within 0.02 m on each side); its flat tops (height over its base: width x depth m): 0.9: 0.5 x 0.42"] }]);
	// an object of the prop's name that building does not name is not taken
	const unnamed = await turn({ clip, building: ["lamp"], build: async agentSculpt => (await agentSculpt.handler({ name: "chair", placement: { x: 5, y: 0, z: 5, rot: 0 }, recipe: boxRecipe([0.5, 0.46, 0.42]) })).affectedIds[0] });
	close(shape(unnamed.studio.rows.get(unnamed.made)).base, [5, 0, 5], 1e-9, "the chair building does not name stays where it was made");
	const none = await turn({ clip });
	assert.doesNotMatch(none.requests[0], /While you write/, "no building: no line for the writer");
	console.log(`PASS a scripted turn: the chair made meanwhile ends at ${box(now.size)}, base ${list(now.base)}, turn ${r2(now.turn)}°; the same request either way`);
}

// 3. generated scenes: what is taken, where it ends, and every number of propsSet read back from the scene
{
	let seed = 7;
	const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648, pick = list => list[Math.floor(rnd() * list.length)], num = (a, b) => Math.round((a + rnd() * (b - a)) * 1000) / 1000;
	const counts = { scenes: 0, props: 0, taken: 0, twins: 0, standIns: 0, lines: 0, numbers: 0 };
	const sizeOf = p => (p.shape === "sphere" ? Array(3).fill(p.size[0]) : p.size);
	for (let s = 0; s < 400; s++) {
		const F = pick([1, 2, 30]), props = [], objects = [], known = {};
		for (let k = 0; k < 1 + Math.floor(rnd() * 4); k++) {
			const sphere = rnd() < 0.2, size = sphere ? Array(3).fill(num(0.05, 1.5)) : [num(0.03, 3), pick([0.01, 0.04, num(0.05, 2.5)]), num(0.03, 3)];
			const id = pick(["chair", "Box", "table_2", "ramp", "bed", "crate"]) + (rnd() < 0.5 ? "" : k), turn = pick([0, 0, 45, -90, num(-180, 180)]);
			if (props.some(p => p.id === id)) continue;
			const p = prop(id, size, [num(-4, 4), pick([0, 0, num(0, 1)]), num(-4, 4)], turn, sphere ? { shape: "sphere" } : {});
			const tilt = rnd() < 0.15 ? [Math.sin(0.2), 0, 0, Math.cos(0.2)] : null;
			p.pos = Array.from({ length: F }, (_, f) => [p.pos[0] + (rnd() < 0.3 ? f * 0.01 : 0), p.pos[1], p.pos[2]]).flat();
			p.quat = Array.from({ length: F }, () => tilt ?? p.quat).flat();
			props.push(p);
			if (rnd() < 0.25) { known[id] = { id: `K-${id}`, x: 0, y: 0, z: 0, rot: 0 }; objects.push({ id: `K-${id}`, name: id, renderer: "cube", x: 0, y: 0, z: 0, rot: 0, footprint: { width: 1, depth: 1 }, height: 1 }); }
		}
		const before = new Set(objects.map(o => o.id)), studio = editor(objects);
		for (const p of props) {
			const copies = rnd() < 0.15 ? 2 : rnd() < 0.6 ? 1 : 0;
			for (let c = 0; c < copies; c++) {
				const name = pick([p.id, p.id.toUpperCase(), ` ${p.id} `, `${p.id}-x`]), kind = pick(["sculpt", "sculpt", "sculpt", "hidden", "tilted", "group part"]);
				const made = await studio.run("object.sculpt", { name, placement: { x: num(-5, 5), y: 0, z: num(-5, 5), rot: num(-180, 180) }, recipe: boxRecipe(rnd() < 0.7 ? sizeOf(p) : [num(0.1, 2), num(0.1, 2), num(0.1, 2)]), ...(kind === "group part" ? { parent: "g" } : {}) });
				if (kind === "hidden") studio.rows.get(made.affectedIds[0]).hidden = true;
				if (kind === "tilted") studio.rows.get(made.affectedIds[0]).rotX = 10;
			}
		}
		const clip = { frameCount: F, characters: [], props };
		const at = new Map(studio.describe().objects.map(o => [o.id, o])), take = takenBy({ props, known, before, rows: [...at.values()], building: props.map(p => p.id) });
		const done = await installClip(clip, studio.run, { existing: { characters: {}, props: known }, turn: true, made: take.made });
		const now = new Map(studio.describe().objects.map(o => [o.id, o]));
		for (const p of props) {
			counts.props++;
			const id = done.placed[p.id], wanted = p.shape === "sphere" ? Array(3).fill(p.size[0]) : p.size;
			const fresh = [...at.values()].filter(o => !before.has(o.id) && !o.hidden && !o.rotX && !o.parent && idOf(o.name) === p.id);
			if (known[p.id]) { assert.equal(id, known[p.id].id); continue; }
			if (fresh.length === 1) {
				counts.taken++;
				assert.equal(id, fresh[0].id, `${p.id}: the one object of its name takes it`);
				close(shape(now.get(id)).size, shape(at.get(id)).size, 1e-9, `${p.id}: keeps its own size`);
				const base = [p.pos[0], p.pos[1] - wanted[1] / 2, p.pos[2]];
				if (Math.abs(p.quat[0]) < 1e-4) close(shape(now.get(id)).base, base, 1e-6, `${p.id}: base`);
			} else {
				counts.standIns++;
				if (fresh.length > 1) counts.twins++;
				assert.ok(done.objectIds.includes(id) && !before.has(id) && !fresh.some(o => o.id === id), `${p.id}: a stand-in`);
				for (const o of fresh) assert.deepEqual(shape(now.get(o.id)), shape(at.get(o.id)), `${p.id}: an object of a twin name is left as it was`);
			}
		}
		const lines = propsSetOf({ props, placed: done.placed, done, take, start: new Map(objects.map(o => [o.id, o])), at, now }) ?? [];
		for (const line of lines) {
			counts.lines++;
			const id = /\(([^)]+)\)/.exec(line)[1], row = now.get(id);
			assert.ok(row, `the line names an object of the scene: ${line}`);
			const own = shape(row), r2 = v => Math.round(v * 100) / 100 + 0;
			const sizeNow = /(?:size |stand-in, )([\d.]+) x ([\d.]+) x ([\d.]+) m/.exec(line), baseNow = /base \[([-\d., ]+)\]/.exec(line), was = /\(was ([\d.]+) x ([\d.]+) x ([\d.]+) m\)/.exec(line);
			if (sizeNow) { assert.deepEqual(sizeNow.slice(1).map(Number), own.size.map(r2), line); counts.numbers += 3; }
			if (baseNow) { assert.deepEqual(baseNow[1].split(", ").map(Number), own.base.map(r2), line); counts.numbers += 3; }
			if (was) { assert.deepEqual(was.slice(1).map(Number), shape(at.get(id)).size.map(r2), line); counts.numbers += 3; }
			const turnNow = /turn ([-\d.]+)°/.exec(line);
			if (turnNow) { assert.equal(Number(turnNow[1]), r2(own.turn), line); counts.numbers++; }
		}
		counts.scenes++;
	}
	assert.ok(counts.taken > 100 && counts.twins > 2 && counts.standIns > 100, JSON.stringify(counts));
	console.log(`PASS generated scenes: ${JSON.stringify(counts)}`);
}
