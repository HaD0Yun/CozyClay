// How big a scene may be. "room" is the stage as it has always been: a 480 m
// floor, props up to 100x, a 30 m crane and a 100 m lens. "large" holds an
// exterior at full size (a tower, a riverbank, a long drone move) in one scene.
//
// Like the locale, the scale is fixed for the lifetime of the page: the bounds
// are read once by the tables and clamps that use them (studio-elements.js,
// object-path.js, the action schemas), so switching saves the choice and
// reloads. ?world=large (or room) in the URL opens one page at that scale
// without saving it. A project saved at the large scale and opened at the room
// scale is clamped back into the room, as it always was.

const KEY = "cozyclay.worldScale";

export const WORLD_SCALES = Object.freeze({
	room: Object.freeze({
		position: 240, // |x|, |z| and height of a character or object, metres
		scale: 100, // largest object scale on any axis
		pathHeight: 60, // highest point of an object's travel path
		railHeight: 30, // highest camera rail height and aim height
		cameraFar: 100, // far clipping plane of the shot, editor and poser cameras
		horizon: Object.freeze({ near: 55, far: 95 }), // fog an exported frame fades its horizon into
		dollySpeed: 40, // fastest rail dolly, m/s
	}),
	large: Object.freeze({
		position: 3000,
		scale: 3000,
		pathHeight: 3000,
		railHeight: 600,
		cameraFar: 6000,
		horizon: Object.freeze({ near: 3300, far: 5700 }),
		dollySpeed: 1000,
	}),
});

function requested() {
	try {
		const query = new URLSearchParams(globalThis.location?.search ?? "").get("world");
		if (Object.hasOwn(WORLD_SCALES, query ?? "")) return query;
		const value = globalThis.localStorage?.getItem(KEY);
		return Object.hasOwn(WORLD_SCALES, value ?? "") ? value : null;
	} catch {
		return null;
	}
}

export const WORLD_SCALE = requested() ?? "room";
export const WORLD = WORLD_SCALES[WORLD_SCALE];

export function setWorldScale(next) {
	if (!Object.hasOwn(WORLD_SCALES, next) || next === WORLD_SCALE) return;
	try {
		localStorage.setItem(KEY, next);
	} catch {
		// Private mode without storage: nothing to keep, and a reload would land on the old scale.
		return;
	}
	window.location.reload();
}
