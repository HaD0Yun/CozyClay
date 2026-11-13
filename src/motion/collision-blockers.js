/**
 * EXTERNAL blockers for the motion verification in studio-agent-motion.js.
 *
 * fix-collisions.js builds capsule proxies for one rig, so it only sees the
 * character's OWN body. The set has two more kinds of solid thing in it — the
 * other cast members, and the objects the user dropped on the deck — and
 * neither is visible from one skeleton. This module turns both into the
 * static-blocker vocabulary that detectPenetrations accepts:
 *
 *   { id, kind: "capsule", a: Vector3, b: Vector3, radius }
 *   { id, kind: "box", center: Vector3, halfExtents: Vector3, yaw }   // radians about world Y
 *
 * Everything here is WORLD SPACE and already posed: a blocker describes where
 * something is at the moment it is built, so a whole-clip pass rebuilds the
 * character blockers per frame (the others are animating too) and re-samples
 * any object that walks a travel path.
 *
 * Ids are namespaced so a penetration label reads unambiguously —
 * `leftHand×obj:chair`, `leftHand×char:subject-2:torso` — and so the App can
 * tell an external hit from a self-collision without a second lookup.
 *
 * Pure: no React, no scene graph ownership. The only thing it reads is the
 * rig's live world matrices (through buildCollisionCapsules) and the scene
 * object records, which is what makes it unit-testable headless.
 */

import * as THREE from "three";
import { buildCollisionCapsules } from "./fix-collisions.js";
import { isEffectivelyHidden, objectSize } from "../scene-objects.js";
import { objectTransformAt } from "../object-path.js";

const DEG = Math.PI / 180;

/** Namespace prefixes. Kept as exports so the App's QA surface and the tests
 * agree on the spelling instead of both hard-coding a string. */
const OBJECT_BLOCKER_PREFIX = "obj:";
const CHARACTER_BLOCKER_PREFIX = "char:";

/** `obj:<sceneObjectId>` — one box per scene object. */
export function objectBlockerId(sceneObjectId) {
	return `${OBJECT_BLOCKER_PREFIX}${sceneObjectId}`;
}

/** `char:<characterId>:<capsuleId>` — one capsule per body segment of one
 * OTHER cast member. The capsule id is fix-collisions' own ("torso", "head",
 * "leftForeArm", …), so a label names the part that was hit. */
export function characterBlockerId(characterId, capsuleId) {
	return `${CHARACTER_BLOCKER_PREFIX}${characterId}:${capsuleId}`;
}

/** The character id a `char:` blocker belongs to, or null. Split on the FIRST
 * colon after the prefix, so a character id may itself contain colons. */
export function blockerCharacterId(blockerId) {
	if (typeof blockerId !== "string" || !blockerId.startsWith(CHARACTER_BLOCKER_PREFIX)) return null;
	const rest = blockerId.slice(CHARACTER_BLOCKER_PREFIX.length);
	const cut = rest.lastIndexOf(":");
	return cut > 0 ? rest.slice(0, cut) : null;
}

/**
 * Resolve an object's world size. `objectSize` (scene-objects.js) is the ONE
 * owner of footprint × scale, so it is reused rather than re-derived here — a
 * cutout's width is a derived quantity and duplicating the derivation is how
 * the plan board and the solver would end up disagreeing about how wide a card
 * is. A record whose footprint is missing (a hand-authored payload, or a kind
 * whose size lives only in the library) falls back to the library entry.
 */
function resolveSize(object, library) {
	if (object.footprint && Number.isFinite(object.height)) return objectSize(object);
	const entry = library?.find((each) => each.kind === object.renderer) ?? null;
	if (!entry) return null;
	return objectSize({
		...object,
		footprint: object.footprint ?? entry.footprint,
		height: Number.isFinite(object.height) ? object.height : entry.height,
	});
}

