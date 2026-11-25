/**
 * Scene objects: everything the user drops into the set themselves.
 *
 * A shot needs things in it. The set used to ship a fixed handful of props and
 * no way to add anything, so this module owns the whole lifecycle instead:
 * the catalogue you can create from, the record every object carries, and the
 * transform maths the gizmo and the inspector sliders both go through. One
 * clamp/snap path means a drag in the viewport and a slider nudge can never
 * disagree about what a legal transform is.
 *
 * Record shape:
 *   { id, name, renderer, x, y, z, rot, rotX, rotZ, scaleX, scaleY, scaleZ,
 *     color, footprint: { width, depth }, height }
 * Position is metres on the floor plane (`y` is height above the deck, 0 =
 * standing on it). `rot` stays the Y (yaw) angle in degrees — the bird's-eye
 * board and its handles are built on it — with `rotX`/`rotZ` the pitch/roll
 * the 3D gizmo's other two rings drive.
 */

import { Euler, Quaternion } from "three";
import { createObjectPath, translateObjectPath } from "./object-path.js";
import { elementByPath } from "./studio-elements.js";
import { MESH_DEFAULT_HEIGHT, MESH_HEIGHT_MIN } from "./scene-mesh.js";
import { normalizeSculptRecipe, sculptStandingBox } from "./sculpt-recipe.js";
import { GREY_BOX } from "./object-colors.js";
import { isEffectivelyHidden } from "./object-hidden.js";
import { retireObjectKind } from "./retired-kinds.js";
import { objectSize } from "./object-size.js";
import { EFFECT_ENTRY, effectFields } from "./effects/effect-record.js";
import { TEXT_ENTRY, TEXT_KIND, textFields, textPatch } from "./text/text-record.js";
import { LIGHT_KIND, LIGHT_MENU_ENTRIES, lightLibraryEntry, objectLookFields, objectLookPatch, objectGraspFields, objectGraspPatch, objectMaterialKeys } from "./object-look.js";
export { OBJECT_COLORS, normalizeObjectColor, rememberObjectColor, readStoredObjectColors, writeStoredObjectColors } from "./object-colors.js";
export { isEffectivelyHidden };

export const DEFAULT_SCENE_OBJECTS = [];
/** The persistence contract (plan §8.1): the version lives in the key AND in
 * the body, so a future v2 can read a v1 body. The quarantine key holds a
 * corrupt payload byte-for-byte until an older build can be upgraded. */
export const SCENE_STORAGE_KEY = "cozyclay.scene.v1";
export const SCENE_QUARANTINE_KEY = "cozyclay.scene.v1.quarantine";
export const SCENE_VERSION = 1;

/** Euler convention shared with the renderer in props.jsx. */
const EULER_ORDER = "XYZ";
const DEG = Math.PI / 180;
const OBJECT_POSITION_LIMITS = elementByPath("object.position");
const OBJECT_ROTATION_LIMITS = elementByPath("object.rotation");
const OBJECT_SCALE_LIMITS = elementByPath("object.scale");

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
/** degrees folded into the declared rotation envelope */
export const wrapAngle = (deg) => {
	const min = OBJECT_ROTATION_LIMITS.min.y;
	const span = OBJECT_ROTATION_LIMITS.max.y - min;
	return ((((deg - min) % span) + span) % span) + min;
};
/** Snap to a detent AND to that detent's own precision: plain multiplication
 * leaves 0.05 grids reading -1.7000000000000002 in the inspector. A step of 0
 * means "no detent" — a free drag still rounds, or the inspector would show a
 * position of 1.2999999999999998. */
const snapTo = (value, step) => Number((step > 0 ? Math.round(value / step) * step : value).toFixed(4));

/**
 * What you can create. `group` is the catalogue heading, `footprint` is the
 * plan-board rectangle in metres, `height` is how tall the untransformed
 * object stands (used for the selection box and the gizmo's height).
 *
 * Primitives are grey-box grey on purpose: a blockout stands in for something
 * else, and a tinted maquette reads as a finished prop.
 */
export const OBJECT_LIBRARY = [
	{ kind: "cube", label: "Cube", group: "Primitives", footprint: { width: 1, depth: 1 }, height: 1, color: GREY_BOX },
	{ kind: "sphere", label: "Sphere", group: "Primitives", footprint: { width: 1, depth: 1 }, height: 1, color: GREY_BOX },
	{ kind: "capsule", label: "Capsule", group: "Primitives", footprint: { width: 0.7, depth: 0.7 }, height: 1.4, color: GREY_BOX },
	{ kind: "cylinder", label: "Cylinder", group: "Primitives", footprint: { width: 1, depth: 1 }, height: 1, color: GREY_BOX },
	{ kind: "cone", label: "Cone", group: "Primitives", footprint: { width: 1, depth: 1 }, height: 1, color: GREY_BOX },
	{ kind: "plane", label: "Plane", group: "Primitives", footprint: { width: 2, depth: 2 }, height: 0, color: GREY_BOX },
];

/**
 * A cutout is a standee: an imported image standing on a card. Its size is NOT
 * library data — the height is measured by the user and the width follows the
 * picture's own aspect — so the record carries `assetId`, `aspect` and
 * `height`, and the footprint is DERIVED from them. Deriving rather than
 * storing is what stops a card persisting a width its picture disagrees with.
 */
export const CUTOUT_KIND = "cutout";
/** Card thickness in metres: thin enough to read as flat, thick enough that
 * the plan board and dropToSurfacePatch still have a rectangle to work on. */
export const CUTOUT_THICKNESS = 0.02;
/** A fresh cutout stands as tall as the figure it blocks against
 * (SUBJECT_HEIGHT_M), so the first thing you see is honest scale. */
export const CUTOUT_DEFAULT_HEIGHT = 1.8;
const CUTOUT_HEIGHT_MIN = 0.05;
const CUTOUT_ASPECT_MIN = 0.02;
const CUTOUT_ASPECT_MAX = 50;
/** Cutouts carry their own colour: unlike a primitive, the card IS the thing
 * it depicts, so it is tinted white and multiplies the image untouched. */
const CUTOUT_TINT = "#ffffff";
const CUTOUT_ENTRY = {
	kind: CUTOUT_KIND,
	label: "Cutout",
	group: "Images",
	footprint: { width: 1, depth: CUTOUT_THICKNESS },
	height: CUTOUT_DEFAULT_HEIGHT,
	color: CUTOUT_TINT,
};

/**
 * A mesh is an imported GLB standing on the floor. Its size is NOT library
 * data — the box is measured (and outlier-fitted) at import — so the record
 * carries `assetId`, `footprint` and `height`. Clay is per-instance: two
 * clones of the same file can disagree about looking like a maquette.
 */
export const MESH_KIND = "mesh";
const MESH_ENTRY = {
	kind: MESH_KIND,
	label: "Model",
	group: "Models",
	footprint: { width: 1, depth: 1 },
	height: MESH_DEFAULT_HEIGHT,
	color: "#c49a6c",
};

/**
 * A sculpt is a clay prop built from a recipe of soft parts (sculpt-recipe.js):
 * data an agent writes from a reference image, never code. Like a mesh its size
 * is per-instance, but it is MEASURED from the recipe rather than stored as a
 * fact, so a record can never disagree with the parts it draws.
 */
export const SCULPT_KIND = "sculpt";
const SCULPT_ENTRY = {
	kind: SCULPT_KIND,
	label: "Sculpt",
	group: "Sculpts",
	footprint: { width: 1, depth: 1 },
	height: 1,
	color: "#c2c6c8",
};

