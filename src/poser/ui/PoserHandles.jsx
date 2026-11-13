// The Auto Pose tool in the viewport (Pose mode, key E): loads the poser network on first use, draws the 19 handles on
// the active character and turns pointer drags into live solves. Presses are claimed in the window capture phase,
// like the fingertip handles, so a press on a handle never orbits the camera; empty-space presses pass through.
import { useEffect, useMemo, useRef, useState } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { ko } from "../../locale.js";
import { ringAngle } from "../../pose-gizmo.js";
import { HANDLES } from "../handles.js";
import { axisAngle, mul } from "../mat3.js";
import { createPoser } from "../poser.js";
import { canMove, canTurn, heldPlace, LOOK_AHEAD } from "./handle-state.js";
import { ensurePoserNetwork } from "./model-host.js";
import { createPoserController } from "./poser-controller.js";
import { HandleMark, LookLine, markRadius, paintMark, paintRings, ringOutlines, Tethers, TurnRings } from "./poser-marks.jsx";
import { pickHandle, pickRing, PICK_MARGIN_PX } from "./poser-pick.js";
import { getPoserState, updatePoserState, usePoserState } from "./poser-store.js";
import { createRigBridge, poserSupports } from "./rig-bridge.js";

const SHOWN = HANDLES.filter((h) => h.id !== "body");
const posers = new WeakMap();
const poserFor = (network) => { if (!posers.has(network)) posers.set(network, createPoser({ network })); return posers.get(network); };
const failText = () => ko("The Auto Pose model could not load. The other Pose tools still work; try again from Pose Details.", "자동 포즈 모델을 불러오지 못했어요. 다른 포즈 도구는 그대로 쓸 수 있어요. 포즈 세부 정보에서 다시 시도하세요.", "无法加载自动姿势模型。其他姿势工具仍可使用；请在姿势详情中重试。");
const callbackBox = () => { let calls = {}; return { set: (next) => { calls = next; }, get: () => calls }; };
// Frame and solve timings for browser QA (kept short).
const perf = { frames: [], reset() { this.frames.length = 0; } };

