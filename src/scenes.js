// Pure multi-scene document model. No three.js, no React.
// A Scene is the set; shotDocument and stage are sealed department envelopes.
// This module stores and copies those envelopes but never opens or validates them.

import { DEFAULT_SENSOR_FORMAT, SENSOR_FORMATS } from "./shot.js";
import { normalizeStableItems } from "./stable-items.js"; import { noteLayerField } from "./timeline-notes.js";

import { elementByPath } from "./studio-elements.js";
import { wrapAngle } from "./scene-objects.js"; import { retireObjectKind } from "./retired-kinds.js";
import { normalizeTakeSource } from "./domains/motion/take-source.js"; import { importedRigOf, isImportedCharacter } from "./character-rig.js";
import { createKeyLight, normalizeLighting } from "./stage-lighting.js";
// The timeline clock lives in timeline-fps.js (three-free, so the agent
// sidecar can import it); re-exported here for every scene-side caller.
import { TIMELINE_FRAME_FPS, toTimelineFrame } from "./timeline-fps.js";

const CHARACTER_POSITION_LIMITS = elementByPath("character.position");
const CHARACTER_SCALE_LIMITS = elementByPath("character.scale");

export const SCENES_VERSION = 5;
export const SCENES_STORAGE_KEY = "cozyclay.scenes.v5";
export const SCENES_QUARANTINE_KEY = "cozyclay.scenes.v5.quarantine";
export const PREVIOUS_SCENES_STORAGE_KEY = "cozyclay.scenes.v4";
const V3_SCENES_STORAGE_KEY = "cozyclay.scenes.v3";
const V2_SCENES_STORAGE_KEY = "cozyclay.scenes.v2";
const V1_SCENES_STORAGE_KEY = "cozyclay.scenes.v1";
export const LEGACY_SCENE_STORAGE_KEY = "cozyclay.scene.v1";
/** Newest-first fallback chain: a user arriving from any older build still
 * finds their scenes, and the reader migrates whatever body it lands on. */
export const LEGACY_SCENES_STORAGE_KEYS = Object.freeze([
	PREVIOUS_SCENES_STORAGE_KEY,
	V3_SCENES_STORAGE_KEY,
	V2_SCENES_STORAGE_KEY,
	V1_SCENES_STORAGE_KEY,
]);

export { TIMELINE_FRAME_FPS };

/** Rigged character models shipped in public/models. The id is both the FBX
 * file stem and the motion3 rig name (src/motion3/rigs/<id>.json). */
export const CHARACTER_MODEL_IDS = Object.freeze(["y-bot-tpose", "x-bot-tpose"]);
export const DEFAULT_CHARACTER_MODEL = "y-bot-tpose";
/** A rig-free capsule stand-in for blocking. It has no FBX and no motion3
 * rig, so it extends the accepted kinds without joining
 * CHARACTER_MODEL_IDS. */
export const PROXY_FIGURE_MODEL = "proxy-figure";
export const CHARACTER_KIND_IDS = Object.freeze([...CHARACTER_MODEL_IDS, PROXY_FIGURE_MODEL]);
export const POSTURES = Object.freeze(["stand", "sit", "lie"]);

export function isProxyFigure(character) {
	return character?.model === PROXY_FIGURE_MODEL;
}
// Descriptions the app once invented for a character with none (#1212): a stored one loads as no subject.
const PLACEHOLDER_SUBJECTS = new Set(["a young woman in a tan coat", "a man in a dark coat", "a person"]);

// The one-character cast every scene used to open with. A new scene now
// starts on an empty stage; legacy documents that never stored a cast, and
// fixtures that want a body to work with, still seed this one.
const SEED_CHARACTER = Object.freeze({ id: "char-a", model: DEFAULT_CHARACTER_MODEL, x: 0, z: 0, rot: 0, hidden: false, pose: null, subject: "" });
const DEFAULT_SCENE_STAGE = Object.freeze({
	characters: Object.freeze([]),
	hasCharSheet: false,
	// The look reference for the location: a data URL so it survives save/load
	environmentImage: null,
	// What the location IS and how it should look: the two lines every shot
	// prompt is built from, plus the flag saying the author has a sheet for it
	// instead. Session state until #345 — a reopened scene came back describing
	// the previous room. A new scene starts with neither; the author writes them.
	environment: "",
	style: "",
	hasEnvSheet: false,
	shotAspect: "16:9",
	cameraPresetId: null,
	sensorId: DEFAULT_SENSOR_FORMAT,
});

