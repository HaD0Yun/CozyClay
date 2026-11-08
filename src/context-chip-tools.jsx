// The stage half of Annotate (context-chips.js): with the pen armed from the
// rail's Annotate cell, a press on the stage marks what is under it. The
// scene's meshes are hit first (objects, characters, the environment), the
// floor after (annotate-hits.js). A click marks one point, a closed loop rings
// what lies inside it (down to a character's joints), an open stroke runs
// along a body, an object or the floor; the line draws live while it moves. Every unsent mark stays drawn with its number,
// brighter while its chip is hovered; Cmd/Ctrl+Z takes the newest mark back
// (Shift redoes it) before the scene's own undo; Esc leaves the tool. The
// annotated picture Send attaches is drawn here (registerAnnotatedCapture).
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { Line } from "@react-three/drei";
import * as THREE from "three";
import { createFloorRaycastTools } from "./floor-raycast.js"; import { createAnnotateHits } from "./annotate-hits.js";
import { disarmViewportSketch, useViewportSketch, viewportSketch } from "./viewport-sketch.js";
import { readHighlightedMark, readMarks, redoMark, registerAnnotatedCapture, subscribeMarks, undoMark, updateMark } from "./context-chips.js";
import { createMark, nearestPoseBone } from "./context-chip-actions.js";
import { GIZMO_LAYER } from "./dualview.jsx";

const STROKE_STEP_PX = 4; // a new stroke sample every few pixels of pointer travel
const CLICK_PX = 6; // a press that travels less than this is a click: a point mark
const LIFT = 0.015; // marks ride just above what they lie on
const COLOUR = "#f2a33a", HOT = "#ff5a1f";
const typing = (target) => Boolean(target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(String(target.tagName ?? ""))));
const v3 = (p) => [p.x, p.y + LIFT, p.z];

/** Each number badge to its mark's anchor, through the stage's camera. */
function placeBadges(layer, camera, canvas) {
	const p = new THREE.Vector3(), width = canvas.clientWidth, height = canvas.clientHeight, marks = readMarks();
	for (const node of layer.children) {
		const mark = marks.find((entry) => entry.id === node.dataset.markId), anchor = mark && (mark.points[0] ?? mark.local?.anchor);
		if (!anchor) continue;
		p.set(anchor.x, anchor.y + LIFT, anchor.z).project(camera);
		node.style.display = p.z > 1 ? "none" : "";
		node.style.transform = `translate(${((p.x + 1) / 2) * width}px, ${((1 - p.y) / 2) * height}px) translate(-50%, -150%)`;
	}
}

