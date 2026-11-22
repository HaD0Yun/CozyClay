// What the drawn lights do to a subject, for verify_result checks ["lighting"] (studio-lighting-check.js): read from the
// three.js scene the stage draws (stage-scene-ref.js) right after the shot frame is rendered, so a light's place, aim,
// range, cone, level and shadow switch are the ones that frame used, and from that frame's pixels. A fact is stated only
// where it is the same arithmetic the renderer does: a light reaches a point when the point is inside its range and its
// cone and, for a light that casts a shadow, nothing that casts a shadow stands between them inside its shadow map.
import { Raycaster, Vector3 } from "three";
import { bodyPoints } from "./studio-geometry-facts.js";

/** Light rows per subject in an answer; the rest are counted in `moreLights`. */
const MAX_LIGHT_ROWS = 8;
/** Side words: within FRONT_DEG of the direction to the camera is front, past BACK_DEG is back; screen left or right past
 * ACROSS (the sine of the angle off the camera's vertical plane); above or below past LEVEL (sine of 15 degrees). */
const FRONT_DEG = 60, BACK_DEG = 120, ACROSS = 0.25, LEVEL = Math.sin((15 * Math.PI) / 180);
/** The pixel mask: a line of this radius (m) along the middle of each bone longer than MIN_BONE_M, leaving out
 * MASK_TRIM of its length at each end, where a figure's joints can show gaps between its parts. */
const MASK_RADIUS_M = 0.015, MIN_BONE_M = 0.05, MASK_TRIM = 0.25, MIN_MASK_PIXELS = 40;
const round = (value, digits = 2) => Number(value.toFixed(digits));
const vec = (p) => new Vector3(p[0] ?? p.x, p[1] ?? p.y, p[2] ?? p.z);

/** The record or character a node belongs to (props.jsx sceneObjectId, stage-characters.jsx characterPick), or null. */
function ownerOf(node) {
	for (let n = node; n; n = n.parent) {
		const id = n.userData?.sceneObjectId ?? n.userData?.characterPick;
		if (id) return id;
	}
	return null;
}

/** The lights the stage draws, as three.js does: shown with every parent, on layer 0. A record's light is named by its
 * record; the shadow-casting directional light standing at stage.keyLight is "key"; other stage lights are left out. */
function drawnLights(scene, keyLight) {
	const out = [];
	scene.traverseVisible((node) => {
		if (!(node.isPointLight || node.isSpotLight || node.isDirectionalLight) || !(node.layers.mask & 1)) return;
		node.updateWorldMatrix(true, false);
		const position = new Vector3().setFromMatrixPosition(node.matrixWorld);
		const id = node.userData.sceneObjectId ?? (node.isDirectionalLight && node.castShadow && keyLight && position.distanceTo(vec(keyLight)) < 1e-3 ? "key" : null);
		if (id) out.push({ id, light: node, position, type: node.isSpotLight ? "spot" : node.isPointLight ? "point" : "directional" });
	});
	return out;
}

/** Meshes the frame draws on layer 0 as { mesh, owner }; with `casting`, only the ones that cast shadows. */
function meshesOf(scene, casting) {
	const out = [];
	scene.traverseVisible((node) => {
		if (!node.isMesh || !(node.layers.mask & 1) || node.userData?.beautyOnly || (casting && !node.castShadow)) return;
		// A skinned body's sphere is kept from an earlier pose; the raycast must test the posed one.
		if (node.isSkinnedMesh) node.boundingSphere = null;
		out.push({ mesh: node, owner: ownerOf(node) });
	});
	return out;
}

const raycaster = new Raycaster();
/** The meshes of `meshes` that are not `own`'s. */
const othersOf = (meshes, own) => meshes.filter((m) => m.owner !== own).map((m) => m.mesh);

/** The owner of the nearest of `meshes` the segment from origin along unit dir crosses within far ("set" for a mesh no
 * record or character owns), or undefined when it crosses none. */
function firstHit(meshes, origin, dir, far) {
	if (!(far > 0)) return undefined;
	raycaster.set(origin, dir);
	raycaster.near = 0;
	raycaster.far = far;
	const hits = raycaster.intersectObjects(meshes, false);
	if (!hits.length) return undefined;
	return ownerOf(hits[0].object) ?? "set";
}

/** The light's aim as a unit vector from its position (spot, directional), or null (point). */
function aimOf({ light, position }) {
	if (light.isPointLight) return null;
	return new Vector3().setFromMatrixPosition(light.target.matrixWorld).sub(position).normalize();
}

