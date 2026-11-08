// What an Annotate drawing points at (context-chip-tools.jsx draws, this
// reads). A screen point hits the nearest mesh along its ray (object,
// character, environment) or else the floor. A closed pen loop is a lasso: what lies inside its screen polygon, down to a character's joints.
// An open stroke is read point by point: along a body it names the bones it
// passes, on an object its faces, and only on the floor is it a route.
import * as THREE from "three";
import { floorPointAt } from "./floor-raycast.js";
import { annotateWorld } from "./viewport-sketch.js";
import { POSE_BONES, normalizeBoneName } from "./poses.js";
import { nearestPoseBone } from "./context-chip-actions.js";

const CLOSE_FRACTION = 0.1; // a stroke whose ends meet within 10% of its size is a loop
const SCREEN_MAX = 64;
const shown = (node) => { for (let at = node; at; at = at.parent) if (!at.visible) return false; return true; };
const FINGER = /(Left|Right)Hand(Thumb|Index|Middle|Ring|Pinky)(\d)$/;

function faceOf(intersection) {
	if (!intersection.face) return null;
	const normal = intersection.face.normal.clone().transformDirection(intersection.object.matrixWorld);
	if (normal.y > 0.7) return "top";
	if (normal.y < -0.7) return "bottom";
	return Math.abs(normal.x) > Math.abs(normal.z) ? (normal.x > 0 ? "right" : "left") : (normal.z > 0 ? "front" : "back");
}

// The body as posed: a capsule round each named bone (joint to its child joint). The skinned mesh's own
// raycast tests the bind-pose bounds, so a posed head or a hand held forward can miss it; these follow the pose.
const CAPSULE_RADIUS = { head: 0.12, neck: 0.06, lHand: 0.06, rHand: 0.06, lFoot: 0.07, rFoot: 0.07, hips: 0.14, spine: 0.13, chest: 0.14, upperChest: 0.14 };
const CAPSULE_DEFAULT = 0.07, HEAD_CAP_M = 0.2;
function capsuleHit(ray, rig) {
	rig.updateWorldMatrix(true, true);
	const a = new THREE.Vector3(), b = new THREE.Vector3(), onRay = new THREE.Vector3(), onBone = new THREE.Vector3();
	let best = null;
	rig.traverse((bone) => {
		if (!bone.isBone || FINGER.test(bone.name)) return;
		const name = normalizeBoneName(bone.name), entry = POSE_BONES.find((row) => { const target = normalizeBoneName(row.bone); return name === target || name.endsWith(target); });
		if (!entry) return;
		bone.getWorldPosition(a);
		const child = bone.children.find((node) => node.isBone && !FINGER.test(node.name));
		if (child) child.getWorldPosition(b); else b.copy(a).add(new THREE.Vector3(0, entry.id === "head" ? HEAD_CAP_M : 0.05, 0));
		const radius = CAPSULE_RADIUS[entry.id] ?? CAPSULE_DEFAULT;
		if (ray.distanceSqToSegment(a, b, onRay, onBone) > radius * radius) return;
		const distance = onRay.distanceTo(ray.origin);
		if (!best || distance < best.distance) best = { distance, bone: entry.id, point: onBone.clone() };
	});
	return best;
}

/** A rig's named joints: POSE_BONES ids, plus the finger joints as IK track names (leftIndex2). */
function joints(rig) {
	const found = [];
	rig.updateWorldMatrix(true, true);
	rig.traverse((bone) => {
		if (!bone.isBone) return;
		const finger = FINGER.exec(bone.name), name = normalizeBoneName(bone.name);
		const entry = finger ? null : POSE_BONES.find((row) => { const target = normalizeBoneName(row.bone); return name === target || name.endsWith(target); });
		const id = finger ? `${finger[1].toLowerCase()}${finger[2]}${finger[3]}` : entry?.id;
		if (id && !found.some((row) => row.id === id)) found.push({ id, pose: Boolean(entry), at: bone.getWorldPosition(new THREE.Vector3()) });
	});
	return found;
}