/**
 * An empty is a pure grouping node: a transform and a place in the hierarchy,
 * with nothing to draw (Unity's Create Empty, Blender's Empty). It exists so a
 * multi-part assembly can have one top-level handle — move it, turn it, give it
 * a route — without any of the parts having to stand in for it.
 *
 * Its size is zero on purpose. Every consumer that reads geometry (blockers,
 * drop surfaces, ground sampling, support rise, fits, the plan footprint) goes
 * through `footprint` × `height`, so a zero box makes the empty invisible to
 * all of them without a per-consumer special case; the few that would
 * misread a zero box as a point (dropToSurfacePatch) check `isEmptyObject`.
 * It is creatable from the menu, so it lives beside the library entries rather
 * than being import-only.
 */
export const EMPTY_KIND = "empty";
/** Editor-only marker size in metres: the axes cross drawn for an empty, and
 * the side of the invisible volume that makes it clickable. */
export const EMPTY_MARKER_SIZE = 0.3;
const EMPTY_ENTRY = {
	kind: EMPTY_KIND,
	label: "Empty",
	group: "Primitives",
	footprint: { width: 0, depth: 0 },
	height: 0,
	color: "#ffffff",
};

/** True for a record that is only a node: no mesh, no collision, no surface.
 * A practical light (object-look.js) is one too: it lights, it does not stand. */
export function isEmptyObject(object) {
	return object?.renderer === EMPTY_KIND || object?.renderer === LIGHT_KIND;
}

/** The catalogue grouped for the create menu: the library plus the empty, a
 * text, the two practical lights and the effect emitter, which are creatable
 * but have no fixed footprint to satisfy the library's contract. */
export const OBJECT_MENU_ENTRIES = Object.freeze([EMPTY_ENTRY, ...OBJECT_LIBRARY, TEXT_ENTRY, ...LIGHT_MENU_ENTRIES, EFFECT_ENTRY]);

/** Every kind that can exist in a scene: the catalogue you can create from,
 * plus the kinds that arrive by import and so are deliberately absent from the
 * "Add object" menu (a cutout without an image, a mesh without a GLB, has
 * nothing to draw). */
function objectLibraryEntry(kind) {
	if (kind === CUTOUT_KIND) return CUTOUT_ENTRY;
	if (kind === MESH_KIND) return MESH_ENTRY;
	if (kind === SCULPT_KIND) return SCULPT_ENTRY;
	if (kind === EMPTY_KIND) return EMPTY_ENTRY;
	if (kind === EFFECT_ENTRY.kind) return EFFECT_ENTRY;
	if (kind === TEXT_KIND) return TEXT_ENTRY;
	return OBJECT_LIBRARY.find((entry) => entry.kind === kind) ?? lightLibraryEntry(kind);
}

/** Return the authored walkable surface for mocap contact staging. */
export function supportHeightForObject(object) {
	if (!object || typeof object !== "object") return 0;
	const entry = objectLibraryEntry(object.renderer);
	const local = Number(object.supportY ?? entry?.supportY ?? object.height ?? entry?.height);
	return Number.isFinite(local) ? local : 0;
}

const cutoutHeight = (value) => Math.max(CUTOUT_HEIGHT_MIN, value);
const cutoutAspect = (value) => clamp(value, CUTOUT_ASPECT_MIN, CUTOUT_ASPECT_MAX);

/** How far a card may be pulled off the picture's own proportions. */
const CUTOUT_STRETCH_MIN = 0.1;
const CUTOUT_STRETCH_MAX = 10;
const cutoutStretch = (value) => {
	const n = Number(value);
	return Number.isFinite(n) ? clamp(n, CUTOUT_STRETCH_MIN, CUTOUT_STRETCH_MAX) : 1;
};

/**
 * The plan-board rectangle a card of this height and picture aspect occupies.
 * `aspect` is the image's width / height.
 *
 * `stretch` is how far the card has been pulled off those proportions: 1 is the
 * picture undistorted. It is kept as its own factor rather than folded into
 * `aspect` so the photograph's true proportions survive every edit — a re-cut
 * recomputes `aspect` from the trimmed image, and a card that had been widened
 * would otherwise silently lose or compound that widening.
 */
export function cutoutFootprint(height, aspect, stretch = 1) {
	return {
		width: cutoutHeight(height) * cutoutAspect(aspect) * cutoutStretch(stretch),
		depth: CUTOUT_THICKNESS,
	};
}

/**
 * The frames a prop can be pinned to on a character. These are the APP's IK
 * track ids — the same names the rig panel and the animation tracks speak —
 * NOT three.js bone names: the store must never depend on which skeleton a
 * character happens to be wearing, or a re-rigged cast would silently drop
 * every attachment it had.
 *
 * `bone: null` is deliberately absent from the list: it means the character's
 * animated ROOT frame (carry the whole body's motion, not one limb's), which
 * is a different thing from "no bone chosen yet" and so is spelled as null
 * rather than as a fifteenth member here.
 */
export const SCENE_ATTACH_BONES = Object.freeze([
	"hips",
	"spine",
	"chest",
	"neck",
	"head",
	"leftShoulder",
	"leftElbow",
	"leftHand",
	"rightShoulder",
	"rightElbow",
	"rightHand",
	"leftKnee",
	"leftFoot",
	"rightKnee",
	"rightFoot",
]);

/**
 * Repair an attachment into the exact two-key record, or report that it is not
 * an attachment at all. THREE outcomes, which is why this returns `undefined`
 * rather than throwing or collapsing to null:
 *   null      — detached, a legal and meaningful value
 *   {…}       — a live attachment, stripped to exactly characterId + bone
 *   undefined — malformed; the caller decides whether that means "refuse the
 *               edit" (setSceneObjectAttach) or "read it as detached" (decode)
 *
 * `characterId` is NOT checked against the cast: this module owns the scene's
 * objects and has never known who is on stage. A dangling id renders as
 * detached — the App's job, since only it can tell.
 *
 * Extra keys are dropped rather than refused, so an over-eager caller (or a
 * record written by a future build) attaches correctly instead of failing.
 */
function normalizeSceneAttach(value) {
	if (value === null) return null;
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const { characterId, bone } = value;
	if (typeof characterId !== "string" || !characterId) return undefined;
	// An absent bone is the root frame, exactly like an explicit null; anything
	// that is not a track id is a typo, and a typo must not pin a prop to
	// nowhere.
	if (bone === null || bone === undefined) return { characterId, bone: null };
	if (typeof bone !== "string" || !SCENE_ATTACH_BONES.includes(bone)) return undefined;
	return { characterId, bone };
}

export function sceneObjectHierarchyId(id) {
	return `object:${id}`;
}

export function sceneObjectIdFromHierarchy(hierarchyId) {
	return typeof hierarchyId === "string" && hierarchyId.startsWith("object:") ? hierarchyId.slice("object:".length) : null;
}

/**
 * A fresh object of `kind`, named and identified uniquely against `existing`.
 * `placement` seeds the floor position (the caller drops it in front of the
 * camera); everything else starts neutral so the first drag is predictable.
 * `text` seeds a text record's words (text-record.js); other kinds ignore it.
 */
export function createSceneObject(kind, existing = [], placement = {}, text = undefined) {
	// Cutouts and meshes come from an import, never from the catalogue:
	// without an asset id the record has nothing to draw.
	if (kind === CUTOUT_KIND || kind === MESH_KIND || kind === SCULPT_KIND) return null;
	const entry = objectLibraryEntry(kind);
	if (!entry) return null;
	const names = new Set(existing.map((object) => object.name));
	let name = entry.label;
	for (let n = 2; names.has(name); n += 1) name = `${entry.label} ${n}`;
	const ids = new Set(existing.map((object) => object.id));
	let id = kind;
	for (let n = 2; ids.has(id); n += 1) id = `${kind}-${n}`;
	return {
		id,
		name,
		// A light kind (point-light, spot-light) is a preset of the one light renderer.
		renderer: entry.renderer ?? kind,
		x: TRANSFORM_LIMITS.x(Number(placement.x) || 0),
		y: entry.placeY ?? 0,
		z: TRANSFORM_LIMITS.z(Number(placement.z) || 0),
		rot: TRANSFORM_LIMITS.rot(Number(placement.rot) || 0),
		rotX: 0,
		rotZ: 0,
		scaleX: 1,
		scaleY: 1,
		scaleZ: 1,
		// A travel path, drawn on the Top-View floor and refined in the scene.
		// null means the object stands where it was placed.
		path: null,
		color: entry.color,
		parent: null,
		// Rides on a character's animated frame instead of the floor. null is a
		// world-anchored prop — where everything starts, because a fresh object
		// is dropped in front of the lens, not into someone's hand.
		attach: null,
		hidden: false,
		footprint: { ...entry.footprint },
		height: entry.height,
		supportY: Number.isFinite(entry.supportY) ? entry.supportY : entry.height,
		...objectLookFields({}, entry),
		...effectFields({ renderer: kind }),
		// A text's words and the box measured from them (src/text/text-record.js).
		...textFields({ renderer: kind, text }),
	};
}

