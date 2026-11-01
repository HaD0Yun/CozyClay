// Shared by the browser and sidecar. No Node, React, renderer or provider imports.
import { STUDIO_ELEMENTS, isSettableElement } from "./studio-elements.js";
import { STUDIO_ERROR_CODES, refusalCode } from "./studio-error-codes.js";
import { EFFECT_VALUE_SCHEMA } from "./effects/effect-record.js";
import { TEXT_VALUE_SCHEMA } from "./text/text-record.js";
import { wrongType, unknownField, missingField, arrayRefusal, duplicateItem, stringRefusal, enumRefusal, numberRefusal, unionRefusal } from "./studio-schema-errors.js";
// Mirrors PREVIS_MODES and CAST_STYLES (project.js) and POSTURES (scenes.js). Neither is imported:
// both pull in three.js, which the agent sidecar must not load. The protocol tests pin the lists to their owners.
const PREVIS_MODES = ["storyboard", "animation"], CAST_STYLES = ["rig", "capsule", "hybrid"], POSTURES = ["stand", "sit", "lie"];

// Sized for the compact index of up to 400 entities (~100 bytes each) beside
// 24 detailed rows; a small scene stays far below it.
export const STUDIO_CONTEXT_MAX_BYTES = 64 * 1024;
export const STUDIO_CONTEXT_LIMITS = Object.freeze({ entities: 24, entityIndex: 400, shots: 8, assets: 48, recentReceipts: 3, jobs: 8 });
export const STUDIO_TOOL_FAMILIES = Object.freeze(["inspect_studio", "run_action", "verify_result"]);
export const STUDIO_TOOL_ALIASES = Object.freeze(["operate_studio", "arrange_objects", "arrange_characters", "patch_elements", "frame_shot", "undo_edit"]);
export const STUDIO_TOOL_LABELS = Object.freeze({
	inspect_studio: "Read the scene",
	operate_studio: "Selection and view",
	arrange_objects: "Arrange objects",
	arrange_characters: "Arrange characters",
	patch_elements: "Edit properties",
	frame_shot: "Frame the shot",
	verify_result: "Verify the result",
	undo_edit: "Undo an edit",
	run_action: "Run an editor action",
});
export const STUDIO_TOOLS = Object.freeze(Object.keys(STUDIO_TOOL_LABELS));
/** One patch target kind per authored commit domain: character→cast,
 * object→objects, shot→shot, stage→stage. */
export const STUDIO_PATCH_KINDS = Object.freeze(["character", "object", "shot", "stage"]);
export { STUDIO_ERROR_CODES, refusalCode };
export const STUDIO_VARIANTS = freezeStudioData({
	selectionKinds: ["scene", "object", "character", "rig", "camera"], modes: ["scene", "pose", "camera", "motion"], shotModes: ["keys", "follow", "rail"],
	framingSizes: ["extreme close-up", "close-up", "medium close-up", "medium shot", "medium-wide shot", "wide shot", "extreme wide shot"],
	framingViews: ["front", "front three-quarter", "profile", "rear three-quarter", "back"], framingLevels: ["ground", "low", "hip", "eye", "high", "overhead"],
	framingSides: ["left", "right"], positionSides: ["left", "right", "front", "behind"], positionBases: ["world", "subject", "shot_camera"], collisionPolicies: ["report", "avoid"],
	objectOps: ["create", "update", "remove", "group", "ungroup"], characterOps: ["create", "update", "remove"],
	inspectionScopes: ["selection", "scene", "entities", "shot", "motion", "catalogue", "actions", "document"], receiptStatuses: ["applied", "partial", "noop", "transient", "installed", "undone"],
	opStatuses: ["applied", "partial", "noop"],
	jobStates: ["queued", "generating", "preparing", "verifying", "repairing", "committing", "reconciling", "installed", "review_required", "failed", "cancelled", "stale_target", "stale_environment"],
});

