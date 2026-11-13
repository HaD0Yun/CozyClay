// The lowvis viewer page (/lowvis/). See src/lowvis/README.md for the URL parameters and window.lowvis.
//   ?panels=<engine>/<demo>:<look>,...  &view=three|front|side|top  &cols=<n>  &autoplay=0  &caption=0
// One canvas; every panel is a scissored viewport with its own scene and the same camera.
import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { CLIP_FPS } from "../clip.js";
import { DEMOS } from "../demos.js";
import { LOOKS } from "../looks/index.js";
import { BACKGROUND, clipBounds, clipPoints, clipUsable, createPanelScene } from "./scene.js";

const params = new URLSearchParams(location.search);
const VIEW = params.get("view") || "three";
const CAPTION_H = params.get("caption") === "0" ? 0 : 44;
const FOV = 26;

// Direction from the framed volume to the camera, and the camera's up vector.
const VIEWS = {
	three: { dir: [0.62, 0.5, 1], up: [0, 1, 0] },
	front: { dir: [0, 0.06, 1], up: [0, 1, 0] },
	side: { dir: [1, 0.06, 0], up: [0, 1, 0] },
	top: { dir: [0, 1, 0], up: [0, 0, -1] }, // +X to the right, +Z down the screen
};

function parsePanels(text) {
	return (text || "sample/locomotion:box").split(",").map(s => s.trim()).filter(Boolean).map(entry => {
		const [path, look = "box"] = entry.split(":");
		const [engine, demo = "locomotion"] = path.split("/");
		return { engine, demo, look: LOOKS[look] ? look : "box", askedLook: look };
	});
}

async function loadClip({ engine, demo }) {
	try {
		const res = await fetch(`${import.meta.env.BASE_URL}lowvis/clips/${encodeURIComponent(engine)}/${encodeURIComponent(demo)}.json`, { cache: "no-store" });
		if (!res.ok) return null;
		const clip = JSON.parse(await res.text()); // a dev server answers a missing file with HTML: that throws here
		return clipUsable(clip) ? clip : null;
	} catch {
		return null;
	}
}

/**
 * The camera position that frames `points` (each padded by `pad` metres) as large as the panel allows, looking
 * along -view.dir: the tight fit of a perspective frustum with a fixed direction.
 */
function fitCamera(points, view, aspect, pad = 0.3) {
	const dir = new THREE.Vector3().fromArray(view.dir).normalize();
	const right = new THREE.Vector3().fromArray(view.up).cross(dir).normalize();
	const up = dir.clone().cross(right);
	const ty = Math.tan(THREE.MathUtils.degToRad(FOV / 2)), tx = ty * aspect;
	// In (right, up, dir) coordinates the camera sits at (cx, cy, D). A point is inside when
	// |x - cx| <= (D - z) * tx and |y - cy| <= (D - z) * ty.
	let xa = -Infinity, xb = -Infinity, ya = -Infinity, yb = -Infinity;
	const v = new THREE.Vector3();
	for (let i = 0; i < points.length; i += 3) {
		v.fromArray(points, i);
		const x = v.dot(right), y = v.dot(up), z = v.dot(dir) + pad;
		xa = Math.max(xa, x + pad + z * tx); xb = Math.max(xb, -x + pad + z * tx);
		ya = Math.max(ya, y + pad + z * ty); yb = Math.max(yb, -y + pad + z * ty);
	}
	const D = Math.max((xa + xb) / (2 * tx), (ya + yb) / (2 * ty)) * 1.03;
	const cx = (xa - xb) / 2, cy = (ya - yb) / 2;
	return { distance: D, position: right.clone().multiplyScalar(cx).addScaledVector(up, cy).addScaledVector(dir, D), dir };
}