/**
 * A fresh cutout for an imported image. `assetId` addresses the picture in the
 * asset store — the record never carries the bytes, which is what keeps a
 * scene small enough to live in localStorage — and `aspect` is the image's
 * width / height so the card can be sized by height alone.
 *
 * `name` seeds the display name (the file's own name is the obvious caller
 * choice); everything else starts neutral, exactly like a catalogue object.
 */
export function createCutoutObject({ assetId, aspect = 1, height = CUTOUT_DEFAULT_HEIGHT, name = "", sourceAssetId, matteAssetId, matteScale, stretch } = {}, existing = [], placement = {}) {
	if (typeof assetId !== "string" || !assetId) return null;
	const pictureAspect = cutoutAspect(Number(aspect));
	const cardHeight = cutoutHeight(Number(height));
	if (!Number.isFinite(pictureAspect) || !Number.isFinite(cardHeight)) return null;
	// A duplicate hands the lineage in so the copy stays re-editable: the
	// picture it renders, the photograph it came from, the selection mask,
	// the trim factor and the stretch. A fresh import passes none, so the
	// defaults below leave it as its own unmasked original — exactly the
	// record an untouched card has always carried.
	const cardStretch = cutoutStretch(stretch);
	const base = typeof name === "string" && name.trim() ? name.trim() : CUTOUT_ENTRY.label;
	const names = new Set(existing.map((object) => object.name));
	let displayName = base;
	for (let n = 2; names.has(displayName); n += 1) displayName = `${base} ${n}`;
	const ids = new Set(existing.map((object) => object.id));
	let id = CUTOUT_KIND;
	for (let n = 2; ids.has(id); n += 1) id = `${CUTOUT_KIND}-${n}`;
	return {
		id,
		name: displayName,
		renderer: CUTOUT_KIND,
		x: TRANSFORM_LIMITS.x(Number(placement.x) || 0),
		y: 0,
		z: TRANSFORM_LIMITS.z(Number(placement.z) || 0),
		rot: TRANSFORM_LIMITS.rot(Number(placement.rot) || 0),
		rotX: 0,
		rotZ: 0,
		scaleX: 1,
		scaleY: 1,
		scaleZ: 1,
		path: null,
		color: CUTOUT_TINT,
		parent: null,
		attach: null,
		hidden: false,
		// Key order matches what `normalizeSceneObject` writes, so a record
		// survives a storage round trip byte-for-byte.
		assetId,
		// A picture nobody has cut is its own original, with no purple on it;
		// a duplicate passes the lineage through so the copy stays re-editable.
		sourceAssetId: typeof sourceAssetId === "string" && sourceAssetId ? sourceAssetId : assetId,
		matteAssetId: typeof matteAssetId === "string" ? matteAssetId : "",
		matteScale: Number.isFinite(Number(matteScale)) ? Number(matteScale) : 1,
		aspect: pictureAspect,
		// A new card wears the picture's own proportions; a widened one carries
		// its factor through so the copy keeps the shape it was pulled to.
		stretch: cardStretch,
		footprint: cutoutFootprint(cardHeight, pictureAspect, cardStretch),
		height: cardHeight,
	};
}

/**
 * The option bundle a cutout duplicate hands to `createCutoutObject`. A copy
 * is minted through the same door an import is, so it must carry the picture
 * it renders AND the photograph it came from, the selection mask, the trim
 * factor and the stretch — otherwise the matte is silently reset and the
 * duplicate is no longer re-editable. Kept as its own pure helper so the
 * duplicate path and its test speak the very same option-building, not a
 * hand-rolled copy.
 */
export function duplicateCutoutOptions(object) {
	return {
		assetId: object.assetId,
		aspect: object.aspect,
		height: object.height,
		name: object.name,
		sourceAssetId: object.sourceAssetId,
		matteAssetId: object.matteAssetId,
		matteScale: object.matteScale,
		stretch: object.stretch,
	};
}

/**
 * A fresh mesh for an imported GLB. `assetId` addresses the bytes in the
 * asset store — the record never carries them — and `footprint`/`height` are
 * the fitted standing size from import. Unlike a cutout, the footprint is
 * stored (not derived): the GLB's width/depth ratio is independent of height,
 * and a later height edit scales that stored rectangle uniformly.
 */
export function createMeshObject({ assetId, height = MESH_DEFAULT_HEIGHT, footprint, name = "", clay = false } = {}, existing = [], placement = {}) {
	if (typeof assetId !== "string" || !assetId) return null;
	const meshHeight = Math.max(MESH_HEIGHT_MIN, Number(height));
	if (!Number.isFinite(meshHeight)) return null;
	const width = Number(footprint?.width);
	const depth = Number(footprint?.depth);
	const meshFootprint =
		Number.isFinite(width) && width > 0 && Number.isFinite(depth) && depth > 0
			? { width, depth }
			: { width: meshHeight, depth: meshHeight };
	const base = typeof name === "string" && name.trim() ? name.trim() : MESH_ENTRY.label;
	const names = new Set(existing.map((object) => object.name));
	let displayName = base;
	for (let n = 2; names.has(displayName); n += 1) displayName = `${base} ${n}`;
	const ids = new Set(existing.map((object) => object.id));
	let id = MESH_KIND;
	for (let n = 2; ids.has(id); n += 1) id = `${MESH_KIND}-${n}`;
	return {
		id,
		name: displayName,
		renderer: MESH_KIND,
		x: TRANSFORM_LIMITS.x(Number(placement.x) || 0),
		y: 0,
		z: TRANSFORM_LIMITS.z(Number(placement.z) || 0),
		rot: wrapAngle(Number(placement.rot) || 0),
		rotX: 0,
		rotZ: 0,
		scaleX: 1,
		scaleY: 1,
		scaleZ: 1,
		path: null,
		color: MESH_ENTRY.color,
		parent: null,
		attach: null,
		hidden: false,
		assetId,
		clay: clay === true,
		footprint: meshFootprint,
		height: meshHeight,
	};
}

/** The option bundle a mesh duplicate hands to `createMeshObject`. A copy
 * is minted through the same door an import is, so it must carry the model
 * it renders, the standing size, and whether it is wearing clay. */
export function duplicateMeshOptions(object) {
	return { assetId: object.assetId, height: object.height, footprint: object.footprint, name: object.name, clay: object.clay === true };
}

/**
 * A fresh sculpt from a recipe. Returns `{ object }` or `{ error }` with the
 * recipe's own refusal, so a caller (the agent above all) hears why a recipe
 * cannot be drawn instead of getting a silent null.
 */
