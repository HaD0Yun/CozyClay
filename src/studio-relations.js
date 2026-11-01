// What stands where, as text the agent reads before it edits: the compact relation list of inspect_studio scope "relations"
// and of the turn's context. Without it the observation is a list of coordinates, and support, occlusion and framing each take
// a separate verify call (#1030). Measured on the same world AABB proxies as the other checks, at the current frame.
//   Lamp#cube-2 ON Table#cube-5                    its base within SUPPORT_M of the top, footprints overlapping
//   Hero#char-a OCCLUDED_BY Pillar#cube-3 30%      share of sample points of its box the other box hides from the shot camera
//   Hero#char-a IN_FRAME 1.00 height 0.42          share of its box inside the picture, and its height as a share of the picture
//   Hero#char-a OUT_OF_FRAME
//   Chair#cube-4 LEFT_OF Hero#char-a               in the picture, as the camera sees it
//   Chair#cube-4 NEAR Hero#char-a 0.35m            the gap between their boxes, under NEAR_M
import { Vector3 } from "three";
import { entityWorldBounds, projectSubject } from "./studio-agent-commands.js";
import { segmentIntersectsAabb } from "./studio-geometry-facts.js";
import { isEffectivelyHidden, isEmptyObject } from "./scene-objects.js";
import { focalMmToFov, SENSOR_FORMATS } from "./shot.js";

// MIN_SHARE: under this much of a box in the picture reads as out of it (a figure against the lens rounded to IN_FRAME 0.00).
const SUPPORT_M = 0.02, NEAR_M = 1, SIDE_MARGIN = 0.02, MIN_OCCLUDED = 0.1, MIN_SHARE = 0.005, GRID = 3, ROWS = 40;
const r2 = v => Math.round(v * 100) / 100 + 0;
const corners = ({ min, max }) => [min.x, max.x].flatMap(x => [min.y, max.y].flatMap(y => [min.z, max.z].map(z => new Vector3(x, y, z))));
const overlapsXZ = (a, b) => a.min.x < b.max.x && b.min.x < a.max.x && a.min.z < b.max.z && b.min.z < a.max.z;
const inside = (box, p) => ["x", "y", "z"].every(k => box.min[k] <= p[k] && p[k] <= box.max[k]);
const gap = (a, b) => Math.hypot(...["x", "y", "z"].map(k => Math.max(0, a.min[k] - b.max[k], b.min[k] - a.max[k])));

function gridPoints({ min, max }) {
	const at = (lo, hi, i) => lo + ((hi - lo) * (i + 0.5)) / GRID, points = [];
	for (let x = 0; x < GRID; x++) for (let y = 0; y < GRID; y++) for (let z = 0; z < GRID; z++) points.push({ x: at(min.x, max.x, x), y: at(min.y, max.y, y), z: at(min.z, max.z, z) });
	return points;
}

/** Where a box lands in the picture: { share (0..1 of it inside), height (of the picture), x (-1..1 of its visible middle) }. */
function landing(box, camera, fov, aspect) {
	const { screenBounds: s, checks } = projectSubject(corners(box), camera, fov, aspect);
	if (checks.behindCamera) return { share: 0, height: 0, x: 0 };
	const span = (lo, hi) => Math.max(0, Math.min(hi, 1) - Math.max(lo, -1)), w = s.x.max - s.x.min, h = s.y.max - s.y.min;
	const share = w > 0 && h > 0 ? (span(s.x.min, s.x.max) * span(s.y.min, s.y.max)) / (w * h) : 0;
	return { share: share < MIN_SHARE ? 0 : Math.min(1, share), height: h / 2, x: (Math.max(s.x.min, -1) + Math.min(s.x.max, 1)) / 2 };
}

/**
 * state: the scene as commands read it (objects, characters, frame, camera, filmback). ports: { bounds }. Answers { relations: [strings],
 * characters: [{ id, bounds }], entityIds (what a check can target), camera: { position, lookAt, focalMm, inFrame, outOfFrame } | null, truncated? }, most telling rows first.
 */