export class StudioProtocolError extends Error {
	constructor(code, message, details = {}) { super(message); this.name = "StudioProtocolError"; this.code = code; this.details = details; }
	toJSON() { return { code: this.code, message: this.message, ...(Object.keys(this.details).length ? { details: this.details } : {}) }; }
}
export const utf8ByteLength = (text) => new TextEncoder().encode(text).byteLength;
export function freezeStudioData(value) {
	if (value && typeof value === "object" && !Object.isFrozen(value)) { for (const child of Object.values(value)) freezeStudioData(child); Object.freeze(value); }
	return value;
}
const fail = (code, message, path = "$", extra = {}) => { throw new StudioProtocolError(code, message, { path, ...extra }); };
const record = value => value !== null && typeof value === "object" && !Array.isArray(value);
const text = (maxLength = 120) => ({ type: "string", minLength: 1, maxLength });
const number = (minimum, maximum) => ({ type: "number", ...(minimum !== undefined ? { minimum } : {}), ...(maximum !== undefined ? { maximum } : {}) });
const integer = (minimum = 0, maximum = Number.MAX_SAFE_INTEGER) => ({ ...number(minimum, maximum), type: "integer" });
const bool = { type: "boolean" }, literal = value => ({ const: value });
const choices = values => ({ type: "string", enum: values });
const nullable = schema => ({ oneOf: [schema, { type: "null" }] });
const array = (items, maxItems, minItems = 0, uniqueItems = false) => ({ type: "array", items, minItems, maxItems, ...(uniqueItems ? { uniqueItems } : {}) });
const object = (required, optional = {}) => ({ type: "object", properties: { ...required, ...optional }, required: Object.keys(required), additionalProperties: false });
const union = (...oneOf) => ({ oneOf });
// Arguments whose schema lives elsewhere (a registered Studio action declares
// its own input and validates it where it runs): any JSON object, detached.
const openObject = { type: "object", properties: {}, required: [], additionalProperties: true };
const id = { ...text(), pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$" };
const uuidSchema = { ...text(36), pattern: "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$" };
export const isUuid = value => typeof value === "string" && new RegExp(uuidSchema.pattern).test(value);
const vec3 = object({ x: number(), y: number(), z: number() });
const positive = { type: "number", exclusiveMinimum: 0 };
const positiveVec3 = object({ x: positive, y: positive, z: positive });
const range = { ...object({ startFrame: integer(), endFrameExclusive: integer(1) }), "x-studio-range": true };
const ids = (max = 100, min = 1) => array(id, max, min, true);
const name = text(120);
// A placement reference: an id, or the name of a part created earlier in the same ops list.
const ref = { ...text(120), description: "Object id, or the name of a part created EARLIER in this ops list (create it first)." };
const identityFields = { workspaceId: id, documentEpoch: id, sceneId: id, sceneEpoch: id };
const identity = object(identityFields);
const host = object({ surface: literal("studio"), ...identityFields, workspaceHandle: nullable(id) });
const revision = object({ scene: integer(), physics: integer(), view: integer() });
const selection = nullable(object({ kind: choices(STUDIO_VARIANTS.selectionKinds), id }, { hierarchyId: id }));
const view = object({ mode: choices(STUDIO_VARIANTS.modes), frame: integer(), playing: bool, lookThrough: bool, grid: bool, autoColor: bool });
const position = union(
	object({ world: vec3 }),
	object({ relativeTo: ref, basis: choices(STUDIO_VARIANTS.positionBases), side: choices(STUDIO_VARIANTS.positionSides), gapM: number(0), support: union(literal("floor"), object({ objectId: ref })) }),
	object({ between: array(ref, 2, 2, true), fraction: number(0, 1), support: literal("floor") }),
	object({ onObject: ref }, { offsetXZ: object({ x: number(), z: number() }) }),
);
const facing = union(object({ yawDeg: number() }), object({ towardId: ref }), object({ sameAsId: ref }), object({ awayFromId: ref }));
const framing = union(
	object({ intent: object({ size: choices(STUDIO_VARIANTS.framingSizes), view: choices(STUDIO_VARIANTS.framingViews), level: choices(STUDIO_VARIANTS.framingLevels), side: choices(STUDIO_VARIANTS.framingSides) }, { focalMm: positive }) }),
	object({ exact: object({ position: vec3, lookAt: vec3, focalMm: positive }) }),
);
const localSpace = { ...choices(["parent"]), description: "\"parent\" reads position.world, rotationDeg and facing.yawDeg in the parent's local frame (its pivot and rotation, not its scale); omit for world space." };
const objectOp = union(
	object({ op: literal("create"), source: object({ kind: id }), position }, { name, facing, scale: positiveVec3,
		rotationDeg: { ...vec3, description: "Euler XYZ degrees (x pitch, y yaw, z roll), as in update. Exclusive with facing. A pitched/rolled part rests its lowest corner on its support." },
		parent: { ...name, description: "Group this new object under a parent: an existing object id, or the name of an object created earlier in this same ops list. Moving the parent then moves it too." },
		space: localSpace }),
	object({ op: literal("update"), id }, { position, facing, rotationDeg: vec3, scale: positiveVec3, color: text(32), name, hidden: bool, space: localSpace }),
	object({ op: literal("remove"), id }),
	object({ op: literal("group"), parentId: id, childIds: ids() }),
	object({ op: literal("ungroup"), childIds: ids() }),
);
const characterOp = union(
	object({ op: literal("create"), name, position }, { facing, scale: positive }),
	object({ op: literal("update"), characterId: id }, { position, facing, scale: positive, name, hidden: bool }),
	object({ op: literal("remove"), characterId: id }),
);

/* ----------------------------------------------- element patches ----
 * The accepted fields of `patch_elements` are DERIVED from the element
 * declaration table (src/studio-elements.js): one property per element whose
 * document field is settable, keyed by the path inside its kind, typed by the
 * declared type and bounded by the declared min/max/enum. Structured values
 * (schedules, routes, pictures) declare their shape here, because the table
 * records what an element IS, not how JSON carries it. */
const dataImage = { ...text(2 * 1024 * 1024), pattern: "^data:image/[A-Za-z0-9.+-]+[;,]" };

const cameraKey = object({ frame: integer(), framing: object({ pos: vec3, yaw: number(), pitch: number(), fovDeg: number(1, 179) }) }, { id });
// A mark is an arc fraction, or { t, bank, pitch } when the object should lean
// there (degrees, +-90). The route normaliser (src/object-path.js) owns the
// rules; this only carries the shape through untouched.
const routeMark = union(number(0, 1), object({ t: number(0, 1) }, { bank: number(-90, 90), pitch: number(-90, 90) }));
const objectRoute = nullable(object({ points: array(vec3, 64, 2) }, { speed: number(0, 50), faceTravel: bool, loop: bool, extend: bool, marks: array(routeMark, 6) }));
// A practical light and a glow (src/object-look.js owns the defaults and the repair); grasp sockets (src/object-grasp.js).
const objectLight = object({}, { type: choices(["point", "spot"]), color: { ...text(32), pattern: "^#[0-9a-fA-F]{6}$" }, intensity: number(0, 1000), range: number(0, 100), angle: number(1, 89), softness: number(0, 1), shadow: bool, flicker: number(0, 1), aim: nullable(vec3) });
const objectGlow = nullable(object({}, { color: { ...text(32), pattern: "^#[0-9a-fA-F]{6}$" }, intensity: number(0, 20), halo: number(0, 4) })), objectGrasp = nullable(openObject);
const PATCH_VALUE_SCHEMAS = {
	"character.pose": nullable(id), "character.identityImage": nullable(dataImage), "object.light": objectLight, "object.glow": objectGlow, "object.grasp": objectGrasp, "object.effect": EFFECT_VALUE_SCHEMA, "object.text": TEXT_VALUE_SCHEMA,
	"object.parent": nullable(id), "object.path": objectRoute, "stage.environmentImage": nullable(dataImage),
	"shot.cameraKeys": array(cameraKey, 64), "shot.targetModel": nullable(id) };
/** One declared element as a JSON value schema, or null when the declaration
 * carries no carriable shape (a structured element without a declared value
 * schema above). Null elements are omitted from the patch schema, and
 * test/verify-studio-elements.mjs fails the moment the table declares one. */
export function patchValueSchema(element) {
	if (Object.hasOwn(PATCH_VALUE_SCHEMAS, element.path)) return PATCH_VALUE_SCHEMAS[element.path];
	if (element.type === "number") return number(element.min, element.max);
	if (element.type === "boolean") return bool;
	if (element.type === "enum") return choices([...element.enum]);
	if (element.type === "id") return id;
	if (element.type === "color") return { ...text(32), pattern: "^#[0-9a-fA-F]{6}$" };
	if (element.type === "image") return nullable(dataImage);
	if (element.type === "vec3") {
		const { min, max } = element; // the element's own range; a gizmo envelope only limits the UI drag
		if (min && typeof min === "object" && max && typeof max === "object") return object({ x: number(min.x, max.x), y: number(min.y, max.y), z: number(min.z, max.z) });
		return vec3;
	}
	if (element.type === "string") return text(240);
	return null;
}
/** One descriptor per patch-exposed element: the wire-facing range vocabulary
 * a caller reads instead of guessing bounds from a rejection. Pure, and
 * derived from the same declaration table as `patchValueSchema` so the two
 * can never drift apart. */
export function buildPatchDescriptors(elements) {
	return elements.filter(isSettableElement).map(({ path, type, min, max, enum: enumValues, note }) => ({
		path, type,
		...(min !== undefined ? { min: min && typeof min === "object" ? { ...min } : min } : {}),
		...(max !== undefined ? { max: max && typeof max === "object" ? { ...max } : max } : {}),
		...(enumValues ? { enum: [...enumValues] } : {}),
		...(note ? { note } : {}),
	}));
}
export const STUDIO_PATCH_DESCRIPTORS = freezeStudioData(buildPatchDescriptors(STUDIO_ELEMENTS));
/** Pure: feed it any element table and read back the `set` schema per kind. */
export function buildPatchSchema(elements) {
	const kinds = {};
	for (const kind of STUDIO_PATCH_KINDS) {
		const properties = {};
		for (const element of elements) {
			if (!isSettableElement(element) || !element.path.startsWith(`${kind}.`)) continue;
			const schema = patchValueSchema(element);
			if (schema) properties[element.path.slice(kind.length + 1)] = schema;
		}
		kinds[kind] = { type: "object", properties, required: [], additionalProperties: false };
	}
	return kinds;
}
export const STUDIO_PATCH_SET_SCHEMAS = freezeStudioData(buildPatchSchema(STUDIO_ELEMENTS));
export const STUDIO_PATCHABLE_PATHS = freezeStudioData(Object.fromEntries(STUDIO_PATCH_KINDS.map(kind =>
	[kind, Object.keys(STUDIO_PATCH_SET_SCHEMAS[kind].properties).map(key => `${kind}.${key}`)])));
const patchOp = union(
	object({ target: object({ kind: literal("character"), id }), set: STUDIO_PATCH_SET_SCHEMAS.character }),
	object({ target: object({ kind: literal("object"), id }), set: STUDIO_PATCH_SET_SCHEMAS.object }),
	object({ target: object({ kind: literal("shot") }, { id }), set: STUDIO_PATCH_SET_SCHEMAS.shot }),
	object({ target: object({ kind: literal("stage") }), set: STUDIO_PATCH_SET_SCHEMAS.stage }),
);
const toolSchemas = {
	inspect_studio: object({ scope: choices(STUDIO_VARIANTS.inspectionScopes) }, { ids: ids(32), select: ids(32), query: name, cursor: text(512), limit: { ...integer(1, 32), default: 12 } }),
	operate_studio: object({}, { selection, shotId: id, frame: integer(), playing: bool, mode: choices(STUDIO_VARIANTS.modes), view: object({}, { lookThrough: bool, grid: bool, autoColor: bool }) }),
	arrange_objects: object({ ops: { ...array(objectOp, 100, 1), description: "Applied in order, as one undo step. Each op sees the parts created by earlier ops, so build an assembly in one call: create the main part, then place the rest with position.onObject / relativeTo(+side,gapM) / between naming earlier parts (e.g. relativeTo \"Hood\"). Reference parts created in this call by name, never by id." } }, { collisionPolicy: { ...choices(STUDIO_VARIANTS.collisionPolicies), default: "report" } }),
	arrange_characters: object({ ops: array(characterOp, 8, 1) }),
	patch_elements: object({ ops: array(patchOp, 32, 1) }),
	frame_shot: object({ subjectIds: ids(1), framing }, { shotId: id, caption: { type: "string", maxLength: 500 }, keyAtFrame: integer(), over: { ...choices(["shot"]), description: "Fit one held camera to every pose of the shot, turned off the asked view only as far as walls need" } }),
	verify_result: object({ checks: { ...array(choices(["placement", "framing", "motion", "lighting"]), 4, 1, true), description: "lighting measures the shot frame rendered at the playhead: checks.lighting { meanLuma 0..1, clippedPct (a channel at full scale), crushedPct (pure black), subjects: [{ id, meanLuma, contrast (5th to 95th percentile luma spread, 0..1) }] inside each target character's projected box, look: { preset, envLight, ao } the stage look's environment light and occlusion strength }. motion also answers exportFraming (one per character with a take): what the camera the export renders shows of the take over sampledFrames: camera (shot where a shot covers the frame, studio = the Studio camera as it stands when none does; shotIds), character { screenFraction [min, max] of the frame height, inFrame [lowest share of its joints' screen box inside the frame, frame], behindCamera, cut { head, hand_l, hand_r, foot_l, foot_r } }, and every object the take names { id, name, inFrame, out, cut }; out, cut and behindCamera are spans [first, last] of sampled frames; { character: { id }, reason } when it cannot be measured" } }, { receiptId: id, targets: ids(), range: union(literal("whole_clip"), range), visual: { ...choices(["none", "frame", "contact_sheet", "plan", "trace"]), default: "none" }, frames: { ...union(choices(["even", "beats"]), array(integer(), 8, 1, true)), default: "even", description: "contact_sheet frames: even spacing, beats (grab/release, beat starts, the worst QA frames, then even fill, answered in visualRefs[0].picks), or up to 8 timeline frames of your choice" }, views: { ...array(choices(["front", "side", "three-quarter", "top"]), 2, 1, true), description: "contact_sheet from cameras of its own around the character instead of the shot camera (which stays as it is): a row per view, each held still over the frames and framed on focus, so small actions fill the tile; side and three-quarter look from the focus's side; a sheet always holds two views at least 60 degrees apart: if the asked ones look along nearly one line, side, front or top is added and named in visualRefs[0].addedView" }, focus: { ...union(text(120), array(text(120), 3, 1, true)), description: "with views: what to frame, as refs (object:<id>, joint:<Bone>, prop:<prop>.<point>, landmark:mouth); default the whole character" }, trail: { ...union(text(120), array(text(120), 3, 1, true)), description: "with views: refs whose path over the range is drawn as one dot per frame (spacing shows speed; later frames faint, the tile's own frame ringed), colours in visualRefs[0].trails" }, ghosts: { ...bool, description: "with views: each tile also shows the first target's poses around its frame as translucent ghosts (onion skin), earlier ones blue, later ones orange, carried props included, so spacing and arcs read in one tile; how many and how far apart is view.setGhosts (while it is off: 3 each side, every 4 frames), answered in visualRefs[0].ghosts" } }),
	undo_edit: object({ receiptId: id }),
	run_action: object({ action: id }, { args: openObject, confirmationToken: id }),
};
export const STUDIO_TOOL_SCHEMAS = freezeStudioData(toolSchemas);
export const STUDIO_CATALOGUE = freezeStudioData(STUDIO_TOOLS.map(name => ({ name, slice: 1, parameters: toolSchemas[name] })));

// Bounded observations, never a document/pose/asset transport. Every nested
// object is closed. Null distinguishes unavailable data from measured zero.
const bounds = object({ min: vec3, max: vec3 });
const entity = object({ id, kind: choices(["object", "character", "rig"]), token: id }, {
	name, detailsOmitted: bool, position: vec3, yawDeg: number(), rotationDeg: vec3, scale: union(positive, positiveVec3), bounds: nullable(bounds),
	libraryKind: id, renderer: id, color: nullable(text(32)), tint: nullable(text(32)), modelId: nullable(text(120)), assetId: id, parentId: nullable(id), attachment: nullable(object({ characterId: id, bone: nullable(id) })), pathPointCount: integer(0, 64), pathMarks: array(union(number(0, 1), object({ t: number(0, 1) }, { bank: number(-90, 90), pitch: number(-90, 90) })), 6),
	local: object({ position: vec3, rotationDeg: vec3 }),
	motion: object({ takeId: nullable(id), frames: integer(), ikKeyCount: integer() }, { poseId: nullable(id), keyIds: ids(8, 0) }),
	capabilities: object({ rigReady: bool, ik: bool, measuredFeet: bool }),
	// `kind` above already names the entity class ("character"); a character's own
	// kind is `characterKind`: a rigged model, or a rig-free capsule figure.
	characterKind: choices(["rig", "proxy"]), posture: choices(POSTURES),
});
// One compact row per entity, so the model sees the whole scene even when
// only 24 rows carry full detail.
const indexRow = object({ id, kind: choices(["object", "character", "rig"]) }, { name, position: vec3 });
// One compact row per registered Studio command: what run_action can call.
// Its schema is on request (inspect_studio scope "actions" with ids); the
// declared generation and hub timeout ride along for the sidecar's gate.
const actionIndexRow = object({ id }, { label: name, generation: literal("motion"), timeoutMs: integer(1, 300_000) });
const shotSummary = object({ id, name, range, keyCount: integer() }, { subjectIds: ids(24, 0), kind: choices(["clip", "still"]), caption: text(500) });
const currentShot = object({ id, name, range, mode: choices(STUDIO_VARIANTS.shotModes) }, { subjectIds: ids(24, 0), kind: choices(["clip", "still"]), caption: text(500) });
const camera = object({ position: vec3, lookAt: vec3, focalMm: positive, sensorId: id, slate: name });
// What the agent can place: a catalogue kind, or an asset imported into the scene.
const assetTypes = choices(["primitive", "set-piece", "image", "mesh"]);
const assetSummary = union(object({ kind: id, name, type: assetTypes }), object({ id, name, type: assetTypes }));
const jobSummary = object({ id, characterId: id, state: choices(STUDIO_VARIANTS.jobStates) }, { targetIds: ids(24, 0), progress: nullable(number(0, 1)), phase: name });
const contextSchema = object({
	schema: literal("studio-context-v1"), host, revision,
	units: object({ distance: literal("m"), angle: literal("deg"), up: literal("+Y"), yawZero: literal("+Z"), yawPositiveToward: literal("+X"), pivot: literal("base"), fps: literal(24), rangeEnd: literal("exclusive") }),
	scene: object({ name, aspect: text(40), floorY: number(), frameCount: integer(), objectCount: integer(), characterCount: integer() }, { previsMode: choices(PREVIS_MODES), castStyle: choices(CAST_STYLES) }),
	selection, activeCharacterId: nullable(id), view, shot: nullable(currentShot), camera: nullable(camera),
	entities: array(entity, 24), entityPage: object({ returned: integer(0, 24), total: integer(), truncated: bool, nextCursor: nullable(text(512)) }),
	shots: array(shotSummary, 8), shotsTruncated: bool, assets: array(assetSummary, STUDIO_CONTEXT_LIMITS.assets),
	recentReceipts: array(object({ id, summary: name, canUndoDirect: bool }), 3), jobs: array(jobSummary, 8),
	capabilities: object({ profile: literal("studio-slice-1"), tools: array(choices(STUDIO_TOOLS), STUDIO_TOOLS.length, 0, true) }, { rigReady: bool, cameraReady: bool, bridgeReady: bool, storyboard: bool }),
}, { entityIndex: array(indexRow, STUDIO_CONTEXT_LIMITS.entityIndex), actionIndex: array(actionIndexRow, 512) });
const guardSchema = object({ ...identityFields, targetId: id, token: id });
const efforts = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];
// Pictures the author pasted or dropped into the composer (#367). Inline bytes
// only: a remote URL would make the turn depend on a fetch nobody authored,
// and the three inline types are the ones the model actually reads. Four, and
// six megabytes of base64 each, is what one turn may carry.
const attachment = object({ dataUrl: { ...text(6_000_000), pattern: "^data:image/(png|jpeg|webp);base64," } }, { name: text(120) });
const turnSchema = object({ surface: literal("studio"), sessionId: uuidSchema, turnId: uuidSchema, text: text(16000), context: contextSchema }, { model: text(120), effort: choices(efforts), attachFrame: bool, attachments: array(attachment, 4, 1), supervisor: bool });
const stopSchema = object({ surface: literal("studio"), sessionId: uuidSchema, turnId: uuidSchema }, { jobId: id });
const revisions = object({ before: integer(), after: integer() });
const undo = object({ historyEntryId: id, entries: literal(1), canUndoDirect: bool });
const installed = object({ characterId: id, beforeTakeId: nullable(id), takeId: id, targetToken: id, frameCount: integer(1), fps: literal(24), durationSeconds: positive, blocks: array(object({ sourceBeat: integer(0, 7), startFrame: integer(), endFrameExclusive: integer(1) }), 120, 1), selectionChanged: literal(false) });
const verification = object({ id, status: choices(["verified", "unverified"]), profile: literal("studio-motion-v1"), range, evaluatedFrames: integer(), physicsRevision: integer(), limitations: array(name, 12) }, {
	surfaceMeasured: bool, maxFloorPenetrationM: number(0), maxContactSlipM: number(0), maxContactFloatM: number(0), unsupportedFrames: integer(), supportedCollisionFrames: integer(), continuityRegressed: bool,
	semanticStatus: choices(["pending_image_review", "passed", "failed", "unavailable"]),
});
// One measured value per patched element path. Exactly one typed member is
// carried, so a picture is reported by its measured size and a schedule by its
// length instead of turning the receipt into a document transport.
// A cleared or refused field reports `text: null`: absence is a measurement,
// not a missing member.
const patchedValue = object({ path: text(120) }, { number: number(), text: nullable(text(512)), flag: bool, vec: vec3, count: integer(), bytes: integer() });
const readback = object({}, { position: vec3, yawDeg: number(), rotationDeg: vec3, scale: union(positive, positiveVec3), name, color: text(32), hidden: bool, modelId: id, renderer: id,
	parentId: nullable(id), childIds: ids(100, 0), childCount: integer(0), bounds: nullable(bounds), removed: bool, range, camera, keyId: id, frame: integer(), subjectIds: ids(24, 0), selection, activeCharacterId: nullable(id), shotId: nullable(id), view, token: id, takeId: nullable(id), statureM: positive,
	patched: array(patchedValue, 32, 1) });