function inPolygon(p, poly) {
	let inside = false;
	for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
		const a = poly[i], b = poly[j];
		if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
	}
	return inside;
}
const crosses = (p, q, r, s) => {
	const d = (a, b, c) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
	return d(p, q, r) * d(p, q, s) < 0 && d(r, s, p) * d(r, s, q) < 0;
};
/** A loop: its ends meet (within 10% of its size), or it crosses itself. */
function closed(screen) {
	if (screen.length < 6) return false;
	const xs = screen.map((p) => p.x), ys = screen.map((p) => p.y), size = Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
	if (size > 8 && Math.hypot(screen[0].x - screen.at(-1).x, screen[0].y - screen.at(-1).y) <= CLOSE_FRACTION * size) return true;
	for (let i = 0; i < screen.length - 1; i += 1) for (let j = i + 2; j < screen.length - 1; j += 1) if (crosses(screen[i], screen[i + 1], screen[j], screen[j + 1])) return true;
	return false;
}
const tally = (list) => { const counts = new Map(); for (const key of list) counts.set(key, (counts.get(key) ?? 0) + 1); return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null; };
const ordered = (list) => list.filter((value, i) => value && list.indexOf(value) === i);

export function createAnnotateHits({ canvas, scene, camera: cameraOf, ours, floorTools }) {
	const raycaster = new THREE.Raycaster(), pointer = new THREE.Vector2();
	raycaster.layers.set(0); // the editor's gizmos and the Top-View board live on their own layers
	const rect = () => canvas.getBoundingClientRect();
	const ndc = (x, y) => { const r = rect(); return pointer.set(((x - r.left) / r.width) * 2 - 1, -((y - r.top) / r.height) * 2 + 1); };
	const toScreen = (v, camera) => { const r = rect(), p = v.clone().project(camera); return { x: r.left + ((p.x + 1) / 2) * r.width, y: r.top + ((1 - p.y) / 2) * r.height, z: p.z }; };
	const floorAt = (x, y) => { const hit = floorPointAt({ clientX: x, clientY: y }, canvas, cameraOf(), floorTools); return hit ? { x: hit.x, y: 0, z: hit.z } : null; };
	/** The screen polygon in 0..1 of the view (and so of the annotated picture), at most 64 points. */
	const normalized = (screen) => {
		const r = rect(), step = Math.max(1, Math.ceil(screen.length / SCREEN_MAX));
		return screen.filter((_, i) => i % step === 0).map((p) => ({ x: Math.round(Math.min(1, Math.max(0, (p.x - r.left) / r.width)) * 1000) / 1000, y: Math.round(Math.min(1, Math.max(0, (p.y - r.top) / r.height)) * 1000) / 1000 }));
	};

	/** What lies under a screen point: { point, hit } or null. The nearest mesh along the ray wins, whatever it is. */
	function hitAt(x, y) {
		const camera = cameraOf(), world = annotateWorld();
		if (!camera) return null;
		raycaster.setFromCamera(ndc(x, y), camera);
		const first = raycaster.intersectObjects(scene.children, true).find((entry) => (entry.object.isMesh || entry.object.isSkinnedMesh) && shown(entry.object) && !ours(entry.object));
		// A posed body part nearer than the mesh hit (or with no mesh hit at all) wins: the nearest hit, whatever its kind.
		let body = null;
		for (const [characterId, rig] of Object.entries(world?.rigs ?? {})) {
			if (!rig || !shown(rig)) continue;
			const hit = capsuleHit(raycaster.ray, rig);
			if (hit && (!body || hit.distance < body.distance)) body = { ...hit, characterId };
		}
		if (body && (!first || body.distance < first.distance)) {
			return { point: { x: body.point.x, y: body.point.y, z: body.point.z }, hit: { type: "character", id: body.characterId, bone: body.bone } };
		}
		if (first) {
			const point = { x: first.point.x, y: first.point.y, z: first.point.z };
			for (let at = first.object; at; at = at.parent) {
				const objectId = at.userData?.sceneObjectId;
				if (objectId) return { point, hit: { type: "object", id: objectId, face: faceOf(first) } };
				const characterId = world && Object.keys(world.rigs ?? {}).find((id) => world.rigs[id] === at);
				if (characterId) return { point, hit: { type: "character", id: characterId, bone: nearestPoseBone(at, first.point) } };
			}
			if (first.point.y > 0.03) return { point, hit: { type: "environment", id: first.object.name || null, name: first.object.name || null } };
		}
		const floor = floorAt(x, y);
		return floor ? { point: floor, hit: { type: "floor", id: null } } : null;
	}

	/** Inside a screen polygon: objects by their middle, characters by their middle or any joint, with the
	 * joints inside, most central first. Returns { members, depth } (depth: NDC z of what was enclosed). */
	function lasso(poly) {
		const camera = cameraOf(), world = annotateWorld(), members = [], depths = [];
		if (!camera || !world) return { members, depth: null };
		const cx = poly.reduce((sum, p) => sum + p.x, 0) / poly.length, cy = poly.reduce((sum, p) => sum + p.y, 0) / poly.length;
		const bounds = new THREE.Box3(), centre = new THREE.Vector3();
		const middleInside = (node) => { bounds.setFromObject(node); if (bounds.isEmpty()) return null; const s = toScreen(bounds.getCenter(centre), camera); return s.z < 1 && inPolygon(s, poly) ? s : null; };
		for (const character of world.characters ?? []) {
			const rig = world.rigs?.[character.id];
			if (!rig || !shown(rig)) continue;
			const inside = joints(rig).map((joint) => ({ ...joint, s: toScreen(joint.at, camera) })).filter((joint) => joint.s.z < 1 && inPolygon(joint.s, poly))
				.sort((a, b) => Math.hypot(a.s.x - cx, a.s.y - cy) - Math.hypot(b.s.x - cx, b.s.y - cy));
			const middle = middleInside(rig);
			if (!inside.length && !middle) continue;
			const bones = inside.map((joint) => joint.id);
			members.push({ type: "character", id: character.id, bone: inside.find((joint) => joint.pose)?.id ?? bones[0] ?? null, bones });
			depths.push(...(inside.length ? inside.map((joint) => joint.s.z) : [middle.z]));
		}
		scene.traverse((node) => {
			const id = node.userData?.sceneObjectId;
			if (!id || members.some((entry) => entry.id === id) || !shown(node)) return;
			const middle = middleInside(node);
			if (middle) { members.push({ type: "object", id }); depths.push(middle.z); }
		});
		return { members, depth: depths.length ? depths.reduce((a, b) => a + b, 0) / depths.length : null };
	}
	/** The screen loop lifted into the scene at `depth` (what it encloses), or laid on the floor without one. */
	function liftLoop(screen, depth) {
		const camera = cameraOf();
		if (depth == null || !camera) return screen.map((p) => floorAt(p.x, p.y)).filter(Boolean);
		return screen.map((p) => { const v = ndc(p.x, p.y); const w = new THREE.Vector3(v.x, v.y, depth).unproject(camera); return { x: w.x, y: w.y, z: w.z }; });
	}

	/** A finished pen drawing { screen, hits, floor } read as a loop or a stroke. */
	function readPen({ screen, hits, floor }) {
		if (closed(screen)) {
			const { members, depth } = lasso(screen), main = members.find((entry) => entry.type === "character" && entry.bones.length) ?? members[0];
			return { shape: "loop", hit: main ?? { type: "floor", id: null }, members, points: liftLoop([...screen, screen[0]], depth), screen: normalized(screen) };
		}
		const key = tally(hits.map(({ hit }) => `${hit.type}:${hit.id}`)), on = hits.filter(({ hit }) => `${hit.type}:${hit.id}` === key);
		const first = on[0]?.hit ?? hits[0].hit, points = hits.map(({ point }) => point);
		if (first.type === "character") {
			const bones = ordered(on.map(({ hit }) => hit.bone));
			return { shape: "stroke", hit: { ...first, bone: tally(on.map(({ hit }) => hit.bone)), bones }, points, screen: normalized(screen) };
		}
		if (first.type === "object") return { shape: "stroke", hit: { ...first, face: tally(on.map(({ hit }) => hit.face)), faces: ordered(on.map(({ hit }) => hit.face)) }, points, screen: normalized(screen) };
		return { shape: "route", hit: hits[0].hit.type === "character" ? hits[0].hit : first, points, floor, screen: normalized(screen) };
	}
	return { raycaster, ndc, floorAt, hitAt, readPen, normalized };
}
