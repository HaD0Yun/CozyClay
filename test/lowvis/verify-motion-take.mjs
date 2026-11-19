#!/usr/bin/env node
// The take with no fit gate (bin/agent/motion-props.mjs takenBy, install.js made) on the Studio's own object records:
// an object named in building and made while the motion is written takes the prop of its name at any size; the install
// sets its place and turn, its size and scale stay the agent's, nothing is duplicated, and motionFit of the same answer
// names every measure where it differs from the prop's box (bin/agent/motion-fit.mjs fitOf, whole), on the plain turn
// and on a call that waits. Objects of several box parts, with a measured flat top and without (narrow, or not drawn
// yet), cubes and balls, carried and still, grouped ones and ones with children, made before and meanwhile. Every
// expected line is built here from the scene by this test's own arithmetic and must equal the answer's.
// Also: the writer's request is the same whether or not anything was built yet.
import assert from "node:assert/strict";
import { part, prop, recipe, shapeOf, stage, studioEditor, turn, written } from "./studio-take-harness.mjs";

let seed = 11;
const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648, pick = list => list[Math.floor(rnd() * list.length)];
const num = (a, b) => Math.round((a + rnd() * (b - a)) * 100) / 100;
const r2 = v => Math.round(v * 100) / 100;
const DEG = Math.PI / 180;

/** A recipe the agent might make, at about size [w, h, d]: one of several part layouts. */
function look(kind, [w, h, d]) {
	if (kind === "block") return recipe(part("body", [w, h, d], [0, 0, 0]));
	if (kind === "seat with back") return recipe(part("seat", [w, h, d], [0, 0, 0]), part("back", [w, h * 0.9, 0.05], [0, h, -d / 2 + 0.025]));
	if (kind === "legs and top") return recipe(...[[-1, -1], [1, -1], [-1, 1], [1, 1]].map(([x, z], k) => part(`leg${k}`, [0.04, h - 0.04, 0.04], [x * (w / 2 - 0.02), 0, z * (d / 2 - 0.02)])), part("top", [w, 0.04, d], [0, h - 0.04, 0]));
	if (kind === "post") return recipe(part("post", [0.1, h, 0.1], [0, 0, 0]), part("cap", [0.12, 0.02, 0.12], [0, h, 0]));
	return recipe(part("step1", [w, h / 2, d], [0, 0, 0]), part("step2", [w, h / 2, d / 2], [0, h / 2, -d / 4]));
}

// floor cells under joints lower than 0.15 m (0.1 m squares), and the turned-rectangle test, as this test computes them
function cellsOf(clip) {
	const cells = new Map();
	for (const c of clip.characters) for (let k = 0; k + 2 < c.pos.length; k += 3) if (c.pos[k + 1] < 0.15) { const i = Math.floor(c.pos[k] / 0.1), j = Math.floor(c.pos[k + 2] / 0.1); cells.set(`${i},${j}`, [r2((i + 0.5) * 0.1), r2((j + 0.5) * 0.1)]); }
	return [...cells.values()];
}
const within = ([x, z], [cx, cz], deg, [hw, hd]) => { const a = deg * DEG, dx = x - cx, dz = z - cz; return Math.abs(dx * Math.cos(a) - dz * Math.sin(a)) <= hw && Math.abs(dx * Math.sin(a) + dz * Math.cos(a)) <= hd; };
const ov = (a0, a1, b0, b1) => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));