/** Is p inside the light's shadow map, the only place it can draw a shadow? */
function inShadowMap(entry, p) {
	const { light, position } = entry, camera = light.shadow.camera;
	if (light.isPointLight) {
		const d = p.distanceTo(position);
		return d > camera.near && d < camera.far;
	}
	light.shadow.updateMatrices(light);
	const q = p.clone().applyMatrix4(light.shadow.matrix);
	return q.x >= 0 && q.x <= 1 && q.y >= 0 && q.y <= 1 && q.z >= 0 && q.z <= 1;
}

/** Side words from the subject's centre toward the light, seen from the camera (constants above). */
function sideOf(toLight, toCamera, right) {
	const angle = (Math.acos(Math.max(-1, Math.min(1, toLight.dot(toCamera)))) * 180) / Math.PI;
	const across = toLight.dot(right), up = toLight.y;
	return [angle < FRONT_DEG ? "front" : angle > BACK_DEG ? "back" : "side", across > ACROSS ? "right" : across < -ACROSS ? "left" : null, up > LEVEL ? "above" : up < -LEVEL ? "below" : null]
		.filter(Boolean).join("-");
}

/**
 * One light against one subject: { id, type, reach (0..1 of the body points it lights), side, distanceM (point, spot),
 * shadow { share (0..1 of the points inside its range and cone that a shadow-casting body hides from it), by [ids] } when
 * one does, why ("off", "range", "cone" or "shadow": what keeps most points unlit) when it reaches none }.
 */
function lightOnSubject(entry, points, centre, view, casters, receives) {
	const { light, position, type } = entry, aim = aimOf(entry);
	const count = { range: 0, cone: 0, shadow: 0 }, by = {};
	let lit = 0;
	for (const p of light.intensity > 0 ? points : []) {
		const toLight = light.isDirectionalLight ? aim.clone().negate() : position.clone().sub(p);
		const d = toLight.length();
		if (!light.isDirectionalLight && light.distance > 0 && d >= light.distance) { count.range++; continue; }
		if (light.isSpotLight && position.clone().sub(p).negate().normalize().dot(aim) <= Math.cos(light.angle)) { count.cone++; continue; }
		if (light.castShadow && receives && inShadowMap(entry, p)) {
			// A directional light's map starts at the plane through the light, square to its aim.
			const far = light.isDirectionalLight ? position.clone().sub(p).dot(toLight) : d;
			const hit = firstHit(casters, p, toLight.clone().normalize(), far);
			if (hit !== undefined) { count.shadow++; by[hit] = (by[hit] ?? 0) + 1; continue; }
		}
		lit++;
	}
	const toLight = light.isDirectionalLight ? aim.clone().negate() : position.clone().sub(centre).normalize();
	const row = { id: entry.id, type, reach: round(lit / points.length), side: sideOf(toLight, view.toCamera, view.right) };
	if (!light.isDirectionalLight) row.distanceM = round(position.distanceTo(centre));
	if (count.shadow) row.shadow = { share: round(count.shadow / (points.length - count.range - count.cone)), by: Object.keys(by).sort((a, b) => by[b] - by[a]) };
	if (!lit) row.why = !(light.intensity > 0) ? "off" : ["range", "cone", "shadow"].reduce((a, b) => (count[b] > count[a] ? b : a));
	return row;
}

/** Pixels of the subject in the frame (1 per pixel, rows bottom-up): a thin line along each of its posed bones whose
 * two ends the camera sees past `seen` (meshes). */
export function bodyMask(bones, points, view, seen) {
	const { camera, width, height } = view, mask = new Uint8Array(width * height);
	const focalPx = height / 2 / Math.tan((camera.fov * Math.PI) / 360), forward = camera.getWorldDirection(new Vector3());
	const projected = points.map((p) => {
		const world = vec(p), depth = world.clone().sub(camera.position).dot(forward);
		if (depth <= camera.near) return null;
		const toPoint = world.clone().sub(camera.position), length = toPoint.length();
		if (firstHit(seen, camera.position, toPoint.clone().divideScalar(length), length) !== undefined) return null;
		const ndc = world.clone().project(camera);
		return { x: ((ndc.x + 1) / 2) * width, y: ((ndc.y + 1) / 2) * height, r: Math.max(1, (MASK_RADIUS_M * focalPx) / depth), world };
	});
	for (const [i, j] of bones) {
		const a = projected[i], b = projected[j];
		if (!a || !b || a.world.distanceTo(b.world) < MIN_BONE_M) continue;
		const r = Math.min(a.r, b.r), dx = b.x - a.x, dy = b.y - a.y, span = dx * dx + dy * dy;
		for (let y = Math.max(0, Math.floor(Math.min(a.y, b.y) - r)); y <= Math.min(height - 1, Math.ceil(Math.max(a.y, b.y) + r)); y++) {
			for (let x = Math.max(0, Math.floor(Math.min(a.x, b.x) - r)); x <= Math.min(width - 1, Math.ceil(Math.max(a.x, b.x) + r)); x++) {
				const t = span > 0 ? ((x + 0.5 - a.x) * dx + (y + 0.5 - a.y) * dy) / span : -1;
				if (t >= MASK_TRIM && t <= 1 - MASK_TRIM && Math.hypot(x + 0.5 - a.x - t * dx, y + 0.5 - a.y - t * dy) <= r) mask[y * width + x] = 1;
			}
		}
	}
	return mask;
}