const CAMERA_SIDES = ["left", "right", "on-axis"];
const checks = object({ coverage: name }, { relationSatisfied: bool, overlapIds: ids(100, 0), actualGapM: number(), requestedGapM: number(0), maximumFootprintOverlapM: number(0),
	basis: choices(STUDIO_VARIANTS.positionBases), clipped: bool, occluded: bool, behindCamera: bool, screenFraction: number(0), derivedSize: choices(STUDIO_VARIANTS.framingSizes), held: object({ frames: array(integer(), 64), hidden: array(integer(), 64), outOfFrame: array(integer(), 64) }, { askedDeg: number(), chosenDeg: number() }), support: name, baseY: number(), facesTargetId: id,
	cameraSide: choices(CAMERA_SIDES), axisConsistent: bool, evaluatedFrames: integer(1), sampledFrames: array(integer(), 64, 1), sampledChecks: array(object({ frame: integer(), screenFraction: number(), clipped: bool, behindCamera: bool, occluded: bool }), 64, 1), issueFrames: array(object({ frame: integer(), codes: array(name, 4, 1), screenFraction: number() }), 64, 0) });
// Code-computed shot geometry verify_result carries beside a framing check
// (src/studio-geometry-facts.js): bounded to 8 shots and 24 subjects.
const geometryFacts = object({
	subjects: array(object({ id, position: vec3, yawDeg: number() }), 24),
	pairs: array(object({ a: id, b: id, distanceM: number(0) }), 24),
	shots: array(object({ shotId: id, subjectIds: ids(2, 0), camera: nullable(object({ position: vec3, lookAt: vec3 })), cameraSide: nullable(choices(CAMERA_SIDES)),
		occluders: array(object({ subjectId: id, byObjectId: id }), 8) }), 8),
	axisConsistent: nullable(bool),
});
const warning = object({ code: id }, { id, message: name, suggestedOutwardDeltaM: number(), count: integer() });
const receiptBase = { ok: literal(true), commandId: id, receiptId: id, host: identity, status: choices(STUDIO_VARIANTS.receiptStatuses), authored: bool, revision: revisions, affectedIds: ids(100, 0),
	delta: array(object({ id, after: readback }), 8), checks, undo: nullable(undo), warnings: array(warning, 12) };