/** The lines motionFit should give for an object that took the prop: this test's own arithmetic on the scene. */
function expected(p, row, tops, cells) {
	const sphere = p.shape === "sphere", size = sphere ? [p.size[0], p.size[0], p.size[0]] : p.size, box = { size: size.map(r2), base: [p.at[0], p.at[1] - size[1] / 2, p.at[2]].map(r2), turn: p.turn ?? 0 };
	const own = shapeOf(row), out = [];
	const sized = () => ["width (x)", "height", "depth (z)"].flatMap((label, k) => (Math.abs(own.size[k] - box.size[k]) > 0.02 ? [`${label} ${r2(own.size[k])} m, the box's ${box.size[k]} m`] : []));
	if (p.moves) return sized();
	if (Math.hypot(...own.base.map((v, k) => v - box.base[k])) > 0.01) out.push(`base at [${own.base.map(r2).join(", ")}], the box's at [${box.base.join(", ")}]`);
	if (sphere) out.push(...sized());
	if (!sphere && Math.abs(((own.turn - box.turn) % 360 + 540) % 360 - 180) > 0.5) out.push(`turn ${r2(own.turn)}°, the box's ${r2(box.turn)}°`);
	const [w, h, d] = box.size;
	if (!sphere && !tops.length) out.push(`top unmeasured (the Studio measured no flat top on it); the box's top is ${h} m over its base`);
	// a taken object's flat top covers the box's whole footprint, within 0.02 m on each side
	if (!sphere && tops.length && !tops.some(t => Math.abs(t.y - h) <= 0.02 && ov(t.x0, t.x1, -w / 2, w / 2) >= w - 0.02 && ov(t.z0, t.z1, -d / 2, d / 2) >= d - 0.02)) out.push(`no flat top at the box's top (${h} m over its base, within 0.02 m) over its footprint (${w} x ${d} m, within 0.02 m on each side); its flat tops (height over its base: width x depth m): ${tops.map(t => `${r2(t.y)}: ${r2(t.x1 - t.x0)} x ${r2(t.z1 - t.z0)}`).join(", ")}`);
	const on = cells.filter(c => within(c, [own.base[0], own.base[2]], own.turn, [own.size[0] / 2, own.size[2] / 2]) && !within(c, [box.base[0], box.base[2]], box.turn, [w / 2, d / 2]));
	if (on.length) out.push(`footprint ${r2(own.size[0])} x ${r2(own.size[2])} m reaches past the box (${w} x ${d} m) onto floor the feet use (${on.length} cell${on.length === 1 ? "" : "s"} of 0.1 m)`);
	return out;
}

