// How recording a rail shot's aim with the mouse reacts: the user's own
// setting (this browser, like the other viewer preferences), not scene data.
//
// sensitivity: degrees the camera turns per 100 pixels of mouse travel. The
//   Studio's right-drag look and walk camera turn 0.0032 rad/px = 18.3 deg/100 px.
// smoothing: the time constant (seconds) of a first-order filter the recorded
//   yaw and pitch pass through, on the production clock. 0 records the raw mouse.
//   A steady pan comes out at the same speed, late by this much; a sudden flick
//   settles to 63 % in one time constant and 95 % in three.

const RAIL_AIM_FEEL_KEY = "cozyclay.railAimFeel";
export const RAIL_AIM_FEEL = Object.freeze({
	sensitivity: Object.freeze({ initial: 7, min: 1, max: 40, step: 0.5 }),
	smoothing: Object.freeze({ initial: 0.2, min: 0, max: 1, step: 0.05 }),
});

function bounded(value, { initial, min, max }) {
	return Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : initial;
}

/** The stored setting, each part bounded; the defaults for anything missing or unreadable. */
function storedFeel(storage) {
	try { return JSON.parse(storage?.getItem?.(RAIL_AIM_FEEL_KEY) ?? "null"); } catch { return null; }
}

export function readRailAimFeel(storage = globalThis.localStorage) {
	const stored = storedFeel(storage);
	// only a stored number counts: a string, a boolean or null there is a broken value, not a 0 or a 1
	const part = (key) => bounded(typeof stored?.[key] === "number" ? stored[key] : NaN, RAIL_AIM_FEEL[key]);
	return { sensitivity: part("sensitivity"), smoothing: part("smoothing") };
}

export function writeRailAimFeel(feel, storage = globalThis.localStorage) {
	try { storage?.setItem?.(RAIL_AIM_FEEL_KEY, JSON.stringify(feel)); } catch { return; }
}

/** Radians the camera turns per pixel of mouse travel. */
export function aimRadiansPerPixel(feel) {
	return (bounded(feel?.sensitivity, RAIL_AIM_FEEL.sensitivity) / 100) * (Math.PI / 180);
}

/** One step of the aim filter: `shown` moves toward the mouse's `target` over `seconds` of production time. */
export function smoothAim(shown, target, seconds, smoothing) {
	const weight = smoothing > 0 ? 1 - Math.exp(-Math.max(0, seconds) / smoothing) : 1;
	return { yaw: shown.yaw + (target.yaw - shown.yaw) * weight, pitch: shown.pitch + (target.pitch - shown.pitch) * weight };
}
