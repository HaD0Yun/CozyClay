/**
 * Number-field scrubbing — the pure half of the Inspector's drag-a-number.
 *
 * The field itself lives in ui.jsx, but the two decisions that make the
 * gesture feel right are arithmetic, not React: "has the hand travelled far
 * enough that this press is a drag and not a click?" and "how much value does
 * a pixel buy?". They live here so a Node test can prove them without a DOM.
 *
 * Sensitivity is a RATE over a fixed travel, the same rule the timeline's
 * curve editors follow (src/motion/timeline.jsx DRAG_TRAVEL_PX): dragging the
 * hand across `SCRUB_TRAVEL_PX` sweeps one meaningful span of the field. The
 * old `pixels * step` mapping tied the feel to the field's precision, so a
 * step 0.05 field needed 100 px to move 5 units while a step 1 field bolted.
 */

/**
 * How far the hand travels to sweep a field's whole meaningful range, in
 * pixels. Matches the timeline curve editors so the wrist learns one gesture.
 */
export const SCRUB_TRAVEL_PX = 220;

/**
 * How far the hand must travel before a press stops being a click. Blender and
 * Unity both keep the number clickable for text entry, so the first few pixels
 * belong to the click; only past this does the drag take the input away.
 */
export const SCRUB_THRESHOLD_PX = 4;

/** Shift buys a quarter-speed pass for fine detail; Alt keeps its old 0.1x. */
export const FINE_SCRUB_FACTOR = 0.25;
const EXTRA_FINE_SCRUB_FACTOR = 0.1;

/**
 * The meaningful span a full drag sweeps when the field does not name one.
 * A step is "the smallest edit worth making", so a hundred of them is a
 * sensible whole range: step 0.05 → 5 units, step 1 → 100 units.
 */
const SCRUB_RANGE_STEPS = 100;

/** The span one full `SCRUB_TRAVEL_PX` drag covers for a field. */
export function scrubRangeFor({ scrubRange, step } = {}) {
	if (Number.isFinite(scrubRange) && scrubRange > 0) return scrubRange;
	const size = Number.isFinite(step) && step > 0 ? step : 1;
	return size * SCRUB_RANGE_STEPS;
}

/**
 * Does this much horizontal travel turn the press into a scrub? Vertical
 * movement does not count: the gesture is explicitly left/right, and a hand
 * sliding down a panel should not hijack the click.
 */
export function shouldStartScrub(dx) {
	return Math.abs(dx) >= SCRUB_THRESHOLD_PX;
}

/**
 * Value under the pointer for a rate-based horizontal drag.
 *
 * `dx` is measured from where the press landed, NOT from where the scrub
 * armed: dropping the first threshold pixels would make the value jump
 * backwards the moment the drag starts.
 */
export function scrubValue(base, dx, { step, scrubRange, shiftKey = false, altKey = false, precision = 2 } = {}) {
	const range = scrubRangeFor({ scrubRange, step });
	const gain = shiftKey ? FINE_SCRUB_FACTOR : altKey ? EXTRA_FINE_SCRUB_FACTOR : 1;
	return snapScrubValue(base + (dx / SCRUB_TRAVEL_PX) * range * gain, { step, precision });
}

/**
 * One press's worth of scrub state, shared by the field and its test.
 *
 * The gesture starts *disarmed*: a press on a number is a click until the hand
 * proves otherwise, so `move` answers null while the travel is inside the
 * threshold and the input keeps its focus. Once armed it stays armed — coming
 * back near the press point is part of the drag, not a return to clicking —
 * and every reported value is measured from the press point so arming does not
 * teleport the value by the threshold's width.
 */
export function createScrubGesture({ x, value, step, precision, scrubRange }) {
	const gesture = {
		scrubbing: false,
		move(clientX, { shiftKey = false, altKey = false } = {}) {
			const dx = clientX - x;
			if (!gesture.scrubbing && !shouldStartScrub(dx)) return null;
			gesture.scrubbing = true;
			return scrubValue(value, dx, { step, precision, scrubRange, shiftKey, altKey });
		},
	};
	return gesture;
}

/**
 * Land the dragged value on the field's own grid: `step` decides which values
 * exist, `precision` kills the float dust that would otherwise print as
 * 1.7000000000000002 in the input.
 */
export function snapScrubValue(value, { step, precision = 2 } = {}) {
	const size = Number.isFinite(step) && step > 0 ? step : 0;
	const snapped = size > 0 ? Math.round(value / size) * size : value;
	const digits = Number.isFinite(precision) ? Math.max(0, Math.min(15, Math.round(precision))) : 2;
	return Number(snapped.toFixed(digits));
}
