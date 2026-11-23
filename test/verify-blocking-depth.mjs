#!/usr/bin/env node

// The blocking frame is the only thing that tells an AI how far away the
// subject is. The stage has no walls, so every depth cue it carries is one we
// put there on purpose: the grid's converging cells, the floor's distance
// shading and contact shadow, and a horizon the fog does not eat.
//
// Each of those was absent, and each went absent for a defensible reason
// (chrome belongs in the viewport; an unlit deck is cheap; a fogged horizon is
// tidy). These checks pin the reasons back to the surface that needs them, so
// a future cleanup cannot quietly flatten the deliverable again.

import { readFileSync } from "node:fs";
import * as THREE from "three";
import { composePrompt, deriveShot } from "../src/shot.js";
import { followSet } from "../src/stage-shadow-fit.js";
import { WORLD_SCALES } from "../src/world-scale.js";

let failures = 0;
const expect = (name, condition, detail = "") => {
	console.log(`${condition ? "PASS" : "FAIL"} ${name}${condition ? "" : ` — ${detail}`}`);
	if (!condition) failures += 1;
};

// The studio source spans App.jsx and app-stage.jsx (module-level extraction); pin against both.
const app = readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8")
	+ readFileSync(new URL("../src/app-stage.jsx", import.meta.url), "utf8")
	+ readFileSync(new URL("../src/stage-capture.jsx", import.meta.url), "utf8")
	+ readFileSync(new URL("../src/stage-characters.jsx", import.meta.url), "utf8");
const room = readFileSync(new URL("../src/room.jsx", import.meta.url), "utf8");
const look = readFileSync(new URL("../src/stage-lighting.js", import.meta.url), "utf8");

/* --- the grid is baked into the deck, not floated over it ----------------- */

// A helper two millimetres above a 500 m plane loses to the floor across the
// whole frame and survives only at the grazed horizon, which is where it is
// useless. Drawing the lines in the floor's own shader ends that contest; the
// lines are computed per pixel (fwidth), so they stay ~1 px at any distance
// and fade out before they alias into a moire band.
expect("the deck draws its grid in its own shader", room.includes("function makeDeckMaterial(light)") && room.includes("material.onBeforeCompile") && room.includes("material={material}"));
expect("the grid has metre lines and heavier ten-metre lines", room.includes("gridLines(1.0, 1.0)") && room.includes("gridLines(${TILE_M.toFixed(1)}, 1.6)") && room.includes("const TILE_M = 10;"));
expect("the grid lines are pixel-wide and fade before they alias", room.includes("fwidth(cell)") && room.includes("1.0 - smoothstep(0.08, 0.2,"));
expect("the material is released with the room", room.includes("material.dispose()"));
expect("no floating grid helper is layered over the deck", !app.includes("new THREE.GridHelper"));

/* --- the floor shades with distance and takes a contact shadow ------------- */

// a diffuse standard surface, so it takes the finish's surface look like the rest of the set
expect("the deck is lit rather than flat-filled", room.includes("new THREE.MeshPhysicalMaterial({") && room.includes("specularIntensity: 0,") && room.includes("color: light ? FLOOR_LIGHT : FLOOR,"));
expect("the deck receives shadow", room.includes("receiveShadow"));
expect("the key light casts one shadow", (room.match(/castShadow/g) ?? []).length === 1 && room.includes("ref={key}"));
// The box follows the set for each draw (measured at the end of this file) rather than the whole 500 m deck.
expect("the shadow frustum covers the blocking area, not the whole 500 m deck", room.includes("followSet(key.current)"));
expect("the renderer actually has shadows enabled", app.includes("<Canvas") && app.includes("shadows") && app.includes("frameloop={renderActive ?"));
expect("the subject casts its own shadow", app.includes("child.castShadow = true;"));

/* --- the exported frame keeps a horizon ------------------------------------ */

// Both fog bounds must stay inside the shot camera's far plane (100 m in the
// room), or the deck is clipped mid-fade and the horizon never resolves.
expect("the capture fog stays inside the camera far plane at every world scale",
	Object.values(WORLD_SCALES).every((world) => world.horizon.near < world.horizon.far && world.horizon.far < world.cameraFar) &&
	app.includes("const CAPTURE_FOG_FAR = WORLD.horizon.far;") && app.includes("far={WORLD.cameraFar}"));
