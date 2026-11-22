// What the export camera shows of a take (verify_result motion, exportFraming): at each sampled frame
// the camera the export renders there (ports.sampleStateAt: the shot's camera where a shot covers the
// frame, else the Studio camera as it stands), and through it the character's joints (as motion.sample
// reads them) and the take's objects (moved by the take's tracks, object-travel.js), projected as
// frame_shot projects a subject (studio-agent-commands.js projectSubject). Measurements, not verdicts:
// how much of the character and of each object is inside the frame, and over which sampled frames a
// part (head, hands, feet) or an object (the outline of each of its bodies) is cut or out. Frames are
// absolute timeline frames; a span joins consecutive samples ([first, last] sampled frame).
import { Euler, Vector3 } from "three";
import { StudioProtocolError } from "./studio-agent-protocol.js";
import { projectSubject, entityWorldBounds } from "./studio-agent-commands.js";
import { focalMmToFov, SENSOR_FORMATS } from "./shot.js";
import { shotAtFrame } from "./cuts.js";
import { sceneObjectsAt } from "./object-travel.js";
import { descendantsOf, isEmptyObject } from "./scene-objects.js";
import { skeletonFor } from "./motion3/rigs/index.js";
import { fk } from "./motion3/compiler/skeleton.js";
import { add, apply, ry } from "./motion3/compiler/math.js";

const SAMPLES = 24, TAKE_SCHEMA = "cozyclay.take.v3", BARE_OBJECT = /^object:(.+?)(\.(?:center|top|base))?$/s;
const PARTS = Object.freeze({ head: ["Head", "HeadTop_End"], hand_l: ["LeftHand", "LeftHandMiddle4", "LeftHandIndex4"], hand_r: ["RightHand", "RightHandMiddle4", "RightHandIndex4"],
	foot_l: ["LeftFoot", "LeftToe_End"], foot_r: ["RightFoot", "RightToe_End"] });
const r2 = v => Math.round(v * 100) / 100;

/** Up to n frames spread evenly over [lo, hi], both ends included. */
export function exportSampleFrames(lo, hi, n = SAMPLES) {
	if (hi <= lo) return [lo];
	const count = Math.min(n, hi - lo + 1);
	return [...new Set(Array.from({ length: count }, (_, i) => Math.round(lo + (i * (hi - lo)) / (count - 1))))];
}

/** [[first, last], ...] of the sampled frames whose flag is set, consecutive samples joined. */
export function sampleSpans(frames, flags) {
	const spans = [];
	frames.forEach((frame, i) => {
		if (!flags[i]) return;
		if (i > 0 && flags[i - 1]) spans.at(-1)[1] = frame; else spans.push([frame, frame]);
	});
	return spans;
}

/** World joint positions of a v3 take at timeline frame f, in take bone order (motion.sample's reading: the take's
 *  skeleton at the character's place, turn and scale as they are now). */
function jointsAt(sk, take, f, character) {
	const B = take.bones.length, ff = Math.max(0, Math.min(take.frameCount - 1, Math.round(f)));
	const quats = Array.from({ length: B }, (_, b) => Array.from(take.rot.subarray((ff * B + b) * 4, (ff * B + b) * 4 + 4)));
	const state = fk(sk, quats, Array.from(take.hips.subarray(ff * 3, ff * 3 + 3)));
	const yaw = ry(character.rot ?? 0), at = [character.x ?? 0, character.y ?? 0, character.z ?? 0], size = character.scale ?? 1;
	return state.P.map(p => add(at, apply(yaw, size === 1 ? p : p.map(v => v * size))));
}

/** Scene object ids a spec names: spec.objects keys, object:<id> refs and any string value that is an object id. */
export function takeObjectIds(spec, objects) {
	const known = new Set(objects.map(o => o.id)), ids = new Set(Object.keys(spec?.objects ?? {}).filter(id => known.has(id)));
	const walk = value => {
		if (typeof value === "string") { const id = BARE_OBJECT.exec(value)?.[1] ?? value; if (known.has(id)) ids.add(id); }
		else if (Array.isArray(value)) value.forEach(walk);
		else if (value && typeof value === "object") Object.values(value).forEach(walk);
	};
	walk(spec);
	return [...ids];
}