const batchDetails = { counts: object({ created: integer(), updated: integer(), deleted: integer() }), detailCursor: nullable(text(512)) };
// Per-operation outcome for path-addressed commands: which ops landed whole,
// which lost a field to a domain normalizer, and exactly which paths were lost.
const opResults = array(object({ index: integer(), status: choices(STUDIO_VARIANTS.opStatuses) }, { droppedPaths: array(text(120), 32, 1) }), 32, 1);
const authoredReceipt = { ...receiptBase, authored: literal(true), undo };
// A run_action receipt names the registered action and what it did.
const actionFields = { action: id, summary: text(240) };
const receiptVariants = {
	// A mutation inside an agent turn answers "completed" (the turn owns its undo entry); a patch
	// among them still reports each op, so ops ride here too.
	completed: object({ ...receiptBase, status: literal("completed"), kind: choices(["job", "document", "transaction", "mutation"]) }, { ...actionFields, ...batchDetails, output: openObject, jobId: id, txId: id, nextHost: identity, ops: opResults }),
	started: object({ ...receiptBase, status: literal("started"), kind: literal("job"), jobId: id, authored: literal(false), undo: literal(null) }, { ...actionFields }),
	applied: object({ ...authoredReceipt, status: literal("applied") }, { mutated: literal(true), ops: opResults, ...batchDetails, ...actionFields }),
	partial: object({ ...authoredReceipt, status: literal("partial"), ops: opResults }, { mutated: literal(true), ...batchDetails }),
	noop: object({ ...receiptBase, status: literal("noop"), authored: literal(false), mutated: literal(false), undo: literal(null) }, { ops: opResults, ...actionFields }),
	transient: object({ ...receiptBase, status: literal("transient"), authored: literal(false), view: revisions, undo: literal(null) }, { mutated: bool, ...actionFields }),
	installed: object({ ...authoredReceipt, status: literal("installed"), jobId: id, artifactId: id, installed, verification }, {
		// Who accepted an unverified take: the user's explicit button, or the
		// runtime's advisory install policy. Exactly these two may admit one.
		mutated: literal(true), explicitUnverifiedAcceptance: bool, acceptance: literal("advisory-policy"), ...batchDetails,
	}),
	undone: object({ ...authoredReceipt, status: literal("undone"), undoneReceiptId: id, restoredTargets: array(guardSchema, 100, 1) }, { mutated: literal(true), ...batchDetails }),
};
const receiptSchema = union(...Object.values(receiptVariants));
const failureSchema = object({ ok: literal(false), commandId: id, host: identity, code: choices(STUDIO_ERROR_CODES), phase: choices(["admission", "execution", "prepare", "verify", "repair", "commit", "reconcile", "undo"]),
	affectedIds: ids(100, 0), expectedTargets: array(guardSchema, 24), currentTargets: array(guardSchema, 24), mutated: union(bool, literal("unknown")),
	preserved: object({ authoredState: choices(["unchanged", "changed", "unknown"]) }), recovery: object({ action: choices(["none", "inspect", "retry", "new_intent", "reconcile", "sign_in"]) }, { retryAllowed: bool }),
}, { message: text(2000), jobId: id, txId: id, candidates: array(object({ id, kind: choices(["object", "character", "rig"]), position: nullable(vec3) }), 5) });

