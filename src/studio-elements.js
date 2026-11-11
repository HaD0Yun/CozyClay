// The authored Studio surface, declared once for future patch, schema and
// history layers. This module is intentionally data-only: it does not import
// React or any persistence implementation. Fields use generic set/read;
// lifecycle and composite elements name the commands that own them.
import { WORLD } from "./world-scale.js";

const freezeBounds = (bounds) => bounds && typeof bounds === "object"
	? Object.freeze({ ...bounds })
	: bounds;

const freezeEntry = (entry) => Object.freeze({
	...entry,
	...(entry.enum ? { enum: Object.freeze([...entry.enum]) } : {}),
	...(entry.actions ? { actions: Object.freeze([...entry.actions]) } : {}),
	...(entry.min && typeof entry.min === "object" ? { min: freezeBounds(entry.min) } : {}),
	...(entry.max && typeof entry.max === "object" ? { max: freezeBounds(entry.max) } : {}),
	...(entry.gizmo ? { gizmo: Object.freeze({ min: freezeBounds(entry.gizmo.min), max: freezeBounds(entry.gizmo.max) }) } : {}),
});

const entries = [
	{ path: "character.position", type: "vec3", persisted: true, undoDomain: "cast", normalizer: "createCharacterEntry", min: { x: -WORLD.position, y: 0, z: -WORLD.position }, max: { x: WORLD.position, y: WORLD.position, z: WORLD.position }, gizmo: { min: { x: -4, y: 0, z: -4 }, max: { x: 4, y: WORLD.position, z: 4 } }, note: "y is the feet" },
	{ path: "character.rot", type: "number", persisted: true, undoDomain: "cast", normalizer: "createCharacterEntry", min: -180, max: 180, angle: true, note: "yaw degrees, wrapped at the upper bound" },
	{ path: "character.scale", type: "number", persisted: true, undoDomain: "cast", normalizer: "createCharacterEntry", min: 0.2, max: 3 },
	{ path: "character.subject", type: "string", persisted: true, undoDomain: "cast", normalizer: "createCharacterEntry" },
	{ path: "character.hidden", type: "boolean", persisted: true, undoDomain: "cast", normalizer: "createCharacterEntry" },
	{ path: "character.parent", type: "id", nullable: true, persisted: true, undoDomain: "cast", normalizer: "createCharacterEntry", note: "scene object id the character is grouped under and rides; null stands in the world" },
	// The model and posture enums mirror scenes.js CHARACTER_KIND_IDS and
	// POSTURES; they are literal because scenes.js imports this module.
	{ path: "character.model", type: "enum", persisted: true, undoDomain: "cast", normalizer: "createCharacterEntry", enum: ["y-bot-tpose", "x-bot-tpose", "proxy-figure"] },
	{ path: "character.posture", type: "enum", persisted: true, undoDomain: "cast", normalizer: "createCharacterEntry", enum: ["stand", "sit", "lie"] },
	{ path: "character.tint", type: "color", persisted: true, undoDomain: "cast", normalizer: "createCharacterEntry" },
	{ path: "character.identityImage", type: "image", persisted: true, undoDomain: "cast", normalizer: "createCharacterEntry", note: "data:image only" },
	{ path: "character.pose", type: "id", persisted: true, undoDomain: "cast", normalizer: "createCharacterEntry" },
	{ path: "character.waypoints", type: "array", persisted: true, undoDomain: "cast", normalizer: "createCharacterEntry", actions: ["character.addWaypoint", "character.moveWaypoint", "character.removeWaypoint", "character.clearWaypoints"], note: "root path pins, addressed by frame" },
	
	{ path: "character.sessionMotion", type: "array", persisted: false, undoDomain: "cast", normalizer: "createCharacterEntry", note: "dropped by createCharacterEntry" },
	{ path: "character.ikKeys", type: "array", persisted: false, undoDomain: "cast", normalizer: "createCharacterEntry", actions: ["character.setIkKey", "character.removeIkKey", "character.clearIkKeys"], note: "dropped by createCharacterEntry; keys travel as JSON quaternions/positions" },
	{ path: "object.renderer", type: "enum", persisted: true, undoDomain: "objects", normalizer: "normalizeSceneObject", enum: ["cube", "sphere", "capsule", "cylinder", "cone", "plane", "empty", "light", "effect", "text"], note: "light is made from catalogue kind point-light or spot-light; effect (smoke, fire, rain, trail...) from kind effect; text (words, a sign, a logo) from kind text" },
	{ path: "object.position", type: "vec3", persisted: true, undoDomain: "objects", normalizer: "normalizeSceneObject", min: { x: -WORLD.position, y: 0, z: -WORLD.position }, max: { x: WORLD.position, y: WORLD.position, z: WORLD.position }, note: "y is the object's base: y=0 rests on the floor; height/supportY rise from it" },
	{ path: "object.rotation", type: "vec3", persisted: true, undoDomain: "objects", normalizer: "normalizeSceneObject", min: { x: -180, y: -180, z: -180 }, max: { x: 180, y: 180, z: 180 }, angle: true, note: "rot/rotX/rotZ degrees, wrapped at the upper bound" },
	{ path: "object.scale", type: "vec3", persisted: true, undoDomain: "objects", normalizer: "normalizeSceneObject", min: { x: 0.01, y: 0.01, z: 0.01 }, max: { x: WORLD.scale, y: WORLD.scale, z: WORLD.scale } },
	{ path: "object.name", type: "string", persisted: true, undoDomain: "objects", normalizer: "normalizeSceneObject" },
	{ path: "object.color", type: "color", persisted: true, undoDomain: "objects", normalizer: "normalizeSceneObject" },
	{ path: "object.opacity", type: "number", persisted: true, undoDomain: "objects", normalizer: "normalizeSceneObject", min: 0.05, max: 1, note: "1 is solid; lower is see-through, e.g. 0.4 for a ghost or water; for a glass object use object.material glass" },
	// The preset names mirror material-presets.js MATERIAL_PRESETS / MATERIAL_FINISHES (test/verify-material-presets.mjs);
	// sparse: a receipt lists them only on a record that has one.
	{ path: "object.material", type: "enum", sparse: true, persisted: true, undoDomain: "objects", normalizer: "normalizeSceneObject", enum: ["clay", "wood", "straw", "stone", "brick", "concrete", "metal", "glass", "ceramic", "plastic", "rubber", "fabric", "paper", "foliage"], note: "cube/sphere/capsule/cylinder/cone/plane only: surface preset with real texture and shine; color stays the tint and a grey (#c2c6c8) object takes the preset's own colour. clay is the default matte look; wood (planks, furniture), straw (thatch, hay, wicker), stone, brick (walls, chimneys), concrete (plaster, pavement), metal (reflects the stage), glass (clear, see-through; tint with color), ceramic (glazed), plastic, rubber (tyres), fabric (cloth, upholstery), paper, foliage (leaves, hedges)" },
	{ path: "object.finish", type: "enum", sparse: true, persisted: true, undoDomain: "objects", normalizer: "normalizeSceneObject", enum: ["matte", "satin", "gloss"], note: "with object.material: overrides the preset's shine, e.g. metal + gloss = chrome, glass + matte = frosted, wood + gloss = varnished" },
	{ path: "object.parent", type: "id", persisted: true, undoDomain: "objects", normalizer: "normalizeSceneObject" },
	{ path: "object.attach", type: "id", persisted: true, undoDomain: "objects", normalizer: "normalizeSceneObject", actions: ["object.attach", "object.detach"], note: "carried by a character's root or bone; channels convert so the prop stays put" },
	{ path: "object.path", type: "array", persisted: true, undoDomain: "objects", normalizer: "normalizeSceneObject" },
	{ path: "object.remove", type: "boolean", persisted: true, undoDomain: "objects", normalizer: null, note: "lifecycle operation, not a document field" },
	{ path: "object.cutout", type: "image", persisted: true, undoDomain: "objects", normalizer: "normalizeSceneObject", actions: ["asset.import"], note: "assetId-backed cutout record; imported pictures and models are placed by asset.import" },
	{ path: "object.light", type: "object", persisted: true, undoDomain: "objects", normalizer: "normalizeSceneObject", note: "renderer light only. { type point|spot, color, intensity 0..1000 candela (lighter 0.45, candle 0.3, desk lamp 5, street lamp 40), range m (0 none), angle 1..89 deg spot half-angle, softness 0..1, shadow (first 2 lights only; inside a solid record it is blocked: receipt LIGHT_BLOCKED), flicker 0..1 (lighter 0.6), aim {x,y,z} world point or null = local -Y }, e.g. { intensity: 40, aim: { x: 0, y: 0, z: 1 } }; a take level track scales it" },
	{ path: "object.glow", type: "object", persisted: true, undoDomain: "objects", normalizer: "normalizeSceneObject", note: "any record: self-lit colour plus additive halo, same under any stage light; casts no shadow, so a light inside a glowing bulb shines out. { color, intensity 0..20, halo 0..4 x the record's radius }, e.g. ember { color: \"#ff5a1f\", intensity: 6, halo: 2 }; null removes; a take level track scales it" },
	{ path: "object.text", type: "object", persisted: true, undoDomain: "objects", normalizer: "normalizeSceneObject", note: "renderer text only: words in one record, e.g. object.add { kind: \"text\", text: { value: \"CozyClay\", size: 0.4 }, placement: { x, y, z, rot } }. { value: the words (up to 200 characters, \\n starts a line), size m height of a capital letter (default 0.3), depth m (0 = flat lettering in any script, default; above 0 = solid letters for Latin, digits and punctuation, and words with other characters stay flat), align left|center|right for several lines }. The record's footprint and height are measured from the words: x is the centre, y the bottom of the lowest line, and the letters face local +z and read toward local +x, so on a side facing +x set rot 90. Flat lettering on a surface: keep it 3 mm or more off the face. color is the letters' colour" },
	{ path: "object.grasp", type: "object", persisted: true, undoDomain: "objects", normalizer: "normalizeSceneObject", note: "grasp sockets: where a hand takes hold of the record, in its own axes (m from the base pivot), moving and saving with it. { <name>: { at: [x,y,z], axis?: [x,y,z] the line across the palm (a bar, a handle), from?: [x,y,z] the side the hand comes from (the palm faces against it), thumb?: [x,y,z] the axis end the thumb takes } }, at most 8; null removes. A motion spec anchor { kind: \"object\", object, socket: <name>, grasp } takes a hand by one; a thin body (a bar, a can, a handle) is a socket of its own, named by its id" },
	{ path: "object.effect", type: "object", persisted: true, undoDomain: "objects", normalizer: "normalizeSceneObject", note: "renderer effect only (object.add kind \"effect\"). { preset: smoke|exhale|steam|fire|sparks|dust|rain|snow|trail, rate particles/s, life s, size m start diameter, grow end/start size, speed m/s along the record's local +Y (rotX 90 aims +Z), spread 0..1 cone, gravity m/s2 (+ falls, - rises), wind {x,y,z} m/s, color, opacity 0..1, additive (emissive: fire, sparks), seed int, area {x,y,z} m birth box (rain/snow/dust fall through it from its top), width m trail ribbon across local Y }. A new preset loads its defaults and fields in the same set override them, e.g. { preset: \"fire\", rate: 40 }; the record stores the merged numbers. Particles are born where the record is at each frame (route, parent, take carry), only while it and its parents are shown, at rate x the take level. To emit from the body (a breath at the mouth), a motion spec entry objects.<id> = { follow: \"landmark:mouth\", aim: \"face\" } moves it there every frame. Measure with inspect_studio { scope: \"entities\", ids }: effect { frame (the playhead), alive, emitter [x,y,z], bounds { min, max } m }" },
	{ path: "stage.keyLight.x", type: "number", persisted: true, undoDomain: "stage", normalizer: "createSceneStage", min: -30, max: 30 },
	{ path: "stage.keyLight.y", type: "number", persisted: true, undoDomain: "stage", normalizer: "createSceneStage", min: 0.5, max: 30 },
	{ path: "stage.keyLight.z", type: "number", persisted: true, undoDomain: "stage", normalizer: "createSceneStage", min: -30, max: 30 },
	{ path: "stage.keyLight.intensity", type: "number", persisted: true, undoDomain: "stage", normalizer: "createSceneStage", min: 0, max: 4 },
	{ path: "stage.keyLight.warmth", type: "number", persisted: true, undoDomain: "stage", normalizer: "createSceneStage", min: 0, max: 1 },
	{ path: "stage.environmentImage", type: "image", persisted: true, undoDomain: "stage", normalizer: "createSceneStage", note: "data:image only" },
	{ path: "stage.environment", type: "string", persisted: true, undoDomain: "stage", normalizer: "createSceneStage", note: "location description every shot prompt is built from" },
	{ path: "stage.style", type: "string", persisted: true, undoDomain: "stage", normalizer: "createSceneStage", note: "look / style line for shot prompts" },
	{ path: "stage.hasEnvSheet", type: "boolean", persisted: true, undoDomain: "stage", normalizer: "createSceneStage", note: "author supplies an environment sheet instead of a description" },
	{ path: "stage.camera", documentPath: "shotAspect", type: "enum", persisted: true, undoDomain: "stage", normalizer: "createSceneStage", enum: ["16:9", "2.39:1", "9:16", "1:1", "4:3", "12:7", "fal 480P"], note: "output aspect ratio" },
	{ path: "stage.cameraPresetId", type: "id", nullable: true, persisted: true, undoDomain: "stage", normalizer: "createSceneStage" },
	{ path: "stage.sensorId", type: "enum", persisted: true, undoDomain: "stage", normalizer: "createSceneStage", enum: ["super16", "super35", "fullFrame", "65mm"] },
	// The stage look (src/stage-lighting.js). stage.applyLighting writes all of it from a recipe; each field stays tweakable.
	{ path: "stage.keyLight.color", type: "color", nullable: true, persisted: true, undoDomain: "stage", normalizer: "createSceneStage", note: "key light colour #rrggbb, overrides warmth, e.g. \"#9db6e6\" cool moonlight or \"#ffad5c\" low sun; null = white tinted by warmth" },
	{ path: "stage.lighting.preset", type: "enum", persisted: true, readOnly: true, undoDomain: "stage", normalizer: "createSceneStage", enum: ["studio", "day", "overcast", "golden", "dusk", "night", "interior", "stage"], note: "label of the last recipe stage.applyLighting applied; studio is the neutral grey default" },
	{ path: "stage.lighting.sky", type: "color", nullable: true, persisted: true, undoDomain: "stage", normalizer: "createSceneStage", note: "background and fog colour at the horizon, e.g. \"#0b1426\" night; null = the UI theme's studio grey" },
	{ path: "stage.lighting.skyTop", type: "color", nullable: true, persisted: true, undoDomain: "stage", normalizer: "createSceneStage", note: "sky colour overhead: shot camera and exports grade from sky at the horizon to this, e.g. \"#020408\"; null = flat sky" },
	{ path: "stage.lighting.ambient", type: "number", persisted: true, undoDomain: "stage", normalizer: "createSceneStage", min: 0, max: 3, note: "multiplier on the hemisphere and ambient light; 1 = studio, 0.6 = night, 0 = black stage" },
	{ path: "stage.lighting.hemiSky", type: "color", persisted: true, undoDomain: "stage", normalizer: "createSceneStage", note: "hemisphere light from above, e.g. \"#34507f\" cool night sky; studio \"#ffffff\"" },
	{ path: "stage.lighting.hemiGround", type: "color", persisted: true, undoDomain: "stage", normalizer: "createSceneStage", note: "hemisphere bounce from below, e.g. \"#6e5136\" warm ground; studio \"#5a5d64\"" },
	{ path: "stage.lighting.fill", type: "number", persisted: true, undoDomain: "stage", normalizer: "createSceneStage", min: 0, max: 3, note: "multiplier on the fixed fill and rim lights; 1 = studio, 0 = key only" },
	{ path: "stage.lighting.fog", type: "number", persisted: true, undoDomain: "stage", normalizer: "createSceneStage", min: 0, max: 1, note: "haze 0..1 fading the set into the sky colour: 0 = far horizon only, 0.45 = from ~18 m to ~38 m, 1 = from 2 m to 14 m" },
	{ path: "stage.lighting.exposure", type: "number", persisted: true, undoDomain: "stage", normalizer: "createSceneStage", min: 0.2, max: 3, note: "camera exposure multiplier on lit surfaces; 1 = studio, e.g. 1.4 to lift a dark frame" },
	{ path: "stage.lighting.shadowSoftness", type: "number", persisted: true, undoDomain: "stage", normalizer: "createSceneStage", min: 0, max: 1, note: "key shadow penumbra; 0 = crisp (studio), 0.75 = soft moonlight, 1 = overcast" },
	{ path: "stage.lighting.envLight", type: "number", persisted: true, undoDomain: "stage", normalizer: "createSceneStage", min: 0, max: 2, note: "sky environment light on every surface: a map from sky, skyTop, hemiGround and a glow toward the key (sun or moon) tints and fills clay from all sides; it takes over the flat hemisphere as it rises. 0 = hemisphere only (studio), 1 = the map alone at the same brightness (every other recipe), e.g. 1.4 for a brighter fill" },
	{ path: "stage.lighting.ao", type: "number", persisted: true, undoDomain: "stage", normalizer: "createSceneStage", min: 0, max: 1, note: "ambient occlusion strength: contact darkening within ~0.5 m where a body meets the floor or a prop and in creases (armpits, the back of a squat's knees), in the viewport and every export. 0 = off (studio), 0.8 = most recipes, 1 = overcast" },
	// An HDR environment map (src/stage-hdr.js): the light and, with hdrBackground, the backdrop.
	{ path: "stage.lighting.hdr", type: "id", nullable: true, persisted: true, undoDomain: "stage", normalizer: "createSceneStage", note: "HDR environment map that replaces the sky environment light: a built-in (\"builtin:night-street\", \"builtin:overcast-field\", \"builtin:studio-softbox\") or a file the user loaded (\"hdr-<32 hex>\"); inspect_studio { scope: \"catalogue\" } environments lists them with each map's brightest direction. It lights the set only while envLight > 0 (its light = map x hdrIntensity x envLight; studio has envLight 0, so set envLight 1). stage.applyLighting clears it unless keep has \"lighting.hdr\". null = the look's own sky" },
	{ path: "stage.lighting.hdrRotation", type: "number", persisted: true, undoDomain: "stage", normalizer: "createSceneStage", min: -180, max: 180, angle: true, note: "degrees the HDR map turns about the vertical axis, light and backdrop together: +90 carries a light at +x (screen right from the default camera) to -z (behind the subject), so a brightest [x, y, z] lands at [x cos r + z sin r, y, z cos r - x sin r]; wrapped at the upper bound" },
	{ path: "stage.lighting.hdrIntensity", type: "number", persisted: true, undoDomain: "stage", normalizer: "createSceneStage", min: 0, max: 4, note: "multiplier on the HDR map's radiance in its light and its backdrop; 1 = the file as authored, e.g. 0.5 to calm a bright daylight map" },
	{ path: "stage.lighting.hdrBackground", type: "boolean", persisted: true, undoDomain: "stage", normalizer: "createSceneStage", note: "true = the HDR map is the backdrop behind the set (the floor fades into its horizon), in the viewport, shot and every export; false = keep the look's sky as the backdrop and use the map only as light" },
	{ path: "shot.crud", type: "array", persisted: true, undoDomain: "shot", normalizer: null, actions: ["shot.create", "shot.split", "shot.duplicate", "shot.remove", "shot.setRange", "shot.reorder"], note: "create/split/duplicate/reorder/remove/range through the shared action registry" },
	{ path: "shot.cameraKeys", type: "array", persisted: true, undoDomain: "shot", normalizer: null, frameMin: 0 },
	{ path: "shot.cameraRail", type: "array", persisted: true, undoDomain: "shot", normalizer: "repairCamera", actions: ["shot.setCameraRail", "shot.clearCameraRail"], note: "rail points; crane/dolly timing follow the shot's camera block" },
	{ path: "shot.targetModel", type: "id", persisted: true, undoDomain: "shot", normalizer: "repairCamera" },
	{ path: "shot.kind", type: "enum", persisted: true, undoDomain: "shot", normalizer: null, readOnly: true, enum: ["clip", "still"], note: "clip or still; a still holds one picture for endFrame - startFrame + 1 frames" },
	{ path: "shot.caption", type: "string", persisted: true, undoDomain: "shot", normalizer: null, readOnly: true, note: "trimmed, at most 500 characters" },
	{ path: "shot.cast", type: "array", persisted: true, undoDomain: "shot", normalizer: null, readOnly: true, note: "per-shot placement overrides keyed by character id: { x, z, rot, posture?, pose? }" },
	{ path: "shot.stylizedAssetId", type: "id", nullable: true, persisted: true, undoDomain: "shot", normalizer: null, readOnly: true, note: "image asset id only" },
	{ path: "shot.freeCamera", type: "vec3", persisted: false, undoDomain: "shot", normalizer: null, note: "transient until keyed" },
	{ path: "scenes", type: "array", persisted: true, undoDomain: null, normalizer: null, actions: ["scene.create", "scene.duplicate", "scene.rename", "scene.delete", "scene.switch"], note: "the project's scene list and the open scene; outside the undo history" },
	{ path: "project", type: "string", persisted: true, undoDomain: null, normalizer: null, actions: ["project.save"], note: "save to the current project file; opening one needs the user's file picker" },
	{ path: "selection", type: "id", persisted: false, undoDomain: null, normalizer: null },
	{ path: "timeline", type: "number", persisted: false, undoDomain: null, normalizer: null },
	{ path: "view.mode", type: "enum", persisted: false, undoDomain: null, normalizer: null, enum: ["scene", "pose", "camera", "motion"] },
	{ path: "view.partColoursGuideModeInset", type: "array", persisted: false, undoDomain: null, normalizer: null, actions: ["view.setPartColours", "view.setGuideMode", "view.setInset", "view.setGhosts"], note: "partColours/guideMode/inset/ghosts; viewer settings, not document fields" },
	{ path: "read.sceneDescription", type: "string", persisted: false, undoDomain: null, normalizer: null },
	{ path: "read.captureFrame", type: "image", persisted: false, undoDomain: null, normalizer: null },
	{ path: "undo", type: "boolean", persisted: false, undoDomain: null, normalizer: null },
];

export const STUDIO_ELEMENTS = Object.freeze(entries.map(freezeEntry));

export function elementByPath(path) {
	return STUDIO_ELEMENTS.find((entry) => entry.path === path);
}

export function elementsFor(normalizer) {
	return STUDIO_ELEMENTS.filter((entry) => entry.normalizer === normalizer);
}

// One writable vocabulary for UI and agent commands, not a second allowlist.
export const isSettableElement = element => element.persisted !== false && !element.actions && !element.readOnly;