let sceneSequence = 1;

const plainObject = (value) => !!value && typeof value === "object" && !Array.isArray(value);

// Persistence values are JSON-shaped. Recursing here keeps duplicateScene
// independent without borrowing the shot document's schema or runtime types.
function cloneValue(value, copies = new WeakMap()) {
	if (value === null || typeof value === "string" || typeof value === "boolean") return value;
	if (typeof value === "number") return Number.isFinite(value) ? value : null;
	if (typeof value !== "object") return null;
	if (copies.has(value)) return copies.get(value);
	if (Array.isArray(value)) {
		const copy = [];
		copies.set(value, copy);
		for (const entry of value) copy.push(cloneValue(entry, copies));
		return copy;
	}
	const copy = {};
	copies.set(value, copy);
	for (const [key, entry] of Object.entries(value)) {
		Object.defineProperty(copy, key, {
			value: cloneValue(entry, copies),
			enumerable: true,
			writable: true,
			configurable: true,
		});
	}
	return copy;
}

const finiteOr = (value, fallback) => (Number.isFinite(value) ? value : fallback);

/** A reference picture kept inside the document. Only inline data URLs are
 * accepted: a file:// or http:// path would break the moment the project is
 * moved or reopened elsewhere, so a slot either holds its own bytes or is
 * empty. */
export function normalizeReferenceImage(value) {
	return typeof value === "string" && value.startsWith("data:image/") ? value : null;
}

/** Stature band for a cast member: the gizmo's scale handles are a deliberate
 * artistic ask, and a previs giant or child is legitimate. */
const clampScale = (value) => (Number.isFinite(value) && value > 0
	? Math.max(CHARACTER_SCALE_LIMITS.min, Math.min(CHARACTER_SCALE_LIMITS.max, value))
	: 1);

/** One character entry in the stage envelope. `source` may be a v3 entry, a
 * partial (spawn dialog), or null — every field falls back to a sane default
 * and every object is freshly owned by the caller. */
export function createCharacterEntry(source = null, index = 0) {
	const s = plainObject(source) ? source : {};
	return {
		id: typeof s.id === "string" && s.id ? s.id : `char-${index + 1}`,
		// an imported character (character-rig.js) keeps its own model id with its rig
		model: CHARACTER_KIND_IDS.includes(s.model) || isImportedCharacter(s) ? s.model : DEFAULT_CHARACTER_MODEL,
		posture: POSTURES.includes(s.posture) ? s.posture : "stand",
		x: Math.max(CHARACTER_POSITION_LIMITS.min.x, Math.min(CHARACTER_POSITION_LIMITS.max.x, finiteOr(s.x, 0))),
		// Lift is bounded by the deck and the shared room headroom, so every
		// writer (inspector field, viewport gizmo, load path) shares one envelope.
		y: Math.max(CHARACTER_POSITION_LIMITS.min.y, Math.min(CHARACTER_POSITION_LIMITS.max.y, finiteOr(s.y, 0))),
		z: Math.max(CHARACTER_POSITION_LIMITS.min.z, Math.min(CHARACTER_POSITION_LIMITS.max.z, finiteOr(s.z, 0))),
		rot: wrapAngle(finiteOr(s.rot, 0)),
		hidden: s.hidden === true,
		// The scene object this character is grouped under, or null. A grouped
		// character rides its object's travel path the way grouped parts do; its
		// own x/y/z stay world numbers at the object's authored pose.
		parent: typeof s.parent === "string" && s.parent ? s.parent : null,
		// User-picked body tint; null means "model default" (y-bot clay, x-bot
		// whiter clay) so the entry survives future default tweaks.
		tint: typeof s.tint === "string" && /^#[0-9a-fA-F]{6}$/.test(s.tint) ? s.tint : null,
		pose: plainObject(s.pose) ? cloneValue(s.pose) : null,
		// Who this cast member IS: a character sheet / reference photo that rides
		// with the capture so a generator matches face, hair and wardrobe instead
		// of re-inventing them per shot.
		identityImage: normalizeReferenceImage(s.identityImage),
		// Stature multiplier: 1 is the canonical body, an extracted take carries
		// the FILMED person's leg ratio. It persists with the entry because the
		// take's root travel was authored against it — see the render path.
		scale: clampScale(s.scale),
		subject: typeof s.subject === "string" && !PLACEHOLDER_SUBJECTS.has(s.subject) ? s.subject : "",
		// The character's animation layer: its own root path.
		layer: normalizeLayer(s.layer),
		// The Pose-mode / IK edits on this character's layer (encoded keys, range
		// pins and their residuals). The motion domain owns them while the scene
		// is open; this is what the saved scene carries so a reload keeps them.
		ikEdits: normalizeIkEdits(s.ikEdits),
		// A compiled take v3 saves its source; the motion layer compiles it again on load.
		motionTake: normalizeTakeSource(s.motionTake), ...importedRigOf(s),
	};
}