// These are JSON Schema data, not validators with hidden browser dependencies.
// x-studio-range is the sole relational schema annotation: end > start.
export const StudioSchemas = freezeStudioData({ catalogue: STUDIO_CATALOGUE, variants: STUDIO_VARIANTS, Vec3: vec3, FrameRange: range, PositionSpec: position, FacingSpec: facing,
	ObjectOp: objectOp, CharacterOp: characterOp, Framing: framing, Identity: identity, Host: host, TargetGuard: guardSchema,
	Entity: entity, ShotSummary: shotSummary, StudioContextV1: contextSchema, StudioTurn: turnSchema, StudioStop: stopSchema, Receipt: receiptSchema, ReceiptVariants: receiptVariants, Failure: failureSchema, GeometryFacts: geometryFacts });

/** Validate the closed JSON Schema subset used above; return a detached value with declared
 * defaults. Errors name the path and what it allows (studio-schema-errors.js). */
export function validateStudioSchema(schema, value, code = "INVALID_ARGUMENT", path = "$") {
	if (schema.oneOf || schema.anyOf) {
		const matches = [], failures = [];
		for (const branch of schema.oneOf ?? schema.anyOf) {
			try { matches.push(validateStudioSchema(branch, value, code, path)); }
			catch (error) { if (!(error instanceof StudioProtocolError)) throw error; failures.push({ branch, error }); }
		}
		// No variant matched: the generic "one of N" message hides which path and
		// bound actually offended. Surface the failure from the variant the input
		// discriminates to (matching target.kind), or else the deepest failing
		// path, instead of the union's own shallow message. A union of plain values
		// (true, false or "ifClean") that failed at its own path names every form.
		if (matches.length === 0 && failures.length) {
			const kind = record(value) && record(value.target) ? value.target.kind : undefined, discriminated = kind !== undefined && failures.find(({ branch }) => branch.properties?.target?.properties?.kind?.const === kind);
			const forms = !discriminated && unionRefusal(path, failures, value);
			if (forms) fail(code, forms, path);
			const chosen = discriminated || failures.reduce((best, next) => next.error.details.path.length > best.error.details.path.length ? next : best);
			throw chosen.error;
		}
		if (matches.length !== 1 && schema.oneOf) fail(code, `${path}: matches ${matches.length} variants; send the fields of exactly one.`, path);
		return matches[0];
	}
	if (Object.hasOwn(schema, "const")) { if (value !== schema.const) fail(code, wrongType(path, schema, value), path); return value; }
	if (schema.type === "null") { if (value !== null) fail(code, wrongType(path, schema, value), path); return null; }
	if (schema.type === "object") {
		if (!record(value)) fail(code, wrongType(path, schema, value), path);
		const open = schema.additionalProperties === true;
		for (const key of Object.keys(value)) if (!Object.hasOwn(schema.properties, key) && !open) fail(code, unknownField(path, schema, key), path);
		const result = {};
		if (open) for (const key of Object.keys(value)) if (!Object.hasOwn(schema.properties, key)) result[key] = structuredClone(value[key]);
		for (const [key, child] of Object.entries(schema.properties)) {
			if (Object.hasOwn(value, key)) result[key] = validateStudioSchema(child, value[key], code, `${path}.${key}`);
			else if (schema.required.includes(key)) fail(code, missingField(path, key), `${path}.${key}`);
			else if (Object.hasOwn(child, "default")) result[key] = structuredClone(child.default);
		}
		if (schema["x-studio-range"] && result.endFrameExclusive <= result.startFrame) fail(code, "Frame range must be nonempty and half-open.", path);
		return result;
	}
	if (schema.type === "array") {
		if (!Array.isArray(value) || value.length < schema.minItems || value.length > schema.maxItems) fail(code, arrayRefusal(path, schema, value), path);
		const result = value.map((item, i) => validateStudioSchema(schema.items, item, code, `${path}[${i}]`));
		if (schema.uniqueItems && new Set(result.map(item => JSON.stringify(item))).size !== result.length) fail(code, duplicateItem(path, result), path);
		return result;
	}
	if (schema.type === "string") {
		if (typeof value !== "string" || !value.trim() || (schema.maxLength !== undefined && [...value].length > schema.maxLength) || (schema.pattern && !new RegExp(schema.pattern).test(value))) fail(code, stringRefusal(path, schema, value), path);
		if (schema.enum && !schema.enum.includes(value)) fail(code, enumRefusal(path, schema, value), path);
		return value;
	}
	if (schema.type === "boolean") { if (typeof value !== "boolean") fail(code, wrongType(path, schema, value), path); return value; }
	if (schema.type === "number" || schema.type === "integer") {
		if (typeof value !== "number" || !Number.isFinite(value) || (schema.type === "integer" && !Number.isSafeInteger(value)) || (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum)) fail(code, numberRefusal(path, schema, value), path);
		if ((schema.minimum !== undefined && value < schema.minimum) || (schema.maximum !== undefined && value > schema.maximum)) {
			const bounds = [schema.minimum, schema.maximum].filter(bound => bound !== undefined);
			fail(code, `${path}: Expected a number within [${bounds.join(", ")}], got ${value}.`, path);
		}
		return value;
	}
	throw new Error("Unsupported internal Studio schema.");
}
export const validateStudioIdentity = value => validateStudioSchema(identity, value, "INVALID_IDENTITY");