export function createSculptObject({ recipe, name = "" } = {}, existing = [], placement = {}) {
	const normalized = normalizeSculptRecipe(recipe);
	if (!normalized.ok) return { error: normalized.error };
	const { footprint, height } = sculptStandingBox(normalized.recipe);
	const base = typeof name === "string" && name.trim() ? name.trim() : SCULPT_ENTRY.label;
	const names = new Set(existing.map((object) => object.name));
	let displayName = base;
	for (let n = 2; names.has(displayName); n += 1) displayName = `${base} ${n}`;
	const ids = new Set(existing.map((object) => object.id));
	let id = SCULPT_KIND;
	for (let n = 2; ids.has(id); n += 1) id = `${SCULPT_KIND}-${n}`;
	return {
		object: {
			id,
			name: displayName,
			renderer: SCULPT_KIND,
			x: TRANSFORM_LIMITS.x(Number(placement.x) || 0),
			y: TRANSFORM_LIMITS.y(Number(placement.y) || 0),
			z: TRANSFORM_LIMITS.z(Number(placement.z) || 0),
			rot: wrapAngle(Number(placement.rot) || 0),
			rotX: 0,
			rotZ: 0,
			scaleX: 1,
			scaleY: 1,
			scaleZ: 1,
			path: null,
			color: SCULPT_ENTRY.color,
			parent: null,
			attach: null,
			hidden: false,
			recipe: normalized.recipe,
			footprint,
			height,
		},
	};
}

export function duplicateSculptOptions(object) {
	return { recipe: object.recipe, name: object.name };
}

/** Every writable transform channel and the rule that keeps it in the room. */
const TRANSFORM_LIMITS = {
	x: (value) => clamp(value, OBJECT_POSITION_LIMITS.min.x, OBJECT_POSITION_LIMITS.max.x),
	y: (value) => clamp(value, OBJECT_POSITION_LIMITS.min.y, OBJECT_POSITION_LIMITS.max.y),
	z: (value) => clamp(value, OBJECT_POSITION_LIMITS.min.z, OBJECT_POSITION_LIMITS.max.z),
	rot: (value) => wrapAngle(value),
	rotX: (value) => wrapAngle(value),
	rotZ: (value) => wrapAngle(value),
	scaleX: (value) => clamp(value, OBJECT_SCALE_LIMITS.min.x, OBJECT_SCALE_LIMITS.max.x),
	scaleY: (value) => clamp(value, OBJECT_SCALE_LIMITS.min.y, OBJECT_SCALE_LIMITS.max.y),
	scaleZ: (value) => clamp(value, OBJECT_SCALE_LIMITS.min.z, OBJECT_SCALE_LIMITS.max.z),
};

/** The patch keys updateSceneObject reads for this object; any other key is
 * silently ignored there, so callers that must not be silent check against this. */
export function objectPatchFields(object) {
	const fields = [...Object.keys(TRANSFORM_LIMITS), "name", "color", "hidden", "opacity", "path", "glow", "grasp", ...objectMaterialKeys(object?.renderer)];
	if (object?.renderer === LIGHT_KIND) fields.push("light");
	if (object?.renderer === CUTOUT_KIND) fields.push("assetId", "sourceAssetId", "matteAssetId", "matteScale", "height", "aspect", "width", "stretch");
	if (object?.renderer === MESH_KIND) fields.push("clay", "assetId", "height");
	if (object?.renderer === SCULPT_KIND) fields.push("recipe");
	if (object?.renderer === TEXT_KIND) fields.push("text");
	return fields;
}

/** Every object that hangs off `id`, at any depth. A cycle cannot form because
 * setParent refuses one, but the seen-set keeps this total even if data is
 * hand-edited into a loop. */
export function descendantsOf(objects, id) {
	const out = [];
	const seen = new Set([id]);
	let frontier = [id];
	while (frontier.length) {
		const next = [];
		for (const object of objects) {
			if (object.parent && frontier.includes(object.parent) && !seen.has(object.id)) {
				seen.add(object.id);
				out.push(object);
				next.push(object.id);
			}
		}
		frontier = next;
	}
	return out;
}

/** Float dust (6e-17 where 0 belongs) is snapped away, and everything else is
 * kept to 1e-9: fine enough that hundreds of small gizmo steps cannot drift a
 * carried child visibly, coarse enough that stored values stay readable. */
const tidy = (value) => {
	const rounded = Math.round(value * 1e9) / 1e9;
	return rounded === 0 ? 0 : rounded;
};
export const tidyAngle = (deg) => tidy(wrapAngle(tidy(deg)));

const orientationOf = (record) =>
	new Quaternion().setFromEuler(new Euler((record.rotX ?? 0) * DEG, (record.rot ?? 0) * DEG, (record.rotZ ?? 0) * DEG, EULER_ORDER));

/** The Euler triple (degrees, XYZ) for an orientation that stays closest to
 * `near`. Every orientation has two XYZ triples — (x, y, z) and
 * (x+180, 180−y, z+180) — and a bare setFromQuaternion always answers with the
 * one whose Y is within ±90. Taking that blindly would turn a plain yaw of 170
 * into "rotX 180, rot −10, rotZ 180": the same pose, but the bird's-eye board
 * and the inspector read `rot` as the yaw. The nearer triple keeps a flat
 * object flat across every turn. */
function eulerNear(quaternion, near) {
	const e = new Euler().setFromQuaternion(quaternion, EULER_ORDER);
	const here = [near.rotX ?? 0, near.rot ?? 0, near.rotZ ?? 0];
	const candidates = [
		[e.x / DEG, e.y / DEG, e.z / DEG],
		[e.x / DEG + 180, 180 - e.y / DEG, e.z / DEG + 180],
	].map((triple) => triple.map(tidyAngle));
	const distance = (triple) => triple.reduce((sum, value, i) => sum + Math.abs(wrapAngle(value - here[i])), 0);
	const [rotX, rot, rotZ] = distance(candidates[1]) < distance(candidates[0]) ? candidates[1] : candidates[0];
	return { rotX, rot, rotZ };
}

/**
 * The rigid motion that takes a pose to another: where its pivot was and is,
 * and the turn Δ = q_after · q_before⁻¹ between the two orientations (XYZ
 * Eulers, the renderer's order). Anything riding the pose goes to
 * `to + Δ·(p − from)` and turns by Δ on the spot. Returns null when the
 * orientation did not change — a pure move stays a plain translation.
 *
 * `yaw` is the part of Δ that turns about the vertical (swing-twist about +Y,
 * degrees). A character only has a yaw, so it takes this and nothing more: the
 * pitch or roll of what it is grouped under moves its position and leaves its
 * facing alone.
 *
 * @returns {{ quaternion: Quaternion, matrix: number[], yaw: number, from: object, to: object } | null}
 */
export function rigidMotionBetween(before, after) {
	if ((before.rotX ?? 0) === (after.rotX ?? 0) && (before.rot ?? 0) === (after.rot ?? 0) && (before.rotZ ?? 0) === (after.rotZ ?? 0)) return null;
	const quaternion = orientationOf(after).multiply(orientationOf(before).invert());
	if (quaternion.w < 0) quaternion.set(-quaternion.x, -quaternion.y, -quaternion.z, -quaternion.w);
	if (quaternion.w > 1 - 1e-15) return null;
	const { x, y, z, w } = quaternion;
	return {
		quaternion,
		// row-major 3x3 of Δ
		matrix: [
			1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w),
			2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w),
			2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y),
		],
		yaw: tidyAngle((2 * Math.atan2(y, w)) / DEG),
		from: { x: before.x ?? 0, y: before.y ?? 0, z: before.z ?? 0 },
		to: { x: after.x ?? 0, y: after.y ?? 0, z: after.z ?? 0 },
	};
}

/** A point carried by a rigid motion from `rigidMotionBetween`. */
export function carryPointByMotion(point, motion) {
	const { matrix: m, from, to } = motion;
	const dx = point.x - from.x;
	const dy = (point.y ?? 0) - from.y;
	const dz = point.z - from.z;
	return {
		x: tidy(to.x + m[0] * dx + m[1] * dy + m[2] * dz),
		y: tidy(to.y + m[3] * dx + m[4] * dy + m[5] * dz),
		z: tidy(to.z + m[6] * dx + m[7] * dy + m[8] * dz),
	};
}