export function PoserHandles({ rig, model, characterId, enabled, onSolve, onDragEnd, onNotice }) {
	const { camera, gl } = useThree();
	const { model: modelState } = usePoserState();
	const [network, setNetwork] = useState(null);
	const [scaleKey, setScaleKey] = useState(0);
	const active = !!enabled && !!rig && poserSupports(model);
	// the latest callbacks, read when a drag writes (not during render)
	const [host] = useState(callbackBox);
	useEffect(() => { host.set({ onSolve, onDragEnd, onNotice }); });

	// Lazy model load on first use; a failure is shown once and not retried until the panel asks. A build without the
	// model is not a failure: the panel says where Auto Pose is available, and nothing is requested or retried.
	useEffect(() => {
		if (!active || modelState.status === "failed" || modelState.status === "unavailable") return undefined;
		let live = true;
		ensurePoserNetwork().then((n) => { if (live) setNetwork(n); }, (error) => { if (live && error?.code !== "unavailable") host.get().onNotice?.(failText()); });
		return () => { live = false; };
	}, [active, modelState.status, host]);

	const ctrl = useMemo(() => {
		if (!active || !network) return null;
		const bridge = createRigBridge(rig, model, poserFor(network));
		return bridge && createPoserController({
			characterId, bridge, poser: poserFor(network),
			host: { solve: (...args) => host.get().onSolve?.(...args), dragEnd: () => host.get().onDragEnd?.() },
		});
	// scaleKey rebuilds the bridge when the character's stature changes
	// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [active, network, rig, model, characterId, scaleKey, host]);

	useEffect(() => {
		if (!ctrl) return undefined;
		updatePoserState({ controller: ctrl, characterId, handles: ctrl.handles, hint: null });
		return () => { if (getPoserState().controller === ctrl) updatePoserState({ controller: null, selected: null }); };
	}, [ctrl, characterId]);

	const marks = useRef(new Map()), rings = useRef(null), look = useRef(null), tethers = useRef(null), hover = useRef({ id: null, axis: null }), turning = useRef(null);
	const scratch = useMemo(() => ({ v: new THREE.Vector3(), head: new THREE.Vector3() }), []);

	// Where each handle is drawn: a held place, the drag target, the look-at point, else its joint.
	const placeOf = (id, out) => {
		const b = ctrl.bridge, held = heldPlace(ctrl.handles, id);
		if (id === ctrl.dragging && ctrl.dragTarget) return b.toWorld(ctrl.dragTarget, out);
		if (held) return b.toWorld(held, out);
		if (id !== "lookAt") return b.jointWorld(SHOWN.find((h) => h.id === id).joint, out);
		const head = b.jointPoser(6), G = b.turnAt(6);
		return b.toWorld([head[0] + LOOK_AHEAD * G[2], head[1] + LOOK_AHEAD * G[5], head[2] + LOOK_AHEAD * G[8]], out);
	};

	useFrame((_, delta) => {
		if (!ctrl) return;
		if (ctrl.dragging) perf.frames.push(delta * 1000);
		if (perf.frames.length > 2000) perf.frames.shift();
		const scale = new THREE.Vector3().setFromMatrixScale(rig.matrixWorld).x;
		if (Math.abs(scale / 0.01 - ctrl.bridge.stature) > 1e-6 && !ctrl.dragging) { setScaleKey((n) => n + 1); return; }
		if (!ctrl.dragging) ctrl.refreshStale();
		const { selected } = getPoserState(), h = ctrl.handles;
		for (const { id } of SHOWN) {
			const group = marks.current.get(id);
			if (!group) continue;
			placeOf(id, group.position);
			group.quaternion.copy(camera.quaternion);
			const s = h[id];
			if (tethers.current) {
				const attr = tethers.current.geometry.attributes.position, k = SHOWN.findIndex((x) => x.id === id), joint = id === "lookAt" ? null : ctrl.bridge.jointWorld(SHOWN[k].joint, scratch.v);
				const apart = joint && joint.distanceTo(group.position) > 0.01;
				attr.setXYZ(2 * k, ...(apart ? joint.toArray() : group.position.toArray()));
				attr.setXYZ(2 * k + 1, group.position.x, group.position.y, group.position.z);
				attr.needsUpdate = true;
			}
			paintMark(group, { enabled: s.enabled, held: s.held && id !== "lookAt" ? true : id === "lookAt" && s.placed, selected: selected === id, hover: hover.current.id === id, active: ctrl.dragging === id });
		}
		if (rings.current) {
			const show = !!selected && canTurn(selected) && marks.current.has(selected);
			rings.current.visible = show;
			if (show) { rings.current.position.copy(turning.current?.centre ?? marks.current.get(selected).position); paintRings(rings.current, turning.current?.axis ?? hover.current.axis, !!turning.current); }
		}
		if (look.current) {
			const attr = look.current.geometry.attributes.position, lookAt = marks.current.get("lookAt");
			ctrl.bridge.jointWorld(6, scratch.head);
			attr.setXYZ(0, scratch.head.x, scratch.head.y, scratch.head.z);
			if (lookAt) attr.setXYZ(1, lookAt.position.x, lookAt.position.y, lookAt.position.z);
			attr.needsUpdate = true;
			look.current.visible = !!h.lookAt?.enabled;
		}
	});

	useEffect(() => {
		if (!ctrl) return undefined;
		const el = gl.domElement, ray = new THREE.Raycaster(), ndc = new THREE.Vector2(), hit = new THREE.Vector3();
		let drag = null;
		const rect = () => el.getBoundingClientRect();
		const toScreen = (p, r) => { const v = p.clone().project(camera); return [r.left + ((v.x + 1) / 2) * r.width, r.top + ((1 - v.y) / 2) * r.height, v.z < 1]; };
		const aim = (ev) => { const r = rect(); ray.setFromCamera(ndc.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1), camera); };
		const right = () => new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0);
		// browser QA reads the controller, timings and where a handle is on screen: dev builds, or a production build
		// whose page set window.__COZYCLAY_QA__ before loading. Cleared on unmount so nothing keeps the rig alive.
		// screenOf: [x, y, in front of the camera, a press there reaches the canvas (not covered by a panel)]
		const reachable = (x, y) => document.elementFromPoint(x, y) === el;
		const qa = (import.meta.env.DEV || globalThis.__COZYCLAY_QA__ === true) && { controller: ctrl, perf, state: getPoserState, screenOf: (id) => { const g = marks.current.get(id); if (!g) return null; const p = toScreen(g.position, rect()); return [...p, p[2] && reachable(p[0], p[1])]; }, project: (x, y, z) => toScreen(new THREE.Vector3(x, y, z), rect()), markAt: (id) => marks.current.get(id)?.position.toArray() ?? null, ringAxis: () => turning.current?.axis ?? hover.current.axis };
		if (qa) globalThis.__cozyclayPoser = qa;
		// A dot under the pointer wins over the selected dot's turn rings, which pass over other dots.
		function pick(ev) {
			const r = rect(), { selected } = getPoserState();
			const candidates = [...marks.current].map(([id, group]) => {
				const [x, y, front] = toScreen(group.position, r), [ex] = toScreen(group.position.clone().addScaledVector(right(), markRadius(id) * group.scale.x), r);
				return front ? { id, x, y, reach: Math.abs(ex - x) + PICK_MARGIN_PX, enabled: ctrl.handles[id]?.enabled } : null;
			}).filter(Boolean);
			const picked = pickHandle(candidates, ev.clientX, ev.clientY);
			if (picked) return { id: picked.id };
			if (selected && rings.current?.visible) {
				const outlines = ringOutlines(rings.current.position);
				const axis = pickRing(outlines.map((o) => ({ axis: o.axis, points: o.points.map((p) => toScreen(p, r)) })), ev.clientX, ev.clientY);
				if (axis) return { ring: outlines.find((o) => o.axis === axis), id: selected };
			}
			return null;
		}
		const onMove = (ev) => {
			if (!drag) { const p = pick(ev); hover.current = { id: p && !p.ring ? p.id : null, axis: p?.ring?.axis ?? null }; return; }
			if (!drag.plane) return; // a press on a turn-only dot only selects it; there is nothing to drag
			aim(ev);
			if (!ray.ray.intersectPlane(drag.plane, hit)) return;
			if (drag.kind === "move") ctrl.move(ctrl.bridge.toPoser(hit.clone().sub(drag.offset)));
			else if (drag.kind === "turn") {
				const angle = ringAngle(drag.axis, drag.centre, drag.start, hit), a = drag.axisPoser;
				ctrl.turn(Array.from(mul(new Float64Array(9), 0, axisAngle(new Float64Array(9), 0, a[0], a[1], a[2], angle), 0, drag.pressTurn, 0)));
			}
		};
		// The release must always arrive: the pointer is captured to the canvas, and a lost capture or a window that
		// loses focus ends the drag too (otherwise a release outside the window would leave the gesture open).
		const ends = [[window, "pointerup"], [window, "pointercancel"], [el, "lostpointercapture"], [window, "blur"]];
		const stop = () => { for (const [target, name] of ends) target.removeEventListener(name, onUp, true); };
		const onUp = () => { const d = drag; drag = null; turning.current = null; stop(); if (d) ctrl.release(); };
		const onDown = (ev) => {
			if (ev.button !== 0 || ev.target !== el || drag) return;
			const picked = pick(ev);
			if (!picked) return;
			ev.stopImmediatePropagation(); ev.stopPropagation(); ev.preventDefault();
			ctrl.press(picked.id);
			drag = { kind: "select" };
			for (const [target, name] of ends) target.addEventListener(name, onUp, true);
			try { el.setPointerCapture?.(ev.pointerId); } catch { /* synthetic events have no capturable pointer */ }
			aim(ev);
			const centre = marks.current.get(picked.id).position.clone();
			if (picked.ring) {
				const axis = picked.ring.dir.clone(), plane = new THREE.Plane().setFromNormalAndCoplanarPoint(axis, centre);
				const start = ray.ray.intersectPlane(plane, new THREE.Vector3()) ?? centre.clone().add(right().multiplyScalar(0.1));
				drag = { kind: "turn", axis, plane, centre, start, axisPoser: ctrl.bridge.axisToPoser(axis), pressTurn: ctrl.handles[picked.id].turn ?? [1, 0, 0, 0, 1, 0, 0, 0, 1] };
				turning.current = { centre, axis: picked.ring.axis };
			} else if (canMove(picked.id)) {
				const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(camera.getWorldDirection(new THREE.Vector3()), centre);
				const grab = ray.ray.intersectPlane(plane, new THREE.Vector3()) ?? centre.clone();
				drag = { kind: "move", plane, offset: grab.sub(centre) };
			}
			perf.reset();
		};
		window.addEventListener("pointerdown", onDown, true);
		window.addEventListener("pointermove", onMove, true);
		return () => {
			window.removeEventListener("pointerdown", onDown, true); window.removeEventListener("pointermove", onMove, true); stop(); if (drag) ctrl.release();
			if (qa && globalThis.__cozyclayPoser === qa) delete globalThis.__cozyclayPoser;
		};
	}, [ctrl, camera, gl]);

	if (!ctrl) return null;
	return (
		<group>
			{SHOWN.map(({ id }) => <HandleMark key={id} id={id} groupRef={(g) => { if (g) marks.current.set(id, g); else marks.current.delete(id); }} />)}
			<TurnRings groupRef={rings} />
			<LookLine lineRef={look} />
			<Tethers lineRef={tethers} count={SHOWN.length} />
		</group>
	);
}