expect("the room keeps its 55-95 m export horizon and 100 m far plane",
	WORLD_SCALES.room.horizon.near === 55 && WORLD_SCALES.room.horizon.far === 95 && WORLD_SCALES.room.cameraFar === 100);
expect(
	"the capture pushes the fog back and restores it",
	app.includes("const CAPTURE_FOG_NEAR = WORLD.horizon.near;") &&
	// haze (stage.lighting.fog) brings its own range; without it the export horizon stands
	app.includes("fog.near = look?.fog?.near ?? CAPTURE_FOG_NEAR;") &&
	app.includes("fog.near = fogNear;") &&
	look.includes("captureFog: l.fog > 0 ? haze : null"),
);
expect(
	"the viewport fog is untouched",
	// Clay stage keeps its tuned values; grid view swaps to the void fog whose
	// far plane also sits below CAPTURE_FOG_NEAR, so the capture trick holds.
	look.includes("base = neutral ? GRID_FOG : themed ? { near: 18, far: 54 } : hazeRange(0)") && look.includes("near: Math.min(base.near, haze.near), far: Math.min(base.far, haze.far)"),
);
const captureFog = app.indexOf("fog.near = look?.fog?.near ?? CAPTURE_FOG_NEAR;");
const restoreFog = app.indexOf("fog.near = fogNear;");
expect("the restore happens after the render, in a finally", captureFog > 0 && restoreFog > captureFog);

/* --- the AI is told to read the grid, not draw it -------------------------- */

const shot = deriveShot({ x: 0, y: 1.6, z: 3 }, { x: 0, z: 0, rot: 0 }, (45 * Math.PI) / 180);
const prompt = composePrompt({
	shot,
	subjects: [{ description: "a young woman in a tan coat", posePhrase: "" }],
	environment: "a sunlit modern living room",
	style: "35mm film look",
});
expect("the prompt explains the grid encodes distance", /grid is a measuring aid/i.test(prompt), prompt.slice(0, 120));
expect("the prompt forbids drawing the grid", /do NOT draw the grid itself/i.test(prompt));
expect("the grid joins the do-not-reproduce list", /measurement grid/i.test(prompt));

const sheeted = composePrompt({
	shot,
	subjects: [{ description: "a young woman in a tan coat", posePhrase: "" }],
	environment: "a sunlit modern living room",
	style: "35mm film look",
	hasCharSheet: true,
	hasEnvSheet: true,
});
expect("sheet mode still carries the grid instruction", /do NOT draw the grid itself/i.test(sheeted));
expect("sheet mode drops the preset subject and environment text", !sheeted.includes("tan coat") && !sheeted.includes("sunlit modern living room"));

/* --- the key's shadow box follows the set (src/stage-shadow-fit.js) -------- */

