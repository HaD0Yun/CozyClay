import { useCallback, useEffect, useRef } from "react";
import { useThree } from "@react-three/fiber";
import { WORLD } from "./world-scale.js";

/**
 * Where the Top-View looks and how far it reaches: a centre on the floor and
 * a zoom, on the bindings of the Studio's other views. The left button stays
 * the content's (pucks, strokes); the view lives on the other buttons, as in
 * the editor camera (controls.jsx) and the matte painter (matte-editor.js):
 *
 *   middle-drag or right-drag    pan; also while a stroke is held, and the
 *                                floor point under the pointer stays put, so
 *                                the stroke carries on across the pan
 *   wheel                        zoom about the pointer
 *   horizontal two-finger swipe  pan sideways, like the timeline's swipe
 *   Home over the Top-View       back to the framing it opened with
 */

/** Half the plan's height at zoom 1, in metres. */
export const PLAN_EXTENT = 12.4;
const ZOOM_MAX = 4;
// Zoomed all the way out the plan holds the whole floor and a margin.
const ZOOM_MIN = PLAN_EXTENT / (WORLD.position * 1.1);
const WHEEL_RATE = 1.0015;
const FRAME_MARGIN = 2; // metres around the content when the view frames it

const clampZoom = (zoom) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Number.isFinite(zoom) ? zoom : 1));
const clampCentre = (value) => Math.max(-WORLD.position, Math.min(WORLD.position, value));
/** Three significant digits for the stored zoom (the tag's readout); the live view keeps its own. */
const roundZoom = (zoom) => Number(clampZoom(zoom).toPrecision(3));

/** Set the orthographic plan camera to a view, for a pane of this aspect. */
export function applyPlanView(camera, view, aspect) {
	const extent = PLAN_EXTENT / clampZoom(view.zoom);
	camera.top = extent;
	camera.bottom = -extent;
	camera.left = -extent * aspect;
	camera.right = extent * aspect;
	camera.position.x = view.x;
	camera.position.z = view.z;
	camera.updateProjectionMatrix();
	camera.updateMatrixWorld();
}

/** The floor box the board's content covers, or null when there is none. */
export function planContentBounds({ points = [], boxes = [] }) {
	let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
	const add = (x, z) => {
		if (!Number.isFinite(x) || !Number.isFinite(z)) return;
		minX = Math.min(minX, x); maxX = Math.max(maxX, x);
		minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
	};
	for (const point of points) if (point) add(point.x, point.z);
	for (const box of boxes) {
		const cos = Math.cos(box.yaw ?? 0), sin = Math.sin(box.yaw ?? 0);
		for (const [u, v] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
			const lx = (u * box.width) / 2, lz = (v * box.depth) / 2;
			add(box.x + lx * cos + lz * sin, box.z - lx * sin + lz * cos);
		}
	}
	return minX <= maxX ? { minX, maxX, minZ, maxZ } : null;
}

/**
 * The framing the plan opens with. When the content already sits inside the
 * view the plan has always opened with (the stage centre at `zoom`), that view
 * stays, so the same clicks land on the same floor points as before. Otherwise
 * the view frames all of it, as far out as the zoom limit allows.
 */
export function openingPlanView(bounds, aspect, zoom) {
	const kept = { x: 0, z: 0, zoom: clampZoom(zoom) };
	if (!bounds) return kept;
	const half = PLAN_EXTENT / kept.zoom;
	const inside = Math.max(Math.abs(bounds.minX), Math.abs(bounds.maxX)) <= half * aspect && Math.max(Math.abs(bounds.minZ), Math.abs(bounds.maxZ)) <= half;
	if (inside) return kept;
	const needHalf = Math.max((bounds.maxZ - bounds.minZ) / 2, (bounds.maxX - bounds.minX) / 2 / aspect) + FRAME_MARGIN;
	return {
		x: clampCentre((bounds.minX + bounds.maxX) / 2),
		z: clampCentre((bounds.minZ + bounds.maxZ) / 2),
		zoom: clampZoom(Math.min(kept.zoom, PLAN_EXTENT / needHalf)),
	};
}