export function studioRelations(state, ports) {
	const solid = o => !isEmptyObject(o) && !isEffectivelyHidden(o, state.objects, state.characters);
	const row = (entity, kind) => { const box = entityWorldBounds(entity, state, ports); return box ? { id: entity.id, label: `${entity.name || entity.subject || kind}#${entity.id}`, box, entity, kind } : null; };
	const characters = state.characters.filter(c => !isEffectivelyHidden(c, state.objects, state.characters)).map(c => row(c, "character")).filter(Boolean);
	const objects = state.objects.filter(solid).map(o => row(o, "object")).filter(Boolean), all = [...characters, ...objects];
	const occluded = [], framed = [], support = [], side = [], near = [];
	for (const a of all) {
		const under = all.filter(b => b !== a && b.kind === "object" && overlapsXZ(a.box, b.box) && Math.abs(a.box.min.y - b.box.max.y) <= SUPPORT_M).sort((p, q) => q.box.max.y - p.box.max.y)[0];
		if (under && a.box.min.y > SUPPORT_M) support.push(`${a.label} ON ${under.label}`);
	}
	const pairs = characters.flatMap(c => all.filter(o => o !== c).map(o => [o, c])), seen = new Set();
	for (const [a, b] of pairs) {
		const key = [a.id, b.id].sort().join("|");
		if (seen.has(key)) continue;
		seen.add(key);
		const d = gap(a.box, b.box);
		if (d < NEAR_M) near.push({ d, text: `${a.label} NEAR ${b.label} ${r2(d)}m` });
	}
	let camera = null;
	const sensor = state.filmback?.sensorId, aspect = state.filmback?.aspectRatio;
	if (state.camera && SENSOR_FORMATS[sensor] && aspect > 0) {
		const fov = focalMmToFov(state.camera.focalMm, sensor, aspect), eye = state.camera.position, land = new Map(all.map(a => [a.id, landing(a.box, state.camera, fov, aspect)]));
		camera = { position: state.camera.position, lookAt: state.camera.lookAt, focalMm: state.camera.focalMm, inFrame: all.filter(a => land.get(a.id).share > 0).map(a => a.id).slice(0, 24), outOfFrame: all.filter(a => land.get(a.id).share === 0).map(a => a.id).slice(0, 24) };
		for (const c of characters) {
			const at = land.get(c.id);
			framed.push(at.share > 0 ? `${c.label} IN_FRAME ${at.share.toFixed(2)} height ${at.height.toFixed(2)}` : `${c.label} OUT_OF_FRAME`);
			const points = gridPoints(c.box), counts = objects.filter(o => o.entity.attach?.characterId !== c.id && !inside(o.box, eye)).map(o => [o, points.filter(p => segmentIntersectsAabb(eye, p, o.box)).length]);
			for (const [o, n] of counts) if (n / points.length >= MIN_OCCLUDED) occluded.push({ n, text: `${c.label} OCCLUDED_BY ${o.label} ${Math.round((100 * n) / points.length)}%` });
			if (at.share === 0) continue;
			for (const o of all) {
				const other = land.get(o.id);
				if (o === c || other.share === 0 || Math.abs(other.x - at.x) < SIDE_MARGIN) continue;
				side.push(`${o.label} ${other.x < at.x ? "LEFT_OF" : "RIGHT_OF"} ${c.label}`);
			}
		}
	}
	const relations = [...occluded.sort((a, b) => b.n - a.n).map(x => x.text), ...framed, ...support, ...near.sort((a, b) => a.d - b.d).map(x => x.text), ...side];
	return { relations: relations.slice(0, ROWS), ...(relations.length > ROWS ? { truncated: relations.length - ROWS } : {}), characters: characters.slice(0, 24).map(c => ({ id: c.id, bounds: c.box })), entityIds: all.map(a => a.id), camera };
}