export function ContextChipTools({ camRef }) {
	const { gl, scene, invalidate } = useThree();
	const sketch = useViewportSketch();
	const marks = useSyncExternalStore(subscribeMarks, readMarks, readMarks);
	const highlighted = useSyncExternalStore(subscribeMarks, readHighlightedMark, readHighlightedMark);
	const floorTools = useMemo(() => createFloorRaycastTools(), []);
	const groupRef = useRef(null);
	// What is being drawn right now: every pointermove lands here and the stage redraws at once (the loop may be on demand).
	const [live, setLive] = useState(null);

	useEffect(() => {
		const canvas = gl.domElement;
		const ours = (node) => { for (let at = node; at; at = at.parent) if (at === groupRef.current) return true; return false; };
		const { raycaster, ndc, floorAt, hitAt, readPen, normalized } = createAnnotateHits({ canvas, scene, camera: () => camRef.current, ours, floorTools });
		const show = (value) => {
			setLive(value);
			window.__cozyclayRouteSketch = { livePoints: value?.points.length ?? 0 }; // QA read: the live drawing's point count
			invalidate();
		};

		let drawing = null;
		const onMove = (event) => {
			if (!drawing) return;
			event.preventDefault();
			const last = drawing.screen.at(-1);
			drawing.travel = Math.max(drawing.travel, Math.hypot(event.clientX - drawing.screen[0].x, event.clientY - drawing.screen[0].y));
			if (Math.hypot(event.clientX - last.x, event.clientY - last.y) < STROKE_STEP_PX) return;
			const at = hitAt(event.clientX, event.clientY), floor = floorAt(event.clientX, event.clientY);
			if (!at) return;
			drawing.screen.push({ x: event.clientX, y: event.clientY });
			drawing.hits.push(at);
			drawing.points.push(at.point);
			if (floor) drawing.floor.push(floor);
			show({ points: drawing.points.slice() });
		};
		const stop = () => {
			drawing = null;
			window.removeEventListener("pointermove", onMove, true);
			window.removeEventListener("pointerup", onUp, true);
			show(null);
		};
		const onUp = (event) => {
			if (!drawing) return;
			event.preventDefault();
			event.stopPropagation();
			const done = drawing;
			stop();
			// A click (or a drag under CLICK_PX) marks the point under it; anything longer is a loop or a stroke.
			if (done.travel < CLICK_PX || done.points.length < 2) createMark("pen", { shape: "point", hit: done.hits[0].hit, points: [done.points[0]], screen: normalized([done.screen[0]]) });
			else createMark("pen", readPen(done));
		};
		const onDown = (event) => {
			const { tool, note } = viewportSketch();
			if (event.button !== 0 || event.target !== canvas || (!tool && !note)) return;
			if (note) {
				// The body under the click names the note's bone; a click beside it leaves the note armed.
				const camera = camRef.current;
				if (!note.rig || !camera) return;
				raycaster.setFromCamera(ndc(event.clientX, event.clientY), camera);
				const hit = raycaster.intersectObject(note.rig, true)[0];
				if (!hit) return;
				event.preventDefault();
				event.stopImmediatePropagation();
				note.onBone?.(nearestPoseBone(note.rig, hit.point));
				return;
			}
			event.preventDefault();
			event.stopImmediatePropagation();
			const at = hitAt(event.clientX, event.clientY);
			if (!at) return;
			// preventDefault keeps focus where it was: a composer left focused would keep Cmd/Ctrl+Z as its text undo.
			if (typing(document.activeElement)) document.activeElement.blur();
			drawing = { screen: [{ x: event.clientX, y: event.clientY }], hits: [at], points: [at.point], floor: [floorAt(event.clientX, event.clientY)].filter(Boolean), travel: 0 };
			show({ points: drawing.points.slice() });
			window.addEventListener("pointermove", onMove, true);
			window.addEventListener("pointerup", onUp, true);
		};
		const onKey = (event) => {
			if (event.key === "Escape" && (viewportSketch().tool || viewportSketch().note || drawing)) { stop(); disarmViewportSketch(); return; }
			// Unsent marks own Cmd/Ctrl+Z: the newest goes first, before any scene edit is undone.
			if (!["KeyZ", "KeyY"].includes(event.code) || !(event.metaKey || event.ctrlKey) || event.altKey || typing(event.target) || typing(document.activeElement)) return;
			if (event.shiftKey || event.code === "KeyY" ? redoMark() : undoMark()) { event.preventDefault(); event.stopImmediatePropagation(); }
		};
		// While the pen is armed the stage only draws: the mouse events and clicks that select, or that start a
		// gizmo drag, never reach the canvas's other listeners. The right button (the camera) passes.
		const swallow = (event) => { if (viewportSketch().tool && event.target === canvas && event.button === 0) event.stopImmediatePropagation(); };
		const swallowed = ["mousedown", "mouseup", "click", "dblclick"];
		for (const type of swallowed) window.addEventListener(type, swallow, true);
		window.addEventListener("pointerdown", onDown, true);
		window.addEventListener("keydown", onKey, true);
		return () => {
			for (const type of swallowed) window.removeEventListener(type, swallow, true);
			window.removeEventListener("pointerdown", onDown, true);
			window.removeEventListener("keydown", onKey, true);
			stop();
		};
	}, [gl, scene, camRef, floorTools, invalidate]);

	// The annotated picture: the view as drawn, marks and all, with each mark's number painted on.
	useEffect(() => registerAnnotatedCapture((list) => {
		const camera = camRef.current, source = gl.domElement;
		if (!camera) return null;
		// The agent's picture is the set plus the marks: every other piece of editor furniture (the transform gizmo,
		// camera bodies and frustums, paths, handles — all on GIZMO_LAYER) is hidden for this one render, then restored.
		const hidden = [];
		scene.traverse((node) => {
			if (!node.visible || !node.layers.isEnabled(GIZMO_LAYER) || node.layers.isEnabled(0)) return;
			for (let at = node; at; at = at.parent) if (at === groupRef.current) return;
			hidden.push(node);
		});
		for (const node of hidden) node.visible = false;
		try { gl.render(scene, camera); } finally { for (const node of hidden) node.visible = true; }
		const scale = Math.min(1, 1280 / source.width), out = document.createElement("canvas");
		out.width = Math.round(source.width * scale);
		out.height = Math.round(source.height * scale);
		const ctx = out.getContext("2d");
		ctx.drawImage(source, 0, 0, out.width, out.height);
		const radius = Math.max(10, out.width / 90);
		ctx.font = `600 ${Math.round(radius * 1.2)}px system-ui, sans-serif`;
		ctx.textAlign = "center";
		ctx.textBaseline = "middle";
		for (const mark of list) {
			const anchor = mark.points[0] ?? mark.local?.anchor;
			if (!anchor) continue;
			const p = new THREE.Vector3(anchor.x, anchor.y, anchor.z).project(camera);
			if (p.z > 1) continue;
			const x = ((p.x + 1) / 2) * out.width, y = ((1 - p.y) / 2) * out.height - radius * 1.4;
			ctx.fillStyle = COLOUR; ctx.strokeStyle = "#1c1a17"; ctx.lineWidth = 2;
			ctx.beginPath(); ctx.arc(x, y, radius, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
			ctx.fillStyle = "#1c1a17"; ctx.fillText(String(mark.n), x, y + 1);
		}
		return out.toDataURL("image/jpeg", 0.85);
	}), [gl, scene, camRef]);

	useEffect(() => {
		const root = document.documentElement, armed = sketch.tool ?? (sketch.note ? "note" : null);
		if (armed) root.dataset.viewportSketch = armed; else delete root.dataset.viewportSketch;
		return () => { delete root.dataset.viewportSketch; };
	}, [sketch.tool, sketch.note]);
	useEffect(() => { invalidate(); }, [marks, highlighted, invalidate]);
	// The number badges: screen-space DOM over the canvas (a layer the R3F tree cannot portal into, so kept
	// imperatively), placed through the stage's own camera every frame.
	const badgesRef = useRef(null);
	useEffect(() => {
		const layer = document.createElement("div");
		layer.className = "annotate-badges"; layer.setAttribute("aria-hidden", "true");
		gl.domElement.parentElement?.appendChild(layer);
		badgesRef.current = layer;
		return () => { layer.remove(); badgesRef.current = null; };
	}, [gl]);
	useEffect(() => {
		// A mark made off the stage (a timeline note) gets its place in the picture from its anchor.
		const camera = camRef.current;
		for (const mark of marks) if (!mark.screen?.length && mark.local?.anchor && camera) {
			const p = new THREE.Vector3(mark.local.anchor.x, mark.local.anchor.y, mark.local.anchor.z).project(camera);
			updateMark(mark.id, { screen: [{ x: Math.round(Math.min(1, Math.max(0, (p.x + 1) / 2)) * 1000) / 1000, y: Math.round(Math.min(1, Math.max(0, (1 - p.y) / 2)) * 1000) / 1000 }] });
		}
		badgesRef.current?.replaceChildren(...marks.map((mark) => {
			const node = document.createElement("span");
			node.className = "annotate-badge" + (mark.n === highlighted ? " hot" : "");
			Object.assign(node.dataset, { markBadge: String(mark.n), markId: mark.id });
			node.textContent = String(mark.n);
			return node;
		}));
		invalidate();
	}, [marks, highlighted, invalidate, camRef]);
	useFrame(() => { if (camRef.current && badgesRef.current) placeBadges(badgesRef.current, camRef.current, gl.domElement); });

	// Marks are editor furniture, like the gizmos: the editor view shows them, the shot camera and every export never do.
	// Every render: drei's lines mount asynchronously, and each new node must land on the gizmo layer.
	useEffect(() => { groupRef.current?.traverse((node) => node.layers.set(GIZMO_LAYER)); });

	return (
		<group ref={groupRef}>
			{live?.points.length > 1 && <Line points={live.points.map(v3)} color={COLOUR} lineWidth={3.5} depthTest={false} depthWrite={false} transparent renderOrder={999} />}
			{marks.map((mark) => {
				const hot = mark.n === highlighted;
				return (
					<group key={mark.id}>
						{mark.points.length > 1 && <Line points={mark.points.map(v3)} color={hot ? HOT : COLOUR} lineWidth={hot ? 5 : 3} depthTest={false} depthWrite={false} transparent renderOrder={998} />}
						{mark.points.length === 1 && (
							<mesh position={v3(mark.points[0])} renderOrder={998}>
								<sphereGeometry args={[hot ? 0.07 : 0.05, 16, 12]} />
								<meshBasicMaterial color={hot ? HOT : COLOUR} depthTest={false} depthWrite={false} transparent />
							</mesh>
						)}
					</group>
				);
			})}
		</group>
	);
}
