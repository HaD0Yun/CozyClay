// The page of tools/lowvis/cube-motion.mjs: lanes side by side, each one clip (built by the tool with engine-simple)
// drawn with the cube look under an orthographic camera of the same scale in every lane (a lane may have its own view
// direction), over a 2.0 x 0.9 m door and lines every 0.25 m.
// window.cubeMotion.load(data) -> { frames, heights, height, pxPerM }, then seek(f) draws frame f. data.ui: how many
// times the pixels of the text and the label strip (1 = sized for an 800 px tall picture). data.height null: one
// scale for every lane, the largest at which each lane's content fits its width, and the picture as tall as 2.2 m of
// it plus the label strip; the height numbers then only at the right edge.
import * as THREE from "three";
import { CUBE_SHAPE, cube } from "../../src/lowvis/looks/cube.js";
import { sizedLook } from "../../src/lowvis/looks/index.js";
import { handGrips } from "../../src/lowvis/grip.js";

const VIEWS = { three: [0.82, 0, 0.57], side: [-1, 0, 0] }; // from the scene to the camera; level, so heights read true
const NAMES = { three: "three-quarter front", side: "side" };
const VOLUME = [[-0.6, 1.8], [0, 2.1], [-0.4, 1.85]]; // x, y, z the lanes' content stays in (m)

function load({ view, shapes: named, width, height: asked, props, lanes, ui = 1 }) {
	const shapes = { look: CUBE_SHAPE, ...Object.fromEntries(Object.entries(named).map(([k, v]) => [k, { ...CUBE_SHAPE, ...v }])) };
	const canvas = document.getElementById("c"), renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
	const LABEL_H = lanes.length > 1 ? Math.round(150 * ui) : 0; // one lane: it fills the picture and its label sits in a corner
	const laneW = width / lanes.length, fit = asked == null, axes = v => { const dir = new THREE.Vector3(...VIEWS[v]).normalize(), up = new THREE.Vector3(0, 1, 0); return { dir, up, right: up.clone().cross(dir).normalize() }; };
	const spanOf = v => { const { right } = axes(v); let u0 = Infinity, u1 = -Infinity; for (const x of VOLUME[0]) for (const z of VOLUME[2]) { const u = right.dot(new THREE.Vector3(x, 0, z)); u0 = Math.min(u0, u); u1 = Math.max(u1, u); } return [u0, u1]; };
	const fitPx = Math.min(...lanes.map(l => { const [u0, u1] = spanOf(l.view || view); return laneW / (u1 - u0 + 0.1); }));
	const height = fit ? 2 * Math.ceil(((VOLUME[1][1] + 0.1 + 0.05) * fitPx + LABEL_H) / 2) : asked;
	const laneH = height - LABEL_H, aspect = laneW / laneH;
	renderer.setPixelRatio(1);
	renderer.setSize(width, height);
	renderer.setScissorTest(true);
	const sized = (el, origin) => { if (ui !== 1) Object.assign(el.style, { transform: `${el.style.transform || ""} scale(${ui})`.trim(), transformOrigin: origin }); return el; };

	/** The camera of view `v`: the volume's corners across right and up, widened to the lane's aspect. */
	function cameraOf(v) {
		const { dir, up, right } = axes(v), [u0, u1] = spanOf(v);
		const y0 = VOLUME[1][0] - 0.05, wNeed = u1 - u0 + 0.1, hNeed = VOLUME[1][1] - y0;
		const halfW = fit ? laneW / fitPx / 2 : Math.max(wNeed, hNeed * aspect) / 2, halfH = halfW / aspect, cu = (u0 + u1) / 2, y1 = y0 + 2 * halfH; // the floor low in the lane
		const centre = right.clone().multiplyScalar(cu);
		const camera = new THREE.OrthographicCamera(-halfW, halfW, y1, y0, 0.1, 40);
		camera.position.copy(centre).addScaledVector(dir, 15).setY(0);
		camera.up.copy(up);
		camera.lookAt(camera.position.clone().sub(dir));
		const back = centre.clone().addScaledVector(dir, -4); // the plane of the door and the lines, behind everything
		return { camera, y0, y1, cu, halfW, onBack: (u, y) => back.clone().addScaledVector(right, u - cu).setY(y) };
	}

	const lineMat = c => new THREE.LineBasicMaterial({ color: c });
	const propMat = new THREE.MeshStandardMaterial({ color: "#c9c4bb", roughness: 0.85, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
	const ink = lineMat("#5a5650");
	const scenes = lanes.map((lane, i) => {
		const v = lane.view || view, { camera, y0, y1, cu, halfW, onBack } = cameraOf(v), pxPerM = laneH / (y1 - y0);
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
		const box = new THREE.Box3(), p3 = new THREE.Vector3();
		look.object3D.traverse(m => { if (!m.isMesh || !m.visible || !m.parent.visible) return; const a = m.geometry.attributes.position; for (let j = 0; j < a.count; j++) box.expandByPoint(p3.fromBufferAttribute(a, j).applyMatrix4(m.matrixWorld)); });
		const label = document.createElement("div");
		label.className = LABEL_H ? "t label" : "t corner";
		label.innerHTML = `<b>${lane.name}</b><br>scale ${lane.scale.toFixed(2)} · height ${box.max.y.toFixed(2)} m`;
		if (LABEL_H) Object.assign(label.style, { left: `${(i + 0.5) * laneW}px`, top: `${laneH + 18 * ui}px`, transform: "translateX(-50%)" });
		document.body.appendChild(sized(label, LABEL_H ? "top center" : "bottom right"));
		for (let k = 0; k <= 4 && (!fit || i === lanes.length - 1); k++) {
			const t = document.createElement("div");
			t.className = "t tick";
			t.textContent = `${(k * 0.5).toFixed(1)}`;
			t.style.left = `${i * laneW + laneW - 34 * ui}px`;
			t.style.top = `${laneH - (k * 0.5 - y0) * pxPerM - 20 * ui}px`;
			document.body.appendChild(sized(t, "top left"));
		}
		return { scene, set, camera, view: v, height: box.max.y, pxPerM };
	});
	const frameText = sized(document.createElement("div"), "top left");
	frameText.className = "t frame";
	document.body.appendChild(frameText);
	const frames = lanes[0].clip.frameCount, views = [...new Set(scenes.map(s => NAMES[s.view]))].join(" | ");
	window.cubeMotion.seek = f => {
		frameText.textContent = `frame ${f} / ${frames} · 24 fps · ${views}, orthographic${lanes.length > 1 ? ", same scale in every lane" : ""}`;
		scenes.forEach(({ scene, set, camera }, i) => {
			set(f);
			renderer.setViewport(i * laneW, LABEL_H, laneW, laneH);
			renderer.setScissor(i * laneW, 0, laneW, height);
			renderer.setClearColor("#f2f1ee");
			renderer.clear();
			renderer.render(scene, camera);
		});
		return true;
	};
	return { frames, heights: scenes.map(s => s.height), height, pxPerM: scenes[0].pxPerM };
}

window.cubeMotion = { load };