function normalizeIkEdits(value) {
	if (!plainObject(value)) return null;
	const rows = (list, valid) => (Array.isArray(list) ? list.filter(valid).map((entry) => cloneValue(entry)) : []);
	const keys = rows(value.keys, (row) => plainObject(row) && Number.isFinite(row.frame) && plainObject(row.tracks));
	const pins = rows(value.pins, (pin) => plainObject(pin) && typeof pin.id === "string");
	const pinResiduals = rows(value.pinResiduals, (row) => Array.isArray(row) && typeof row[0] === "string");
	return keys.length || pins.length ? { keys, pins, pinResiduals } : null;
}

function normalizeLayer(layer) {
	const source = plainObject(layer) ? layer : {};
	return {
		waypoints: normalizeStableItems(cloneValue(source.waypoints), "waypoint"), ...noteLayerField(source.notes), // timeline notes (timeline-notes.js)
	};
}

function normalizeStageLayers(stage) {
	const source = plainObject(stage) ? stage : {};
	const ids = new Set();
	return {
		...source,
		characters: Array.isArray(source.characters)
			? source.characters.map((character) => ({
				...character,
				layer: {
					waypoints: normalizeStableItems(cloneValue(character.layer?.waypoints), "waypoint", ids), ...noteLayerField(character.layer?.notes),
				},
			}))
			: source.characters,
	};
}

export function createCharacterLayer() {
	return { waypoints: [] };
}

/** Retime one animation layer from the 20 fps authoring clock onto the 24 fps
 * production clock. Frame numbers only: positions and headings are untouched.
 * The mapping is strictly increasing, so ascending order survives it. */
function migrateLayerFrames(layer) {
	if (!plainObject(layer)) return layer;
	const next = { ...cloneValue(layer) };
	if (Array.isArray(layer.waypoints)) {
		const byFrame = new Map();
		for (const waypoint of layer.waypoints) {
			if (!plainObject(waypoint) || !Number.isFinite(waypoint.frame)) continue;
			const frame = Math.max(0, toTimelineFrame(Math.round(waypoint.frame)));
			byFrame.set(frame, { ...cloneValue(waypoint), frame });
		}
		next.waypoints = [...byFrame.values()].sort((a, b) => a.frame - b.frame);
	}
	return next;
}

/** v3 → v4 for one stage envelope: every frame-bearing number in every cast
 * member's layer moves onto the production clock. Exported because a project
 * FILE carries its own scene document and needs the same migration. */
export function migrateStageFrames(stage) {
	if (!plainObject(stage) || !Array.isArray(stage.characters)) return stage;
	return {
		...stage,
		characters: stage.characters.map((entry) => (plainObject(entry) && plainObject(entry.layer)
			? { ...entry, layer: migrateLayerFrames(entry.layer) }
			: entry)),
	};
}

/** Stage envelopes before v3 stored a fixed cast (charA/charB/showB/poseA/
 * poseB/subject/subject2). Fold that cast into the characters list so the
 * rest of the app only ever sees one shape. */
function migrateLegacyCast(source) {
	const cast = [createCharacterEntry({ ...plainObject(source.charA) ? source.charA : {}, id: "char-a", pose: source.poseA ?? null, subject: source.subject }, 0)];
	if (source.showB === true) {
		cast.push(createCharacterEntry({ ...plainObject(source.charB) ? source.charB : {}, id: "char-b", pose: source.poseB ?? null, subject: source.subject2 }, 1));
	}
	return cast;
}