/**
 * One box blocker per scene object, in world space.
 *
 * The box is the object's footprint rectangle extruded to its height, centred
 * half a height above where it stands: `y` is the base above the deck (0 =
 * standing on it), so the centre sits at `y + height / 2`. `yaw` carries the
 * record's `rot` in RADIANS about world Y, which is exactly the convention the
 * renderer places the prop with (props.jsx: `rotation={[rotX·DEG, rot·DEG,
 * rotZ·DEG]}`).
 *
 * Skipped, and why:
 *   - `plane` and anything else of zero height: a card lying flat on the deck
 *     is the floor, and the floor already has its own clearance rule
 *     (PUSH_FLOOR_CLEARANCE). A zero-thickness blocker would also make every
 *     escape normal degenerate.
 *   - no resolvable footprint: nothing to build a rectangle from.
 *   - an ATTACHED prop (`attach` non-null): while attached, x/y/z/rot are the
 *     prop's LOCAL transform in a bone's frame, not world — placing that box in
 *     world space would put a solid obstacle at a fictional position. Resolving
 *     it needs the live scene graph (attachFrameMatrix), which this pure module
 *     deliberately does not have; the App can pass such objects in itself once
 *     it wants carried props to block.
 *   - anything named in `skipIds` (the object being dragged, say).
 *
 * Pitch and roll (`rotX`/`rotZ`) are a documented approximation: the box stays
 * upright, exactly as `objectFootprintBounds` treats a tilted prop. Yaw is
 * exact.
 *
 * @param {object[]} sceneObjects  scene object records
 * @param {object}   [options]
 * @param {object[]} [options.library]  OBJECT_LIBRARY, for records with no footprint
 * @param {number}   [options.frame]    absolute timeline frame; sample travel paths at it
 * @param {{frameCount:number,fps:number}} [options.take]  timeline geometry for the sampling
 * @param {Iterable<string>} [options.skipIds]
 * @returns {Array<{id:string,kind:"box",center:THREE.Vector3,halfExtents:THREE.Vector3,yaw:number}>}
 */
export function sceneObjectBlockers(sceneObjects, { library = null, frame = null, take = null, skipIds = null, characters = null } = {}) {
	if (!Array.isArray(sceneObjects) || !sceneObjects.length) return [];
	const skip = skipIds ? new Set(skipIds) : null;
	const cast = !characters ? [] : Array.isArray(characters) ? characters : [...characters];
	const out = [];
	for (const object of sceneObjects) {
		if (!object || typeof object !== "object") continue;
		if (typeof object.id !== "string" || !object.id) continue;
		if (skip?.has(object.id)) continue;
		if (isEffectivelyHidden(object, sceneObjects, cast)) continue;
		// A carried prop's numbers are not world numbers — see the note above.
		if (object.attach) continue;
		const size = resolveSize(object, library);
		if (!size) continue;
		if (!(size.width > 0) || !(size.depth > 0) || !(size.height > 0)) continue;
		// A prop on a travel path stands somewhere else on every frame; sample it
		// with the same helper the renderer places it with, so a blocker is where
		// the box on screen is.
		let x = object.x ?? 0;
		let y = object.y ?? 0;
		let z = object.z ?? 0;
		let rot = object.rot ?? 0;
		if (Number.isFinite(frame) && object.path) {
			const at = objectTransformAt(object, frame, take ?? {});
			if (at) {
				x = at.x;
				y = at.y;
				z = at.z;
				if (at.rot !== null) rot = at.rot;
			}
		}
		out.push({
			id: objectBlockerId(object.id),
			kind: "box",
			center: new THREE.Vector3(x, y + size.height / 2, z),
			halfExtents: new THREE.Vector3(size.width / 2, size.height / 2, size.depth / 2),
			yaw: rot * DEG,
		});
	}
	return out;
}

/** rigs may arrive as the App's plain `{ [characterId]: rig }` map or as a Map;
 * both are read through one iterator so a caller never has to convert. */
function rigEntries(rigs) {
	if (!rigs) return [];
	if (rigs instanceof Map) return [...rigs.entries()];
	if (typeof rigs !== "object") return [];
	return Object.entries(rigs);
}

/**
 * True for a capsule that stands for a FINGER rather than a body segment.
 *
 * fix-collisions marks its finger defs two ways — `optional: true` (a rig is
 * allowed not to have them) and `handId`, the hand the finger hangs off — and
 * either is enough to tell one from a body proxy. Read from the def rather
 * than pattern-matched on the id, so a renamed finger cannot quietly become an
 * obstacle again.
 *
 * ANOTHER character's fingers are not obstacles. They are ~11 mm thin, so a
 * limb can pass one without anything visibly wrong, and there are ten of them
 * per body: including them multiplies the blocker list (and so the pair loop)
 * by nearly three for hits nobody would see. The character's OWN fingers are
 * untouched — that is fix-collisions' business, and there the fingers are the
 * whole point.
 */
function isFingerCapsule(def) {
	if (!def) return false;
	return def.optional === true || typeof def.handId === "string";
}

/** The set of ids a caller says are actually in the cast, or null for "no
 * opinion". Accepts ids or character records, so the App can hand its
 * `characters` array straight in. */
