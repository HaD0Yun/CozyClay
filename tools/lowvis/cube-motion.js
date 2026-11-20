// The page of tools/lowvis/cube-motion.mjs: lanes side by side, each one clip (built by the tool with engine-simple)
// drawn with the cube look, all with one orthographic camera, over a 2.0 x 0.9 m door and lines every 0.25 m.
// window.cubeMotion.load(data) -> { frames, heights }, then seek(f) draws frame f.
import * as THREE from "three";
import { CUBE_SHAPE, CUBE_SHAPE_B, cube } from "../../src/lowvis/looks/cube.js";
import { sizedLook } from "../../src/lowvis/looks/index.js";
import { handGrips } from "../../src/lowvis/grip.js";

const VIEWS = { three: [0.82, 0, 0.57], side: [-1, 0, 0] }; // from the scene to the camera; level, so heights read true
const VOLUME = [[-0.6, 1.8], [0, 2.1], [-0.4, 1.85]]; // x, y, z the lanes' content stays in (m)
const LABEL_H = 150;

function load({ view, b, width, height, props, lanes }) {
	const shapes = { now: CUBE_SHAPE, b: { ...CUBE_SHAPE_B, ...b } };
	const canvas = document.getElementById("c"), renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
	renderer.setPixelRatio(1);
	renderer.setSize(width, height);
	renderer.setScissorTest(true);
	const dir = new THREE.Vector3(...VIEWS[view]).normalize(), up = new THREE.Vector3(0, 1, 0), right = up.clone().cross(dir).normalize();
	// the camera's window: the volume's corners across right and up, widened to the lane's aspect
	let u0 = Infinity, u1 = -Infinity;
	for (const x of VOLUME[0]) for (const z of VOLUME[2]) { const u = right.dot(new THREE.Vector3(x, 0, z)); u0 = Math.min(u0, u); u1 = Math.max(u1, u); }
	const laneW = width / lanes.length, laneH = height - LABEL_H, aspect = laneW / laneH;
	const y0 = VOLUME[1][0] - 0.05, wNeed = u1 - u0 + 0.1, hNeed = VOLUME[1][1] - y0;
	const halfW = Math.max(wNeed, hNeed * aspect) / 2, halfH = halfW / aspect, cu = (u0 + u1) / 2, y1 = y0 + 2 * halfH; // the floor low in the lane
	const centre = right.clone().multiplyScalar(cu);
	const camera = new THREE.OrthographicCamera(-halfW, halfW, y1, y0, 0.1, 40);
	camera.position.copy(centre).addScaledVector(dir, 15).setY(0);
	camera.up.copy(up);
	camera.lookAt(camera.position.clone().sub(dir));
	const back = centre.clone().addScaledVector(dir, -4); // the plane of the door and the lines, behind everything
	const onBack = (u, y) => back.clone().addScaledVector(right, u - cu).setY(y);
	const pxPerM = laneH / (y1 - y0);

	const lineMat = c => new THREE.LineBasicMaterial({ color: c });
	const propMat = new THREE.MeshStandardMaterial({ color: "#c9c4bb", roughness: 0.85, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
	const ink = lineMat("#5a5650");
	const scenes = lanes.map((lane, i) => {
		const scene = new THREE.Scene();
		scene.background = new THREE.Color("#f2f1ee");
		scene.add(new THREE.HemisphereLight("#ffffff", "#b8b4ac", 2.2));
		const sun = new THREE.DirectionalLight("#ffffff", 1.6);
		sun.position.set(2, 4, 6);
		scene.add(sun);
		const line = (pts, m) => scene.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), m));
		for (let k = 0; k <= 8; k++) line([onBack(cu - halfW, k * 0.25), onBack(cu + halfW, k * 0.25)], lineMat(k === 0 ? "#555" : k % 2 ? "#dedbd5" : "#b9b5ae"));
		const du = cu - halfW + 0.12;
		line([onBack(du, 0), onBack(du, 2), onBack(du + 0.9, 2), onBack(du + 0.9, 0)], lineMat("#555"));
		const meshes = props.map(p => {
			const g = new THREE.BoxGeometry(...p.size), m = new THREE.Mesh(g, propMat);
			m.add(new THREE.LineSegments(new THREE.EdgesGeometry(g), ink));
			m.position.fromArray(p.at);
			scene.add(m);
			return m;
		});
		const c = lane.clip.characters[0], look = sizedLook(cube({ shape: shapes[lane.shape] }), c.scale ?? 1), grip = handGrips(lane.clip, 0);
		scene.add(look.object3D);
		const clipProps = lane.clip.props.map(cp => ({ cp, mesh: meshes[props.findIndex(p => p.id === cp.id)] }));
		const set = f => {
			look.setPose(c.pos, c.quat, f, { Left: grip.Left[f], Right: grip.Right[f] });
			for (const { cp, mesh } of clipProps) { const n = cp.pos.length / 3, k = Math.min(f, n - 1); mesh.position.fromArray(cp.pos, k * 3); mesh.quaternion.fromArray(cp.quat, k * 4); }
		};
		set(0);
		look.object3D.updateWorldMatrix(true, true);
		const box = new THREE.Box3(), v = new THREE.Vector3();
		look.object3D.traverse(m => { if (!m.isMesh || !m.visible || !m.parent.visible) return; const a = m.geometry.attributes.position; for (let j = 0; j < a.count; j++) box.expandByPoint(v.fromBufferAttribute(a, j).applyMatrix4(m.matrixWorld)); });
		const label = document.createElement("div");
		label.className = "t label";
		label.innerHTML = `<b>${lane.name}</b><br>scale ${lane.scale.toFixed(2)} · height ${box.max.y.toFixed(2)} m`;
		label.style.left = `${(i + 0.5) * laneW}px`;
		label.style.top = `${laneH + 18}px`;
		document.body.appendChild(label);
		for (let k = 0; k <= 4; k++) {
			const t = document.createElement("div");
			t.className = "t tick";
			t.textContent = `${(k * 0.5).toFixed(1)}`;
			t.style.left = `${i * laneW + laneW - 34}px`;
			t.style.top = `${laneH - (k * 0.5 - y0) * pxPerM - 20}px`;
			document.body.appendChild(t);
		}
		return { scene, set, height: box.max.y };
	});
	const frameText = document.createElement("div");
	frameText.className = "t frame";
	document.body.appendChild(frameText);
	const frames = lanes[0].clip.frameCount;
	window.cubeMotion.seek = f => {
		frameText.textContent = `frame ${f} / ${frames} · 24 fps · ${view === "side" ? "side" : "three-quarter front"}, orthographic, same scale in every lane`;
		scenes.forEach(({ scene, set }, i) => {
			set(f);
			renderer.setViewport(i * laneW, LABEL_H, laneW, laneH);
			renderer.setScissor(i * laneW, 0, laneW, height);
			renderer.setClearColor("#f2f1ee");
			renderer.clear();
			renderer.render(scene, camera);
		});
		return true;
	};
	return { frames, heights: scenes.map(s => s.height) };
}

window.cubeMotion = { load };