/** How a set of world points lands in the camera: the projection and how much of its screen box is inside the frame. */
function landing(points, view) {
	const forward = new Vector3().subVectors(view.lookAt, view.position);
	const behind = points.filter(p => p.clone().sub(view.position).dot(forward) <= 0).length;
	if (behind === points.length) return { behind: true, cut: true, fraction: 0, screenFraction: 0 };
	const { screenBounds: b, checks } = projectSubject(points, view.camera, view.fov, view.aspect);
	if (behind) return { behind: true, cut: true, fraction: null, screenFraction: checks.screenFraction };
	// the share of each screen axis inside [-1, 1]; a box flat along an axis is in or out whole
	const share = ({ min, max }) => max - min > 1e-6 ? Math.max(0, Math.min(1, max) - Math.max(-1, min)) / (max - min) : Math.abs(min) <= 1 ? 1 : 0;
	return { behind: false, cut: checks.clipped, fraction: share(b.x) * share(b.y), screenFraction: checks.screenFraction };
}

const corners = box => [box.min.x, box.max.x].flatMap(x => [box.min.y, box.max.y].flatMap(y => [box.min.z, box.max.z].map(z => new Vector3(x, y, z))));
const RING = Array.from({ length: 8 }, (_, i) => [Math.cos(i * Math.PI / 4), Math.sin(i * Math.PI / 4)]);
// A body's outline in its own frame (base pivot, local +Y up, 1 m primitives scaled): rims for the round
// primitives, so a disc seen face on is not measured by the corners of its box; box corners otherwise.
const OUTLINES = { cylinder: [[0, 1], [1, 1]], cone: [[0, 1], [1, 0]], sphere: [[0, 0], [0.5, 1], [1, 0]], capsule: [[0, 0], [0.25, 1], [0.75, 1], [1, 0]] };
/** World points outlining a body as drawn at its posed record: the same placement geometry() uses for a box. */
function bodyPoints(object, state, ports) {
	const outline = OUTLINES[object.renderer];
	if (object.attach || object.path || !object.footprint) { const box = entityWorldBounds(object, state, { bounds: ports.bounds }); return box ? corners(box) : []; }
	const w = object.footprint.width * object.scaleX / 2, d = object.footprint.depth * object.scaleZ / 2, h = object.height * object.scaleY;
	const local = outline ? outline.flatMap(([y, r]) => r ? RING.map(([c, s]) => [w * r * c, y * h, d * r * s]) : [[0, y * h, 0]])
		: [-w, w].flatMap(x => [0, h].flatMap(y => [-d, d].map(z => [x, y, z])));
	const rotation = new Euler((object.rotX ?? 0) * Math.PI / 180, (object.rot ?? 0) * Math.PI / 180, (object.rotZ ?? 0) * Math.PI / 180, "XYZ");
	return local.map(([x, y, z]) => new Vector3(x, y, z).applyEuler(rotation).add(new Vector3(object.x, object.y ?? 0, object.z)));
}
const lowest = (rows, frames) => rows.reduce((best, row, i) => row !== null && (best === null || row < best[0]) ? [r2(row), frames[i]] : best, null);

/**
 * exportFraming for one character's installed v3 take. scene: the binding's command state (objects,
 * characters, camera, filmback, shotDocument); ports: { sampleStateAt, bounds }; range: verify_result's
 * range ("whole_clip" or { startFrame, endFrameExclusive }).
 */
