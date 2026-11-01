// One Studio action registry for the editor UI and the agent. The
// declarations below are data shared with the sidecar (ids, descriptions,
// input schemas, kinds); the editor registers ONE implementation per id, and
// both its UI controls and the agent's `run_action` family call
// `registry.run(id, args)`. No React, renderer or Node imports.
import { StudioProtocolError, StudioSchemas, freezeStudioData, validateStudioSchema } from "./studio-agent-protocol.js";

/** mutation: authored, undoable, answered with a journal receipt.
 * transient: view state only. job: long-running work (a generation, an
 * export); it answers "started", or "completed" with its output when it runs
 * to its end. A job that needs longer than the hub's 30 s default declares
 * `timeoutMs` (at most the hub's 300 s ceiling); one that starts a motion
 * generation declares `generation: "motion"`, the agent's one per message.
 * document: project-level work outside the undo history (scenes, the project
 * file); it answers "completed", with the new host when the open scene moved. */
export const STUDIO_ACTION_KINDS = freezeStudioData(["mutation", "transient", "job", "document"]);

const idSchema = StudioSchemas.TargetGuard.properties.targetId;
const frame = { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
const input = (required = {}, optional = {}) => ({ type: "object", properties: { ...required, ...optional }, required: Object.keys(required), additionalProperties: false });
const shotId = { shotId: idSchema };
const sceneId = { sceneId: idSchema };
const NOT_UNDOABLE = "Scenes are outside the undo history: undo_edit and Ctrl+Z cannot revert this.";
const SCENE_MOVES = "The open scene changes, so later commands in this message are admitted in it; the receipt's host names it.";
const characterId = { characterId: idSchema };
const castOverride = {
	type: "object",
	properties: {
		x: { type: "number" },
		z: { type: "number" },
		rot: { type: "number" },
		posture: { type: "string", enum: ["stand", "sit", "lie"] },
		pose: { type: "object", properties: {}, required: [], additionalProperties: true },
	},
	required: [],
	additionalProperties: false,
};
/** A world floor point in metres; y is the floor. */
const floorPoint = input({ x: { type: "number" }, z: { type: "number" } });
const worldPoint = input({ x: { type: "number" }, y: { type: "number" }, z: { type: "number" } });
const waypointFrame = { ...frame, minimum: 1 };
/** The tracks an IK key stores (src/motion/ik.js IK_TRACKS and FK_TRACKS). A
 * chain track keys its three bones (upper, lower, end); a joint track one. */
export const STUDIO_IK_CHAIN_TRACKS = freezeStudioData(["leftHand", "rightHand", "leftFoot", "rightFoot"]);
export const STUDIO_IK_JOINT_TRACKS = freezeStudioData(["hips", "spine", "chest", "neck", "head", "leftShoulder", "rightShoulder",
	...["left", "right"].flatMap(side => ["Thumb", "Index", "Middle", "Ring", "Pinky"].flatMap(finger => [1, 2, 3].map(joint => `${side}${finger}${joint}`)))]);
const num = { type: "number" };
const perBone = items => ({ type: "array", items, minItems: 1, maxItems: 3 });
const quaternion = input({ x: num, y: num, z: num, w: num });
/** One track's key: the IK state's { q, p, baseQ, basePos, chainP,
 * keepTranslations, blend, pin, correctionRange } with quaternions as {x,y,z,w} and positions
 * as {x,y,z}; blend is the key's own correction range in frames (src/motion/ik.js
 * correctionWeight), absent for the editor's default range; pin is the id of
 * the range pin that baked the key (src/motion/range-pin.js). correctionRange
 * pairs the boundary keys of an explicitly selected interval. */
const ikTrackKey = input({}, { q: perBone(quaternion), p: StudioSchemas.Vec3, baseQ: perBone(quaternion), basePos: StudioSchemas.Vec3,
	chainP: perBone(StudioSchemas.Vec3), keepTranslations: { type: "boolean" }, blend: { type: "integer", minimum: 1, maximum: 240 },
	correctionRange: input({ start: frame, end: frame }),
	pin: { type: "string", minLength: 1, maxLength: 64 } });
// placement: the whole character's world spot in Pose mode, p = { x, y: yaw in degrees, z } (src/motion/placement-keys.js)
const ikTracks = input({}, { ...Object.fromEntries([...STUDIO_IK_CHAIN_TRACKS, ...STUDIO_IK_JOINT_TRACKS].map(track => [track, ikTrackKey])), placement: input({ p: StudioSchemas.Vec3 }) });
/** The bones an object can ride (src/scene-objects.js SCENE_ATTACH_BONES). */
export const STUDIO_ATTACH_BONES = freezeStudioData(["hips", "spine", "chest", "neck", "head", "leftShoulder", "leftElbow", "leftHand",
	"rightShoulder", "rightElbow", "rightHand", "leftKnee", "leftFoot", "rightKnee", "rightFoot"]);
/** The shot frame's composition guides (src/shot-guides.js GUIDE_MODES). */
const GUIDE_MODES = freezeStudioData(["off", "thirds", "golden", "center", "safe"]);
/** The image models the Studio writes Send-to-AI prompts for (src/shot.js IMAGE_MODELS). */
const AI_IMAGE_MODELS = freezeStudioData(["nano_banana_pro", "nano_banana_2", "gpt_image_2", "seedream_5", "flux_2"]);
const stillHold = { type: "integer", minimum: 1, maximum: 240 };
const stillIndex = { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
const STORYBOARD_CAP = "Refused when the stills would run past the 28800-frame timeline.";
const WAYPOINT_RULES = "Pins sit at least 8 frames apart, the walk between two pins must stay within 0.5-3 m/s, and x/z are clamped to +/-11 m; a pin that breaks a rule is refused with the frame or distance that would work.";

export const STUDIO_ACTIONS = freezeStudioData([
	{ id: "shot.create", label: "Add shot", kind: "mutation", undoDomain: "shot", input: input(),
		description: "Add a new shot at the playhead, keyed with the current camera framing (the timeline's + Add shot). Move the playhead first with operate_studio { frame }. When the playhead is inside a shot, the new one goes in the next free gap. In a storyboard project it adds a still instead, exactly like shot.createStill with no arguments." },
	{ id: "shot.createStill", label: "Add still", kind: "mutation", undoDomain: "shot", input: input({}, { caption: { type: "string", maxLength: 500 }, hold: stillHold }),
		description: `Add a still (a storyboard panel: one picture held for hold frames at 24 fps, default 48, 1-240) after the last still, keyed with the current camera framing. Stills sit end to end from frame 0 in order. ${STORYBOARD_CAP}` },
	{ id: "shot.setCaption", label: "Set shot caption", kind: "mutation", undoDomain: "shot", input: input({ ...shotId, caption: { type: "string", maxLength: 500 } }),
		description: "Set a shot's caption (the panel's action or dialogue line), trimmed, at most 500 characters; an empty caption clears it." },
	{ id: "shot.setCastOverride", label: "Set shot cast override", kind: "mutation", undoDomain: "shot",
		input: input({ ...shotId, ...characterId, override: { oneOf: [castOverride, { type: "null" }] } }),
		description: "Set or clear one character's placement and pose override for a shot. Overrides apply only when the character has no installed take; a root path still wins." },
	{ id: "shot.setHold", label: "Set still hold", kind: "mutation", undoDomain: "shot", input: input({ ...shotId, hold: stillHold }),
		description: `Set how many frames (1-240 at 24 fps) a still holds; the stills after it move so they stay end to end. Stills only. ${STORYBOARD_CAP}` },
	{ id: "shot.split", label: "Split shot", kind: "mutation", undoDomain: "shot", input: input(shotId),
		description: "Cut a shot in two at the playhead. The playhead must be inside that shot, after its first frame; the second half starts at the playhead." },
	{ id: "shot.duplicate", label: "Duplicate shot", kind: "mutation", undoDomain: "shot", input: input(shotId),
		description: "Copy a shot, its camera, keys, caption, per-shot cast and stylized image. A still's copy goes right after it and the stills after it move along; a clip's copy goes into the next free gap on the timeline." },
	{ id: "shot.remove", label: "Delete shot", kind: "mutation", undoDomain: "shot", input: input(shotId),
		description: "Delete a shot and leave its frames as free-camera time." },
	{ id: "shot.setRange", label: "Set shot range", kind: "mutation", undoDomain: "shot", input: input({ ...shotId, range: StudioSchemas.FrameRange }),
		description: "Move a shot's start and end to a half-open frame range, e.g. { shotId, range: { startFrame: 0, endFrameExclusive: 240 } } for frames 0-239. range: [0, 240] ([start, endExclusive]) and flat { shotId, startFrame: 0, endFrameExclusive: 240 } are taken as the same range. Edges are clamped to the timeline and refused where they would overlap another shot; the receipt's summary shows the range that landed (\"Set shot range: Shot 1 [0, 240).\")." },
	{ id: "shot.reorder", label: "Move shot", kind: "mutation", undoDomain: "shot",
		input: input(shotId, { startFrame: frame, index: stillIndex }),
		description: "Move a shot; give exactly one of startFrame or index. With startFrame, a clip moves in time to start there, keeping its length and camera keys (a noop where it would overlap another shot), and a still moves to the place in the still order that frame falls in. With index (stills only), the still moves to that position among the stills (0 is first; past the end means last). Stills stay end to end from frame 0." },
	{ id: "character.addWaypoint", label: "Add root waypoint", kind: "mutation", undoDomain: "cast", input: input({ ...characterId, position: floorPoint }, { frame: waypointFrame }),
		description: `Pin a character's root path: at frame, the character's root stands at position (world x/z metres). Frame 0 is the character's own spot, so pins start at frame 1 and each frame holds one pin. Omit frame to pace the pin at a walk (1.4 m/s) from the previous one. ${WAYPOINT_RULES} Read paths with inspect_studio { scope: "motion" }.` },
	{ id: "character.move", label: "Move character", kind: "mutation", undoDomain: "cast", input: input(characterId, { x: num, z: num, rot: num }),
		description: "Move a character's stage placement. Inside a still this writes that panel's cast override; outside a still it changes the stage record." },
	{ id: "character.moveWaypoint", label: "Move root waypoint", kind: "mutation", undoDomain: "cast", input: input({ ...characterId, frame: waypointFrame, position: floorPoint }),
		description: `Move the character's root waypoint at frame to a new floor position (world x/z metres), keeping its frame. ${WAYPOINT_RULES}` },
	{ id: "character.removeWaypoint", label: "Remove root waypoint", kind: "mutation", undoDomain: "cast", input: input({ ...characterId, frame: waypointFrame }),
		description: "Remove the character's root waypoint at frame." },
	{ id: "character.clearWaypoints", label: "Clear root path", kind: "mutation", undoDomain: "cast", input: input(characterId),
		description: "Remove every root waypoint of the character, leaving its motion unconstrained by a path." },
	{ id: "character.setIkKey", label: "Set IK key", kind: "mutation", undoDomain: "motion", input: input({ ...characterId, frame, tracks: ikTracks }),
		description: "Key a character's IK correction layer at frame, the same key a pose drag bakes. tracks maps a track id to its key: q is the bones' LOCAL rotations as unit quaternions {x,y,z,w}, three for a chain track (leftHand, rightHand, leftFoot, rightFoot: upper, lower and end bone) and one for a joint track (hips, spine, chest, neck, head, leftShoulder, rightShoulder, and the finger bones <side><Thumb|Index|Middle|Ring|Pinky><1-3>, e.g. leftIndex2); p is a joint's local position {x,y,z} (the hips' height and lean). Optional baseQ/basePos give the take's own pose the key was made over, so it applies as a delta on the take; chainP gives a chain's three local bone positions; keepTranslations keeps them over the take's; blend (frames, 1-240) is how far this key's correction eases into the take around it, 6 when omitted; pin (1-64 characters) tags the key as baked by that range pin. A key needs q or p. Each named track replaces its key at frame and starts evaluating; other tracks at that frame stay. Keyed frames are in inspect_studio { scope: \"motion\" } ikKeyFrames." },
	{ id: "character.removeIkKey", label: "Delete IK key", kind: "mutation", undoDomain: "motion", input: input({ ...characterId, frame }),
		description: "Delete the character's whole IK key at frame (every track keyed there), like the Full-Body lane's delete." },
	{ id: "character.clearIkKeys", label: "Clear IK keys", kind: "mutation", undoDomain: "motion", input: input(characterId),
		description: "Delete every IK key of the character, returning it to its take or pose without corrections." },
	{ id: "shot.setCameraRail", label: "Set camera rail", kind: "mutation", undoDomain: "shot",
		input: input({ ...shotId, points: { type: "array", items: floorPoint, minItems: 2, maxItems: 512 } }, { height: { oneOf: [{ type: "number", minimum: 0.1, maximum: 30 }, { type: "array", items: input({ t: { type: "number", minimum: 0, maximum: 1 }, height: { type: "number", minimum: 0.1, maximum: 30 } }), minItems: 2, maxItems: 8 }] }, aim: { oneOf: [{ type: "array", items: idSchema, minItems: 1, maxItems: 4 }, input({ x: num, y: num, z: num }), { type: "null" }] }, aimHeight: { type: "number", minimum: 0, maximum: 30 }, focalMm: { oneOf: [{ type: "number", minimum: 10, maximum: 300 }, { type: "null" }] } }),
		description: "Lay a shot's dolly rail through points (world floor x/z metres, in travel order) and put the shot's camera on it, like drawing the rail in the Top-View: the camera runs the rail at an even speed over the whole shot (or its authored rail-follow range), so a push-in, pull-out, orbit, track or crane is one call with 2-6 points (a line, or an arc through a few points; the rail is a smooth curve through them). height is the lens height in metres, one number or crane marks [{ t: 0..1 along the rail, height }] (default the follow height, 1.6). aim is what the camera holds: up to 4 character or object ids (their middle, frame by frame: a character's chest, an object's middle) or a world point { x, y, z }; without an aim it follows the scene's first character. aimHeight puts a cast aim at that world height instead of the chest, e.g. 0.9 to hold a whole standing body, 1.6 for faces. focalMm is the shot's lens (default the scene lens). It replaces any rail the shot had and keeps any height, aim or lens you leave out (null clears aim and lens), and it removes the camera keys the rail covers. Answers the rail's length, speed, height, aim and lens; check the framing with verify_result { targets, checks: [\"framing\"], range: the shot's frames } and a contact sheet. Read rails with inspect_studio { scope: \"shot\" }." },
	{ id: "shot.clearCameraRail", label: "Delete camera rail", kind: "mutation", undoDomain: "shot", input: input(shotId),
		description: "Delete a shot's camera rail; the shot's camera goes back to following its subject at the current distance." },
	{ id: "shot.setCameraMode", label: "Set shot camera mode", kind: "mutation", undoDomain: "shot", input: input({ ...shotId, mode: { type: "string", enum: ["keys", "follow", "rail"] } }),
		description: "Set how a shot's camera moves: keys plays the shot's camera keys (frame_shot frames them; one framing holds the whole shot), follow keeps the captured distance from the subject, rail rides the shot's rail (lay one first with shot.setCameraRail). Deleting a rail leaves follow; set keys to hold a framed camera instead." },
	{ id: "shot.rename", label: "Rename shot", kind: "mutation", undoDomain: "shot", input: input({ ...shotId, name: { type: "string", maxLength: 240 } }),
		description: "Rename a shot: its label on the timeline and in shot lists." },
	{ id: "object.attach", label: "Attach to character", kind: "mutation", undoDomain: "objects",
		input: input({ objectId: idSchema, ...characterId }, { bone: { type: "string", enum: STUDIO_ATTACH_BONES } }),
		description: "Make a scene object ride a character, like dropping it on the character's Hierarchy row: on one bone (a cup in the right hand: bone \"rightHand\") or, with bone omitted, on the character's animated root so it travels with the body. The object keeps its place on screen: its position, rotation and scale are rewritten into the new frame (local to that bone while attached), and it leaves any group. Needs the character's rig on stage." },
	{ id: "object.detach", label: "Detach object", kind: "mutation", undoDomain: "objects", input: input({ objectId: idSchema }),
		description: "Put an attached or grouped object back in the world where it is now, like the Inspector's Detach or dropping it on the Props row: it stops following the character, keeps its current world placement and leaves any group." },
	{ id: "view.setPartColours", label: "Part colours", kind: "transient", input: input({ mode: { type: "string", enum: ["off", "flat", "shaded"] } }),
		description: "Paint the characters in stable per-body-part colours (the View menu's Part colours): flat colours, shaded colours that keep the surface lighting (the look motion reading from a frame needs), or off. A viewer setting: never saved in the scene or undone." },
	{ id: "view.setGuideMode", label: "Composition guides", kind: "transient", input: input({ mode: { type: "string", enum: GUIDE_MODES } }),
		description: "Show a composition guide over the shot frame: rule of thirds, golden ratio, center cross, safe areas, or off. Overlay only, never in exported pixels; a viewer setting that is never undone." },
	{ id: "view.setInset", label: "Top-View inset", kind: "transient", input: input({ collapsed: { type: "boolean" } }),
		description: "Fold (collapsed: true) or unfold the Top-View inset pane over the viewport. A viewer setting that is never undone." },
	{ id: "view.setGhosts", label: "Ghosts", kind: "transient", input: input({ mode: { type: "string", enum: ["off", "step", "keys"] } }, { count: { type: "integer", minimum: 1, maximum: 6 }, step: { type: "integer", minimum: 1, maximum: 24 } }),
		description: "Onion skin in the editor viewport, like the View menu's Ghosts: translucent poses of the active character's installed take, count (1-6, default 3) before the playhead in blue and as many after it in orange, fading with distance in time; props the take carries (a kit's bat) ghost with the body. mode step spaces them every step frames (1-24, default 4), keys puts them on the spec's key frames, off hides them; e.g. { mode: \"step\", count: 3, step: 4 }. An editor overlay: never in capture_frame, exports or contact sheets (verify_result ghosts: true draws them on a views sheet). A viewer setting: never saved or undone." },
	{ id: "view.frame", label: "Move editor view", kind: "transient", input: input({ position: worldPoint, lookAt: worldPoint }),
		description: "Move the editor view the user is looking at (world metres) and leave Look Through, so they see what you point at. The shot camera, its keys and the export do not change (frame_shot frames those). A viewer setting that is never undone." },
	{ id: "export.shotVideo", exposure: "confirm", confirmationReason: "Exporting writes a video file outside the Studio.", label: "Export video (mp4)", kind: "job", timeoutMs: 300_000, input: input({}, { ...shotId, scope: { type: "string", enum: ["timeline", "shot"], description: "timeline: the whole timeline, every shot back to back; shot: one shot (shotId, or the one under the playhead)." } }),
		description: "Record a shot to an MP4 (camera move and character motion, no editor chrome), like the Export menu's Video (mp4), and hand it to the configured export folder or, when none is usable, the browser download. With shotId it records that shot's own range; without it, what the menu records: the whole take when there is motion, else the shot under the playhead (else the first shot), keyed from the current camera if it has no keys. Waits until the file is encoded (up to 5 minutes) and answers status \"completed\" with output.fileName and output.frameCount. One export at a time; not a motion generation." },
	{ id: "scene.create", label: "New scene", kind: "document", input: input(),
		description: `Add an empty scene (named SCENE 01, SCENE 02, ...) after the others and open it, like the scene menu's New scene. ${SCENE_MOVES} ${NOT_UNDOABLE}` },
	{ id: "scene.duplicate", label: "Duplicate scene", kind: "document", input: input(sceneId),
		description: `Copy a scene (objects, shots, cast and stage) right after it and open the copy, like the Hierarchy scene menu's Duplicate. ${SCENE_MOVES} ${NOT_UNDOABLE}` },
	{ id: "scene.rename", label: "Rename scene", kind: "document", input: input({ ...sceneId, name: { type: "string", minLength: 1, maxLength: 240 } }),
		description: `Rename a scene; a name another scene already has gets a number. ${NOT_UNDOABLE}` },
	{ id: "scene.delete", exposure: "confirm", confirmationReason: "Deleting a scene cannot be undone.", label: "Delete scene", kind: "document", input: input(sceneId),
		description: `Delete a scene and everything in it, like the Hierarchy scene menu's Delete; delete only a scene the user asked to delete. The last scene cannot be deleted. Deleting the open scene opens its neighbour. ${SCENE_MOVES} ${NOT_UNDOABLE}` },
	{ id: "scene.switch", label: "Open scene", kind: "document", input: input(sceneId),
		description: `Open another scene of the project, like the scene pill's menu; the scene being left keeps its state. ${SCENE_MOVES}` },
	{ id: "project.save", exposure: "confirm", confirmationReason: "Saving may overwrite a file or open a file picker.", label: "Save project", kind: "document", input: input(),
		description: "Save the whole project to its current file, like the Project menu's Save Project, and answer status \"completed\" with output.fileName. A browser file picker opens only from the user's own click, so it is refused, with the reason, when the project has no file yet this session or the browser must re-grant access to it; ask the user to press Save Project once. An unnamed project opens the Save dialog for the user to name it. Browsers without file access download the project file instead." },
	{ id: "project.exportAsAnimation", exposure: "confirm", confirmationReason: "Exporting writes an animation project file outside the Studio.", label: "Export as Animation project", kind: "document", input: input(),
		description: "Export the current storyboard as a new Animation project file, leaving the storyboard open and unchanged. Still shots become clip shots with their ranges, camera keys, captions, cast overrides and stylized asset references preserved. The browser asks where to save the new .cclayproject or downloads it when file access is unavailable." },
	{ id: "asset.import", label: "Import asset", kind: "mutation", undoDomain: "objects",
		input: input({ source: { type: "string", minLength: 1, maxLength: 8_000_000, pattern: "^(data:|https?://)" }, name: { type: "string", minLength: 1, maxLength: 120 },
			placeAs: { type: "string", enum: ["cutout", "backdrop", "mesh"] } }),
		description: "Import a picture or a 3D model into the scene through the editor's own import path and place it: \"cutout\" stands a picture up as a 1.8 m card in front of the camera, \"backdrop\" as a 5 m plate 12 m down the shot camera's view, facing it, and \"mesh\" stands a GLB, OBJ or FBX model on the floor in front of the camera. source is a data: URL (up to 8 MB of text) or an http(s) URL the editor fetches (its server must allow cross-origin reads); name is the file name with its extension (poster.png, chair.glb). One undo entry; the new object is in affectedIds and its asset id in the summary. A file on the user's disk needs their own click: ask them to drop it on the Assets shelf." },
	{ id: "object.duplicate", label: "Duplicate object", kind: "mutation", undoDomain: "objects", input: input({}, { objectId: idSchema }),
		description: "Copy a scene object (the selected one when objectId is omitted) and place the copy half a metre beside it." },
	{ id: "ai.prepareShot", label: "Send to AI", kind: "job", input: input({}, { mode: { type: "string", enum: ["image", "video"] }, model: { type: "string", enum: AI_IMAGE_MODELS } }),
		description: "Prepare the Studio's Send-to-AI package for the shot under the playhead (else the current camera): the prompt for an external image or video model, written from the shot's camera, cast, poses, environment and style, plus reference frames rendered from the shot camera (its first and last camera key when it has keys). No AI service is called. mode \"image\" is a still, \"video\" a shot with its camera move; model is the image model the prompt is written for (image mode only). Each omitted choice keeps the Studio's current one; a given one becomes it. The Studio opens its result panel, where the user copies the prompt and exports the frames to the configured export folder or browser downloads; the frame images stay there and are not in the answer. Answers status \"completed\" with output.prompt, mode, modelLabel, shot (id, name, range), aspectRatio, cameraMode and referenceFrames (how many frames the panel shows). Changes nothing in the scene; not a motion generation." },
	// The instruction leads the H3 prompt, which the motion API caps at 4000
	// characters with its camera-lock text (about 225) appended.
]);
export const STUDIO_ACTION_IDS = freezeStudioData(STUDIO_ACTIONS.map(action => action.id));

const fail = (code, message) => { throw new StudioProtocolError(code, message); };

/** A refusal an editor control can also meet. `message` is written for the
 * model; `uiMessage` is the localized text the editor's UI door shows a
 * person. A refusal without one stays silent in the UI. */
export function studioActionRefusal(code, message, uiMessage) {
	return Object.assign(new StudioProtocolError(code, message), { uiMessage });
}
// A localized toast producer is evaluated twice, without showing it twice:
// once for the existing UI and once in English for command evidence.
export function resolveStudioToast(value, isKo, ko, isZh = false) {
	return typeof value === "function" ? { uiMessage: value(isKo, ko, isZh), message: value(false, en => en, false) } : { uiMessage: value, message: value };
}
const unknown = (id, known) => fail("INVALID_ARGUMENT", `Unknown Studio action "${id}". Known actions: ${known.join(", ")}. List them with inspect_studio { scope: "actions" }.`);

export function studioActionDeclaration(id) {
	return STUDIO_ACTIONS.find(action => action.id === id) ?? unknown(id, STUDIO_ACTION_IDS);
}

/** `readState` is the editor's current action state; when it is supplied,
 * run() refuses an unavailable action with its reason before anything runs. */
export function createStudioActionRegistry({ readState } = {}) {
	const entries = new Map();
	const availability = (entry, state) => {
		const verdict = entry.available(state);
		if (verdict !== true && (typeof verdict !== "string" || !verdict.trim())) throw new Error(`Studio action ${entry.id} must answer availability with true or a reason.`);
		return verdict;
	};
	const settled = (id, result) => {
		if (!Array.isArray(result?.affectedIds) || result.affectedIds.some(value => typeof value !== "string") || typeof result.summary !== "string") {
			throw new Error(`Studio action ${id} must return { affectedIds, summary }.`);
		}
		return { affectedIds: [...result.affectedIds], summary: result.summary, ...(result.output === undefined ? {} : { output: structuredClone(result.output) }),
			// What the command measured and what it found wrong; the bus puts both on the receipt.
			...(result.checks === undefined ? {} : { checks: structuredClone(result.checks) }), ...(result.warnings?.length ? { warnings: structuredClone(result.warnings) } : {}) };
	};
	const registry = {
		register(entry) {
			if (typeof entry?.id !== "string" || !new RegExp(idSchema.pattern).test(entry.id)) throw new Error("A Studio action needs an id.");
			if (entries.has(entry.id)) throw new Error(`Studio action ${entry.id} is already registered.`);
			if (!STUDIO_ACTION_KINDS.includes(entry.kind)) throw new Error(`Studio action ${entry.id} has an unknown kind.`);
			if (entry.input?.type !== "object" || !entry.input.properties || !Array.isArray(entry.input.required)) throw new Error(`Studio action ${entry.id} needs an object input schema.`);
			if (typeof entry.available !== "function") throw new Error(`Studio action ${entry.id} needs available(state).`);
			if (typeof entry.run !== "function") throw new Error(`Studio action ${entry.id} needs run(args).`);
			if (entry.timeoutMs !== undefined && (!Number.isSafeInteger(entry.timeoutMs) || entry.timeoutMs < 1 || entry.timeoutMs > 300_000)) throw new Error(`Studio action ${entry.id} timeoutMs must be 1..300000.`);
			if (entry.exposure !== undefined && !["open", "confirm", "ui-only"].includes(entry.exposure)) throw new Error(`Studio action ${entry.id} has an invalid exposure.`);
			entries.set(entry.id, Object.freeze({ exposure: "open", ...entry }));
			return registry;
		},
		get(id) { return entries.get(id) ?? unknown(id, [...entries.keys()]); },
		ids() { return [...entries.keys()]; },
		state() { return readState?.(); },
		/** Available actions carry their description and input schema;
		 * unavailable ones carry the reason instead of arguments. The declared
		 * hub timeout and generation travel with each, so no caller keeps its
		 * own copy of them. */
		list(state = readState?.()) {
			return [...entries.values()].map(entry => {
				const verdict = availability(entry, state);
				const row = { id: entry.id, label: entry.label, kind: entry.kind, description: entry.description, exposure: entry.exposure, ...(entry.agentHidden ? { agentHidden: true } : {}), ...(entry.readOnly ? { readOnly: true } : {}),
					...(entry.timeoutMs === undefined ? {} : { timeoutMs: entry.timeoutMs }), ...(entry.generation ? { generation: entry.generation } : {}) };
				return verdict === true ? { ...row, available: true, input: entry.input } : { ...row, available: false, reason: verdict };
			});
		},
		prepare(id, args = {}) {
			const entry = registry.get(id), given = args ?? {};
			// normalizeArgs (optional) rewrites another spelling the action takes into its declared input first.
			const validated = validateStudioSchema(entry.input, entry.normalizeArgs ? entry.normalizeArgs(given) : given, "INVALID_ARGUMENT", "$.args");
			if (readState) {
				const verdict = availability(entry, readState());
				if (verdict !== true) fail("TARGET_NOT_READY", verdict);
			}
			return { entry, args: validated };
		},
		invoke(entry, args, context) {
			const result = entry.run(args, context);
			return typeof result?.then === "function" ? result.then(value => settled(entry.id, value)) : settled(entry.id, result);
		},
		run(id, args = {}, context) {
			const prepared = registry.prepare(id, args);
			return registry.invoke(prepared.entry, prepared.args, context);
		},
	};
	return registry;
}