/** Mean luma of the brightest quarter of the mask's pixels over the darkest quarter's (each at least 1 of 255), or null
 * when the frame shows fewer than MIN_MASK_PIXELS of the body. */
function litToShade({ data }, mask) {
	const lumas = [];
	for (let i = 0; i < mask.length; i++) if (mask[i]) lumas.push(0.2126 * data[i * 4] + 0.7152 * data[i * 4 + 1] + 0.0722 * data[i * 4 + 2]);
	if (lumas.length < MIN_MASK_PIXELS) return null;
	lumas.sort((a, b) => a - b);
	const quarter = Math.floor(lumas.length / 4), mean = (list) => list.reduce((sum, v) => sum + v, 0) / list.length;
	return round(Math.max(1, mean(lumas.slice(-quarter))) / Math.max(1, mean(lumas.slice(0, quarter))), 1);
}

/**
 * The light facts: { subjects: { [id]: { litToShade, lights: [rows], moreLights } }, notDrawn: [light record ids the
 * frame does not draw], aimNotFound: [ids of drawn lights whose aimed-at id is not on stage] } (the lists only when not
 * empty). subjects: [{ subject, bounds }] with the bounds port's posed points and bones; view: { camera (the shot camera
 * the frame was rendered with), width, height }; image: that frame. Rows are sorted by reach, at most MAX_LIGHT_ROWS.
 */
export function stageLightFacts(scene, { subjects, keyLight, view, image, state, ports }) {
	const lights = drawnLights(scene, keyLight), drawn = new Set(lights.map((entry) => entry.id));
	const notDrawn = state.objects.filter((o) => o.renderer === "light" && !drawn.has(o.id)).map((o) => o.id);
	const aimNotFound = lights.filter((entry) => entry.light.userData.aimFound === false).map((entry) => entry.id);
	return { subjects: subjectLightFacts(scene, lights, { subjects, view, image, state, ports }), ...(notDrawn.length ? { notDrawn } : {}), ...(aimNotFound.length ? { aimNotFound } : {}) };
}

function subjectLightFacts(scene, lights, { subjects, view, image, state, ports }) {
	const casters = meshesOf(scene, true), seen = meshesOf(scene, false);
	const right = new Vector3().crossVectors(view.camera.getWorldDirection(new Vector3()), new Vector3(0, 1, 0)).normalize();
	const facts = {};
	for (const { subject, bounds } of subjects) {
		if (!bounds) continue;
		const points = bodyPoints(subject, state, ports, bounds).map(vec);
		const centre = new Vector3((bounds.min.x + bounds.max.x) / 2, (bounds.min.y + bounds.max.y) / 2, (bounds.min.z + bounds.max.z) / 2);
		let receives = false;
		scene.traverseVisible((node) => { if (node.isMesh && node.receiveShadow && ownerOf(node) === subject.id) receives = true; });
		const look = { toCamera: view.camera.position.clone().sub(centre).normalize(), right };
		const others = othersOf(casters, subject.id);
		const rows = lights.map((entry) => lightOnSubject(entry, points, centre, look, others, receives)).sort((a, b) => b.reach - a.reach);
		const mask = bounds.bones?.length ? bodyMask(bounds.bones, bounds.points, view, othersOf(seen, subject.id)) : null;
		facts[subject.id] = { litToShade: mask ? litToShade(image, mask) : null, lights: rows.slice(0, MAX_LIGHT_ROWS), ...(rows.length > MAX_LIGHT_ROWS ? { moreLights: rows.length - MAX_LIGHT_ROWS } : {}) };
	}
	return facts;
}