const LEGACY_CAST_KEYS = Object.freeze(["charA", "charB", "showB", "poseA", "poseB", "subject", "subject2"]), STAGE_ENVELOPE_KEYS = new Set([
	"characters", "hasCharSheet", "environmentImage", "environment", "style", "hasEnvSheet", "shotAspect", "cameraPresetId", "sensorId", "keyLight", "lighting",
	...LEGACY_CAST_KEYS,
]);

export function createSceneStage(stage = null) {
	const source = plainObject(stage) ? stage : {};
	// With no cast list, a pre-v3 envelope folds its fixed cast in; anything else is an empty stage.
	const characters = Array.isArray(source.characters)
		? source.characters.map((entry, index) => createCharacterEntry(entry, index))
		: LEGACY_CAST_KEYS.some((key) => Object.hasOwn(source, key)) ? migrateLegacyCast(source) : [];
	// Unknown extra keys (shotAspect was one, once) ride along so the envelope
	// stays sealed-but-lossless; legacy cast keys are deliberately dropped.
	const extras = {};
	for (const [key, value] of Object.entries(source)) {
		if (!STAGE_ENVELOPE_KEYS.has(key)) extras[key] = cloneValue(value);
	}
	return {
		...extras,
		characters,
		hasCharSheet: source.hasCharSheet === true,
		// Persisted exactly like shotAspect: part of the stage envelope, written
		// on every save and read back on load.
		environmentImage: normalizeReferenceImage(source.environmentImage),
		environment: typeof source.environment === "string" ? source.environment : DEFAULT_SCENE_STAGE.environment,
		style: typeof source.style === "string" ? source.style : DEFAULT_SCENE_STAGE.style,
		hasEnvSheet: source.hasEnvSheet === true,
		shotAspect: ["16:9", "2.39:1", "9:16", "1:1", "4:3", "12:7", "fal 480P"].includes(source.shotAspect)
			? source.shotAspect
			: DEFAULT_SCENE_STAGE.shotAspect,
		// A label recording which named framing the shot camera was placed by.
		// Unknown ids are dropped rather than kept: a stage that names a preset
		// this build cannot apply would claim a framing nobody can reproduce.
		cameraPresetId: typeof source.cameraPresetId === "string" && source.cameraPresetId
			? source.cameraPresetId
			: DEFAULT_SCENE_STAGE.cameraPresetId,
		// `sensorFormat` was this field's name for one unreleased day; read it so
		// a stage saved in that window still loads with its camera intact.
		sensorId: Object.hasOwn(SENSOR_FORMATS, source.sensorId ?? source.sensorFormat)
			? (source.sensorId ?? source.sensorFormat)
			: DEFAULT_SCENE_STAGE.sensorId,
		// The key light the user grabs (puck position, master brightness, warmth or
		// colour) and the stage look; a stage saved before either renders as it did.
		keyLight: createKeyLight(source.keyLight),
		lighting: normalizeLighting(source.lighting),
	};
}

function uniqueId(existing) {
	const ids = new Set(existing.map((scene) => scene?.id));
	let id;
	do id = `scene-${Date.now().toString(36)}-${sceneSequence++}`;
	while (ids.has(id));
	return id;
}

function uniqueName(requested, existing) {
	const nameKey = (name) => typeof name === "string" ? name.normalize("NFKC").toLowerCase() : "";
	const names = new Set(existing.map((scene) => nameKey(scene?.name)));
	const hasName = (name) => names.has(nameKey(name));
	const base = typeof requested === "string" && requested.trim() ? requested.trim() : "SCENE 01";
	if (!hasName(base)) return base;
	const numbered = base.match(/^(.*?)(\d+)$/);
	if (numbered) {
		const [, prefix, digits] = numbered;
		for (let number = Number(digits) + 1; ; number += 1) {
			const candidate = `${prefix}${String(number).padStart(digits.length, "0")}`;
			if (!hasName(candidate)) return candidate;
		}
	}
	for (let number = 2; ; number += 1) {
		const candidate = `${base} ${number}`;
		if (!hasName(candidate)) return candidate;
	}
}

