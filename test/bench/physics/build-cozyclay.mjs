#!/usr/bin/env node
// Set -> CozyClay project document (docs/qa/physics-bench.md, PR 1): an Animation project with the set's objects and
// one Y Bot (castStyle rig), the shape the Studio opens through window.__cozyclayProject.open.
//   node test/bench/physics/build-cozyclay.mjs <set id or task number> [--out file.cclayproject]
// Object records sit on their base pivot (bottom centre, src/motion3/scene.js) and turn by Euler XYZ in degrees,
// so a cylinder along X is a Y cylinder turned rotZ -90 with its pivot at the -X end, and along Z one turned rotX 90.
import { writeFileSync } from "node:fs";
import { loadSets } from "./sets.mjs";

const SAVED_AT = 1792200000000; // fixed, so a set always builds the same bytes

function recordOf(o) {
	const base = { id: o.id, name: o.name, renderer: "cube", x: 0, y: 0, z: 0, rot: 0, rotX: 0, rotZ: 0, scaleX: 1, scaleY: 1, scaleZ: 1,
		path: null, color: o.color ?? "#b0bec5", parent: o.parent ?? null, attach: null, hidden: false, footprint: { width: 1, depth: 1 }, height: 1, supportY: 1 };
	const [cx, cy, cz] = o.center;
	if (o.shape === "group") return { ...base, renderer: "empty", x: cx, y: cy, z: cz, color: "#ffffff", footprint: { width: 0, depth: 0 }, height: 0, supportY: 0 };
	const [sx, sy, sz] = o.size;
	if (o.shape === "box") return { ...base, x: cx, y: cy - sy / 2, z: cz, scaleX: sx, scaleY: sy, scaleZ: sz };
	const cyl = { ...base, renderer: "cylinder" };
	if (o.axis === "y") return { ...cyl, x: cx, y: cy - sy / 2, z: cz, scaleX: sx, scaleY: sy, scaleZ: sz };
	if (o.axis === "x") return { ...cyl, x: cx - sx / 2, y: cy, z: cz, rotZ: -90, scaleX: sy, scaleY: sx, scaleZ: sy };
	return { ...cyl, x: cx, y: cy, z: cz - sz / 2, rotX: 90, scaleX: sx, scaleY: sz, scaleZ: sx };
}

function characterOf(c) {
	const [x, y, z] = c.position;
	return { id: c.id, model: c.rig, posture: "stand", x, y, z, rot: 0, hidden: false, parent: null, tint: null, pose: null,
		identityImage: null, scale: 1, subject: "a person", layer: { waypoints: [] }, ikEdits: null };
}

const STAGE = {
	hasCharSheet: false, environmentImage: null, shotAspect: "16:9", cameraPresetId: null, sensorId: "fullFrame",
	keyLight: { x: 6, y: 9, z: 4, intensity: 1.12, warmth: 0.5, color: null },
	lighting: { preset: "studio", sky: null, skyTop: null, ambient: 1, hemiSky: "#ffffff", hemiGround: "#5a5d64", fill: 1, fog: 0, exposure: 1,
		shadowSoftness: 0, envLight: 0, ao: 0, hdr: null, hdrRotation: 0, hdrIntensity: 1, hdrBackground: true },
	environment: "", style: "", hasEnvSheet: false,
};

/** The project document for one set. */
export function cozyclayDoc(set) {
	const sceneId = `scene-bench-${set.id}`;
	return {
		app: "cozyclay", kind: "project", version: 5, name: `Physics bench ${set.id}`, previsMode: "animation", savedAt: SAVED_AT,
		scenes: { version: 5, activeSceneId: sceneId, scenes: [{
			id: sceneId, name: "SCENE 01", shotDocument: { version: 5, frameCount: 240, waypoints: [], shots: [] },
			stage: { ...STAGE, characters: [characterOf(set.character)] }, order: 0, objects: set.objects.map(recordOf),
		}] },
		workspace: { hierarchyWidth: 300, sidebarWidth: 380, timelineHeight: 224, insetWidth: 310, insetHeight: 310, insetCollapsed: false, planZoom: 1 },
		poseLibrary: [], workflow: { version: 1, nodes: [], edges: [] }, resources: { assets: [] }, castStyle: "rig",
	};
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const [which] = process.argv.slice(2), at = process.argv.indexOf("--out");
	const [set] = loadSets([which]);
	if (!set) { console.error("usage: build-cozyclay.mjs <set id or task number> [--out file]"); process.exit(2); }
	const text = `${JSON.stringify(cozyclayDoc(set), null, "\t")}\n`;
	if (at > 0) writeFileSync(process.argv[at + 1], text); else process.stdout.write(text);
}
