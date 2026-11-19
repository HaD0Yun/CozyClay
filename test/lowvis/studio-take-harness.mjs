// A Studio turn for the take tests (verify-motion-take*.mjs): the real motion door, runMotion, studioScene and
// installClip, an editor made of the Studio's own object reducers (src/scene-objects.js, src/commands/object-sculpt.js),
// flat tops measured by the Studio's own tops.js over the box meshes a record draws, and a scripted motion writer whose
// scene and spec the real engine compiles. No one-box shortcut: a record's size is what the Studio computes from its parts.
import * as THREE from "three";
import { createMotionDoor } from "../../bin/agent/motion-door.mjs";
import { runMotion } from "../../bin/agent/motion-run.mjs";
import { sculptMethod } from "../../src/commands/object-sculpt.js";
import { buildClip } from "../../src/lowvis/engine-simple/engine.js";
import { serializeClip } from "../../src/lowvis/clip.js";
import { installClip } from "../../src/lowvis/studio/install.js";
import { studioScene } from "../../src/lowvis/studio/scene.js";
import { objectTops } from "../../src/lowvis/studio/tops.js";
import * as O from "../../src/scene-objects.js";

const coded = (code, message) => Object.assign(new Error(message), { code });
const changedIds = (before, after) => [...new Set([...before, ...after].map(row => row.id))].filter(id => JSON.stringify(before.find(row => row.id === id)) !== JSON.stringify(after.find(row => row.id === id)));

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
	group.rotation.y = row.rot * Math.PI / 180;
	group.scale.set(row.scaleX, row.scaleY, row.scaleZ);
	return group;
}