export function mandatoryStudioTargetIds(context) {
	return [...new Set([
		...(["object", "character", "rig"].includes(context.selection?.kind) ? [context.selection.id] : []),
		...(context.activeCharacterId ? [context.activeCharacterId] : []), ...(context.shot?.subjectIds ?? []),
		...context.jobs.flatMap(job => [job.characterId, ...(job.targetIds ?? [])]),
	])];
}
export function validateStudioContext(value) {
	// Budget check before inspecting strings/arrays; still reject nonfinite values
	// structurally below (JSON itself would otherwise turn them into null).
	const bytes = utf8ByteLength(JSON.stringify(value) ?? "");
	if (bytes > STUDIO_CONTEXT_MAX_BYTES) fail("CONTEXT_TOO_LARGE", `Studio context exceeds ${STUDIO_CONTEXT_MAX_BYTES / 1024} KiB.`, "$", { bytes, maxBytes: STUDIO_CONTEXT_MAX_BYTES });
	const c = validateStudioSchema(contextSchema, value, "INVALID_CONTEXT");
	const unique = new Set(c.entities.map(e => e.id));
	if (unique.size !== c.entities.length) fail("INVALID_CONTEXT", "Duplicate entity ID.");
	for (const targetId of mandatoryStudioTargetIds(c)) if (!unique.has(targetId)) fail("TARGET_NOT_READY", "Mandatory target is absent from context.");
	if (c.activeCharacterId && !c.entities.some(e => e.id === c.activeCharacterId && e.kind === "character")) fail("INVALID_CONTEXT", "Active target is not a character.");
	if (["object", "character", "rig"].includes(c.selection?.kind) && !c.entities.some(e => e.id === c.selection.id && e.kind === c.selection.kind)) fail("INVALID_CONTEXT", "Selection kind disagrees with the selected entity.");
	if (c.selection?.kind === "scene" && c.selection.id !== c.host.sceneId) fail("INVALID_CONTEXT", "Selected scene is not the bound scene.");
	for (const e of c.entities) {
		if (e.bounds && ["x", "y", "z"].some(axis => e.bounds.min[axis] > e.bounds.max[axis])) fail("INVALID_CONTEXT", "Inverted entity bounds.");
		if (e.kind === "object" && typeof e.scale === "number") fail("INVALID_CONTEXT", "Objects use three-axis scale.");
		if (e.kind !== "object" && record(e.scale)) fail("INVALID_CONTEXT", "Cast uses scalar scale.");
	}
	const p = c.entityPage;
	if (p.returned !== c.entities.length || p.total < p.returned || p.truncated !== (p.total > p.returned) || (p.truncated ? p.nextCursor === null : p.nextCursor !== null)) fail("INVALID_CONTEXT", "Entity pagination is inconsistent.");
	if (c.entityIndex) {
		const indexed = new Set(c.entityIndex.map(e => e.id));
		if (indexed.size !== c.entityIndex.length) fail("INVALID_CONTEXT", "Duplicate entity index ID.");
		if (c.entityIndex.length > p.total || c.entities.some(e => !indexed.has(e.id))) fail("INVALID_CONTEXT", "Entity index must cover every detailed entity and no more than the total.");
	}
	if (c.view.frame >= Math.max(1, c.scene.frameCount)) fail("INVALID_CONTEXT", "Playhead is outside the scene.");
	if (new Set(c.shots.map(s => s.id)).size !== c.shots.length) fail("INVALID_CONTEXT", "Duplicate shot ID.");
	for (const shot of [...c.shots, ...(c.shot ? [c.shot] : [])]) if (shot.range.endFrameExclusive > c.scene.frameCount) fail("INVALID_CONTEXT", "Shot is outside the scene.");
	if (c.shot && !c.shots.some(s => s.id === c.shot.id && s.range.startFrame === c.shot.range.startFrame && s.range.endFrameExclusive === c.shot.range.endFrameExclusive)) fail("INVALID_CONTEXT", "Current shot and range must survive projection.");
	return c;
}
export function validateStudioTurnEnvelope(value) {
	if (!record(value) || value.surface !== "studio") fail("INVALID_REQUEST", "Expected Studio envelope.");
	if (!isUuid(value.turnId)) fail("INVALID_TURN_ID", "Studio turnId must be a UUID.");
	if (!isUuid(value.sessionId)) fail("INVALID_SESSION_ID", "Studio sessionId must be a UUID.");
	validateStudioContext(value.context);
	return validateStudioSchema(turnSchema, value, "INVALID_REQUEST");
}
export const validateStudioStopEnvelope = value => validateStudioSchema(stopSchema, value, "INVALID_REQUEST");
export function validateTargetGuard(expected, current) {
	const a = validateStudioSchema(guardSchema, expected, "STALE_TARGET");
	const b = validateStudioSchema(guardSchema, current, "STALE_TARGET");
	if (Object.keys(a).some(key => a[key] !== b[key])) fail("STALE_TARGET", "Workspace, scene, epoch or target incarnation/content changed.", "$", { currentTargets: [b] });
	return true;
}
/** readContext must be authoritative for the explicitly submitted host, never
 * selected by connection order. View-only refreshes do not invalidate guards. */