export function createScene(name = "SCENE 01", existing = []) {
	return { id: uniqueId(existing), name: uniqueName(name, existing), objects: [], shotDocument: null, stage: createSceneStage() };
}

export function addScene(scenes, name = "SCENE 01") {
	const list = Array.isArray(scenes) ? scenes : [];
	return [...list, createScene(name, list)];
}

export function duplicateScene(scenes, index) {
	if (!Array.isArray(scenes) || index < 0 || index >= scenes.length) return scenes;
	const source = scenes[index];
	const duplicate = createScene(source.name, scenes);
	duplicate.objects = cloneValue(source.objects);
	duplicate.shotDocument = cloneValue(source.shotDocument);
	duplicate.stage = createSceneStage(source.stage);
	return [...scenes.slice(0, index + 1), duplicate, ...scenes.slice(index + 1)];
}

export function renameScene(scenes, index, name) {
	if (!Array.isArray(scenes) || index < 0 || index >= scenes.length || typeof name !== "string" || !name.trim()) return scenes;
	const others = scenes.filter((_, sceneIndex) => sceneIndex !== index);
	const nextName = uniqueName(name, others);
	if (nextName === scenes[index].name) return scenes;
	return scenes.map((scene, sceneIndex) => sceneIndex === index ? { ...scene, name: nextName } : scene);
}

export function removeScene(scenes, index) {
	if (!Array.isArray(scenes) || scenes.length <= 1 || index < 0 || index >= scenes.length) return scenes;
	return scenes.filter((_, sceneIndex) => sceneIndex !== index);
}

export function activeSceneIndex(scenes, activeSceneId) {
	if (!Array.isArray(scenes) || !scenes.length) return -1;
	const index = scenes.findIndex((scene) => scene.id === activeSceneId);
	return index < 0 ? 0 : index;
}

export function activeScene(scenes, activeSceneId) {
	const index = activeSceneIndex(scenes, activeSceneId);
	return index < 0 ? null : scenes[index];
}

// The stage a scene opened with before empty stages: one standing Y Bot.
export const createSeededSceneStage = () => createSceneStage({ characters: [SEED_CHARACTER] });

// A one-scene document on an empty stage. `{ seedCharacter: true }` gives
// the scene the old one-character cast instead.
export function createSceneDocument({ seedCharacter = false } = {}) {
	const scene = { ...createScene(), ...(seedCharacter === true ? { stage: createSeededSceneStage() } : {}) };
	return { version: SCENES_VERSION, activeSceneId: scene.id, scenes: [scene] };
}

function repairScene(record, existing, fallbackNumber, fallbackStage, legacyClock = false) {
	if (!plainObject(record) || typeof record.id !== "string" || !record.id || !Array.isArray(record.objects)) return null;
	if (existing.some((scene) => scene.id === record.id)) return null;
	const stage = normalizeStageLayers(createSceneStage(cloneValue(plainObject(record.stage) ? record.stage : fallbackStage)));
	return {
		id: record.id,
		name: uniqueName(typeof record.name === "string" ? record.name : `SCENE ${String(fallbackNumber).padStart(2, "0")}`, existing),
		// A kind this build no longer ships opens as the cube that stands in for it.
		objects: record.objects.filter(plainObject).map((object) => retireObjectKind(cloneValue(object))),
		// The shot document is a sealed envelope with its OWN version, and it
		// migrates its own frames when its reader opens it.
		shotDocument: cloneValue(record.shotDocument ?? null),
		stage: legacyClock ? migrateStageFrames(stage) : stage,
	};
}

function repairDocument(payload, fallbackStage = DEFAULT_SCENE_STAGE, legacyClock = false) {
	const scenes = [];
	let dropped = 0;
	for (const record of payload.scenes) {
		const scene = repairScene(record, scenes, scenes.length + 1, fallbackStage, legacyClock);
		if (scene) scenes.push(scene);
		else dropped += 1;
	}
	if (!scenes.length) scenes.push(createScene());
	const index = activeSceneIndex(scenes, payload.activeSceneId);
	return { document: { version: SCENES_VERSION, activeSceneId: scenes[index].id, scenes }, dropped };
}

function parse(raw) {
	try {
		return JSON.parse(raw);
	} catch {
		return null;
	}
}

