// A comparison sheet of the cube look (src/lowvis/looks/cube.js): columns of one figure each, a front and a side view
// with the same orthographic camera, over a height ruler with a 2.0 x 0.9 m door and a 0.45 m box. Served by the dev
// server and captured by tools/lowvis/cube-sheet.mjs.
//   ?pose=stand|t   stand: the engine's idle (engine-simple), t: the rig's rest T-pose
//   &cols=A:look:0.81,...   letter:shape:scale; shape "look" = the look's own CUBE_SHAPE, any other = a key of &shapes
//   &shapes={"old":{"armTopX":0.177}}   named sets, each JSON fields laid over CUBE_SHAPE
import * as THREE from "three";
import { CUBE_SHAPE, cube } from "../../src/lowvis/looks/cube.js";
import { sizedLook } from "../../src/lowvis/looks/index.js";
import { buildClip } from "../../src/lowvis/engine-simple/engine.js";
import { INDEX, JOINT_COUNT, REST } from "../../src/lowvis/rig17.js";

const q = new URLSearchParams(location.search);
const T = q.get("pose") === "t";
const SHAPES = { look: CUBE_SHAPE, ...Object.fromEntries(Object.entries(JSON.parse(q.get("shapes") || "{}")).map(([k, v]) => [k, { ...CUBE_SHAPE, ...v }])) };
const COLS = (q.get("cols") || "look:look:0.81,look:look:1").split(",").map(s => { const [id, shape, scale] = s.split(":"); return { id, shape, scale: +scale }; });

const W = T ? 2.9 : 1.7, X0 = 2.3, TOTAL = X0 + COLS.length * W + 0.1, TOP = 2.15, FLOOR_PAD = 0.06;
const PX = 2400, PXM = PX / TOTAL, LABEL_PX = 240, HEIGHT = Math.round((TOP + FLOOR_PAD) * PXM + LABEL_PX);
const BOTTOM = -FLOOR_PAD - LABEL_PX / PXM;

const renderer = new THREE.WebGLRenderer({ canvas: document.getElementById("c"), antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(1);
renderer.setSize(PX, HEIGHT);
renderer.setClearColor("#f2f1ee");
const scene = new THREE.Scene();
const camera = new THREE.OrthographicCamera(0, TOTAL, TOP, BOTTOM, 0.1, 50);
camera.position.set(0, 0, 10);
scene.add(new THREE.HemisphereLight("#ffffff", "#b8b4ac", 2.2));
const sun = new THREE.DirectionalLight("#ffffff", 1.6);
sun.position.set(2, 4, 6);
scene.add(sun);

const sheet = document.getElementById("sheet");
const text = (cls, html, x, y) => { const d = document.createElement("div"); d.className = `t ${cls}`; d.innerHTML = html; d.style.left = `${x * PXM}px`; d.style.top = `${(TOP - y) * PXM}px`; sheet.appendChild(d); return d; };
const line = (pts, color, z = -2) => scene.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts.map(([x, y]) => new THREE.Vector3(x, y, z))), new THREE.LineBasicMaterial({ color })));

// The ruler behind everything, the door and the box.
for (let k = 0; k <= 8; k++) {
	const y = k * 0.25, major = k % 2 === 0;
	line([[0.45, y], [TOTAL, y]], k === 0 ? "#555" : major ? "#b5b1aa" : "#d9d6d0", -3);
	if (major) text("tick", `${y.toFixed(1)} m`, 0.06, y);
}
line([[0.6, 0], [0.6, 2], [1.5, 2], [1.5, 0]], "#555");
text("note", "door 2.0 x 0.9 m", 1.05, -0.03);
line([[1.65, 0], [1.65, 0.45], [2.1, 0.45], [2.1, 0]], "#555");
text("note", "box 0.45 m", 1.875, -0.03);

/** The world box of the visible meshes under `o` (vertex-exact). */
function boxOf(o) {
	const box = new THREE.Box3(), v = new THREE.Vector3();
	o.updateWorldMatrix(true, true);
	o.traverse(m => {
		if (!m.isMesh) return;
		for (let p = m; p; p = p.parent) if (!p.visible) return;
		const a = m.geometry.attributes.position;
		for (let i = 0; i < a.count; i++) box.expandByPoint(v.fromBufferAttribute(a, i).applyMatrix4(m.matrixWorld));
	});
	return box;
}

