// The flythrough speed multiplier: one range and one step for every way to
// change it (the wheel during a right-drag, the viewport pill's field, its
// arrows and the wheel over the pill).
const FLY_SPEED_MIN = 0.15;
const FLY_SPEED_MAX = 6;

/** A typed or computed speed inside the range; NaN for a value that is not a number. */
export function clampFlySpeed(value) {
	const number = Number(value);
	if (!Number.isFinite(number)) return Number.NaN;
	return Math.min(FLY_SPEED_MAX, Math.max(FLY_SPEED_MIN, number));
}

/** One wheel notch: down (deltaY > 0) is 10 % slower, up is 10 % faster. */
export function stepFlySpeed(speed, deltaY) {
	return clampFlySpeed(speed * (deltaY > 0 ? 0.9 : 1.1));
}