/** Tagged, side-effect-free reader. The caller decides when quarantine bytes
 * are written; future payloads are deliberately returned without a document. */
export function readSceneDocument(raw, legacyRaw = null) {
	if (raw === null || raw === undefined || raw === "") {
		if (legacyRaw !== null && legacyRaw !== undefined && legacyRaw !== "") {
			const legacy = parse(legacyRaw);
			if (!plainObject(legacy) || legacy.version !== 1 || !Array.isArray(legacy.objects)) {
				return { status: "corrupt", document: createSceneDocument(), dropped: 0, quarantineRaw: legacyRaw };
			}
			// A v1 scene had no stored cast; it always opened with the seed character.
			const document = createSceneDocument({ seedCharacter: true });
			document.scenes[0].objects = legacy.objects.filter(plainObject).map((object) => retireObjectKind(cloneValue(object)));
			return { status: "migrated", document, dropped: legacy.objects.length - document.scenes[0].objects.length };
		}
		return { status: "absent", document: createSceneDocument(), dropped: 0 };
	}

	const payload = parse(raw);
	if (!plainObject(payload) || !Number.isInteger(payload.version) || payload.version < 1) {
		return { status: "corrupt", document: createSceneDocument(), dropped: 0, quarantineRaw: raw };
	}
	if (payload.version > SCENES_VERSION) return { status: "future", document: null, dropped: 0 };
	if (!Array.isArray(payload.scenes)) {
		return { status: "corrupt", document: createSceneDocument(), dropped: 0, quarantineRaw: raw };
	}
	const migrating = payload.version < SCENES_VERSION;
	// Anything below v4 was authored while the timeline ran at 20 fps. The
	// fallback stage (a v1 global cast) rides the same conversion, applied
	// once, inside repairScene — whichever stage that scene ends up with.
	// v4 → v5 needs no step of its own: every cast member passes through
	// createCharacterEntry, which fills the missing posture with "stand".
	const legacyClock = payload.version < 4;
	// Before v3 the cast lived on one global stage, and a document without one
	// opened with the seed character.
	const repaired = repairDocument(payload, payload.version < 3 && !plainObject(payload.stage) ? createSeededSceneStage() : createSceneStage(payload.stage), legacyClock);
	return { status: migrating ? "migrated" : "valid", ...repaired };
}

/** Lift a scene document that skipped the storage reader (a project file, a
 * playground preset) onto SCENES_VERSION: v3 and older move their frames onto
 * the 24 fps clock, v4 and older gain a standing posture per cast member. */
export function migrateScenesDocument(source) {
	if (!Number.isInteger(source.version) || source.version >= SCENES_VERSION) return source;
	const legacyClock = source.version < 4;
	return {
		...source,
		version: SCENES_VERSION,
		scenes: source.scenes.map((scene) => {
			const stage = legacyClock ? migrateStageFrames(scene.stage) : scene.stage;
			return { ...scene, stage: plainObject(stage) && Array.isArray(stage.characters)
				? { ...stage, characters: stage.characters.map((entry) => (plainObject(entry) && !POSTURES.includes(entry.posture) ? { ...entry, posture: "stand" } : entry)) }
				: stage };
		}),
	};
}

export function serializeSceneDocument(document) {
	return JSON.stringify({ version: SCENES_VERSION, activeSceneId: document.activeSceneId, scenes: document.scenes });
}

/** Storage adapter: quarantine corrupt bytes, persist successful migration,
 * and never write over a future document. The legacy key remains as a backup. */
export function loadSceneDocumentFromStorage(storage) {
	let raw = storage.getItem(SCENES_STORAGE_KEY);
	for (const key of LEGACY_SCENES_STORAGE_KEYS) {
		if (raw) break;
		raw = storage.getItem(key);
	}
	const legacyRaw = raw ? null : storage.getItem(LEGACY_SCENE_STORAGE_KEY);
	const result = readSceneDocument(raw, legacyRaw);
	if (result.status === "corrupt" && result.quarantineRaw !== undefined) {
		storage.setItem(SCENES_QUARANTINE_KEY, result.quarantineRaw);
	}
	if (result.status === "migrated") {
		storage.setItem(SCENES_STORAGE_KEY, serializeSceneDocument(result.document));
	}
	return result;
}
