// A Studio turn for the draft tests (verify-motion-draft*.mjs): the real motion door, runMotion, studioScene, installClip
// and turnFitView, an editor made of the Studio's own object reducers (src/scene-objects.js, src/commands/object-sculpt.js),
// flat tops measured by the Studio's own tops.js over the box meshes a record draws, and a scripted motion writer whose
// compiles the real engine builds and which the test steps one at a time. No one-box shortcut: a record's size is what
// the Studio computes from its parts.
import * as THREE from "three";
import { createMotionDoor } from "../../bin/agent/motion-door.mjs";
import { turnFitView } from "../../bin/agent/motion-fit.mjs";
import { runMotion } from "../../bin/agent/motion-run.mjs";
import { sculptMethod } from "../../src/commands/object-sculpt.js";
import { buildClip } from "../../src/lowvis/engine-simple/engine.js";
import { serializeClip } from "../../src/lowvis/clip.js";
import { addStandIn, installClip, standInOf } from "../../src/lowvis/studio/install.js";
import { studioScene } from "../../src/lowvis/studio/scene.js";
import { objectTops } from "../../src/lowvis/studio/tops.js";
import * as O from "../../src/scene-objects.js";

const coded = (code, message) => Object.assign(new Error(message), { code });
const changedIds = (before, after) => [...new Set([...before, ...after].map(row => row.id))].filter(id => JSON.stringify(before.find(row => row.id === id)) !== JSON.stringify(after.find(row => row.id === id)));
export const tick = () => new Promise(resolve => setTimeout(resolve, 2));

/** The box meshes of one record as the stage draws them (box parts without rotation, and cubes), or null. */
function groupOf(row) {
	const group = new THREE.Group();
	const add = (size, at) => { const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size), new THREE.MeshBasicMaterial()); mesh.position.set(...at); group.add(mesh); };
	if (row.renderer === "sculpt") {
		for (const part of row.recipe?.parts ?? []) {
			if (part.shape !== "box" || part.op || part.mirror || part.repeat || part.parent || (part.rotation ?? []).some(v => v)) return null;
			add(part.size, part.position);
		}
	} else if (row.renderer === "cube") add([row.footprint.width, row.height, row.footprint.depth], [0, row.height / 2, 0]);
	else return null;
	group.position.set(row.x, row.y, row.z);
	group.rotation.set((row.rotX ?? 0) * Math.PI / 180, row.rot * Math.PI / 180, (row.rotZ ?? 0) * Math.PI / 180);
	group.scale.set(row.scaleX, row.scaleY, row.scaleZ);
	return group;
}

/**
 * An editor of the Studio's own reducers: run(action, args) (a refusal throws), describe(args), mark / rollback;
 * refuse(action, args) -> true makes the editor refuse that step (a Studio refusal).
 */