function characterIdSet(characterIds) {
	if (!characterIds) return null;
	const ids = [...characterIds].map((each) => (typeof each === "string" ? each : each?.id)).filter(Boolean);
	return new Set(ids);
}

/**
 * Capsule blockers for every cast member EXCEPT `activeId` — the bodies the
 * character being fixed has to keep out of.
 *
 * The proxies come from `buildCollisionCapsules`, the same table the self-
 * collision pass uses, so radii are the measured contact radii of that
 * character's own mesh and a blocker is exactly as thick as the part it stands
 * for. The rig must be MOUNTED and its world matrices current — the capsules
 * are read from `bone.getWorldPosition`, which is what makes a blocker follow
 * the other character's animation, its stage position and its scale for free.
 *
 * A rig `buildCollisionCapsules` cannot describe (a non-Mixamo skeleton, a
 * missing required bone) returns null and is SKIPPED rather than refusing the
 * whole set: one unsupported extra in the cast must not switch external
 * blocking off for everybody else. Finger capsules are left out — see
 * isFingerCapsule.
 *
 * `characterIds` is the CAST as it stands, and passing it is what keeps a
 * ghost out of the set: the rig map is keyed by character id and an undo that
 * removes a subject puts the cast list back without necessarily evicting the
 * rig that was mounted for it, so a stale entry would go on blocking with a
 * body nobody can see. Membership is decided by the caller's list, never by
 * whether a rig object happens to still be reachable.
 *
 * @param {object|Map} rigs        characterId → THREE.Object3D (the App's `rigs`)
 * @param {string|null} activeId   the character being fixed; never blocks itself
 * @param {object} [options]
 * @param {object|Map} [options.radii]  radii override, per character id or shared
 * @param {Iterable<string|{id:string}>} [options.characterIds]  the current cast; ids outside it are ignored
 * @returns {Array<{id:string,kind:"capsule",a:THREE.Vector3,b:THREE.Vector3,radius:number}>}
 */
export function characterBlockers(rigs, activeId = null, { radii = null, characterIds = null } = {}) {
	const cast = characterIdSet(characterIds);
	const hiddenCast = new Set(
		[...(characterIds ?? [])].filter((each) => each && typeof each === "object" && each.hidden === true).map((each) => each.id),
	);
	const out = [];
	for (const [characterId, rig] of rigEntries(rigs)) {
		if (!rig || characterId === activeId) continue;
		if (cast && !cast.has(characterId)) continue;
		if (hiddenCast.has(characterId)) continue;
		const override = radii instanceof Map ? radii.get(characterId) ?? null : radii?.[characterId] ?? radii ?? null;
		const capsules = buildCollisionCapsules(rig, override);
		if (!capsules) continue;
		for (const [capsuleId, capsule] of capsules) {
			if (isFingerCapsule(capsule.def)) continue;
			out.push({
				id: characterBlockerId(characterId, capsuleId),
				kind: "capsule",
				a: capsule.a.clone(),
				b: capsule.b.clone(),
				radius: capsule.radius,
			});
		}
	}
	return out;
}

/**
 * Everything external, in one call: the other cast members as they stand right
 * now plus the scene's objects. studio-agent-motion.js rebuilds this list per
 * frame and hands it to its penetration check.
 */
export function collisionBlockers({ rigs = null, activeId = null, characterIds = null, sceneObjects = null, library = null } = {}) {
	return [
		...characterBlockers(rigs, activeId, { characterIds }),
		...sceneObjectBlockers(sceneObjects, { library, characters: characterIds }),
	];
}

/**
 * A JSON-safe view of a blocker list, for the verification report and for
 * tests: plain numbers only, no THREE.Vector3, so a headless check can
 * serialize it across the CDP boundary.
 */
export function blockerSummary(blockers) {
	if (!Array.isArray(blockers)) return [];
	return blockers.map((blocker) =>
		blocker.kind === "box"
			? {
					id: blocker.id,
					kind: "box",
					cx: blocker.center.x, cy: blocker.center.y, cz: blocker.center.z,
					hx: blocker.halfExtents.x, hy: blocker.halfExtents.y, hz: blocker.halfExtents.z,
					yaw: blocker.yaw,
				}
			: {
					id: blocker.id,
					kind: "capsule",
					ax: blocker.a.x, ay: blocker.a.y, az: blocker.a.z,
					bx: blocker.b.x, by: blocker.b.y, bz: blocker.b.z,
					radius: blocker.radius,
				},
	);
}
