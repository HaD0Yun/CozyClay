import { isEffectivelyHidden, objectFootprintBounds } from "../scene-objects.js";

/**
 * Ground height under a point, from the scene's objects (issue #250).
 *
 * Against ONE flat floor (`floorY`), a character standing on a box or a step
 * would read as sunk into it. This module answers "what is the ground here?":
 * studio-agent-motion.js samples it per support site, and physics-review.js
 * takes it as `groundAt` for contact spans, foot anchors and the floor/float
 * metrics, so they measure against the surface actually under the foot.
 *
 * Surface model: each scene object is an axis-aligned box from
 * objectFootprintBounds (yaw-exact XZ footprint, flat top at topY). The
 * highest top whose footprint contains the point, and that is not higher than
 * `maxY` (so a foot below a table does not snap up onto it), wins; otherwise
 * the floor. Sloped tops are out of scope - the height is flat per object and
 * the foot keeps its source rotation.
 */
export function createGroundSampler(objects = [], { floorY = 0, characters = [] } = {}) {
	const surfaces = objects.filter((object) => !isEffectivelyHidden(object, objects, characters) && isCollidable(object)).map((object) => objectFootprintBounds(object));
	const groundAt = (x, z, maxY = Infinity) => {
		let best = floorY;
		for (const b of surfaces) {
			if (x < b.minX || x > b.maxX || z < b.minZ || z > b.maxZ) continue;
			if (b.topY > maxY || b.topY <= best) continue;
			best = b.topY;
		}
		return best;
	};
	groundAt.surfaces = surfaces;
	groundAt.floorY = floorY;
	return groundAt;
}

/** Objects a foot can stand on: solid props with a real footprint. Cutouts,
 * cameras, lights, and attached/child objects are not ground. */
export function isCollidable(object) {
	if (!object || object.kind === "cutout" || object.hidden === true) return false;
	if (object.parentId || object.attach) return false;
	if (object.collide === false) return false;
	const b = objectFootprintBounds(object);
	return b.maxX - b.minX > 1e-6 && b.maxZ - b.minZ > 1e-6 && b.topY > b.baseY + 1e-6;
}