export function studioEditor({ refuse = () => false, slow = () => 0 } = {}) {
	let rows = [], cast = new Map([["a1", { id: "a1", model: "x-bot-tpose", x: 0, z: 0, rot: 0, scale: 1 }]]), marked = null;
	const calls = [];
	const objectOf = id => rows.find(row => row.id === id) ?? (() => { throw coded("STALE_TARGET", `Object ${id} is not in this scene.`); })();
	const sculpt = sculptMethod({ owned: () => ({ read: () => rows, write: next => { rows = next; } }), objectOf, changed: before => changedIds(before, rows) });
	const run = async (action, args = {}) => {
		calls.push({ action, args });
		if (slow(action)) await new Promise(resolve => setTimeout(resolve, slow(action)));
		if (refuse(action, args)) throw coded("INVALID_ARGUMENT", `refused ${action}`);
		const before = rows;
		if (action === "object.sculpt") return { ok: true, ...sculpt(args) };
		if (action === "object.add") {
			const object = O.createSceneObject(args.kind, before, args.placement);
			const placed = O.updateSceneObject([object], object.id, { ...(args.placement ?? {}), ...(args.name === undefined ? {} : { name: args.name }) })[0];
			rows = args.parent === undefined ? [...before, placed] : O.setSceneObjectParent([...before, placed], placed.id, args.parent);
			return { ok: true, affectedIds: [placed.id] };
		}
		if (action === "object.update") { objectOf(args.id); rows = O.updateSceneObject(before, args.id, args.patch); return { ok: true, affectedIds: changedIds(before, rows) }; }
		if (action === "object.remove") { for (const id of args.ids) objectOf(id); rows = args.ids.reduce((list, id) => O.removeSceneObject(list, id), before); return { ok: true, affectedIds: changedIds(before, rows) }; }
		if (action === "object.group") { rows = args.children.reduce((list, id) => O.setSceneObjectParent(list, id, args.parent), before); return { ok: true, affectedIds: changedIds(before, rows) }; }
		if (action === "character.add") { cast.set(args.character.id, { ...args.character }); return { ok: true, affectedIds: [args.character.id] }; }
		if (action === "character.update") { Object.assign(cast.get(args.characterId) ?? {}, args.patch); return { ok: true, affectedIds: [args.characterId] }; }
		if (action === "character.clearWaypoints" || action === "motion.v4.install") return { ok: true, affectedIds: [args.characterId] };
		throw coded("INVALID_ARGUMENT", `no action ${action}`);
	};
	const topsOf = row => (row.hidden ? [] : objectTops(groupOf(row)));
	const describe = (args = {}) => ({ characters: [...cast.values()].map(row => ({ ...row })), objects: rows.map(row => ({ ...structuredClone(row), ...(args.tops === true && !row.hidden ? { tops: topsOf(row) } : {}) })) });
	return {
		run, describe, calls, topsOf, rows: () => rows, row: id => rows.find(row => row.id === id), named: name => rows.filter(row => row.name === name),
		hub: { command: async (name, args) => describe(args) },
		// another caller's edit (the user, a task): past the turn's tools
		outside: fn => { rows = fn(rows); },
		mark: async () => { marked = { rows, cast: new Map([...cast].map(([id, row]) => [id, { ...row }])) }; return {}; },
		rollback: async () => { if (!marked) return null; rows = marked.rows; cast = new Map([...marked.cast].map(([id, row]) => [id, { ...row }])); return { receiptId: "t" }; },
	};
}

function withMovers(scene, spec) {
	const moved = new Set();
	for (const [key, acts] of Object.entries(spec)) {
		if (!Array.isArray(acts)) continue;
		if (scene.props?.some(p => p.id === key) && acts.length) moved.add(key);
		for (const a of acts) if (["carry", "hold", "release", "place"].includes(a[1]) && typeof a[2]?.prop === "string") moved.add(a[2].prop);
	}
	return { ...scene, props: (scene.props ?? []).map(p => (moved.has(p.id) ? { ...p, moves: true } : p)) };
}
/** One compile of the writer: { scene (as the compile tool keeps it), spec, clip (the engine's, as JSON) }. */
export function written(scene, spec) {
	const def = withMovers(structuredClone(scene), spec), built = buildClip(structuredClone({ demo: "x", ...spec }), structuredClone(def));
	return { scene: def, spec, clip: JSON.parse(serializeClip(built.clip)) };
}

/** A box part [w, h, d] with its underside centre at [x, y, z]; a recipe of parts. */
export const part = (id, size, at) => ({ id, shape: "box", size, position: [at[0], at[1] + size[1] / 2, at[2]], roundness: 0 });
export const recipe = (...parts) => ({ version: 1, parts });
/** A prop of the writer's scene by its size and base. */
export const prop = (id, size, base, extra = {}) => ({ id, size, at: [base[0], base[1] + (extra.shape === "sphere" ? size[0] : size[1]) / 2, base[2]], ...extra });
export const stage = (props, frames = 60) => ({ frames, characters: [{ id: "a1", at: [0, 0], heading: 0 }], props });

/**
 * A scripted motion writer: compiles [written(...) | null (a compile that fails)], stepped by the test: step() runs the
 * next compile (or ends the run once all ran). end: "report" (the model's report), "infra" (the proxy fails), "none"
 * (no scene, no report). The scenes it read: requests.
 */