export function exportFraming({ character, take, scene, ports, range }) {
	const sensorId = scene.filmback?.sensorId, aspect = scene.filmback?.aspectRatio;
	if (!SENSOR_FORMATS[sensorId] || !(aspect > 0)) throw new StudioProtocolError("TARGET_NOT_READY", "The shot camera and filmback must be available.");
	if (typeof ports.sampleStateAt !== "function") throw new StudioProtocolError("CAPABILITY_MISSING", "This editor cannot sample the export camera at timeline frames.");
	const sk = skeletonFor(take.rig ?? character.model), last = take.frameCount - 1;
	const lo = range && range !== "whole_clip" ? Math.max(0, range.startFrame) : 0, hi = range && range !== "whole_clip" ? Math.min(last, range.endFrameExclusive - 1) : last;
	const frames = exportSampleFrames(lo, hi), shots = scene.shotDocument?.shots ?? [];
	const tracks = new Map(Object.entries(take.objects ?? {}).map(([id, track]) => [id, { frameCount: take.frameCount, characterId: character.id, ...track }]));
	const objectIds = takeObjectIds(take.spec, scene.objects), partIndex = Object.fromEntries(Object.entries(PARTS).map(([part, bones]) => [part, bones.map(b => sk.index[b]).filter(i => i !== undefined)]));
	const shotIds = new Set(), sources = new Set(), body = [], parts = Object.fromEntries(Object.keys(PARTS).map(p => [p, []])), objects = objectIds.map(() => []);
	for (const frame of frames) {
		const sampled = ports.sampleStateAt(frame, scene), camera = sampled?.camera ?? scene.camera;
		if (!camera) throw new StudioProtocolError("TARGET_NOT_READY", "The shot camera must be available.");
		const shot = shotAtFrame(shots, frame);
		if (shot) shotIds.add(shot.id);
		sources.add(shot ? "shot" : "studio");
		const view = { camera, position: new Vector3(camera.position.x, camera.position.y, camera.position.z), lookAt: new Vector3(camera.lookAt.x, camera.lookAt.y, camera.lookAt.z),
			fov: focalMmToFov(camera.focalMm, sensorId, aspect), aspect };
		const joints = jointsAt(sk, take, frame, character).map(([x, y, z]) => new Vector3(x, y, z));
		body.push(landing(joints, view));
		for (const [part, index] of Object.entries(partIndex)) parts[part].push(landing(index.map(i => joints[i]), view));
		const posed = sceneObjectsAt(scene.objects, frame, { frameCount: take.frameCount, fps: 24, objectTracks: tracks }), state = { ...scene, objects: posed, frame };
		objectIds.forEach((id, k) => {
			const object = posed.find(o => o.id === id), bodies = object && (isEmptyObject(object) ? descendantsOf(posed, id).filter(o => !isEmptyObject(o)) : [object]);
			const points = (bodies ?? []).filter(o => !o.hidden).flatMap(o => bodyPoints(o, state, ports));
			objects[k].push(points.length ? landing(points, view) : null);
		});
	}
	const spans = (rows, key) => sampleSpans(frames, rows.map(row => !!row?.[key]));
	const cut = Object.fromEntries(Object.entries(parts).map(([part, rows]) => [part, spans(rows, "cut")]).filter(([, s]) => s.length));
	const fractions = body.map(row => row.screenFraction);
	return {
		coverage: "sampled-export-camera-joints-and-object-outlines",
		camera: sources.size === 1 ? [...sources][0] : "mixed", shotIds: [...shotIds], sampledFrames: frames,
		character: { id: character.id, screenFraction: [r2(Math.min(...fractions)), r2(Math.max(...fractions))], inFrame: lowest(body.map(row => row.fraction), frames),
			...(spans(body, "behind").length ? { behindCamera: spans(body, "behind") } : {}), ...(Object.keys(cut).length ? { cut } : {}) },
		objects: objectIds.map((id, k) => {
			const rows = objects[k], out = sampleSpans(frames, rows.map(row => row !== null && row.fraction === 0));
			const partly = sampleSpans(frames, rows.map(row => row !== null && row.cut && row.fraction !== 0));
			return { id, name: scene.objects.find(o => o.id === id)?.name ?? id, inFrame: lowest(rows.map(row => row?.fraction ?? null), frames), ...(out.length ? { out } : {}), ...(partly.length ? { cut: partly } : {}) };
		}),
	};
}

/** verify_result motion: result.exportFraming for every subject character with an installed v3 take (one: the row itself). */
export function exportFramingInto(result, { args, s, receipt, scene, ports }) {
	const rows = [];
	for (const id of (args.targets ?? receipt?.affectedIds ?? []).filter(id => s.characters.some(c => c.id === id))) {
		const take = s.targets.get(id)?.motion, character = s.characters.find(c => c.id === id);
		if (take?.schema !== TAKE_SCHEMA || !take.rot || !take.hips) continue;
		// what could not be measured says why in its own row, beside the motion check's reasons
		try { rows.push(exportFraming({ character, take, scene, ports, range: args.range })); }
		catch (error) { rows.push({ character: { id }, reason: String(error?.message ?? error) }); }
	}
	if (rows.length) result.exportFraming = rows.length === 1 ? rows[0] : rows;
}