/** Descendants that turn with a rotating parent: everything under it except
 * records riding a character (their numbers are bone-local, so they follow the
 * bone, not the parent) and whatever hangs below such a record. */
function descendantsThatTurn(objects, id) {
	const out = new Set();
	let frontier = [id];
	while (frontier.length) {
		const next = [];
		for (const object of objects) {
			if (!object.parent || !frontier.includes(object.parent) || object.id === id || out.has(object.id) || object.attach) continue;
			out.add(object.id);
			next.push(object.id);
		}
		frontier = next;
	}
	return out;
}

export function updateSceneObject(objects, id, patch) {
	let changed = false;
	const target = objects.find((object) => object.id === id);
	// A parent carries its children: the group is dragged, nudged, turned and
	// dropped as one body. Translation shifts every descendant by the same
	// delta. Rotation turns the group rigidly about the parent's pivot: each
	// descendant orbits it by Δ = q_new · q_old⁻¹ and composes Δ onto its own
	// orientation, so every child keeps its pose relative to the parent. A
	// child's travel route is NOT turned with it: the route is a road in the
	// world, and a parent's turn turns the bodies (their orientation and the
	// authored position they orbit), never the road they would drive. A move and a turn in one patch is both at once,
	// about the pivot's old and new place. Scale is NOT carried — rescaling a
	// group would have to resize every child about the parent, a different
	// feature. Records riding a character (`attach`) hold bone-local numbers and
	// are left alone by the turn, and so is everything below them.
	const carried = target ? descendantsOf(objects, id) : [];
	const delta = { x: 0, y: 0, z: 0 };
	if (target) {
		for (const axis of ["x", "y", "z"]) {
			if (patch[axis] === undefined) continue;
			const value = Number(patch[axis]);
			if (!Number.isFinite(value)) continue;
			delta[axis] = TRANSFORM_LIMITS[axis](value) - target[axis];
		}
	}
	const moving = new Set(carried.map((object) => object.id));
	const shifts = delta.x || delta.y || delta.z;
	let turn = null;
	let turning = null;
	if (target && !target.attach && carried.length) {
		const after = { x: (target.x ?? 0) + delta.x, y: (target.y ?? 0) + delta.y, z: (target.z ?? 0) + delta.z };
		for (const key of ["rotX", "rot", "rotZ"]) {
			const value = patch[key] === undefined ? NaN : Number(patch[key]);
			after[key] = Number.isFinite(value) ? TRANSFORM_LIMITS[key](value) : (target[key] ?? 0);
		}
		turn = rigidMotionBetween(target, after);
		if (turn) turning = descendantsThatTurn(objects, id);
	}

	const next = objects.map((object) => {
		if (object.id !== id) {
			if ((!shifts && !turn) || !moving.has(object.id)) return object;
			if (turn && turning.has(object.id)) {
				const update = {};
				const orbit = carryPointByMotion({ x: object.x, y: object.y, z: object.z }, turn);
				for (const axis of ["x", "y", "z"]) {
					const bounded = TRANSFORM_LIMITS[axis](orbit[axis]);
					if (bounded !== (object[axis] ?? 0)) update[axis] = bounded;
				}
				const orientation = new Quaternion().multiplyQuaternions(turn.quaternion, orientationOf(object));
				const euler = eulerNear(orientation, object);
				for (const key of ["rotX", "rot", "rotZ"]) {
					if (euler[key] !== (object[key] ?? 0)) update[key] = euler[key];
				}
				// A move in the same edit still carries the road along, unturned.
				if (object.path && shifts) {
					const moved = translateObjectPath(object.path, delta);
					if (JSON.stringify(moved ?? null) !== JSON.stringify(object.path ?? null)) update.path = moved;
				}
				if (!Object.keys(update).length) return object;
				changed = true;
				return { ...object, ...update };
			}
			if (!shifts) return object;
			const update = {};
			const carriedDelta = { x: 0, y: 0, z: 0 };
			for (const axis of ["x", "y", "z"]) {
				if (!delta[axis]) continue;
				const bounded = TRANSFORM_LIMITS[axis](object[axis] + delta[axis]);
				if (bounded === object[axis]) continue;
				update[axis] = bounded;
				carriedDelta[axis] = bounded - object[axis];
			}
			// A carried child takes its route along too, or the group would move
			// while the child stayed nailed to its old route.
			if (object.path && (carriedDelta.x || carriedDelta.y || carriedDelta.z)) {
				update.path = translateObjectPath(object.path, carriedDelta);
			}
			if (!Object.keys(update).length) return object;
			changed = true;
			return { ...object, ...update };
		}
		const update = {};
		for (const [key, limit] of Object.entries(TRANSFORM_LIMITS)) {
			if (patch[key] === undefined) continue;
			const value = Number(patch[key]);
			if (!Number.isFinite(value)) continue;
			const bounded = limit(value);
			if (bounded === object[key]) continue;
			update[key] = bounded;
		}
		for (const key of ["name", "color"]) {
			if (typeof patch[key] !== "string" || !patch[key] || patch[key] === object[key]) continue;
			update[key] = patch[key];
		}
		if (typeof patch.hidden === "boolean" && patch.hidden !== (object.hidden === true)) update.hidden = patch.hidden;
		if (patch.opacity !== undefined && Number.isFinite(Number(patch.opacity))) {
			const opacity = objectOpacity(patch.opacity);
			if (opacity !== objectOpacity(object.opacity)) update.opacity = opacity;
		}
		// The travel path is authored geometry, not a bounded transform: it is
		// normalized by createObjectPath (which repairs or refuses it) and set
		// wholesale, with null clearing it back to a standing object.
		if (patch.path !== undefined) {
			const next = patch.path === null ? null : createObjectPath(patch.path);
			if (JSON.stringify(next ?? null) !== JSON.stringify(object.path ?? null)) update.path = next;
		} else if (object.path && shifts) {
			// Moving a prop that owns a route moves the route with it. Playback
			// places a routed prop FROM its route, so without this the card sits
			// exactly where it was while the inspector reports the new position —
			// a drag that changes numbers and nothing on screen.
			const moved = translateObjectPath(object.path, delta);
			if (JSON.stringify(moved ?? null) !== JSON.stringify(object.path ?? null)) update.path = moved;
		}
		// A cutout is sized in metres — you measure something in the picture and
		// type its height — so `height` and `aspect` are writable where every
		// other kind takes them from the library. The footprint is DERIVED here
		// and never patched: one owner for the card's width is what keeps it
		// from disagreeing with its own image.
		if (object.renderer === CUTOUT_KIND) {
			// The picture itself is writable: cutting the background out stores a
			// NEW asset (different bytes, different id) and points the card at it,
			// which is what makes the cut undoable — the original stays addressed
			// by the history entry before it.
			// Three ids, because a cut card is not one picture: `assetId` is what
			// the set renders, `sourceAssetId` is the photograph it came from and
			// keeps being edited from, and `matteAssetId` is the purple itself.
			// Keeping all three is what makes the cut re-editable instead of
			// destructive — the original is never replaced, only masked.
			for (const key of ["assetId", "sourceAssetId", "matteAssetId"]) {
				if (typeof patch[key] === "string" && patch[key] && patch[key] !== object[key]) update[key] = patch[key];
			}
			// How much of the original frame the trimmed card is. Stored so a
			// second edit can work out the height the card would have at full
			// frame instead of compounding one trim onto the last.
			if (Number.isFinite(Number(patch.matteScale))) {
				const scale = clamp(Number(patch.matteScale), 0.01, 1);
				if (scale !== object.matteScale) update.matteScale = scale;
			}
			const patchedHeight = patch.height === undefined ? NaN : cutoutHeight(Number(patch.height));
			const patchedAspect = patch.aspect === undefined ? NaN : cutoutAspect(Number(patch.aspect));
			const height = Number.isFinite(patchedHeight) ? patchedHeight : object.height;
			const aspect = Number.isFinite(patchedAspect) ? patchedAspect : object.aspect;
			const previousStretch = cutoutStretch(object.stretch);
			// A width in metres is what the inspector and the drag both speak, so it
			// is accepted directly and kept as the factor the record stores.
			const patchedStretch =
				patch.width !== undefined && Number.isFinite(Number(patch.width))
					? cutoutStretch(Number(patch.width) / (height * aspect))
					: patch.stretch === undefined
						? previousStretch
						: cutoutStretch(patch.stretch);
			if (height !== object.height || aspect !== object.aspect || patchedStretch !== previousStretch) {
				update.height = height;
				update.aspect = aspect;
				update.stretch = patchedStretch;
				update.footprint = cutoutFootprint(height, aspect, patchedStretch);
			}
		}
		if (object.renderer === MESH_KIND) {
			if (typeof patch.clay === "boolean" && patch.clay !== (object.clay === true)) update.clay = patch.clay;
			if (typeof patch.assetId === "string" && patch.assetId && patch.assetId !== object.assetId) update.assetId = patch.assetId;
			const patchedHeight = patch.height === undefined ? NaN : Math.max(MESH_HEIGHT_MIN, Number(patch.height));
			if (Number.isFinite(patchedHeight) && patchedHeight !== object.height) {
				update.height = patchedHeight;
				const prevHeight = Number(object.height);
				if (prevHeight > 0) {
					const factor = patchedHeight / prevHeight;
					update.footprint = {
						width: Number(object.footprint?.width) * factor,
						depth: Number(object.footprint?.depth) * factor,
					};
				}
			}
		}
		// A recipe that cannot be drawn leaves the sculpt as it was; the command
		// layer (object.sculpt) is where the refusal is reported.
		if (object.renderer === SCULPT_KIND && patch.recipe !== undefined) {
			const normalized = normalizeSculptRecipe(patch.recipe);
			if (normalized.ok && JSON.stringify(normalized.recipe) !== JSON.stringify(object.recipe)) {
				update.recipe = normalized.recipe;
				Object.assign(update, sculptStandingBox(normalized.recipe));
			}
		}
		// Light, glow and a text's words merge over the record's own and are repaired (object-look.js, text-record.js); grasp sockets replace (object-grasp.js).
		Object.assign(update, objectLookPatch(object, patch), textPatch(object, patch), objectGraspPatch(object, patch));
		if (!Object.keys(update).length) return object;
		changed = true;
		return { ...object, ...update };
	});
	return changed ? next : objects;
}