export function scriptedWriter(compiles, { end = "report" } = {}) {
	const requests = [], files = new Map();
	let gate = null, started = null;
	const ready = new Promise(resolve => { started = resolve; });
	const wait = () => new Promise(resolve => { gate = resolve; });
	const runScene = async ({ request, log, onCompiled, signal }) => {
		requests.push(request);
		started();
		let last = null, n = 0;
		for (const work of compiles) {
			await Promise.race([wait(), new Promise(resolve => signal?.addEventListener("abort", resolve, { once: true }))]);
			if (signal?.aborted) break;
			n++;
			if (!work) { log?.(`  motion ${n}: rejected (bad spec)`); continue; }
			files.set(`clip-${n}.json`, work.clip);
			log?.(`  motion ${n}: ok, build 1 ms, render 1 ms, 1 image(s)`);
			last = { n, work };
			onCompiled?.({ n, scene: work.scene, clip: `clip-${n}.json` });
		}
		if (!signal?.aborted) await Promise.race([wait(), new Promise(resolve => signal?.addEventListener("abort", resolve, { once: true }))]);
		const final = last ? { clip: `clip-${last.n}.json`, scene: last.work.scene, spec: last.work.spec } : null;
		return { wallMs: 1000, compiles: n, report: end === "report" ? "Made.\nMissing: nothing." : null, missing: end === "report" ? "nothing." : null, final, ...(end === "infra" ? { infraError: { message: "the proxy failed" } } : {}), endedBy: end };
	};
	return { requests, runScene, readClip: file => structuredClone(files.get(file)), started: () => ready, release: () => { const go = gate; gate = null; go?.(); }, step: async () => { while (!gate) await tick(); const go = gate; gate = null; go(); for (let k = 0; k < 6; k++) await tick(); } };
}

const ACTIONS = ["object.sculpt", "object.add", "object.update", "object.group", "object.remove"];
/**
 * One turn on the real door: background true (a plain turn: the agent's tools go through turnFitView and the door's
 * guard, as agent-routes.mjs wraps them) or false (a task's run: the call waits; tools are another caller's). -> { call,
 * tools: { sculpt, add, update, group, remove }, result() (motion_result), door }.
 */
export function turn({ studio, writer, key = "conv", background = true, request = "the agent's note" }) {
	const deps = { runScene: writer.runScene, installClip, addStandIn, standInOf, studioScene, readClip: writer.readClip };
	const door = createMotionDoor({ run: options => runMotion({ ...options, words: "the user's words", note: options.request, memoryKey: key, hub: studio.hub, workspaceHandle: "ws", invoke: studio.run, env: {}, deps }), mark: studio.mark, rollback: studio.rollback, background });
	const fitted = turnFitView({ value: { sessionId: key, context: { host: { workspaceHandle: "ws" } } }, env: {}, hub: studio.hub, delayMs: 0 }).tools(ACTIONS.map(action => ({ name: action, handler: async args => studio.run(action, args) })));
	// a script: its steps run through the nested tools (door.nested), as agent-routes.mjs wraps a script's tools
	const inner = door.nested(fitted), script = { name: "script", handler: async ({ steps }) => {
		const calls = [];
		for (const [action, args] of steps) calls.push({ tool: action, ok: true, affectedIds: (await inner[ACTIONS.indexOf(action)].handler(args)).affectedIds ?? [] });
		return { ok: true, calls };
	} };
	const list = background ? door.with([...fitted, script]) : [...fitted, script, door];
	const tools = Object.fromEntries([...ACTIONS, "script"].map((action, k) => [action.split(".").pop(), args => list[k].handler(args)]));
	const call = door.handler({ request });
	const resultTool = list.find(tool => tool.name === "motion_result");
	return { call, tools, door, result: () => resultTool.handler() };
}

/** A record as the Studio draws it: base, size (own box x scale), turn, scale. */
export const shapeOf = row => ({ base: [row.x, row.y, row.z], size: [row.footprint.width * row.scaleX, row.height * row.scaleY, row.footprint.depth * row.scaleZ], turn: row.rot, scale: [row.scaleX, row.scaleY, row.scaleZ] });
