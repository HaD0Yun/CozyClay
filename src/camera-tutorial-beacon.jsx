// The camera tutorial's beacon: a numbered circle and a caption pinned onto the control a step is about.
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

/** the beacon's own geometry, in px — the circle sits above-left of the target */
const DOT = 22;
const LIFT_X = 30;
const LIFT_Y = 44;
/** nominal box used only for edge clamping; the chip itself is auto-sized */
const BEACON_W = 190;
const BEACON_H = 26;

const boxOf = (element) => {
	if (!element) return null;
	const box = element.getBoundingClientRect();
	if (box.width < 2 || box.height < 2) return null;
	if (box.right < 0 || box.bottom < 0 || box.left > window.innerWidth || box.top > window.innerHeight) return null;
	return box;
};

/** first element matching `selector` that is actually laid out on screen */
const firstVisible = (selector) => {
	if (!selector) return null;
	for (const element of document.querySelectorAll(selector)) {
		const box = boxOf(element);
		if (box) return { element, box };
	}
	return null;
};

const round = (value) => Math.round(value * 2) / 2;

/**
 * Place the beacon above-left of the target and clamp it inside whatever
 * scrolls the target (the timeline body, or the viewport pane). The leader
 * line is aimed at the real target, so a shot block scrolled past the lane's
 * edge still gets an arrow pointing off toward it.
 *
 * Above is the default; when the target hugs the top of its own pane — the
 * camera bar under the transport row, the Top-View inset under the titlebar —
 * the beacon flips below rather than sitting on the pane's header controls.
 */
function place(element, box) {
	const clip = element.closest(".tl-body, .timeline, .viewport")?.getBoundingClientRect();
	const edge = Math.min(14, box.height / 2);
	const above = box.top + edge - LIFT_Y - DOT / 2;
	const flip = above < (clip ? clip.top : 0) + BEACON_H;
	const aimX = box.left + Math.min(18, box.width / 2);
	const aimY = flip ? box.bottom - edge : box.top + edge;
	const minLeft = Math.max(8, clip ? clip.left + 6 : 8);
	const maxLeft = Math.max(minLeft, Math.min(window.innerWidth - 8, clip ? clip.right - 6 : window.innerWidth - 8) - BEACON_W);
	const left = Math.min(Math.max(aimX - LIFT_X - DOT / 2, minLeft), maxLeft);
	const top = Math.min(Math.max(flip ? aimY + LIFT_Y - DOT / 2 : above, 8), Math.max(8, window.innerHeight - 46));
	return { left: round(left), top: round(top), aimX: round(aimX - left), aimY: round(aimY - top) };
}

const samePlace = (a, b) => !!a && !!b && a.left === b.left && a.top === b.top && a.aimX === b.aimX && a.aimY === b.aimY;

/**
 * One numbered circle plus a caption chip, portalled to <body> and pinned to a
 * live control. It measures on mount, on resize, on scroll, on a
 * ResizeObserver of the timeline and viewport, and on any DOM mutation — the
 * camera bar mounts only after a shot is selected, so "target not there yet"
 * is the normal case, not an error. Pointer-transparent: the control it points
 * at must stay clickable through it.
 */
export function TutorialBeacon({ kind, step, role, selector, label, requires = null, absent = null }) {
	const [spot, setSpot] = useState(null);

	useEffect(() => {
		let frame = 0;
		const measure = () => {
			frame = 0;
			if (absent && firstVisible(absent)) return setSpot(null);
			if (requires && !firstVisible(requires)) return setSpot(null);
			const found = firstVisible(selector);
			if (!found) return setSpot(null);
			const next = place(found.element, found.box);
			// Same numbers means no re-render, which keeps the MutationObserver
			// below from chasing this component's own portal forever.
			setSpot((prev) => (samePlace(prev, next) ? prev : next));
		};
		const schedule = () => {
			if (!frame) frame = requestAnimationFrame(measure);
		};
		measure();
		window.addEventListener("resize", schedule);
		window.addEventListener("scroll", schedule, true);
		const resize = new ResizeObserver(schedule);
		for (const pane of [document.querySelector(".timeline"), document.querySelector(".viewport")]) {
			if (pane) resize.observe(pane);
		}
		const mutations = new MutationObserver(schedule);
		mutations.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "style", "data-rail-draw"] });
		return () => {
			if (frame) cancelAnimationFrame(frame);
			window.removeEventListener("resize", schedule);
			window.removeEventListener("scroll", schedule, true);
			resize.disconnect();
			mutations.disconnect();
		};
	}, [selector, requires, absent]);

	if (!spot) return null;
	return createPortal(
		<div
			className="tutorial-beacon"
			data-testid="camera-tutorial-beacon"
			data-kind={kind}
			data-role={role}
			style={{ left: `${spot.left}px`, top: `${spot.top}px` }}
		>
			<svg className="tutorial-beacon-leader" aria-hidden="true">
				<line x1={DOT / 2} y1={DOT / 2} x2={spot.aimX} y2={spot.aimY} />
			</svg>
			<span className="tutorial-beacon-dot" aria-hidden="true">{step}</span>
			<span className="tutorial-beacon-label">{label()}</span>
		</div>,
		document.body,
	);
}
