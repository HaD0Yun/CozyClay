// verify_result visual "closeup": one picture of up to 4 objects from three cameras of its own (closeup-framing.js),
// so the agent can judge the thing it just made close up. One export pass at the playhead (renderFrameBuffer with a
// `within` view, stage-capture.jsx): every other object and the cast are hidden, the stage floor, sky and lights
// stay, and a plain 1.8 m stand-in is drawn beside it for scale. The scene, the shot camera and the user's view are
// put back as they were; nothing is authored, so the revision and the undo history do not move.
import * as THREE from "three";
import { StudioProtocolError } from "./studio-agent-protocol.js";
import { tileRgba } from "./studio-contact-sheet.js";
import { CLOSEUP_PANE, FIGURE_HEIGHT, closeupCameras, closeupTargets, figureSpot } from "./closeup-framing.js";

const JPEG_QUALITY = 0.82, LABEL = { "three-quarter": "three-quarter", front: "front", side: "side (from +x)", top: "top (front down)" };
const drawn = node => node.isMesh || node.isLine || node.isPoints || node.isSprite;

/** The object id or character a node is drawn for: its nearest tagged ancestor. */
function ownerOf(node) {
	for (let at = node; at; at = at.parent) {
		if (at.userData?.sceneObjectId) return at.userData.sceneObjectId;
		if (at.userData?.characterPick) return "character";
	}
	return null;
}

/** A plain grey figure, feet at y 0, FIGURE_HEIGHT tall: never part of the scene except for this render. */
function standIn() {
	const group = new THREE.Group(), material = new THREE.MeshStandardMaterial({ color: 0x8c919b, roughness: 0.9 });
	const capsule = (r, length, x, y) => { const m = new THREE.Mesh(new THREE.CapsuleGeometry(r, length, 4, 12), material); m.position.set(x, y, 0); group.add(m); };
	for (const side of [-1, 1]) { capsule(0.075, 0.74, side * 0.1, 0.445); capsule(0.05, 0.56, side * 0.235, 1.12); }
	capsule(0.17, 0.42, 0, 1.24);
	const head = new THREE.Mesh(new THREE.SphereGeometry(0.11, 16, 12), material);
	head.position.y = FIGURE_HEIGHT - 0.11; group.add(head);
	return { group, dispose: () => { group.traverse(node => node.geometry?.dispose()); material.dispose(); } };
}

/** World box of the drawn meshes of `ids` (layer 0, visible), or null before they are drawn. */
function drawnBox(scene, ids) {
	const box = new THREE.Box3(), part = new THREE.Box3();
	scene.updateMatrixWorld(true);
	scene.traverse(node => {
		if (!drawn(node) || !node.layers.isEnabled(0) || !ids.has(ownerOf(node)) || !node.geometry) return;
		for (let at = node; at; at = at.parent) if (!at.visible) return;
		if (!node.geometry.boundingBox) node.geometry.computeBoundingBox();
		box.union(part.copy(node.geometry.boundingBox).applyMatrix4(node.matrixWorld));
	});
	return box.isEmpty() ? null : { min: box.min.toArray(), max: box.max.toArray() };
}

/** Every sculpt among `records` is drawn from its current recipe (props.jsx tags the built group): a re-sculpt the
 * editor has not drawn yet would show the old shape. */
function drawnAsAuthored(scene, records) {
	const recipes = new Map();
	scene.traverse(node => { if (node.userData?.sculptRecipe) recipes.set(ownerOf(node), node.userData.sculptRecipe); });
	return records.every(o => !o.recipe || (recipes.has(o.id) && (recipes.get(o.id) === o.recipe || JSON.stringify(recipes.get(o.id)) === JSON.stringify(o.recipe))));
}

/** Rows bottom-up (read-back order) into a JPEG data URL, each pane labelled. */
function encode(sheet, names) {
	const canvas = document.createElement("canvas");
	canvas.width = sheet.width; canvas.height = sheet.height;
	const ctx = canvas.getContext("2d"), image = ctx.createImageData(sheet.width, sheet.height), row = sheet.width * 4;
	for (let y = 0; y < sheet.height; y++) image.data.set(sheet.data.subarray((sheet.height - 1 - y) * row, (sheet.height - y) * row), y * row);
	ctx.putImageData(image, 0, 0);
	ctx.font = "600 13px system-ui, sans-serif";
	names.forEach((name, i) => {
		const x = i * CLOSEUP_PANE.width, text = LABEL[name] + (name === "top" ? "" : ", figure 1.8 m");
		ctx.fillStyle = "rgba(0,0,0,0.55)"; ctx.fillRect(x + 6, 6, ctx.measureText(text).width + 12, 20);
		ctx.fillStyle = "#fff"; ctx.fillText(text, x + 12, 21);
		if (i) { ctx.fillStyle = "#16181d"; ctx.fillRect(x - 1, 0, 2, sheet.height); }
	});
	return canvas.toDataURL("image/jpeg", JPEG_QUALITY);
}

/** The closeup image and its visualRefs entry: [image, ref]. */
export function studioCloseup(args, { s, receipt, ports }) {
	const { targets, ids } = closeupTargets(args, s, receipt), keep = new Set(ids);
	if (typeof ports.renderFrameBuffer !== "function") throw new StudioProtocolError("CAPABILITY_MISSING", "This editor cannot render a closeup.");
	let cameras = null, box = null, refused = null;
	// the export pass rewraps what its render throws, so a refusal is kept here and thrown as itself
	const refuse = message => { refused = new StudioProtocolError("TARGET_NOT_READY", `visual "closeup": ${message}`); throw refused; };
	const within = (scene, shoot) => {
		if (!drawnAsAuthored(scene, s.objects.filter(o => keep.has(o.id)))) refuse(`${targets.join(", ")} is still being drawn; ask again in a moment.`);
		box = drawnBox(scene, keep);
		if (!box) refuse(`${targets.join(", ")} has nothing drawn yet.`);
		cameras = closeupCameras(box);
		const hidden = [], figure = standIn();
		scene.traverse(node => { if (drawn(node) && node.visible && ownerOf(node) && !keep.has(ownerOf(node))) { node.visible = false; hidden.push(node); } });
		scene.add(figure.group);
		try {
			return tileRgba(cameras.map(cam => { figure.group.visible = cam.name !== "top"; figure.group.position.fromArray(figureSpot(box, cam.name)); figure.group.updateMatrixWorld(true); return shoot(cam).slice(); }), CLOSEUP_PANE.width, CLOSEUP_PANE.height, { columns: cameras.length, rows: 1, bottomUp: true }).data;
		} finally {
			scene.remove(figure.group); figure.dispose();
			for (const node of hidden) node.visible = true;
		}
	};
	let sheet;
	try { sheet = ports.renderFrameBuffer(s.view.frame, { output: CLOSEUP_PANE, within }).data; } catch (error) { throw refused ?? error; }
	const names = cameras.map(c => c.name), round = v => v.map(n => Math.round(n * 100) / 100);
	const width = CLOSEUP_PANE.width * names.length, height = CLOSEUP_PANE.height;
	return [{ dataUrl: encode({ data: sheet, width, height }, names), width, height, kind: "closeup", views: names, frames: [s.view.frame] },
		{ kind: "closeup", targets, drawn: ids, views: names, layout: `${names.length}x1, left to right`, frame: s.view.frame,
			bounds: { min: round(box.min), max: round(box.max), size: round(box.max.map((v, i) => v - box.min[i])) },
			figure: { heightM: FIGURE_HEIGHT, at: Object.fromEntries(names.filter(n => n !== "top").map(n => [n, round(figureSpot(box, n))])) } }];
}