const counts = { scenes: 0, taken: 0, toldLines: 0, unmeasured: 0, noTop: 0, sized: 0, fits: 0, before: 0, grouped: 0, parents: 0, waits: 0 };
for (let s = 0; s < 160; s++) {
	const props = [], plans = [], ids = new Set();
	for (let k = 0; k < 1 + Math.floor(rnd() * 3); k++) {
		const id = pick(["chair", "table", "crate", "post", "ball", "step", "bench"]) + (k ? k : "");
		if (ids.has(id)) continue;
		ids.add(id);
		const sphere = rnd() < 0.2, size = sphere ? [num(0.2, 0.9)] : [num(0.3, 1.4), num(0.3, 1.2), num(0.3, 1.0)], turnDeg = pick([0, 0, 30, -90, num(-170, 170)]);
		props.push(prop(id, sphere ? [size[0], size[0], size[0]] : size, [num(-2.5, 2.5), 0, num(0.8, 3)], { ...(sphere ? { shape: "sphere" } : {}), ...(sphere || !turnDeg ? {} : { turn: turnDeg }) }));
		const when = pick(["meanwhile", "meanwhile", "meanwhile", "before", "none"]), how = pick(["top", "top", "top", "grouped", "parent"]);
		const made = sphere ? null : pick(["block", "seat with back", "legs and top", "post", "steps"]);
		const scale = rnd() < 0.4 ? 1 : num(0.6, 1.5);
		plans.push({ id, when, how: sphere ? "top" : how, made, mine: sphere ? [size[0] * scale] : size.map(v => r2(v * (rnd() < 0.4 ? 1 : num(0.6, 1.5)))), turn: num(-180, 180) });
	}
	const carried = props.find(p => !p.shape && rnd() < 0.3);
	let work;
	try { work = written(stage(props), carried ? { a1: [[0, "idle"], [10, "carry", { prop: carried.id }]] } : { a1: [[0, "idle"]] }); } catch { work = written(stage(props), { a1: [[0, "idle"]] }); }
	const undrawn = new Set(), studio = studioEditor({ undrawn }), madeIds = {};
	const make = async (tools, plan) => {
		const placement = { x: num(4, 6), y: 0, z: num(4, 6), rot: plan.turn };
		const id = plan.made ? (await tools.sculpt({ name: plan.id, placement, recipe: look(plan.made, plan.mine) })).affectedIds[0]
			: (await tools.add({ kind: "sphere", name: plan.id, placement })).affectedIds[0];
		if (!plan.made) await tools.update({ id, patch: { scaleX: plan.mine[0], scaleY: plan.mine[0], scaleZ: plan.mine[0] } });
		if (plan.how === "grouped") { const g = (await tools.add({ kind: "empty", name: `${plan.id} set`, placement })).affectedIds[0]; await tools.group({ parent: g, children: [id] }); }
		if (plan.how === "parent") { const c = (await tools.sculpt({ name: `${plan.id} lamp`, placement: { ...placement, y: plan.mine[1] }, recipe: recipe(part("lamp", [0.1, 0.3, 0.1], [0, 0, 0])) })).affectedIds[0]; await tools.group({ parent: id, children: [c] }); }
		if (rnd() < 0.15) undrawn.add(id);
		madeIds[plan.id] = id;
	};
	const direct = { sculpt: args => studio.run("object.sculpt", args), add: args => studio.run("object.add", args), update: args => studio.run("object.update", args), group: args => studio.run("object.group", args) };
	for (const plan of plans) if (plan.when === "before") await make(direct, plan);
	const before = new Map(studio.rows().map(row => [row.id, shapeOf(row)]));
	const building = plans.map(plan => plan.id);
	const background = rnd() < 0.75, done = await turn({ studio, work, building, background, meanwhile: async tools => { for (const plan of plans) if (plan.when === "meanwhile") await make(tools, plan); } });
	const answer = done.answer, cells = cellsOf(work.clip);
	assert.equal(answer.ok, true);
	// the writer's request: the same whether or not anything was built
	const bare = await turn({ studio: studioEditor(), work, building, background });
	if (!plans.some(plan => plan.when === "before")) assert.equal(bare.requests[0], done.requests[0], "the request does not depend on what was built");
	for (const p of work.scene.props) {
		const plan = plans.find(x => x.id === p.id), id = madeIds[p.id], row = id && studio.row(id), fit = (answer.motionFit?.objects ?? []).find(entry => entry.id === id);
		const takes = plan.when === "meanwhile" && plan.how !== "grouped";
		if (!row) continue;
		if (plan.when === "before") { counts.before++; assert.equal(studio.named(p.id).length, 1, `${p.id}: made before, it is the scene's own object: moved, not duplicated`); continue; }
		if (!takes) { counts.grouped++; assert.deepEqual(shapeOf(row), before.get(id) ?? shapeOf(row)); assert.ok(answer.propsSet.includes(`${row.name} (${id}), made meanwhile: the motion does not use it.`), `${p.id}: the grouped one is told`); continue; }
		counts.taken++;
		if (plan.how === "parent") counts.parents++;
		if (!background) counts.waits++;
		assert.equal(studio.named(p.id).length, 1, `${p.id}: one object, no stand-in beside it`);
		const prop0 = work.clip.props.find(q => q.id === p.id), f0 = { pos: prop0.pos.slice(0, 3), quat: prop0.quat.slice(0, 4) }, h = (p.shape === "sphere" ? p.size[0] : p.size[1]) / 2;
		const yaw = r2(2 * Math.atan2(f0.quat[1], f0.quat[3]) / DEG);
		assert.ok(Math.abs(row.x - f0.pos[0]) < 1e-4 && Math.abs(row.y - (f0.pos[1] - h)) < 1e-4 && Math.abs(row.z - f0.pos[2]) < 1e-4, `${p.id}: at the prop's base: ${JSON.stringify([row.x, row.y, row.z, row.rot, f0, h])}`);
		assert.ok(Math.abs(((row.rot - yaw) % 360 + 540) % 360 - 180) < 0.01, `${p.id}: the prop's turn ${yaw}, has ${row.rot}`);
		assert.deepEqual([row.scaleX, row.scaleY, row.scaleZ], plan.made ? [1, 1, 1] : Array(3).fill(plan.mine[0]), `${p.id}: the scale is the agent's`);
		assert.ok(answer.propsSet.some(line => line.startsWith(`${p.id} (${id}), made meanwhile, took the motion's prop ${p.id}: `)), `${p.id}: the take is told`);
		const want = expected(p, row, studio.topsOf(row), cells);
		assert.deepEqual(fit?.differs ?? [], want, `${p.id} (${plan.made ?? "ball"}, ${p.moves ? "moves" : "still"}): motionFit`);
		counts.toldLines += want.length; if (!want.length) counts.fits++;
		if (want.some(line => line.startsWith("top unmeasured"))) counts.unmeasured++;
		if (want.some(line => line.startsWith("no flat top"))) counts.noTop++;
		if (want.some(line => /^(width|height|depth)/.test(line))) counts.sized++;
	}
	counts.scenes++;
}
assert.ok(counts.taken > 80 && counts.unmeasured > 5 && counts.noTop > 10 && counts.sized > 5 && counts.fits > 2 && counts.before > 5 && counts.grouped > 5 && counts.parents > 5 && counts.waits > 10, JSON.stringify(counts));
console.log(`PASS the take at any size, every difference told: ${JSON.stringify(counts)}`);