/** The pose arrays (one frame) of a figure at `scale`: the engine's idle, or the rest T-pose. */
function poseOf(scale) {
	if (T) return { pos: Float32Array.from(REST.flatMap(p => p.map(v => v * scale))), quat: Float32Array.from({ length: JOINT_COUNT * 4 }, (_, i) => (i % 4 === 3 ? 1 : 0)) };
	const { clip } = buildClip({ demo: "sheet", a: [[0, "idle"]] }, { frames: 1, characters: [{ id: "a", at: [0, 0], heading: 0, ...(scale !== 1 && { scale }) }], props: [] });
	return { pos: clip.characters[0].pos.slice(0, JOINT_COUNT * 3), quat: clip.characters[0].quat.slice(0, JOINT_COUNT * 4) };
}

/** The drawn arm at rest, scale 1: from the upper arm's shoulder end to the forearm's wrist end and to the hand's tip (open hand). */
function armOf(shape) {
	const look = cube({ shape }), j = name => look.object3D.children[INDEX[name]];
	look.setPose(Float32Array.from(REST.flat()), Float32Array.from({ length: JOINT_COUNT * 4 }, (_, i) => (i % 4 === 3 ? 1 : 0)));
	const start = boxOf(j("LeftArm")).min.x;
	return { toWrist: boxOf(j("LeftForeArm")).max.x - start, toTip: boxOf(j("LeftHand")).max.x - start, start };
}

const numbers = { pose: T ? "T-pose" : "standing (engine-simple idle)", shapes: SHAPES, columns: [] };
const f3 = v => v.toFixed(3), f2 = v => v.toFixed(2);
COLS.forEach((col, i) => {
	const shape = SHAPES[col.shape], s = col.scale, { pos, quat } = poseOf(s), cx = X0 + i * W;
	const views = [];
	for (const [k, turn, x] of [["front", 0, cx + (T ? 1.0 : 0.5)], ["side", Math.PI / 2, cx + (T ? 2.35 : 1.25)]]) {
		const look = sizedLook(cube({ shape }), s), holder = new THREE.Group();
		holder.add(look.object3D);
		holder.position.x = x;
		holder.rotation.y = turn;
		look.setPose(pos, quat, 0);
		scene.add(holder);
		views.push({ k, look, holder, x });
	}
	const fig = views[0].look.object3D, box = boxOf(fig), jn = name => fig.children[INDEX[name]];
	const armGap = boxOf(jn("LeftArm")).min.x - boxOf(jn("Spine2")).max.x; // front view: upper arm's inner side to the chest's side
	const arm = armOf(shape), wristY = pos[INDEX.LeftHand * 3 + 1];
	const head = shape.head.map(v => v * s);
	const n = {
		column: col.id, shape: col.shape, scale: s, head: head.map(v => +f3(v)), height: +f3(box.max.y), floor: +f3(box.min.y),
		wrist: +f3(wristY), handBottom: +f3(boxOf(jn("LeftHand")).min.y), armToWrist: +f3(arm.toWrist * s), armToTip: +f3(arm.toTip * s),
		armStart: +f3(arm.start * s), upperArmToChestX: +f3(armGap),
	};
	numbers.columns.push(n);
	const mid = cx + W / 2;
	text("label", `<b>${col.id}</b><br>scale ${f2(s)} · height ${f2(n.height)} m<br>head ${head.map(f3).join(" x ")} m<br>wrist ${T ? "(T-pose) " : ""}${f2(n.wrist)} m<br>arm ${f3(n.armToWrist)} / ${f3(n.armToTip)} m`, mid, -0.05);
	text("note", "front", views[0].x, TOP - 0.02).style.transform = "translateX(-50%)";
	text("note", "side", views[1].x, TOP - 0.02).style.transform = "translateX(-50%)";
});
text("note", `arm = shoulder end to wrist end / to hand tip, at rest · ${numbers.pose}`, TOTAL / 2, BOTTOM + 30 / PXM);

renderer.render(scene, camera);
document.getElementById("numbers").textContent = JSON.stringify(numbers);
document.title = "ready";