/**
 * Attach `id` to `parentId` (or detach with null). Refuses the two shapes that
 * would corrupt the tree: an object parented to itself, and a cycle formed by
 * parenting an object to one of its own descendants.
 *
 * Grouping and character attachment are EXCLUSIVE: a prop follows exactly one
 * frame, so taking a parent drops any attachment. Two owners of one transform
 * would leave the record describing a position nothing renders at.
 */
export function setSceneObjectParent(objects, id, parentId) {
	if (id === parentId) return objects;
	if (parentId !== null && !objects.some((object) => object.id === parentId)) return objects;
	if (parentId !== null && descendantsOf(objects, id).some((object) => object.id === parentId)) return objects;
	let changed = false;
	const next = objects.map((object) => {
		if (object.id !== id) return object;
		const parent = parentId ?? null;
		// Detaching from a group says nothing about a character attachment, so
		// only a real parent clears one — and the key is written only when it
		// has something to clear, leaving every unattached record untouched.
		const clearsAttach = parent !== null && (object.attach ?? null) !== null;
		if ((object.parent ?? null) === parent && !clearsAttach) return object;
		changed = true;
		return clearsAttach ? { ...object, parent, attach: null } : { ...object, parent };
	});
	return changed ? next : objects;
}

/**
 * Pin `id` to a character (or one of its bones), or detach it with null.
 * Returns a NEW array on a real change and the SAME array when the edit is
 * refused or is a no-op — the `setSceneObjectParent` convention, and the thing
 * that lets a caller pass the result straight to a history store without
 * minting an empty undo entry.
 *
 * Refused: an unknown object id, and any `attach` that is neither null nor
 * `{ characterId: <non-empty string>, bone: null | <SCENE_ATTACH_BONES member> }`.
 * A refused edit is silent — the Hierarchy's canDrop is what tells the user a
 * drop is illegal, long before the store sees it.
 *
 * Attaching CLEARS `parent`, the mirror of the rule above. NOTE for callers:
 * while attached, the position, rotation and scale channels are the object's
 * LOCAL transform in the attach frame. The store treats those as opaque
 * numbers and never converts them, so taking a world transform into the
 * attach frame on attach (and back out on detach) is the App's job — it is the
 * one that has the three.js scene and can read where the bone actually is.
 */
export function setSceneObjectAttach(objects, id, attach) {
	const next = normalizeSceneAttach(attach);
	if (next === undefined) return objects;
	if (!objects.some((object) => object.id === id)) return objects;
	let changed = false;
	const mapped = objects.map((object) => {
		if (object.id !== id) return object;
		const current = object.attach ?? null;
		if (next === null) {
			if (current === null) return object;
			changed = true;
			return { ...object, attach: null };
		}
		const same = current !== null && current.characterId === next.characterId && (current.bone ?? null) === next.bone;
		const clearsParent = (object.parent ?? null) !== null;
		if (same && !clearsParent) return object;
		changed = true;
		return clearsParent ? { ...object, attach: next, parent: null } : { ...object, attach: next };
	});
	return changed ? mapped : objects;
}

export function removeSceneObject(objects, id) {
	const next = objects.filter((object) => object.id !== id);
	if (next.length === objects.length) return objects;
	// Deleting a parent must not leave its children pointing at a ghost: they
	// are promoted to top level rather than vanishing with it, because a group
	// is an editing convenience and never an owner of the parts.
	return next.map((object) => (object.parent === id ? { ...object, parent: null } : object));
}

/**
 * Wrap `id` in a new Empty: the Empty takes the object's place in the tree
 * (its parent, its position) and the object becomes its child. One pure edit,
 * so the caller can publish it as ONE history entry.
 *
 * Returns `{ objects, emptyId }`, or null when the object is unknown or is
 * carried by a character (its numbers are local to a bone frame, so an Empty
 * "at its position" would sit at a fictional place — detach first).
 *
 * Rotation is not copied: the Empty starts unturned, because a group node
 * should be a clean handle, and the children keep their world transforms
 * (grouping moves nothing on screen).
 */
export function groupUnderNewEmpty(objects, id) {
	const target = objects.find((object) => object.id === id);
	if (!target || target.attach) return null;
	const created = createSceneObject(EMPTY_KIND, objects, { x: target.x, z: target.z });
	if (!created) return null;
	const names = new Set(objects.map((object) => object.name));
	const base = `${target.name} Group`;
	let name = base;
	for (let n = 2; names.has(name); n += 1) name = `${base} ${n}`;
	const empty = { ...created, name, y: TRANSFORM_LIMITS.y(target.y ?? 0), parent: target.parent ?? null };
	// The Empty goes in just before the object, so the Outliner row keeps its place.
	const next = objects.flatMap((object) => (object.id === id ? [empty, { ...object, parent: empty.id }] : [object]));
	return { objects: next, emptyId: empty.id };
}
/**
 * Repair one stored record into a live record, or return null to drop it.
 * Storage is never trusted: `footprint`/`height` are rebuilt from the
 * library, every transform channel goes through the same clamps the editor
 * uses, and missing channels take `createSceneObject` defaults. An unknown
 * `renderer` (or a record without an id) has nothing to render or address,
 * so it is dropped rather than half-restored (plan §8.2).
 */
const OBJECT_OPACITY_MIN = 0.05;

/** 1 = solid. Clamped above zero so a see-through object never becomes an invisible, unpickable one. */
function objectOpacity(value) {
	const n = Number(value);
	return Number.isFinite(n) ? Math.min(1, Math.max(OBJECT_OPACITY_MIN, n)) : 1;
}

