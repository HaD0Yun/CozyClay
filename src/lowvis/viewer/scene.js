// One panel's three.js scene: floor grid, soft light with a shadow, clay box props and the clip's characters.
import * as THREE from "three";
import { JOINT_COUNT } from "../rig17.js";
import { handGrips } from "../grip.js";
import { DEFAULT_TINT, LOOKS } from "../looks/index.js";
import { clayMaterial } from "../looks/parts.js";

export const BACKGROUND = "#e8e5df";
const TINTS = [DEFAULT_TINT, "#8fa8c2", "#a9bf98", "#c79aa6"]; // character a, b, c, d
const PROP_TINT = "#b0aaa0";

/** World bounds { min, max } of everything a clip shows over all frames. */
export function clipBounds(clip, box = new THREE.Box3()) {
	for (const c of clip.characters) {
		for (let i = 0; i < c.pos.length; i += 3) box.expandByPoint(new THREE.Vector3(c.pos[i], c.pos[i + 1], c.pos[i + 2]));
	}
	for (const p of clip.props ?? []) {
		const r = Math.hypot(...p.size) / 2;
		for (let i = 0; i < p.pos.length; i += 3) {
			box.expandByPoint(new THREE.Vector3(p.pos[i] - r, Math.max(0, p.pos[i + 1] - r), p.pos[i + 2] - r));
			box.expandByPoint(new THREE.Vector3(p.pos[i] + r, p.pos[i + 1] + r, p.pos[i + 2] + r));
		}
	}
	return box;
}

/** Flat [x,y,z,...] of the points a camera must keep in frame: every 2nd frame's joints, the floor under them, prop corners. */
export function clipPoints(clip) {
	const pts = [];
	for (const c of clip.characters) {
		for (let f = 0; f < clip.frameCount; f += 2) {
			const o = f * JOINT_COUNT * 3;
			for (let j = 0; j < JOINT_COUNT; j++) pts.push(c.pos[o + j * 3], c.pos[o + j * 3 + 1], c.pos[o + j * 3 + 2]);
			pts.push(c.pos[o], 0, c.pos[o + 2]);
		}
	}
	for (const p of clip.props ?? []) {
		const r = Math.hypot(...p.size) / 2 - 0.25; // the camera pads every point by more than this
		for (let i = 0; i < p.pos.length; i += 3) for (let k = 0; k < 8; k++) {
			pts.push(p.pos[i] + (k & 1 ? r : -r), Math.max(0, p.pos[i + 1] + (k & 2 ? r : -r)), p.pos[i + 2] + (k & 4 ? r : -r));
		}
	}
	return pts;
}

/** Floor: a shadow catcher over the page background and lines on every whole metre around `bounds`. */
function floor(bounds) {
	const g = new THREE.Group();
	const x0 = Math.floor(bounds.min.x) - 2, x1 = Math.ceil(bounds.max.x) + 2;
	const z0 = Math.floor(bounds.min.z) - 2, z1 = Math.ceil(bounds.max.z) + 2;
	const pts = [];
	for (let x = x0; x <= x1; x++) pts.push(x, 0, z0, x, 0, z1);
	for (let z = z0; z <= z1; z++) pts.push(x0, 0, z, x1, 0, z);
	const geo = new THREE.BufferGeometry();
	geo.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
	g.add(new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: "#83878a" })));
	const plane = new THREE.Mesh(new THREE.PlaneGeometry(x1 - x0, z1 - z0), new THREE.MeshStandardMaterial({ color: "#bfc2c4", roughness: 1, metalness: 0 }));
	plane.rotation.x = -Math.PI / 2;
	plane.position.set((x0 + x1) / 2, -0.002, (z0 + z1) / 2);
	plane.receiveShadow = true;
	g.add(plane);
	return g;
}

function lights(bounds) {
	const g = new THREE.Group();
	g.add(new THREE.HemisphereLight("#ffffff", "#a39a8d", 0.9));
	const centre = bounds.getCenter(new THREE.Vector3());
	const radius = bounds.getSize(new THREE.Vector3()).length() / 2 + 0.6;
	const sun = new THREE.DirectionalLight("#fffaf4", 2.6);
	sun.position.copy(centre).add(new THREE.Vector3(-0.45, 1, 0.55).normalize().multiplyScalar(radius * 2));
	sun.target.position.copy(centre);
	sun.castShadow = true;
	sun.shadow.mapSize.set(2048, 2048);
	Object.assign(sun.shadow.camera, { left: -radius, right: radius, top: radius, bottom: -radius, near: 0.1, far: radius * 4 });
	sun.shadow.bias = -0.0004;
	sun.shadow.normalBias = 0.012;
	sun.shadow.radius = 5;
	g.add(sun, sun.target);
	return g;
}

/**
 * Builds a panel scene. `clip` may be null (a missing file): the panel then shows the empty floor.
 * Returns { scene, setFrame(f) }; a frame past the clip's end holds its last frame.
 */
export function createPanelScene({ clip, look, bounds, environment }) {
	const scene = new THREE.Scene();
	scene.background = new THREE.Color(BACKGROUND);
	scene.environment = environment;
	scene.environmentIntensity = 0.3; // three uses this for a scene environment, not the material's envMapIntensity
	scene.add(floor(bounds), lights(bounds));
	const body = clip ? createClipGroup(clip, look) : null;
	if (body) scene.add(body.group);
	return { scene, setFrame(f) { body?.setFrame(f); } };
}

/**
 * The clip's characters (drawn with `look`) and its props in one group, for any three.js scene.
 * figures: false draws the props alone (the characters are drawn by someone else).
 * Returns { group, setFrame(f) }; a frame past the clip's end holds its last frame.
 */
export function createClipGroup(clip, look, { figures = true } = {}) {
	const group = new THREE.Group(), actors = [];
	if (figures) clip.characters.forEach((c, i) => {
		const body = (LOOKS[look] ?? LOOKS.box)({ tint: TINTS[i % TINTS.length] });
		group.add(body.object3D);
		const grip = handGrips(clip, i); // which hand holds a prop at each frame; a look may close it into a fist
		actors.push(f => body.setPose(c.pos, c.quat, f, { Left: grip.Left[f], Right: grip.Right[f] }));
	});
	for (const p of clip.props ?? []) {
		const mesh = new THREE.Mesh(p.shape === "sphere" ? new THREE.SphereGeometry(p.size[0] / 2, 24, 16) : new THREE.BoxGeometry(...p.size), clayMaterial(PROP_TINT));
		mesh.castShadow = mesh.receiveShadow = true;
		group.add(mesh);
		const n = p.pos.length / 3;
		actors.push(f => {
			const k = Math.min(f, n - 1);
			mesh.position.fromArray(p.pos, k * 3);
			mesh.quaternion.fromArray(p.quat, k * 4);
		});
	}
	const last = clip.frameCount - 1;
	return { group, setFrame(f) { const k = Math.max(0, Math.min(f, last)); for (const a of actors) a(k); } };
}

/** True when a parsed clip has the array lengths the looks index into. */
export function clipUsable(clip) {
	return clip?.schema === "lowvis.clip.v1" && Number.isInteger(clip.frameCount) && clip.frameCount > 0 && clip.characters?.length > 0
		&& clip.characters.every(c => c.pos?.length === clip.frameCount * JOINT_COUNT * 3 && c.quat?.length === clip.frameCount * JOINT_COUNT * 4);
}