export function validateStudioContextFreshness(submitted, current) {
	const a = validateStudioContext(submitted), b = validateStudioContext(current);
	if (!a.host.workspaceHandle || !b.host.workspaceHandle) fail("LIVE_HUB_UNAVAILABLE", "A connected editor handle is required.");
	if (Object.keys(host.properties).some(key => a.host[key] !== b.host[key])) fail("STALE_SCENE", "Studio host binding changed.", "$", { currentHost: b.host });
	for (const target of a.entities) {
		const actual = b.entities.find(e => e.id === target.id);
		if (!actual) fail("STALE_TARGET", "Submitted target is no longer available in the authoritative projection.");
		validateTargetGuard({ ...pickIdentity(a.host), targetId: target.id, token: target.token }, { ...pickIdentity(b.host), targetId: actual.id, token: actual.token });
	}
	if (a.revision.scene !== b.revision.scene || a.revision.physics !== b.revision.physics) fail("STALE_SCENE", "Authored context changed; obtain fresh intent.");
	return true;
}
const pickIdentity = value => Object.fromEntries(Object.keys(identityFields).map(key => [key, value[key]]));

/** Unknown paths are answered with the paths that DO exist for that kind, so a
 * caller never has to guess the vocabulary from a rejection. */
function validatePatchPaths(args) {
	const kinds = new Set();
	for (const op of Array.isArray(args?.ops) ? args.ops : []) {
		const kind = record(op) ? op.target?.kind : undefined;
		if (!STUDIO_PATCH_KINDS.includes(kind)) continue;
		kinds.add(kind);
		for (const key of record(op.set) ? Object.keys(op.set) : []) {
			if (!Object.hasOwn(STUDIO_PATCH_SET_SCHEMAS[kind].properties, key)) {
				fail("INVALID_ARGUMENT", `Unknown ${kind} path "${kind}.${key}". Valid ${kind} paths: ${STUDIO_PATCHABLE_PATHS[kind].join(", ")}.`);
			}
		}
	}
	// One patch is one commit domain and one history entry: a receipt asserts a
	// single revision step and exactly one undo entry, so a mixed batch could
	// not describe itself honestly.
	if (kinds.size > 1) fail("INVALID_ARGUMENT", "One domain per patch: split character, object, shot and stage edits into separate commands.");
}
export function validateStudioCommand(command) {
	if (!record(command) || !STUDIO_TOOLS.includes(command.name)) fail("UNKNOWN_TOOL", "Unsupported Studio tool.");
	if (command.name === "patch_elements") validatePatchPaths(command.args);
	const { args } = validateStudioSchema(object({ name: choices(STUDIO_TOOLS), args: toolSchemas[command.name] }), command);
	if (command.name === "inspect_studio" && args.ids && args.query !== undefined) fail("INVALID_ARGUMENT", "IDs and query are exclusive.");
	if (command.name === "operate_studio" && (!Object.keys(args).length || (args.view && !Object.keys(args.view).length))) fail("INVALID_ARGUMENT", "Transient operation must specify an action.");
	if (args.ops) {
		const names = args.ops.filter(op => op.op === "create" && op.name !== undefined).map(op => op.name.normalize("NFC").trim());
		if (new Set(names).size !== names.length) fail("DUPLICATE_NAME", "Create names must be unique; resolve existing targets by ID.");
		for (const op of args.ops) {
			if (op.op === "update" && Object.keys(op).length === 2) fail("INVALID_ARGUMENT", "Update has no fields.");
			if (op.facing && op.rotationDeg) fail("INVALID_ARGUMENT", "Facing and rotationDeg are exclusive: facing sets yaw only (toward/away/same-as/yawDeg); rotationDeg {x,y,z} sets the full rotation, with y as the yaw.");
			if (op.op === "group" && op.childIds.includes(op.parentId)) fail("INVALID_ARGUMENT", "Cannot group an object under itself.");
			if (op.op === "create" && op.parent !== undefined && op.name !== undefined && op.parent.normalize("NFC").trim() === op.name.normalize("NFC").trim()) fail("INVALID_ARGUMENT", "Cannot group an object under itself.");
		}
		// Avoidance nudges outward from a relativeTo reference, so at least one op needs one;
		// the others (world/onObject/between, remove, group) are placed as given and the
		// final batch is still checked for overlap.
		if (args.collisionPolicy === "avoid" && !args.ops.some(op => ["create", "update"].includes(op.op) && op.position?.relativeTo)) fail("INVALID_ARGUMENT", "collisionPolicy avoid needs at least one op with position.relativeTo (it nudges outward from that reference); other ops are placed as given.");
	}
	if (command.name === "frame_shot" && args.framing.exact && JSON.stringify(args.framing.exact.position) === JSON.stringify(args.framing.exact.lookAt)) fail("INVALID_ARGUMENT", "Camera position and aim cannot coincide.");
	if (command.name === "patch_elements") {
		for (const op of args.ops) if (!Object.keys(op.set).length) fail("INVALID_ARGUMENT", "Patch has no fields.");
	}
	if (command.name === "verify_result") {
		if (Boolean(args.receiptId) === Boolean(args.targets)) fail("INVALID_ARGUMENT", "Exactly one of receiptId or targets is required.");
		if (args.checks.includes("motion") && args.range === undefined) {
			args.range = "whole_clip";
			Object.defineProperty(args, "rangeWasDefaulted", { value: true, enumerable: false });
		}
	}
	return { name: command.name, args };
}
export function validateReceipt(value) {
	if (value?.ok === false) {
		const r = validateStudioSchema(failureSchema, value, "INVALID_RECEIPT");
		if (utf8ByteLength(JSON.stringify(r)) > 8192) fail("INVALID_RECEIPT", "Failure receipt exceeds 8 KiB.");
		if ((r.mutated === false && r.preserved.authoredState !== "unchanged") || (r.mutated === true && r.preserved.authoredState !== "changed") || (r.mutated === "unknown" && (r.preserved.authoredState !== "unknown" || r.recovery.action !== "reconcile" || r.recovery.retryAllowed === true))) fail("INVALID_RECEIPT", "Failure must preserve uncertainty and actual state evidence.");
		return freezeStudioData(r);
	}
	const r = validateStudioSchema(receiptSchema, value, "INVALID_RECEIPT");
	if (utf8ByteLength(JSON.stringify(r)) > 8192) fail("INVALID_RECEIPT", "Receipt exceeds 8 KiB; use a detail cursor.");
	if (r.delta.some(d => !r.affectedIds.includes(d.id) || !Object.keys(d.after).length)) fail("INVALID_RECEIPT", "Readback must identify affected targets and actual state.");
	if (r.ops) {
		const dropped = r.ops.some(op => op.status === "partial");
		if (r.ops.some((op, index) => op.index !== index)) fail("INVALID_RECEIPT", "Operation results must report every operation in order.");
		if (r.ops.some(op => (op.status === "partial") !== Boolean(op.droppedPaths?.length))) fail("INVALID_RECEIPT", "A partial operation must name the paths the domain dropped, and only a partial one may.");
		if (r.status === "applied" && dropped) fail("INVALID_RECEIPT", "Applied status cannot hide a dropped path.");
		if (r.status === "partial" && !dropped) fail("INVALID_RECEIPT", "Partial status requires at least one dropped path.");
		if (r.status === "noop" && r.ops.some(op => op.status === "applied")) fail("INVALID_RECEIPT", "A noop cannot report an applied operation.");
	}
	if (r.status === "started" || r.status === "completed") {
		if (r.revision.after < r.revision.before && !r.nextHost) fail("INVALID_RECEIPT", "Completion revisions must not move backwards in one document.");
		if (r.status === "started" && (r.authored || r.undo || r.revision.before !== r.revision.after)) fail("INVALID_RECEIPT", "Started jobs cannot claim an authored commit.");
		if (r.kind === "mutation" && (!r.authored || !r.undo || r.revision.after <= r.revision.before || !r.delta.length)) fail("INVALID_RECEIPT", "A completed composite mutation needs retained undo and advancing revision evidence.");
		if (r.undo && (!r.authored || !r.affectedIds.length)) fail("INVALID_RECEIPT", "An undo entry requires an authored result and affected targets.");
	} else if (r.status === "noop" || r.status === "transient") {
		if (r.authored || r.undo !== null || r.revision.before !== r.revision.after) fail("INVALID_RECEIPT", "Non-authored operations cannot create history or advance authored revision.");
		if (r.status === "noop" && (r.mutated !== false || r.delta.length)) fail("INVALID_RECEIPT", "Noop must prove no mutation.");
		if (r.status === "transient" && (!r.view || r.view.after < r.view.before || !r.delta.length)) fail("INVALID_RECEIPT", "Transient receipt requires view revisions and actual readback.");
	} else {
		if (!r.authored || !r.undo || r.revision.after !== r.revision.before + 1 || !r.affectedIds.length || !r.delta.length || r.mutated === false) fail("INVALID_RECEIPT", "Authored mutation requires one revision and one undo entry with actual readback.");
		if (r.delta.length < r.affectedIds.length && !r.detailCursor) fail("INVALID_RECEIPT", "Omitted batch readback requires a detail cursor.");
	}
	if (r.status === "undone") {
		if (new Set(r.restoredTargets.map(t => t.targetId)).size !== r.affectedIds.length || r.restoredTargets.some(t => !r.affectedIds.includes(t.targetId) || Object.keys(identityFields).some(key => t[key] !== r.host[key]))) fail("INVALID_RECEIPT", "Undo must identify every restored target and its new token in the bound host.");
	}
	if (r.status === "installed") {
		if (!r.jobId || !r.artifactId || !r.installed || !r.verification || !r.affectedIds.includes(r.installed.characterId)) fail("INVALID_RECEIPT", "Installation requires correlated target, artifact and verification evidence.");
		const { frameCount, blocks } = r.installed; let previous = 0;
		for (const block of blocks) { if (block.startFrame !== previous || block.endFrameExclusive <= previous || block.endFrameExclusive - previous > 120) fail("INVALID_RECEIPT", "Installed schedule is not contiguous or bounded."); previous = block.endFrameExclusive; }
		if (previous !== frameCount || r.installed.durationSeconds !== frameCount / 24 || r.verification.range.startFrame !== 0 || r.verification.range.endFrameExclusive !== frameCount || r.verification.evaluatedFrames > frameCount) fail("INVALID_RECEIPT", "Installed schedule and verification coverage disagree.");
		if (r.verification.status === "verified" && r.verification.evaluatedFrames !== frameCount) fail("INVALID_RECEIPT", "Verified motion requires whole-clip coverage.");
		if (r.verification.status === "unverified" && r.explicitUnverifiedAcceptance !== true && r.acceptance !== "advisory-policy") fail("INVALID_RECEIPT", "Unverified installation requires explicit user or advisory-policy acceptance.");
	} else if (r.installed || r.verification || (r.jobId && !["started", "completed"].includes(r.status)) || r.artifactId || r.explicitUnverifiedAcceptance !== undefined) fail("INVALID_RECEIPT", "Installation evidence is exclusive to installed receipts.");
	return freezeStudioData(r);
}