async function start() {
	const specs = parsePanels(params.get("panels"));
	const clips = await Promise.all(specs.map(loadClip));
	const loaded = clips.filter(Boolean);

	// The same bounds for every panel: all clips, padded for the body around the joints (head top, hands, feet).
	const bounds = new THREE.Box3();
	for (const clip of loaded) clipBounds(clip, bounds);
	if (bounds.isEmpty()) bounds.set(new THREE.Vector3(-1, 0, -1), new THREE.Vector3(1, 1.8, 1));
	bounds.min.y = 0;
	bounds.expandByVector(new THREE.Vector3(0.25, 0, 0.25));
	bounds.max.y += 0.28;
	// What the camera frames: every joint of every frame, and the props.
	const points = loaded.flatMap(clip => clipPoints(clip));
	if (!points.length) points.push(-1, 0, -1, 1, 0, 1, 0, 1.6, 0);

	const canvas = document.getElementById("lowvis-canvas");
	const overlay = document.getElementById("lowvis-overlay");
	const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
	renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
	renderer.shadowMap.enabled = true;
	renderer.shadowMap.type = THREE.PCFShadowMap;
	renderer.setScissorTest(true);
	renderer.setClearColor(BACKGROUND);
	const environment = new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(), 0.04).texture;

	const panels = specs.map((spec, i) => {
		const clip = clips[i];
		const el = document.createElement("div");
		el.className = "lowvis-panel";
		const label = document.createElement("div");
		label.className = `lowvis-label${clip ? "" : " missing"}`;
		label.innerHTML = "";
		label.append(spec.engine);
		const small = document.createElement("small");
		small.textContent = clip ? `${spec.demo} · ${spec.look}` : `${spec.demo} · no clip`;
		label.append(small);
		el.append(label);
		if (clip?.notes?.length && params.get("notes") === "1") {
			const note = document.createElement("div");
			note.className = "lowvis-note";
			note.textContent = clip.notes.join(" / ");
			el.append(note);
		}
		overlay.append(el);
		return { spec, clip, el, ...createPanelScene({ clip, look: spec.look, bounds, environment }) };
	});

	const caption = document.createElement("div");
	caption.id = "lowvis-caption";
	if (CAPTION_H) overlay.append(caption);

	const fps = loaded[0]?.fps || CLIP_FPS;
	const frameCount = loaded.reduce((n, c) => Math.max(n, c.frameCount), 0) || 1;
	const demo = DEMOS[specs[0].demo];
	const view = VIEWS[VIEW] ?? VIEWS.three;
	const camera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 200);
	let cols = 1, rows = 1, cellW = 1, cellH = 1;

	function layout() {
		const W = window.innerWidth, H = window.innerHeight - CAPTION_H, n = panels.length;
		renderer.setSize(W, window.innerHeight, false);
		const asked = Number(params.get("cols"));
		if (asked >= 1) cols = Math.min(n, Math.floor(asked));
		else {
			// The column count that shows the figure largest; side by side wins unless stacking is 12% closer.
			let best = Infinity;
			for (let c = n; c >= 1; c--) {
				const d = fitCamera(points, view, (W / c) / (H / Math.ceil(n / c))).distance;
				if (d < best * 0.88) { best = d; cols = c; }
			}
		}
		rows = Math.ceil(n / cols);
		cellW = W / cols; cellH = H / rows;
		panels.forEach((p, i) => {
			Object.assign(p.el.style, { left: `${(i % cols) * cellW}px`, top: `${Math.floor(i / cols) * cellH}px`, width: `${cellW}px`, height: `${cellH}px` });
		});
		camera.aspect = cellW / cellH;
		const fit = fitCamera(points, view, camera.aspect);
		camera.position.copy(fit.position);
		camera.up.fromArray(view.up);
		camera.lookAt(fit.position.clone().sub(fit.dir));
		camera.updateProjectionMatrix();
	}

	let frame = 0;
	function draw(f) {
		frame = Math.max(0, Math.min(Math.round(f), frameCount - 1));
		const H = window.innerHeight;
		panels.forEach((p, i) => {
			p.setFrame(frame);
			const x = (i % cols) * cellW, y = H - (Math.floor(i / cols) + 1) * cellH;
			renderer.setViewport(x, y, cellW, cellH);
			renderer.setScissor(x, y, cellW, cellH);
			renderer.render(p.scene, camera);
		});
		if (CAPTION_H) {
			const beats = (demo?.beats ?? []).filter(b => frame >= b.from && frame < b.to).map(b => `${b.who}: ${b.do}`).join("   |   ");
			caption.innerHTML = "";
			const name = document.createElement("b"); name.textContent = specs[0].demo;
			const count = document.createElement("span"); count.className = "frame";
			count.textContent = `frame ${String(frame).padStart(3, "0")} / ${frameCount - 1}   ${(frame / fps).toFixed(2)} s`;
			const beat = document.createElement("span"); beat.className = "beat"; beat.textContent = beats;
			caption.append(name, count, beat);
		}
	}
	const nextPaint = () => new Promise(resolve => requestAnimationFrame(() => resolve()));

	let playing = false, playStart = 0, playFrom = 0;
	function tick(now) {
		if (!playing) return;
		draw((playFrom + Math.floor(((now - playStart) / 1000) * fps)) % frameCount);
		requestAnimationFrame(tick);
	}
	const api = {
		fps, frameCount,
		panels: panels.map(p => ({ engine: p.spec.engine, demo: p.spec.demo, look: p.spec.look, loaded: !!p.clip, frameCount: p.clip?.frameCount ?? 0, stats: p.clip?.stats ?? null })),
		/** Draws exactly frame f in every panel; resolves once that frame has been presented. */
		async seek(f) {
			playing = false;
			draw(f);
			await nextPaint();
			return frame;
		},
		play() {
			if (playing) return;
			playing = true; playFrom = frame; playStart = performance.now();
			requestAnimationFrame(tick);
		},
		pause() { playing = false; },
	};

	layout();
	draw(0);
	window.addEventListener("resize", () => { layout(); draw(frame); });
	window.addEventListener("keydown", e => {
		if (e.key === " ") { if (playing) api.pause(); else api.play(); }
		if (e.key === "ArrowRight") api.seek(frame + 1);
		if (e.key === "ArrowLeft") api.seek(frame - 1);
	});
	await nextPaint();
	if (params.get("autoplay") !== "0") api.play();
	return api;
}

// `ready` exists at once; the rest of the API is filled in when it resolves.
const lowvis = { ready: null, fps: CLIP_FPS, frameCount: 0, seek: async f => (await lowvis.ready, lowvis.seek(f)), play() {}, pause() {} };
lowvis.ready = start().then(api => { Object.assign(lowvis, api); return lowvis; });
window.lowvis = lowvis;