export function normalizeSceneObject(record) {
	if (!record || typeof record !== "object" || Array.isArray(record)) return null;
	record = retireObjectKind(record);
	const entry = objectLibraryEntry(record.renderer);
	if (!entry) return null;
	if (typeof record.id !== "string" || !record.id) return null;
	// A cutout addresses its picture by id. A record without one has nothing to
	// draw, so it is dropped rather than restored as a blank card — the same
	// rule an unknown renderer already gets.
	const isCutout = entry.kind === CUTOUT_KIND;
	const isMesh = entry.kind === MESH_KIND;
	const sculpt = entry.kind === SCULPT_KIND ? normalizeSculptRecipe(record.recipe) : null;
	// Same rule as a cutout without its picture: nothing to draw, so dropped.
	if (sculpt && !sculpt.ok) return null;
	if (isCutout && (typeof record.assetId !== "string" || !record.assetId)) return null;
	if (isMesh && (typeof record.assetId !== "string" || !record.assetId)) return null;
	// Defensive import fallback, not a migration: hand-authored or external
	// payloads may carry one `scale` (the pre-split record shape). It fans
	// out to all three axes only when no axis is present — an explicit
	// scaleX wins over the fallback.
	const hasSingleScale = record.scaleX === undefined && record.scaleY === undefined && record.scaleZ === undefined;
	const singleScale = hasSingleScale ? Number(record.scale) : NaN;
	const scaleFallback = Number.isFinite(singleScale) ? singleScale : 1;
	const pick = (value, fallback) => {
		const n = value === undefined ? fallback : Number(value);
		return Number.isFinite(n) ? n : fallback;
	};
	const meshWidth = Number(record.footprint?.width);
	const meshDepth = Number(record.footprint?.depth);
	const meshFootprint =
		Number.isFinite(meshWidth) && meshWidth > 0 && Number.isFinite(meshDepth) && meshDepth > 0
			? { width: meshWidth, depth: meshDepth }
			: { ...entry.footprint };
	return {
		id: record.id,
		name: typeof record.name === "string" && record.name ? record.name : entry.label,
		renderer: entry.renderer ?? entry.kind,
		x: TRANSFORM_LIMITS.x(pick(record.x, 0)),
		y: TRANSFORM_LIMITS.y(pick(record.y, 0)),
		z: TRANSFORM_LIMITS.z(pick(record.z, 0)),
		rot: TRANSFORM_LIMITS.rot(pick(record.rot, 0)),
		rotX: TRANSFORM_LIMITS.rotX(pick(record.rotX, 0)),
		rotZ: TRANSFORM_LIMITS.rotZ(pick(record.rotZ, 0)),
		scaleX: TRANSFORM_LIMITS.scaleX(pick(record.scaleX, scaleFallback)),
		scaleY: TRANSFORM_LIMITS.scaleY(pick(record.scaleY, scaleFallback)),
		scaleZ: TRANSFORM_LIMITS.scaleZ(pick(record.scaleZ, scaleFallback)),
		// A stored travel path is repaired by its own schema; anything that
		// cannot describe travel normalizes back to a standing object.
		path: createObjectPath(record.path),
		color: typeof record.color === "string" && record.color ? record.color : entry.color,
		// Group membership. null is a top-level object; the id of another object
		// makes this one ride along when that object moves.
		parent: typeof record.parent === "string" && record.parent ? record.parent : null,
		// Character attachment, repaired by the same rule the editor writes
		// through: anything that is not a well-formed pair — a string, an array,
		// a missing characterId, a bone that is not one of SCENE_ATTACH_BONES —
		// reads as detached rather than pinning the prop to a frame that does
		// not exist. A record written before attachment existed has no field at
		// all, and null is exactly what it meant: world-anchored.
		attach: normalizeSceneAttach(record.attach) ?? null,
		hidden: record.hidden === true,
		// Absent means solid, so documents written before see-through objects are unchanged.
		...(objectOpacity(record.opacity) < 1 ? { opacity: objectOpacity(record.opacity) } : {}),
		// Library kinds take their size from the library — a stored footprint is
		// stale data, not a fact. Cutouts and meshes are the exceptions: their
		// size IS per-instance. A cutout rebuilds the footprint from height and
		// aspect; a mesh keeps the stored box (the import heuristic is not
		// re-run, or a deliberately 12 m truck would shrink on reload).
		...(isCutout
			? {
					assetId: record.assetId,
					// An older record (or a hand-authored one) has no source: the
					// picture it points at IS the original, because nothing has
					// been cut from it yet.
					sourceAssetId: typeof record.sourceAssetId === "string" && record.sourceAssetId ? record.sourceAssetId : record.assetId,
					matteAssetId: typeof record.matteAssetId === "string" ? record.matteAssetId : "",
					matteScale: clamp(pick(record.matteScale, 1), 0.01, 1),
					aspect: cutoutAspect(pick(record.aspect, 1)),
					// A record written before cards could be stretched has none, and
					// 1 is exactly what it meant: the picture's own proportions.
					stretch: cutoutStretch(pick(record.stretch, 1)),
					footprint: cutoutFootprint(
						pick(record.height, CUTOUT_DEFAULT_HEIGHT),
						pick(record.aspect, 1),
						pick(record.stretch, 1),
					),
					height: cutoutHeight(pick(record.height, CUTOUT_DEFAULT_HEIGHT)),
				}
			: sculpt
				? { recipe: sculpt.recipe, ...sculptStandingBox(sculpt.recipe) }
			: isMesh
				? {
						assetId: record.assetId,
						clay: record.clay === true,
						// Stored box is the truth: the 0.05–10 m import heuristic is
						// NOT re-run here, or a deliberately 12 m truck would shrink
						// back to 1 m on reload.
						footprint: meshFootprint,
						height: Math.max(MESH_HEIGHT_MIN, pick(record.height, entry.height)),
					}
				: { footprint: { ...entry.footprint }, height: entry.height, supportY: Number.isFinite(entry.supportY) ? entry.supportY : entry.height }),
		// A light's light, and a glow on any record (object-look.js); grasp sockets (object-grasp.js).
		...objectLookFields(record, entry), ...objectGraspFields(record),
		// An effect record's emitter (src/effects/effect-record.js).
		...effectFields(record),
		// A text's words; its box is measured from them (src/text/text-record.js).
		...textFields(record),
	};
}

/** The only writer. The body carries the version alongside the key so a
 * future build can read today's payload after a key rename. */
export function serializeScene(objects) {
	return JSON.stringify({ version: SCENE_VERSION, objects });
}

/**
 * Total, consistent tag predicate (plan §8.2): every input falls into exactly
 * one row and this never throws. `absent` and `corrupt` fall back to the
 * defaults; `future` is quarantined in App — never overwritten.
 */
export function loadScene(raw) {
	if (raw === null || raw === undefined || raw === "") {
		return { status: "absent", objects: [], dropped: 0 };
	}
	let payload;
	try {
		payload = JSON.parse(raw);
	} catch {
		return { status: "corrupt", objects: [], dropped: 0 };
	}
	// A scene body is a non-array plain object holding an array of records.
	if (payload === null || typeof payload !== "object" || Array.isArray(payload) || !Array.isArray(payload.objects)) {
		return { status: "corrupt", objects: [], dropped: 0 };
	}
	const { version } = payload;
	// The supported range is exactly the integers 1..SCENE_VERSION; a
	// malformed version ("1", 1.5, 0, -1, NaN) is corrupt, never future.
	if (!Number.isInteger(version) || version < 1) {
		return { status: "corrupt", objects: [], dropped: 0 };
	}
	if (version > SCENE_VERSION) {
		return { status: "future", objects: [], dropped: 0 };
	}
	const seen = new Set();
	const objects = [];
	let dropped = 0;
	for (const record of payload.objects) {
		const normalized = normalizeSceneObject(record);
		// Unknown renderers and duplicate ids are dropped and counted, so the
		// caller can report what was lost instead of silently degrading.
		if (!normalized || seen.has(normalized.id)) {
			dropped += 1;
			continue;
		}
		seen.add(normalized.id);
		objects.push(normalized);
	}
	return { status: "valid", objects, dropped };
}