/** An editor of the Studio's own reducers: run(action, args) (a refusal throws), describe(args), mark / rollback; undrawn: ids whose group is not drawn yet (tops []). */
export function studioEditor({ undrawn = new Set() } = {}) {
	let rows = [], cast = new Map([["a1", { id: "a1", model: "x-bot-tpose", x: 0, z: 0, rot: 0, scale: 1 }]]), marked = null;
	const calls = [];
	const objectOf = id => rows.find(row => row.id === id) ?? (() => { throw coded("STALE_TARGET", `Object ${id} is not in this scene.`); })();
	const sculpt = sculptMethod({ owned: () => ({ read: () => rows, write: next => { rows = next; } }), objectOf, changed: before => changedIds(before, rows) });
	const run = async (action, args = {}) => {
		calls.push({ action, args });
		const before = rows;
		if (action === "object.sculpt") return { ok: true, ...sculpt(args) };
		if (action === "object.add") {
			const object = O.createSceneObject(args.kind, before, args.placement);
			const placed = O.updateSceneObject([object], object.id, { ...(args.placement ?? {}), ...(args.name === undefined ? {} : { name: args.name }) })[0];
			rows = args.parent === undefined ? [...before, placed] : O.setSceneObjectParent([...before, placed], placed.id, args.parent);
			return { ok: true, affectedIds: [placed.id] };
		}
		if (action === "object.update") { objectOf(args.id); rows = O.updateSceneObject(before, args.id, args.patch); return { ok: true, affectedIds: changedIds(before, rows) }; }
		if (action === "object.remove") { rows = args.ids.reduce((list, id) => O.removeSceneObject(list, id), before); return { ok: true, affectedIds: changedIds(before, rows) }; }
		if (action === "object.group") { rows = args.children.reduce((list, id) => O.setSceneObjectParent(list, id, args.parent), before); return { ok: true, affectedIds: changedIds(before, rows) }; }
		if (action === "character.add") { cast.set(args.character.id, { ...args.character }); return { ok: true, affectedIds: [args.character.id] }; }
		if (action === "character.update") { Object.assign(cast.get(args.characterId) ?? {}, args.patch); return { ok: true, affectedIds: [args.characterId] }; }
		if (action === "character.clearWaypoints" || action === "motion.v4.install") return { ok: true, affectedIds: [args.characterId] };
		throw coded("INVALID_ARGUMENT", `no action ${action}`);
	};
	const topsOf = row => (undrawn.has(row.id) ? [] : objectTops(groupOf(row)));
	const describe = (args = {}) => ({ characters: [...cast.values()].map(row => ({ ...row })), objects: rows.map(row => ({ ...structuredClone(row), ...(args.tops === true && !row.hidden ? { tops: topsOf(row) } : {}) })) });
	return {
		run, describe, calls, topsOf, rows: () => rows, row: id => rows.find(row => row.id === id), named: name => rows.filter(row => row.name === name),
		hub: { command: async (name, args) => describe(args) },
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
/** What the writer ends with: { scene (as the compile tool keeps it), spec, clip (the engine's, as JSON) }. */
export function written(scene, spec) {
	const def = withMovers(structuredClone(scene), spec), built = buildClip(structuredClone({ demo: "x", ...spec }), structuredClone(def));
	return { scene: def, spec, clip: JSON.parse(serializeClip(built.clip)) };
}

/** A box part [w, h, d] with its underside centre at [x, y, z]; a recipe of parts. */
export const part = (id, size, at) => ({ id, shape: "box", size, position: [at[0], at[1] + size[1] / 2, at[2]], roundness: 0 });
export const recipe = (...parts) => ({ version: 1, parts });
/** A prop of the writer's scene by its size and base. */
export const prop = (id, size, base, extra = {}) => ({ id, size, at: [base[0], base[1] + (extra.shape === "sphere" ? size[0] : size[1]) / 2, base[2]], ...extra });
export const stage = props => ({ frames: 60, characters: [{ id: "a1", at: [0, 0], heading: 0 }], props });

/**
 * One turn: motion { request, building }, then meanwhile(tools) (sculpt, add, update, group, remove: the agent's calls while
 * the writer works), then motion_result. background false: the call waits, and meanwhile runs beside it as another
 * caller's edits. -> { answer, requests }
 */
export async function turn({ studio, work, building, meanwhile = async () => {}, background = true, key = null }) {
	const requests = [];
	let release;
	const gate = new Promise(resolve => { release = resolve; });
	const runScene = async ({ request, log }) => {
		requests.push(request);
		await gate;
		log?.("  motion 1: ok frames");
		return { wallMs: 1000, compiles: 1, report: "Made.\nMissing: nothing.", missing: "nothing.", final: { clip: "clip.json", scene: work.scene, spec: work.spec } };
	};
	const deps = { runScene, installClip, studioScene, readClip: () => work.clip };
	const door = createMotionDoor({ run: options => runMotion({ ...options, words: "the user's words", note: options.request, memoryKey: key, hub: studio.hub, workspaceHandle: "ws", invoke: studio.run, env: {}, deps }), mark: studio.mark, rollback: studio.rollback, background });
	const actions = ["object.sculpt", "object.add", "object.update", "object.group", "object.remove"];
	const list = door.with(actions.map(action => ({ name: action, handler: async args => studio.run(action, args) })));
	const via = background ? list : actions.map(action => ({ handler: args => studio.run(action, args) }));
	const tools = Object.fromEntries(actions.map((action, k) => [action.split(".")[1], args => via[k].handler(args)]));
	const call = door.handler({ request: "the agent's note", ...(building === undefined ? {} : { building }) });
	if (background) await call; else await new Promise(resolve => setTimeout(resolve, 5));
	await meanwhile(tools);
	release();
	const answer = background ? await list.find(tool => tool.name === "motion_result").handler() : await call;
	return { answer, requests };
}

/** A record as the Studio draws it: base, size (own box x scale), turn, scale. */
export const shapeOf = row => ({ base: [row.x, row.y, row.z], size: [row.footprint.width * row.scaleX, row.height * row.scaleY, row.footprint.depth * row.scaleZ], turn: row.rot, scale: [row.scaleX, row.scaleY, row.scaleZ] });