// A figure 20 m from the origin shadows the deck around it (the old fixed box stopped at 14 m); a set that fits the
// old 28 m box keeps its texel density; only what can cast into the camera's view sizes the box; a wider box keeps the
// penumbra's width in metres; and the same draw fits the same box.
{
	const scene = new THREE.Scene();
	const light = new THREE.DirectionalLight("#ffffff", 1);
	light.position.set(6, 9, 4);
	light.castShadow = true;
	light.userData.shadowRadius = 2;
	scene.add(light);
	const box = (x, z) => {
		const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.5, 1.8, 0.5), new THREE.MeshStandardMaterial());
		mesh.position.set(x, 0.9, z);
		mesh.castShadow = true;
		scene.add(mesh);
		return mesh;
	};
	const home = box(0, 0), far = box(20, -3);
	const undo = followSet(light);
	const camera = (eye, at) => {
		const cam = new THREE.PerspectiveCamera(40, 16 / 9, 0.1, 100);
		cam.position.set(...eye);
		cam.lookAt(...at);
		cam.updateMatrixWorld();
		return cam;
	};
	// a world point is in the fitted map when every texture coordinate is in 0..1
	const inMap = (point) => { const p = new THREE.Vector4(...point, 1).applyMatrix4(light.shadow.matrix); return [p.x, p.y, p.z].every((v) => v >= 0 && v <= 1); };
	const fit = (cam) => {
		scene.updateMatrixWorld(true);
		light.shadow.updateMatrices(light, cam);
		return { width: light.shadow.camera.right - light.shadow.camera.left, radius: light.shadow.radius, matrix: light.shadow.matrix.toArray() };
	};
	const beside = camera([22.6, 1.6, 1.4], [20, 0.9, -3]), besideFit = fit(beside);
	expect("a figure 20 m out casts onto the deck around it", inMap([20, 1.8, -3]) && inMap([20, 0, -3]) && inMap([19, 0, -4.5]));
	expect("a set that fits the old 28 m box keeps its texel density and its kernel", besideFit.width === 28 && besideFit.radius === 2 && light.shadow.mapSize.x === 2048, `${besideFit.width} m, radius ${besideFit.radius}`);
	expect("the same draw fits the same box", JSON.stringify(fit(beside).matrix) === JSON.stringify(besideFit.matrix));
	// the camera beside the far figure looks away from the one at home, 20 m behind it: that one cannot cast into the view
	const alone = light.shadow.camera.left;
	home.position.set(0, 0.9, 3);
	expect("a caster that cannot cast into the view does not move the box", fit(beside).width === 28 && light.shadow.camera.left === alone);
	home.position.set(0, 0.9, 0);
	const wideFit = fit(camera([10, 6, 16], [10, 0, -2]));
	expect("a camera that sees both figures shadows both", inMap([0, 1.8, 0]) && inMap([20, 1.8, -3]) && wideFit.width === 28);
	far.position.x += 0.003;
	const moved = fit(beside), left = light.shadow.camera.left / (moved.width / 2048);
	expect("a figure that moves by a hair leaves the box edge on a texel, so shadow edges do not crawl", Math.abs(left - Math.round(left)) < 1e-6);
	// a walk of 6 m in view keeps the box's size: shadow edges move only when the size does
	const sizes = new Set();
	for (let step = 0; step <= 12; step += 1) { far.position.x = 17 + step * 0.5; sizes.add(fit(beside).width); }
	far.position.x = 20;
	expect("a walk across the view keeps the box's size", sizes.size === 1, [...sizes].join(","));
	// a set wider than the old box: a wider box of the ladder, with the kernel narrowed in texels
	const street = camera([-10, 10, 30], [15, 0, -5]);
	const lamp = box(45, -20);
	const streetFit = fit(street);
	expect("a set wider than 28 m takes a wider box that holds it", [32, 40, 48, 56, 64, 80, 96, 120].includes(streetFit.width) && inMap([0, 1.8, 0]) && inMap([45, 1.8, -20]), `${streetFit.width} m`);
	expect("a wider box narrows the kernel in texels, so the penumbra keeps its width in metres", Math.abs(streetFit.radius * streetFit.width - 2 * 28) < 1e-9, String(streetFit.radius));
	lamp.position.set(20.5, 0.9, -3.5);
	const plan = new THREE.OrthographicCamera(-20, 20, 20, -20, 0.1, 200);
	plan.position.set(0, 100, 0);
	plan.lookAt(0, 0, 0);
	plan.updateMatrixWorld();
	home.position.set(-30, 0.9, 10);
	fit(plan);
	expect("without a perspective view (the plan) the box holds every caster", inMap([-30, 1.8, 10]) && inMap([20, 1.8, -3]));
	home.position.set(0, 0.9, 0);
	// an instanced mesh is where its instances are, not where its one geometry is
	const many = new THREE.InstancedMesh(new THREE.BoxGeometry(0.5, 1.8, 0.5), new THREE.MeshStandardMaterial(), 2);
	many.setMatrixAt(0, new THREE.Matrix4().makeTranslation(40, 0.9, -3));
	many.setMatrixAt(1, new THREE.Matrix4().makeTranslation(41, 0.9, -3));
	many.castShadow = true;
	scene.add(many);
	fit(camera([43, 1.6, 1.4], [40.5, 0.9, -3]));
	expect("an instanced mesh casts from where its instances stand", inMap([40, 1.8, -3]) && inMap([41, 0, -3]));
	undo();
	expect("the undo puts three's own fit back", !Object.hasOwn(light.shadow, "updateMatrices"));
}

if (failures) process.exit(1);
console.log("blocking-frame depth checks PASS");