/** Pan by a pointer movement in CSS pixels: the floor under the pointer follows it. */
export function pannedPlanView(view, dx, dy, paneHeight) {
	const perPixel = (2 * PLAN_EXTENT) / clampZoom(view.zoom) / Math.max(1, paneHeight);
	return { ...view, x: clampCentre(view.x - dx * perPixel), z: clampCentre(view.z - dy * perPixel) };
}

/** Zoom by a factor about a pane point (u, v in -1..1, v down), keeping the floor point there. */
export function zoomedPlanView(view, factor, u, v, aspect) {
	const zoom = clampZoom(view.zoom * factor);
	const before = PLAN_EXTENT / clampZoom(view.zoom), after = PLAN_EXTENT / zoom;
	return {
		x: clampCentre(view.x + u * aspect * (before - after)),
		z: clampCentre(view.z + v * (before - after)),
		zoom,
	};
}

/**
 * Wire the view gestures onto the Top-View host. The live view rides on the
 * plan camera (`userData.planView`), which the renderer reads, so a gesture
 * and a stroke always see one camera. Returns `isPanMove(event)`: true when a
 * window pointermove belongs to a pan, so the board's own drags skip it.
 */
export function usePlanNavigation({ hostRef, planCamRef, planZoom = 1, onPlanZoom, content, railDraw }) {
	const invalidate = useThree((three) => three.invalidate);
	const view = useRef({ x: 0, z: 0, zoom: clampZoom(planZoom) });
	// The zoom last handed to the layout: a prop equal to it is this view's echo.
	const sentZoom = useRef(planZoom);
	const home = useRef(null);
	const pan = useRef(null);
	const latest = useRef({});
	// Declared first, so the effects below read this render's callbacks.
	useEffect(() => {
		latest.current = { onPlanZoom, invalidate, content };
	});
	const contentBounds = () => {
		const board = latest.current.content?.();
		if (!board) return null;
		return planContentBounds({
			points: [...board.targets, ...(board.waypoints ?? []), ...(board.track ?? []), ...(board.rail ?? []), ...(board.objects ?? []).flatMap((object) => object.path?.points ?? [])],
			boxes: board.targets.filter((entry) => entry.footprint).map((entry) => ({ x: entry.x, z: entry.z, yaw: entry.yaw, ...entry.footprint })),
		});
	};

	const aspectOf = (host) => {
		const rect = host.getBoundingClientRect();
		return rect.width > 1 && rect.height > 1 ? rect.width / rect.height : 1;
	};
	const publish = (next) => {
		const host = hostRef.current;
		view.current = next;
		const camera = planCamRef.current;
		if (camera && host) {
			camera.userData.planView = next;
			applyPlanView(camera, next, aspectOf(host));
		}
		const stored = roundZoom(next.zoom);
		if (stored !== sentZoom.current) {
			sentZoom.current = stored;
			latest.current.onPlanZoom?.(stored);
		}
		latest.current.invalidate?.();
	};

	// A zoom set elsewhere (a restored layout) is the view's zoom too.
	useEffect(() => {
		if (planZoom !== sentZoom.current) {
			sentZoom.current = planZoom;
			publish({ ...view.current, zoom: clampZoom(planZoom) });
		} else if (planCamRef.current) planCamRef.current.userData.planView = view.current;
	}, [planZoom]); // eslint-disable-line react-hooks/exhaustive-deps

	// Opening the rail drawing frames what matters; Home returns there.
	useEffect(() => {
		const host = hostRef.current;
		if (!railDraw || !host) return;
		const opening = openingPlanView(contentBounds(), aspectOf(host), view.current.zoom);
		home.current = opening;
		publish(opening);
	}, [railDraw]); // eslint-disable-line react-hooks/exhaustive-deps

	useEffect(() => {
		const host = hostRef.current;
		if (!host) return undefined;
		const isPlan = () => host.classList.contains("plan");
		let hovered = false;
		const onDown = (event) => {
			if ((event.button !== 1 && event.button !== 2) || !isPlan()) return;
			event.preventDefault();
			event.stopPropagation();
			pan.current = { x: event.clientX, y: event.clientY };
			host.style.cursor = "grabbing";
		};
		const onMove = (event) => {
			// A middle or right button held during a left stroke is a pan too.
			const chord = (event.buttons & 6) !== 0 && isPlan();
			if (pan.current?.chord && !chord) {
				// The chord's button lifted while the stroke's left button stays down.
				pan.current = null;
				return;
			}
			if (!pan.current && !chord) return;
			if (!pan.current) pan.current = { x: event.clientX, y: event.clientY, chord: true };
			const dx = event.clientX - pan.current.x, dy = event.clientY - pan.current.y;
			pan.current.x = event.clientX;
			pan.current.y = event.clientY;
			if (dx || dy) publish(pannedPlanView(view.current, dx, dy, host.getBoundingClientRect().height));
		};
		const endPan = () => {
			if (!pan.current) return;
			pan.current = null;
			host.style.cursor = "";
		};
		const onWheel = (event) => {
			event.preventDefault();
			hovered = true;
			const rect = host.getBoundingClientRect();
			if (Math.abs(event.deltaX) > Math.abs(event.deltaY)) {
				if (isPlan()) publish(pannedPlanView(view.current, -event.deltaX, 0, rect.height));
				return;
			}
			const u = rect.width > 1 ? ((event.clientX - rect.left) / rect.width) * 2 - 1 : 0;
			const v = rect.height > 1 ? ((event.clientY - rect.top) / rect.height) * 2 - 1 : 0;
			const factor = Math.pow(WHEEL_RATE, -event.deltaY);
			publish(isPlan() ? zoomedPlanView(view.current, factor, u, v, aspectOf(host)) : { ...view.current, zoom: clampZoom(view.current.zoom * factor) });
		};
		const onKey = (event) => {
			if (event.code !== "Home" || !hovered || !isPlan() || host.classList.contains("collapsed")) return;
			// Capture phase: the same press must not also frame the editor camera.
			event.preventDefault();
			event.stopPropagation();
			publish(home.current ?? openingPlanView(contentBounds(), aspectOf(host), view.current.zoom));
		};
		const onEnter = () => { hovered = true; };
		const onLeave = () => { hovered = false; };
		const onMenu = (event) => { if (isPlan()) event.preventDefault(); };
		host.addEventListener("pointerdown", onDown, true);
		host.addEventListener("pointerenter", onEnter);
		host.addEventListener("pointerleave", onLeave);
		host.addEventListener("contextmenu", onMenu);
		host.addEventListener("wheel", onWheel, { passive: false });
		window.addEventListener("pointermove", onMove, true);
		window.addEventListener("pointerup", endPan, true);
		window.addEventListener("pointercancel", endPan, true);
		window.addEventListener("blur", endPan);
		window.addEventListener("keydown", onKey, true);
		return () => {
			host.removeEventListener("pointerdown", onDown, true);
			host.removeEventListener("pointerenter", onEnter);
			host.removeEventListener("pointerleave", onLeave);
			host.removeEventListener("contextmenu", onMenu);
			host.removeEventListener("wheel", onWheel);
			window.removeEventListener("pointermove", onMove, true);
			window.removeEventListener("pointerup", endPan, true);
			window.removeEventListener("pointercancel", endPan, true);
			window.removeEventListener("blur", endPan);
			window.removeEventListener("keydown", onKey, true);
			pan.current = null;
		};
	}, [hostRef, planCamRef]); // eslint-disable-line react-hooks/exhaustive-deps

	return useCallback((event) => !!pan.current || ((event.buttons & 6) !== 0 && !!hostRef.current?.classList.contains("plan")), [hostRef]);
}