/** The three world axes the gizmo drags along, and the record field each one
 * rotates / scales. */
const WORLD_AXES = ["x", "y", "z"];
const ROTATION_KEYS = { x: "rotX", y: "rot", z: "rotZ" };
const SCALE_KEYS = { x: "scaleX", y: "scaleY", z: "scaleZ" };
/** 5 cm translate detents, 5° rotate detents and 5% scale steps: the same grid
 * the plan board blocks on, so an object dragged in 3D lands where the top-down
 * view expects. */
const TRANSLATE_SNAP = 0.05;
const ROTATE_SNAP = 5;
const SCALE_SNAP = 0.05;

/**
 * Axis-drag result. `start` is the object as it was when the drag began and
 * `distance` the travel along that world axis, so a move is absolute and can
 * never compound across pointer ticks.
 */
export function translatePatch(start, axis, distance, snap = TRANSLATE_SNAP) {
	if (!WORLD_AXES.includes(axis) || !Number.isFinite(distance)) return null;
	const value = snapTo((start[axis] ?? 0) + distance, snap);
	return { [axis]: value };
}

/** Ring-drag result: `deltaDeg` degrees added to the drag-start angle. */
export function rotatePatch(start, axis, deltaDeg, snap = ROTATE_SNAP) {
	const key = ROTATION_KEYS[axis];
	if (!key || !Number.isFinite(deltaDeg)) return null;
	return { [key]: wrapAngle(snapTo((start[key] ?? 0) + deltaDeg, snap)) };
}

/**
 * Scale-drag result. `factor` is how much bigger the handle's axis got over the
 * drag (1 = untouched); `axis` null scales all three at once, which is what the
 * gizmo's centre box does.
 */
export function scalePatch(start, axis, factor, snap = SCALE_SNAP) {
	if (!Number.isFinite(factor) || factor <= 0) return null;
	const axes = axis === null ? WORLD_AXES : WORLD_AXES.includes(axis) ? [axis] : [];
	if (!axes.length) return null;
	const patch = {};
	for (const each of axes) {
		const key = SCALE_KEYS[each];
		patch[key] = TRANSFORM_LIMITS[key](snapTo((start[key] ?? 1) * factor, snap));
	}
	return patch;
}

/**
 * Screen-ring result: `deltaDeg` about an arbitrary world axis (the camera's
 * view direction), composed onto the drag-start orientation. The record stores
 * Euler degrees per world axis, so the spin is done in quaternion space and all
 * three channels are written back together — anything less would drift.
 */
export function screenRotatePatch(start, viewAxis, deltaDeg, snap = ROTATE_SNAP) {
	if (!Number.isFinite(deltaDeg) || !viewAxis) return null;
	const turned = snapTo(deltaDeg, snap);
	const orientation = new Quaternion().setFromEuler(
		new Euler((start.rotX ?? 0) * DEG, (start.rot ?? 0) * DEG, (start.rotZ ?? 0) * DEG, EULER_ORDER),
	);
	// world-space delta: new = delta · old, so the object spins about the view
	// axis no matter how it is already turned
	orientation.premultiply(new Quaternion().setFromAxisAngle(viewAxis, turned * DEG));
	const back = new Euler().setFromQuaternion(orientation, EULER_ORDER);
	return {
		rotX: wrapAngle(snapTo(back.x / DEG, 0)),
		rot: wrapAngle(snapTo(back.y / DEG, 0)),
		rotZ: wrapAngle(snapTo(back.z / DEG, 0)),
	};
}

export { objectSize };
/** The tolerance that keeps an edge-abutting footprint from counting as
 * overlap: a strict `<` against `max - EPS` makes a 0.5 - 0.5 touch false. */
const OVERLAP_EPS = 1e-4;

/**
 * The object's world-space axis-aligned bounds. The footprint rectangle is
 * rotated by `rot` (the yaw the plan board reads) and projected to its AABB:
 * at 45 degrees a long plank widens on both axes. Pitch/roll are a documented
 * approximation — the vertical extent still uses the unrotated height, so a
 * tilted object's support level is approximate while yaw is exact.
 */
export function objectFootprintBounds(object) {
	const size = objectSize(object);
	const rot = (object.rot ?? 0) * DEG;
	const c = Math.abs(Math.cos(rot));
	const s = Math.abs(Math.sin(rot));
	const halfW = (size.width * c + size.depth * s) / 2;
	const halfD = (size.width * s + size.depth * c) / 2;
	const x = object.x ?? 0;
	const z = object.z ?? 0;
	const baseY = object.y ?? 0;
	return {
		minX: x - halfW,
		maxX: x + halfW,
		minZ: z - halfD,
		maxZ: z + halfD,
		baseY,
		topY: baseY + size.height,
	};
}

/**
 * Where the object would land if it fell straight down, as a `{ y }` patch —
 * PURE: it reads `object` and `others` and mutates nothing. Returns null when
 * the object is already resting exactly on the surface, so a redundant drop
 * can never create a history entry.
 *
 * Strict drop-down (plan §9.2): among the `others` whose projected footprints
 * strictly overlap this object's (EPS keeps edge abutments out), only
 * surfaces whose top is at or below the object's current base are support;
 * the object lands with its base exactly on the highest such top, or on the
 * floor when there is none. An object already penetrating a surface is
 * therefore NOT supported by it and falls through — the recovery is to raise
 * Y above the box and press End again. The deferred alternative (a bounded
 * penetration threshold) is cut because the user cannot see the threshold
 * and a second End press would differ from the first.
 *
 * The contact height is exact, never snapped to the 5 cm grid, and never
 * clamped here: the y clamp stays in updateSceneObject, the single owner.
 */
export function dropToSurfacePatch(object, others, characters = []) {
	// An empty has no base to rest on and no extent to rest with: dropping it
	// would carry a whole assembly to wherever a zero-size point happens to sit.
	if (isEmptyObject(object)) return null;
	const self = objectFootprintBounds(object);
	let highestTop = 0;
	for (const other of others) {
		if (isEmptyObject(other)) continue;
		if (isEffectivelyHidden(other, others, characters)) continue;
		const bounds = objectFootprintBounds(other);
		if (self.minX >= bounds.maxX - OVERLAP_EPS || bounds.minX >= self.maxX - OVERLAP_EPS) continue;
		if (self.minZ >= bounds.maxZ - OVERLAP_EPS || bounds.minZ >= self.maxZ - OVERLAP_EPS) continue;
		if (bounds.topY > self.baseY + OVERLAP_EPS) continue;
		if (bounds.topY > highestTop) highestTop = bounds.topY;
	}
	return highestTop === self.baseY ? null : { y: highestTop };
}

/**
 * Where a fresh object should land: on the floor a few metres down the lens, so
 * it appears where you were looking.
 *
 * Position only — the object is created UNROTATED. Unity's primitives arrive
 * axis-aligned at identity rotation, and that is also the only convention that
 * keeps the invariant a blocking tool needs: equal rotation values face the
 * same way. Turning new objects to face the camera (what this used to do) left
 * every box sitting at a skewed angle to the room and to the character, whose
 * own rotation starts at 0. (docs/unity-reference.md §7)
 */
export function placementInFront(cameraPos, yaw, distance = 2.6) {
	const x = cameraPos.x - Math.sin(yaw) * distance;
	const z = cameraPos.z - Math.cos(yaw) * distance;
	return {
		x: snapTo(TRANSFORM_LIMITS.x(x), TRANSLATE_SNAP),
		z: snapTo(TRANSFORM_LIMITS.z(z), TRANSLATE_SNAP),
	};
}
