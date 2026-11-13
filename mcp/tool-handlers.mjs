/**
 * The CozyClay authoring tools, as data.
 *
 * server.mjs used to own the 26 tool registrations inline, which meant the only
 * way to run one was to speak MCP to a running server. Every tool here is the
 * same handler that server.mjs registers — name, description, input schema,
 * safety annotations and live routing flag travel with it — so an in-process
 * agent can import this module and call a handler directly, and the MCP surface
 * stays the single definition of what a tool is.
 *
 * Importing this module has no side effects: no port is opened, no directory is
 * changed, no signal handler is installed and no temporary file is swept. The
 * owning process does that wiring — server.mjs resolves the project root (and
 * chdirs into it), sweeps stale capture artifacts and installs the exit hooks —
 * and hands what the handlers need to createToolHandlers.
 *
 * State is the same one authoring document server.mjs always had: this module
 * owns it, and `liveHub` is a live binding the owner installs with setLiveHub,
 * so every handler sees the editor connection the moment it exists.
 */
import { link, open as openFile, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { constants as fsConstants, readdirSync, statSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";

import { z } from "zod";

import { MAX_COMMAND_TIMEOUT_MS } from "./live-hub.mjs";
import { readMeshFromPath } from "./mesh-file.mjs";
import { encodePng, readImageFromPath } from "./image-file.mjs";
import { rankingRow, scoreSculptAgainstReference } from "../src/sculpt-compare.js";
import { scoreSculptAgainstViews } from "../src/sculpt-views.js";
import { DEFAULT_POSE } from "../src/poses.js";

import {
	CAMERA_MOVES,
	DEFAULT_SENSOR_FORMAT,
	IMAGE_MODELS,
	VIDEO_MODELS,
	composePrompt,
	deriveShot,
	focalMmToFov,
	nearestPrime,
	shotAspectRatio,
	slateLine,
} from "../src/shot.js";
import {
	CHARACTER_KIND_IDS,
	POSTURES,
	activeScene,
	isProxyFigure,
	addScene,
	createCharacterEntry,
	createSceneDocument,
	readSceneDocument,
	serializeSceneDocument,
} from "../src/scenes.js";
import { normalizeSculptRecipe, patchSculptRecipe } from "../src/sculpt-recipe.js";
import {
	OBJECT_LIBRARY,
	SCULPT_KIND,
	createSceneObject,
	createSculptObject,
	objectSize,
	removeSceneObject,
	setSceneObjectParent,
	updateSceneObject,
} from "../src/scene-objects.js";
import { classifyMove, captureFraming, moveSlate } from "../src/camera-move.js";
import { DEFAULT_PREVIS_MODE, PREVIS_MODES, readProjectDocument } from "../src/project.js";
import { characterName, promptDescription } from "../src/character-name.js";
import { splitSavedCamera, serializeSavedProject } from "./project-camera.mjs";

/** The authoring state. One scene document, one camera, one project name. */
export const state = {
	// Memory mode keeps the one-character stage it always opened with; the
	// studio's new project starts empty, and a connected editor reports its own.
	doc: createSceneDocument({ seedCharacter: true }),
	name: "Untitled",
	/** the project's previs mode ("storyboard" | "animation"); the live editor reports it with every describe */
	previsMode: DEFAULT_PREVIS_MODE,
	camera: { x: 0, y: 1.6, z: 4.5, focalMm: 35 },
	timeline: { currentFrame: 0, frameCount: 360, fps: 24 },
	/** which character the camera frames against; null means the first of the cast */
	focus: null,
	/** true after focus_character explicitly selects the server-side subject */
	focusLocked: false,
	/** framing snapshot taken by `mark_camera_move`, consumed by `describe_camera_move` */
	markedFraming: null,
};

export let liveHub = null;
/** The live editor port this session tried to own; set by whoever starts the hub. */
let livePort = null;
/** True when another process (a sibling MCP session's child) already owns the live editor port. */
let liveHubPortBusy = false;
/** Explain a missing live editor, naming the sibling session that owns the port when that is the cause. */
const noLiveEditor = (requirement) =>
	liveHubPortBusy
		? `${requirement} Live port ${livePort} is owned by the first MCP session of this server, so this ` +
			"session is memory-only; reuse that first session, or restart the server and reconnect, to drive the editor."
		: requirement;
export const liveWorkspace = new AsyncLocalStorage();
const liveWorkspaceTools = new Set([
	"describe_scene", "describe_shot", "render_prompt", "mark_camera_move", "describe_camera_move", "save_project",
	"set_camera", "frame_shot", "add_character", "place_character", "remove_character",
	"focus_character", "place_object", "import_mesh", "sculpt_object", "compare_sculpt", "group_objects", "update_object",
	"remove_object", "apply_batch", "add_scene", "switch_scene", "open_project", "capture_frame",
	"studio_commands", "studio_run",
]);
const MAX_CAPTURE_BYTES = 1_000_000;
const CAPTURE_ARTIFACT_TTL_MS = 10 * 60_000;
const MAX_CAPTURE_ARTIFACTS = 20;
const captureArtifacts = [];
const captureArtifactPattern = /^cozyclay-capture-[0-9a-f-]+\.png$/;
export const cleanupCaptureArtifacts = () => {
	for (const path of captureArtifacts.splice(0)) {
		try { unlinkSync(path); } catch {}
	}
};
export const sweepCaptureArtifacts = () => {
	for (const name of readdirSync(tmpdir())) {
		if (!captureArtifactPattern.test(name)) continue;
		try {
			const path = join(tmpdir(), name);
			if (Date.now() - statSync(path).mtimeMs >= CAPTURE_ARTIFACT_TTL_MS) unlinkSync(path);
		} catch {}
	}
};

/** The live editor connection, installed by whoever owns the hub. Handlers read
 * this binding directly, so a hub that arrives after registration is still seen. */
export const setLiveHub = (hub) => {
	liveHub = hub;
};

/** The live port and whether a sibling session already owns it — the two facts
 * `noLiveEditor` needs to explain a memory-only session. */
export const setLivePortInfo = (port, portBusy) => {
	livePort = port;
	liveHubPortBusy = portBusy;
};

const requirePrivateProjectInode = async (file) => {
	const stat = await file.stat();
	if (stat.nlink !== 1) throw new Error("Project files must not have hard links.");
};

const TOOL_ANNOTATIONS = Object.freeze({
	describe_scene: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
	live_status: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
	describe_shot: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
	capture_frame: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
	set_camera: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
	frame_shot: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
	add_character: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
	place_character: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
	remove_character: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
	focus_character: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
	place_object: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
	import_mesh: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
	sculpt_object: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
	compare_sculpt: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
	group_objects: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
	update_object: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
	remove_object: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
	apply_batch: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
	render_prompt: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
	mark_camera_move: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
	describe_camera_move: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
	add_scene: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
	switch_scene: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
	open_project: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
	save_project: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
	studio_commands: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
	// Whatever the editor registers: some commands delete, export or spend a
	// paid generation, and those answer CONFIRMATION_REQUIRED instead of running.
	studio_run: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
});

/** The document identity a Studio command is admitted in. */
const STUDIO_IDENTITY_KEYS = ["workspaceId", "documentEpoch", "sceneId", "sceneEpoch"];

/** The Studio context behind an inspect answer. inspect_studio answers the
 * revision and document identity, not the whole context (older editors embedded
 * it); entities, selection and the mode are read apart, at that identity. */
const contextOf = async (inspected, workspaceHandle = liveWorkspace.getStore()) => {
	if (inspected?.context) return inspected.context;
	if (!inspected?.host || !Number.isSafeInteger(inspected.revision?.scene)) return undefined;
	const read = await liveHub.command("read_studio_context", { host: inspected.host }, workspaceHandle);
	return read?.context ?? read;
};
/** One registered editor command through the editor's own bus, admitted at
 * the open document and its current revision like the agent's run_action. Its
 * declaration (read from the editor, never from this server) sets the hub
 * deadline unless the caller gives one. */
const executeStudioCommand = async ({ action, args, expectedRevision, commandId, timeoutMs, confirmationToken, inspected }) => {
	const workspaceHandle = liveWorkspace.getStore();
	inspected ??= await liveHub.command("inspect_studio", { scope: "actions", ids: [action] }, workspaceHandle);
	const context = await contextOf(inspected, workspaceHandle);
	if (!context?.host || !Number.isSafeInteger(context.revision?.scene)) throw new Error("The editor did not return a Studio context to admit this command against.");
	// Admission stays at the revision the inspect answered: an edit that lands
	// between that inspect and the context read is the editor's to refuse (STALE_SCENE).
	const inspectedRevision = Number.isSafeInteger(inspected?.revision?.scene) ? inspected.revision.scene : context.revision.scene;
	const declared = inspected.actions?.find((row) => row.id === action);
	const receipt = await liveHub.command("run_action", {
		name: "run_action",
		args: { action, args: typeof args === "function" ? await args(context) : args ?? {}, ...(confirmationToken ? { confirmationToken } : {}) },
		commandId: commandId ?? randomUUID(),
		host: Object.fromEntries(STUDIO_IDENTITY_KEYS.map((key) => [key, context.host[key]])),
		expectedRevision: expectedRevision ?? inspectedRevision,
	}, workspaceHandle, { timeoutMs: timeoutMs ?? (declared?.timeoutMs === undefined ? undefined : Math.min(MAX_COMMAND_TIMEOUT_MS, declared.timeoutMs)) });
	return receipt;
};
// A refusal is the editor's receipt: its code and recovery are the answer.
const studioResult = (...receipts) => ({
	content: receipts.map(receipt => ({ type: "text", text: JSON.stringify(receipt) })),
	...(receipts.some(receipt => receipt.ok === false) ? { isError: true } : {}),
});
const runStudioCommand = async options => studioResult(await executeStudioCommand(options));

// The tool list is fixed when the server starts, so a tool the project's mode
// or the target's kind cannot run answers a structured refusal instead of acting.
const refusal = (code, reason) => ({ content: [{ type: "text", text: JSON.stringify({ ok: false, code, reason }) }], isError: true });

/** NOT_IN_MODE in a storyboard project; null when the tool may run. `context` is
 * the connected editor's Studio context; without one the in-memory project answers. */
const previsRefusal = (toolName, { context } = {}) => {
	if ((context ? context.scene?.previsMode : state.previsMode) === "storyboard") {
		return refusal("NOT_IN_MODE", `This project is a Storyboard - ${toolName} is available in Animation projects.`);
	}
	return null;
};

const scene = () => activeScene(state.doc.scenes, state.doc.activeSceneId);
const stage = () => scene().stage;

/** The cast of the active scene. A v3 stage carries an unbounded `characters`
 * list, so "character A/B" is simply index 0/1 of this array. */
const cast = () => stage().characters;

/** Resolve a character by id, by its A/B/C letter (an MCP handle by cast position;
 * the studio itself numbers them), or by 1-based slot. Returns null when nothing matches. */
const findCharacter = (ref) => {
	const list = cast();
	if (ref === undefined || ref === null || ref === "") return list[0] ?? null;
	const key = String(ref).trim();
	const byId = list.find((c) => c.id === key);
	if (byId) return byId;
	if (/^[A-Za-z]$/.test(key)) return list[key.toUpperCase().charCodeAt(0) - 65] ?? null;
	const n = Number(key);
	if (Number.isInteger(n) && n >= 1) return list[n - 1] ?? null;
	return null;
};

// Resolve legacy letters and slots from the complete live cast inside the
// inspected admission. A missing id is refused by the command, not hidden here.
const liveCharacterId = async ref => {
	await refreshLiveDescription();
	return findCharacter(ref)?.id ?? ref;
};

/** The MCP handle of a cast member: A, B, C… by position (the studio itself numbers them). */
const letterFor = (character) => String.fromCharCode(65 + cast().indexOf(character));

/** What to say when a character reference does not resolve. */
const castHint = () =>
	`Cast: ${cast()
		.map((c, i) => `${String.fromCharCode(65 + i)}=${c.id}`)
		.join(", ")}`;

const filmback = () => ({
	sensorId: state.camera.sensorId ?? stage().sensorId ?? DEFAULT_SENSOR_FORMAT,
	aspectRatio: state.camera.aspectRatio ?? shotAspectRatio(stage().shotAspect),
});

/** The camera's vertical FOV, derived from the focal length and cropped gate. */
const fov = () => {
	const gate = filmback();
	return focalMmToFov(state.camera.focalMm, gate.sensorId, gate.aspectRatio);
};

/** The subject `deriveShot` frames against: the framed character, which is the
 * first of the cast unless `focus_character` moved it. */
const subject = () => {
	const a = findCharacter(state.focus) ?? cast()[0];
	return a ? { x: a.x, z: a.z, rot: a.rot } : { x: 0, z: 0, rot: 0 };
};

/** The height every shot is measured to: the framed subject's chest.
 * Mirrors src/shot.js FRAMING_PIVOT_Y. */
const FRAMING_PIVOT_Y = 1.3;

/** Yaw/pitch that aim the camera at the framing pivot — what captureFraming wants. */
const aimAtSubject = () => {
	const s = subject();
	const dx = state.camera.x - s.x;
	const dz = state.camera.z - s.z;
	const dy = state.camera.y - FRAMING_PIVOT_Y;
	const horizontal = Math.hypot(dx, dz);
	return {
		yaw: (Math.atan2(dx, dz) * 180) / Math.PI,
		pitch: (-Math.atan2(dy, Math.max(horizontal, 1e-6)) * 180) / Math.PI,
	};
};

const framing = () => {
	const { yaw, pitch } = aimAtSubject();
	return captureFraming({
		pos: { x: state.camera.x, y: state.camera.y, z: state.camera.z },
		yaw,
		pitch,
		fovDeg: (fov() * 180) / Math.PI,
	});
};

const currentShot = () => deriveShot(state.camera, subject(), fov(), undefined, filmback());

const modelById = (id) =>
	[...VIDEO_MODELS, ...IMAGE_MODELS].find((m) => m.id === id) ?? null;

/** Copy the protocol's deliberately small live description into the existing
 * scene shape. Formatting and film vocabulary below then remain exactly the
 * same code paths as memory-only mode. */
const applyLiveDescription = (description) => {
	if (!description || typeof description !== "object") throw new Error("Live editor returned an invalid scene description.");
	if (description.document && typeof description.document === "object") {
		const parsed = readSceneDocument(serializeSceneDocument(description.document));
		if (!parsed.document) throw new Error("Live editor returned an invalid scene document.");
		state.doc = parsed.document;
	}
	if (PREVIS_MODES.includes(description.previsMode)) state.previsMode = description.previsMode;
	const sc = scene();
	if (typeof description.sceneName === "string" && description.sceneName) sc.name = description.sceneName;
	if (description.camera && typeof description.camera === "object") {
		for (const key of ["x", "y", "z", "focalMm"]) {
			if (Number.isFinite(description.camera[key])) state.camera[key] = description.camera[key];
		}
		if (typeof description.camera.sensorId === "string") state.camera.sensorId = description.camera.sensorId;
		if (Number.isFinite(description.camera.aspectRatio)) state.camera.aspectRatio = description.camera.aspectRatio;
	}
	if (description.stage && typeof description.stage === "object") {
		if (typeof description.stage.shotAspect === "string") sc.stage.shotAspect = description.stage.shotAspect;
		if (typeof description.stage.sensorId === "string") sc.stage.sensorId = description.stage.sensorId;
		if (typeof description.stage.hasCharSheet === "boolean") sc.stage.hasCharSheet = description.stage.hasCharSheet;
	}
	if (description.timeline && typeof description.timeline === "object") {
		for (const key of ["currentFrame", "frameCount", "fps"]) {
			if (Number.isFinite(description.timeline[key])) state.timeline[key] = description.timeline[key];
		}
	}
	if (!state.focusLocked && typeof description.activeCharacterId === "string") state.focus = description.activeCharacterId;
	if (Array.isArray(description.characters)) {
		const prior = new Map(stage().characters.map((character) => [character.id, character]));
		stage().characters = description.characters.map((character, index) => {
			const previous = prior.get(character.id);
			return createCharacterEntry({ ...previous, ...character, model: character.model ?? previous?.model }, index);
		});
		if (state.focus && !stage().characters.some((character) => character.id === state.focus)) {
			state.focus = null;
			state.focusLocked = false;
		}
	}
	if (Array.isArray(description.objects)) {
		const prior = new Map(sc.objects.map((object) => [object.id, object]));
		sc.objects = description.objects.map((object) => {
			const previous = prior.get(object.id);
			// The reported renderer is the truth; the name match is only a rescue
			// for older editors that did not send one. A renamed object ("Building
			// A") defeats the name match, and a record without a renderer survives
			// the save but cannot be drawn after the load.
			const kind =
				(typeof object.renderer === "string" && (object.renderer === SCULPT_KIND || OBJECT_LIBRARY.some((entry) => entry.kind === object.renderer))
					? object.renderer
					: null) ??
				OBJECT_LIBRARY.find(({ label }) => object.name === label || object.name?.startsWith(`${label} `))?.kind;
			const defaults = previous ?? (kind === SCULPT_KIND ? createSculptObject({ recipe: object.recipe }, sc.objects, object).object ?? null : kind ? createSceneObject(kind, sc.objects, object) : null);
			// The editor is the source of truth for anything it reports; the
			// library defaults only fill what the frame omits. Defaulting AFTER
			// the spread would reset a reported scale back to 1 and make every
			// prop measure 1x1x1 no matter how it was actually built.
			return {
				...defaults,
				footprint: defaults?.footprint ?? { width: 1, depth: 1 },
				height: defaults?.height ?? 1,
				scaleX: defaults?.scaleX ?? 1,
				scaleY: defaults?.scaleY ?? 1,
				scaleZ: defaults?.scaleZ ?? 1,
				...object,
			};
		});
	}
};

const refreshLiveDescription = async (workspaceHandle = liveWorkspace.getStore()) => {
	if (!liveHub?.connected) return false;
	applyLiveDescription(await liveHub.command("describe", {}, workspaceHandle));
	return true;
};

const liveError = (error) => ({
	content: [{ type: "text", text: `Live editor error: ${error.message}` }],
	isError: true,
});

/** capture_frame's checked frame as a tool result; sculpt_object { capture: true } reuses it. */
const captureFrameResult = async (maxInlineBytes) => {
	if (!liveHub?.connected) return liveError(new Error(noLiveEditor("capture_frame requires a connected CozyClay editor with a renderable shot camera.")));
		try {
			const workspaceHandle = liveWorkspace.getStore();
			const frame = await liveHub.command("capture_frame", {}, workspaceHandle);
			const beforeHash = createHash("sha256").update(frame?.authoredStateBefore ?? "").digest("hex");
			const afterHash = createHash("sha256").update(frame?.authoredStateAfter ?? "").digest("hex");
			if (beforeHash !== afterHash) {
				throw new Error(`capture_frame changed authored editor state; capture was rejected (${beforeHash} -> ${afterHash}).`);
			}
			if (!frame || frame.width !== 640 || frame.height !== 360 || frame.mimeType !== "image/png" || typeof frame.data !== "string") {
				throw new Error("Live editor returned an invalid capture payload.");
			}
			const bytes = Buffer.from(frame.data, "base64");
			if (bytes.length === 0 || bytes.length !== frame.byteSize || bytes.length > MAX_CAPTURE_BYTES) {
				throw new Error(`Live editor returned an invalid compressed image size (maximum ${MAX_CAPTURE_BYTES} bytes).`);
			}
			if (frame.assertions?.renderable !== true || frame.assertions?.blackFrame === true) {
				throw new Error("Live editor rejected the capture as non-renderable or black.");
			}
			const metadata = {
				width: frame.width,
				height: frame.height,
				mimeType: frame.mimeType,
				encoding: frame.encoding,
				byteSize: frame.byteSize,
				assertions: frame.assertions,
				stateHashBefore: beforeHash,
				stateHashAfter: afterHash,
			};
			if (bytes.length > maxInlineBytes) {
				while (captureArtifacts.length >= MAX_CAPTURE_ARTIFACTS) {
					const oldest = captureArtifacts.shift();
					await unlink(oldest).catch(() => {});
				}
				const path = join(tmpdir(), `cozyclay-capture-${randomUUID()}.png`);
				await writeFile(path, bytes, { mode: 0o600 });
				captureArtifacts.push(path);
				const expiry = setTimeout(() => {
					const index = captureArtifacts.indexOf(path);
					if (index >= 0) captureArtifacts.splice(index, 1);
					void unlink(path).catch(() => {});
				}, CAPTURE_ARTIFACT_TTL_MS);
				expiry.unref?.();
				return text(JSON.stringify({ ...metadata, artifact: { path, width: frame.width, height: frame.height, byteSize: bytes.length } }));
			}
			return {
				content: [
					{ type: "text", text: JSON.stringify({ ...metadata, image: { transport: "inline", width: frame.width, height: frame.height, byteSize: bytes.length } }) },
					{ type: "image", data: frame.data, mimeType: frame.mimeType },
				],
			};
		} catch (error) {
			return liveError(error);
		}
};


const round = (n, places = 2) => Number(n.toFixed(places));
const metres = (n) => `${round(n)}m`;

const text = (body) => ({ content: [{ type: "text", text: body }] });

/** A scene rendered the way a crew would read it, not as JSON. */
function sceneReport({ characterCursor = 0, objectCursor = 0, limit = 50 } = {}) {
	const sc = scene();
	const st = sc.stage;
	const shot = currentShot();
	const revision = createHash("sha256")
		.update(JSON.stringify({ document: state.doc, camera: state.camera, timeline: state.timeline }))
		.digest("hex")
		.slice(0, 12);
	const characterPage = st.characters.slice(characterCursor, characterCursor + limit);
	const objectPage = sc.objects.slice(objectCursor, objectCursor + limit);
	const lines = [
		`Project: ${state.name}`,
		`Scene: ${sc.name}  (${state.doc.scenes.length} scene${state.doc.scenes.length === 1 ? "" : "s"} in project)`,
		`previsMode: ${state.previsMode}`,
		"",
		"CAMERA",
		`  position   x ${round(state.camera.x)}  y ${round(state.camera.y)}  z ${round(state.camera.z)}`,
		`  lens       ${state.camera.focalMm}mm  (nearest prime ${nearestPrime(fov(), filmback().sensorId, filmback().aspectRatio)}mm)`,
		`  filmback   ${filmback().sensorId} · ${round(filmback().aspectRatio, 3)}:1`,
		`  framing    ${slateLine(shot)}`,
		`  distance   ${metres(shot.distance)} to the subject's centre of mass`,
		"",
		`CAST (total: ${st.characters.length}, returned: ${characterPage.length}, truncated: ${characterCursor + characterPage.length < st.characters.length}, revision: ${revision})`,
	];
	const framed = findCharacter(state.focus) ?? st.characters[0];
	for (const [offset, c] of characterPage.entries()) {
		const letter = String.fromCharCode(65 + characterCursor + offset);
		lines.push(
			`  ${letter} ${c.id}  "${characterName(c)}"  at x ${round(c.x)}, z ${round(c.z)}, ` +
				`facing ${round(c.rot, 1)}deg  [${c.model}]` +
				`${c.pose ? " posed" : ""}${c.hidden ? " hidden" : ""}` +
				`${c === framed ? "  <- framed" : ""}`,
			`    model: ${c.model}  kind: ${isProxyFigure(c) ? "proxy" : "rig"}${isProxyFigure(c) ? `  posture: ${c.posture ?? "stand"}` : ""}  pose: ${JSON.stringify(c.pose ?? null)}  tint: ${c.tint ?? null}  scale: ${c.scale ?? 1}`,
						`    layer: ${JSON.stringify({ waypoints: c.layer?.waypoints ?? [] })}`,
		);
	}

	lines.push("", `SET (total: ${sc.objects.length}, returned: ${objectPage.length}, truncated: ${objectCursor + objectPage.length < sc.objects.length}, revision: ${revision})`);
	if (sc.objects.length === 0) {
		lines.push("  empty — add with place_object");
	} else {
		for (const object of objectPage) {
			const size = objectSize(object);
			lines.push(
				`  ${object.id}  ${object.name}  at x ${round(object.x)}, y ${round(object.y)}, z ${round(object.z)}` +
					`  yaw ${round(object.rot, 1)}deg  size ${round(size.width)}x${round(size.height)}x${round(size.depth)}m` +
					`${object.hidden ? " hidden" : ""}`,
				`    rotX: ${round(object.rotX ?? 0, 1)}  rotZ: ${round(object.rotZ ?? 0, 1)}  color: ${object.color ?? null}${object.opacity < 1 ? `  opacity: ${round(object.opacity, 2)}` : ""}  parent: ${object.parent ?? null}`,
			);
			if (object.path?.points?.length >= 2) {
				const points = object.path.points;
				const first = points[0];
				const last = points[points.length - 1];
				lines.push(`    path: ${points.length} pts  (${round(first.x, 1)},${round(first.z, 1)}) → (${round(last.x, 1)},${round(last.z, 1)})  speed: ${object.path.speed || "fills take"}${object.path.extend ? "  keeps going" : ""}${object.path.loop ? "  loops" : ""}${object.path.marks?.length ? `  marks: ${object.path.marks.map((mark) => (typeof mark === "number" ? round(mark, 2) : `${round(mark.t, 2)}${mark.bank ? ` bank ${round(mark.bank, 1)}` : ""}${mark.pitch ? ` pitch ${round(mark.pitch, 1)}` : ""}`)).join(", ")}` : ""}`);
			}
		}
	}
		lines.push(
			"",
			"STAGE",
			`  shotAspect: ${st.shotAspect}  sensorId: ${st.sensorId}  hasCharSheet: ${st.hasCharSheet}`,
		);
		// The stage's key light crosses the socket inside the stage envelope; a
		// director tool that cannot see it cannot describe the scene's light.
		const keyLight = sc.stage?.keyLight ?? st.keyLight;
		if (keyLight && typeof keyLight === "object") {
			lines.push(`  keyLight: x ${round(keyLight.x, 1)}  y ${round(keyLight.y, 1)}  z ${round(keyLight.z, 1)}  intensity ${round(keyLight.intensity, 2)}`);
		}
		// The editorial structure crosses the socket too — list the shots so an
		// agent reading describe_scene is not blind to cuts and rail/crane rigs.
		const shots = Array.isArray(sc.shotDocument?.shots) ? sc.shotDocument.shots : [];
		if (shots.length) {
			lines.push("", "SHOTS");
			for (const shotEntry of shots) {
				const cam = shotEntry.camera ?? {};
				const rig = cam.mode === "rail" ? "rail" + (cam.craneHeight ? "+crane" : "") : cam.mode ?? "keys";
				lines.push(`  ${shotEntry.name ?? shotEntry.id}  frames ${shotEntry.startFrame ?? "?"}-${shotEntry.endFrame ?? "?"}  ${rig}`);
			}
		}
		lines.push(
			"",
			"TIMELINE",
			`  currentFrame: ${state.timeline.currentFrame}  frameCount: ${state.timeline.frameCount}  fps: ${state.timeline.fps}`,
		);
		return lines.join("\n");
}

/** The shot, described in the vocabulary a director and an image model share. */
function shotReport() {
	const shot = currentShot();
	return [
		slateLine(shot),
		"",
		`size      ${shot.sizeLabel} — the subject fills ${Math.round(shot.screenFraction * 100)}% of frame height`,
		`view      ${shot.viewPhrase}`,
		`level     ${shot.levelPhrase}`,
		`lens      ${shot.focalMm}mm (exact ${round(shot.exactFocalMm, 1)}mm)`,
		`distance  ${metres(shot.distance)}`,
		`elevation ${round(shot.elevationDeg, 1)}deg`,
		"",
		`texture guidance: ${shot.sizeContext}`,
	].join("\n");
}

const studioAliasTools = new Set([
	"set_camera", "frame_shot", "place_object", "update_object", "remove_object",
	"import_mesh", "sculpt_object", "group_objects", "add_scene", "switch_scene", "apply_batch", "open_project",
	"add_character", "place_character", "remove_character",
]);
const studioAdmissionSchema = {
	expectedRevision: z.number().int().min(0).optional().describe("scene revision to admit against; defaults to the inspected revision"),
	commandId: z.string().min(1).max(120).optional().describe("idempotency key; reuse with the original expectedRevision to replay its receipt"),
	timeoutMs: z.number().int().min(1).max(MAX_COMMAND_TIMEOUT_MS).optional().describe("hub deadline; defaults to the editor command declaration"),
};

/** One tool, as the registry hands it out: everything server.mjs needs to
 * register it, and everything a direct caller needs to run it. */
const tool = (name, config, handler) => ({
	name,
	title: config.title,
	description: config.description,
	inputSchema: studioAliasTools.has(name) ? { ...config.inputSchema, ...studioAdmissionSchema } : config.inputSchema,
	annotations: TOOL_ANNOTATIONS[name],
	live: liveWorkspaceTools.has(name),
	handler,
});

/**
 * Build the tool registry.
 *
 * @param {object} deps
 * @param {Promise<string>} [deps.projectRootPromise] the resolved directory
 *   `open_project`/`save_project` confine themselves to; the owner resolves it
 *   because doing so chdirs the process.
 * @returns {Array<{name: string, title: string, description: string, inputSchema: object, annotations: object, live: boolean, handler: Function}>}
 */
export const createToolHandlers = ({ projectRootPromise } = {}) => {
	const resolveProjectPath = async (path, { existing }) => {
		if (!path.endsWith(".cclayproject")) throw new Error("Project path must end in .cclayproject.");
		const root = await projectRootPromise;
		const requested = resolve(path);
		const requestedParent = await realpath(dirname(requested));
		if (requestedParent !== root) throw new Error(`Project files must be direct children of configured project root ${root}.`);
		const name = basename(requested);
		if (!name || name.includes("/")) throw new Error("Project filename is invalid.");
		if (existing) {
			const file = await openFile(name, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
			try {
				await requirePrivateProjectInode(file);
			} finally {
				await file.close();
			}
		}
		return { displayPath: requested, descriptorPath: name };
	};

	return [
		tool(
			"describe_scene",
			{
				title: "Describe the scene",
				description:
					"Read the authoring state: camera, lens, current framing, cast positions and set objects. " +
					"Cast and set reads return at most 50 entries by default (100 maximum); each section reports " +
					"total, returned, truncated and revision. Use character_cursor or object_cursor to read omitted entries.",
				inputSchema: {
					character_cursor: z.number().int().min(0).default(0).describe("zero-based cast entry offset"),
					object_cursor: z.number().int().min(0).default(0).describe("zero-based set object offset"),
					limit: z.number().int().min(1).max(100).default(50).describe("entries returned per cast and set section"),
				},
			},
			async ({ character_cursor, object_cursor, limit }) => {
				try {
					await refreshLiveDescription();
					return text(sceneReport({ characterCursor: character_cursor, objectCursor: object_cursor, limit }));
				} catch (error) {
					return liveError(error);
				}
			},
		),

		tool(
			"live_status",
			{
				title: "Live editor status",
				description:
					"Report connected CozyClay editor workspaces and their handles. Multiple editor instances stay connected; " +
					"mutations require a workspace_handle whenever routing would otherwise be ambiguous.",
				inputSchema: {},
			},
			async () => text(
				liveHub?.connected
					? `Live editor connected. Workspaces:\n` + liveHub.workspaceHandleDetails().map((entry) => {
						const label = entry.meta?.project || entry.meta?.scene
							? ` — ${[entry.meta.project, entry.meta.scene, entry.meta.cast != null ? `${entry.meta.cast} in cast` : null].filter(Boolean).join(" / ")}`
							: "";
						return `  ${entry.handle}${label}`;
					}).join("\n")
					: noLiveEditor("No live editor connected; using in-memory state."),
			),
		),

		tool(
			"describe_shot",
			{
				title: "Describe the current shot",
				description:
					"Turn the current camera geometry into film vocabulary — shot size, angle on the subject, " +
					"camera level, and the nearest real prime lens. This is what the camera is actually seeing.",
				inputSchema: {},
			},
			async () => {
				try {
					await refreshLiveDescription();
					return text(shotReport());
				} catch (error) {
					return liveError(error);
				}
			},
		),

		tool(
			"capture_frame",
			{
				title: "Capture a compressed blocking frame",
				description:
					"Unlike render_prompt, capture_frame reads the connected editor's rendered 640x360 preview and computed spatial assertions without changing authored scene, playback or camera state. " +
					"It returns an inline PNG when it fits max_inline_bytes, otherwise a local artifact path with the same dimensions and byte size.",
				inputSchema: {
					max_inline_bytes: z.number().int().min(1024).max(1_000_000).default(200_000)
						.describe("maximum PNG byte size returned inline; larger frames are written to a local artifact"),
				},
			},
			async ({ max_inline_bytes }) => {
				return captureFrameResult(max_inline_bytes);
			},
		),

		tool(
			"set_camera",
			{
				title: "Set the camera",
				description:
					"Unlike frame_shot, set_camera applies explicit camera coordinates or focal length rather than deriving a shot. " +
					"Every field is optional — omitted fields keep their current value. The shot is measured as if the camera aims at the subject; " +
					"pass look_at_x/look_at_y/look_at_z together to actually point a connected editor's lens at a world point. Use focal_mm to change " +
					"framing without moving (longer = tighter), or move x/y/z to change the angle.",
				inputSchema: {
					x: z.number().optional().describe("world x in metres (right)"),
					y: z.number().optional().describe("lens height above the floor in metres"),
					z: z.number().optional().describe("world z in metres (toward default camera side)"),
					focal_mm: z
						.number()
						.min(8)
						.max(300)
						.optional()
						.describe("focal length on the scene's cropped filmback, e.g. 24, 35, 50, 85"),
					look_at_x: z.number().optional().describe("world x of an explicit aim point; give all three to aim the lens"),
					look_at_y: z.number().optional().describe("world y of an explicit aim point; give all three to aim the lens"),
					look_at_z: z.number().optional().describe("world z of an explicit aim point; give all three to aim the lens"),
				},
			},
			async ({ x, y, z: zPos, focal_mm, look_at_x, look_at_y, look_at_z, ...admission }) => {
				if (liveHub?.connected) {
					try {
						return await runStudioCommand({ ...admission, action: "shot.frame", args: context => {
							const camera = context.camera;
							const position = { x: x ?? camera.position.x, y: y ?? camera.position.y, z: zPos ?? camera.position.z };
							// Preserve direction when no complete explicit aim point was given.
							const lookAt = [look_at_x, look_at_y, look_at_z].every(value => value !== undefined)
								? { x: look_at_x, y: look_at_y, z: look_at_z }
								: Object.fromEntries(["x", "y", "z"].map(axis => [axis, position[axis] + camera.lookAt[axis] - camera.position[axis]]));
							return { subjectIds: [state.focusLocked ? state.focus : context.activeCharacterId],
								framing: { exact: { position, lookAt, focalMm: focal_mm ?? camera.focalMm } } };
						} });
					} catch (error) {
						return liveError(error);
					}
				}
				if (x !== undefined) state.camera.x = x;
				if (y !== undefined) state.camera.y = y;
				if (zPos !== undefined) state.camera.z = zPos;
				if (focal_mm !== undefined) state.camera.focalMm = focal_mm;
				return text(`Camera set.\n\n${shotReport()}`);
			},
		),

		tool(
			"frame_shot",
			{
				title: "Frame a shot by intent",
				description:
					"Unlike set_camera, frame_shot derives camera position and lens from shot intent rather than applying explicit coordinates. " +
					"It chooses a distance and height that actually produce the requested size and level, " +
					"orbiting to the requested side of the subject.",
				inputSchema: {
					size: z
						.enum([
							"extreme close-up",
							"close-up",
							"medium close-up",
							"medium shot",
							"medium-wide shot",
							"wide shot",
							"extreme wide shot",
						])
						.describe("how much of the frame the subject fills"),
					view: z
						.enum(["front", "front three-quarter", "profile", "rear three-quarter", "back"])
						.default("front three-quarter")
						.describe("which side of the subject the camera sits on"),
					level: z
						.enum(["ground", "low", "hip", "eye", "high", "overhead"])
						.default("eye")
						.describe("how high the lens rides"),
					side: z.enum(["left", "right"]).default("right").describe("camera left or camera right"),
					focal_mm: z.number().min(8).max(300).default(35).describe("lens to frame with"),
				},
			},
			async ({ size, view, level, side, focal_mm, ...admission }) => {
				let inspected;
				if (liveHub?.connected) {
					try {
						inspected = await liveHub.command("inspect_studio", { scope: "actions", ids: ["shot.frame"] }, liveWorkspace.getStore());
						await refreshLiveDescription();
					} catch (error) {
						return liveError(error);
					}
				}
				// Midpoints of shot.js's SIZE_TABLE bands, so the label that comes back is
				// the label that was asked for rather than whatever sits on a boundary.
				const FRACTION = {
					"extreme close-up": 3.4,
					"close-up": 2.2,
					"medium close-up": 1.375,
					"medium shot": 0.975,
					"medium-wide shot": 0.66,
					"wide shot": 0.41,
					"extreme wide shot": 0.2,
				};
				// Heights that land mid-band in shot.js's LEVEL_TABLE.
				const HEIGHT = { ground: 0.3, low: 0.7, hip: 1.1, eye: 1.65, high: 2.1, overhead: 2.8 };
				// Angle off the subject's facing direction, in degrees.
				const ANGLE = { front: 0, "front three-quarter": 40, profile: 90, "rear three-quarter": 140, back: 180 };

				const s = subject();
				let lensMm = focal_mm;
				// Invert deriveShot's screenFraction: distance that yields the target size.
				const distanceFor = (mm) => {
					const gate = filmback();
					return 1.8 / (2 * FRACTION[size] * Math.tan(focalMmToFov(mm, gate.sensorId, gate.aspectRatio) / 2));
				};

				// Size and level can physically conflict: an extreme close-up on a wide
				// lens sits half a metre from the pivot, which no overhead rig can also
				// satisfy. Size is the stronger request (it is the shot), so the lens is
				// lengthened until the requested level fits, exactly as a crew would swap
				// glass rather than abandon the close-up.
				const neededDy = Math.abs(HEIGHT[level] - FRAMING_PIVOT_Y);
				const MIN_HORIZONTAL = 0.25;
				const needed = Math.hypot(neededDy, MIN_HORIZONTAL);
				if (distanceFor(lensMm) < needed) {
					for (const mm of [50, 85, 100, 135, 180, 240, 300]) {
						if (mm <= lensMm) continue;
						lensMm = mm;
						if (distanceFor(mm) >= needed) break;
					}
				}
				const distance = distanceFor(lensMm);
				let camY = HEIGHT[level];
				// deriveShot measures distance in 3D to the framing pivot, so the height
				// offset has to come out of the requested distance. A very tight shot from
				// a very high or low lens can ask for more vertical offset than the whole
				// distance allows; when that happens the size is what was actually asked
				// for, so the lens is pulled toward the pivot rather than the shot widened.
				let dy = camY - FRAMING_PIVOT_Y;
				const maxDy = Math.sqrt(Math.max(distance * distance - MIN_HORIZONTAL * MIN_HORIZONTAL, 0));
				if (Math.abs(dy) > maxDy) {
					dy = Math.sign(dy) * maxDy;
					camY = FRAMING_PIVOT_Y + dy;
				}
				const horizontal = Math.sqrt(Math.max(distance * distance - dy * dy, MIN_HORIZONTAL * MIN_HORIZONTAL));

				// deriveShot calls it camera-right when cross(facing, toCamera) >= 0, which
				// is the negative yaw direction here — so camera-left orbits by +angle.
				const sign = side === "right" ? -1 : 1;
				const theta = ((s.rot + sign * ANGLE[view]) * Math.PI) / 180;

				const nextCamera = {
					x: s.x + Math.sin(theta) * horizontal,
					z: s.z + Math.cos(theta) * horizontal,
					y: camY,
					focalMm: lensMm,
				};
				if (liveHub?.connected) {
					try {
						return await runStudioCommand({ ...admission, action: "shot.frame", inspected, args: {
							subjectIds: [(findCharacter(state.focus) ?? cast()[0]).id],
							framing: { exact: {
								position: { x: nextCamera.x, y: nextCamera.y, z: nextCamera.z },
								lookAt: { x: s.x, y: FRAMING_PIVOT_Y, z: s.z }, focalMm: lensMm,
							} },
						} });
					} catch (error) {
						return liveError(error);
					}
				} else {
					Object.assign(state.camera, nextCamera);
				}

				const note =
					lensMm !== focal_mm
						? `Note: ${focal_mm}mm could not hold a ${size} from ${level} level — the lens would have to be ` +
							`inside the subject. Went to ${lensMm}mm to keep the size and the angle.\n\n`
						: "";
				return text(`${note}Framed.\n\n${shotReport()}`);
			},
		),

		tool(
			"add_character",
			{
				title: "Add a character to the cast",
				description:
					"Unlike place_character, add_character adds a new cast member instead of changing an existing one. " +
					"The cast is unbounded — each one gets its own letter (A, B, C…), position and prompt description. " +
					'model "proxy-figure" adds a capsule figure: a rigless stand-in for blocking that holds a posture (stand, sit or lie) ' +
					"and refuses motion, takes, IK and posing with TARGET_NOT_READY.",
				inputSchema: {
					subject: z.string().describe('prompt description, e.g. "a courier holding a package"'),
					x: z.number().default(0).describe("floor position x in metres"),
					z: z.number().default(0).describe("floor position z in metres"),
					facing: z.number().default(0).describe("yaw in degrees; 0 faces the default camera"),
					model: z
						.enum(CHARACTER_KIND_IDS)
						.optional()
						.describe('which mannequin to use; "proxy-figure" is a rigless capsule figure for blocking'),
					posture: z
						.enum(POSTURES)
						.optional()
						.describe("capsule figure posture (stand, sit or lie); stand when omitted"),
				},
			},
			async ({ subject: desc, x, z: zPos, facing, model, posture, ...admission }) => {
				if (liveHub?.connected) {
					try {
						return await runStudioCommand({ ...admission, action: "character.add", args: {
							character: { subject: desc, x, z: zPos, rot: facing, model, posture, pose: DEFAULT_POSE },
						} });
					} catch (error) {
						return liveError(error);
					}
				}
				const st = stage();
				const index = st.characters.length;
				// The default scene already owns "char-a", and createCharacterEntry only
				// falls back to `char-<n>` when no id is supplied, so pick the first id
				// the cast is not already using instead of assuming a naming scheme.
				const taken = new Set(st.characters.map((c) => c.id));
				let id = `char-${String.fromCharCode(97 + index)}`;
				for (let n = index + 1; taken.has(id); n += 1) id = `char-${n}`;
				const entry = createCharacterEntry({ id, subject: desc, x, z: zPos, rot: facing, model, posture }, index);
				st.characters = [...st.characters, entry];
				return text(`Added ${String.fromCharCode(65 + index)} (${entry.id}).\n\n${sceneReport()}`);
			},
		),

		tool(
			"place_character",
			{
				title: "Move or re-describe a character",
				description:
					"Unlike add_character, place_character changes an existing cast member instead of adding one. " +
					"Every field is optional; omitted fields keep their value.",
				inputSchema: {
					character: z
						.string()
						.default("A")
						.describe('which character — a letter ("A"), a slot number ("2") or an id ("char-a")'),
					x: z.number().optional().describe("floor position x in metres"),
					z: z.number().optional().describe("floor position z in metres"),
					y: z
						.number()
						.min(0)
						.optional()
						.describe("height above the floor in metres — stand a character on a roof; 0 is the street"),
					facing: z.number().optional().describe("yaw in degrees; 0 faces the default camera"),
					subject: z.string().optional().describe("prompt description"),
					hidden: z.boolean().optional().describe("hide without removing from the cast"),
				},
			},
			async ({ character, x, z: zPos, y, facing, subject: desc, hidden, ...admission }) => {
				if (liveHub?.connected) {
					try {
						return await runStudioCommand({ ...admission, action: "character.update", args: async () => ({
							characterId: await liveCharacterId(character), patch: { x, y, z: zPos, rot: facing, subject: desc, hidden },
						}) });
					} catch (error) {
						return liveError(error);
					}
				}
				const target = findCharacter(character);
				if (!target) return text(`No character "${character}". ${castHint()}`);
				if (x !== undefined) target.x = x;
				if (y !== undefined) target.y = y;
				if (zPos !== undefined) target.z = zPos;
				if (facing !== undefined) target.rot = facing;
				if (desc !== undefined) target.subject = desc;
				if (hidden !== undefined) target.hidden = hidden;
				return text(`Character ${letterFor(target)} updated.\n\n${sceneReport()}`);
			},
		),

		tool(
			"remove_character",
			{
				title: "Remove a character",
				description: "Take a character out of the cast. The last character can go too: an empty cast is a legal stage.",
				inputSchema: {
					character: z.string().describe('which character — letter, slot number or id'),
				},
			},
			async ({ character, ...admission }) => {
				if (liveHub?.connected) {
					try {
						return await runStudioCommand({ ...admission, action: "character.remove", args: async () => ({
							characterId: await liveCharacterId(character),
						}) });
					} catch (error) {
						return liveError(error);
					}
				}
				const st = stage();
				const target = findCharacter(character);
				if (!target) return text(`No character "${character}". ${castHint()}`);
				const letter = letterFor(target);
				st.characters = st.characters.filter((c) => c !== target);
				if (state.focus && !findCharacter(state.focus)) {
					state.focus = null;
					state.focusLocked = false;
				}
				return text(`Removed ${letter}.\n\n${sceneReport()}`);
			},
		),

		tool(
			"focus_character",
			{
				title: "Choose who the camera frames",
				description:
					"Pick which character the shot is measured against. describe_shot, frame_shot and " +
					"render_prompt all frame this character. Defaults to the first of the cast.",
				inputSchema: {
					character: z.string().describe('which character — letter, slot number or id'),
				},
			},
			async ({ character }) => {
				try {
					await refreshLiveDescription();
				} catch (error) {
					return liveError(error);
				}
				const target = findCharacter(character);
				if (!target) return text(`No character "${character}". ${castHint()}`);
				state.focus = target.id;
				state.focusLocked = true;
				return text(`Framing ${letterFor(target)} "${characterName(target)}".\n\n${shotReport()}`);
			},
		),

		tool(
			"place_object",
			{
				title: "Place an object in the set",
				description:
					`Unlike update_object, import_mesh and sculpt_object, place_object adds a catalog prop instead of changing an existing one, loading a GLB, OBJ or FBX from disk, or building one from a recipe. Available kinds: ${OBJECT_LIBRARY.map((o) => o.kind).join(", ")}. ` +
					"It returns the object id, which update_object and remove_object take.",
				inputSchema: {
					kind: z
						.enum(OBJECT_LIBRARY.map((o) => o.kind))
						.describe("what to place"),
					x: z.number().default(0).describe("floor position x in metres"),
					z: z.number().default(0).describe("floor position z in metres"),
					y: z.number().optional().describe("height above the floor; 0 stands on the deck"),
					facing: z.number().optional().describe("yaw in degrees"),
					name: z.string().min(1).optional().describe("display name, e.g. 'Building A / Roof'"),
					parent: z
						.string()
						.optional()
						.describe("object id to attach to — the parent then carries this object when it moves"),
				},
			},
			async ({ kind, x, z: zPos, y, facing, name, parent, ...admission }) => {
				if (liveHub?.connected) {
					try {
						return await runStudioCommand({ ...admission, action: "object.add", args: { kind, placement: { x, z: zPos, y, rot: facing }, name, parent } });
					} catch (error) {
						return liveError(error);
					}
				}
				const sc = scene();
				// The parent is checked before anything is created: a bad id must not
				// leave a half-made part lying around unattached.
				if (parent !== undefined && !sc.objects.some((o) => o.id === parent)) {
					return text(`No object "${parent}" to attach to. Call describe_scene for the current ids.`);
				}
				const placement = { x, z: zPos };
				if (y !== undefined) placement.y = y;
				if (facing !== undefined) placement.rot = facing;
				const object = createSceneObject(kind, sc.objects, placement);
				sc.objects = [...sc.objects, object];
				if (name !== undefined) sc.objects = updateSceneObject(sc.objects, object.id, { name });
				if (parent !== undefined) sc.objects = setSceneObjectParent(sc.objects, object.id, parent);
				const placed = sc.objects.find((o) => o.id === object.id);
				return text(
					`Placed ${placed.name} as ${placed.id}${parent !== undefined ? ` under ${parent}` : ""}.\n\n${sceneReport()}`,
				);
			},
		),

		tool(
			"import_mesh",
			{
				title: "Import a GLB, OBJ or FBX as a mesh prop",
				description:
					"Unlike place_object, import_mesh loads a local GLB, OBJ or FBX from a filesystem path as a mesh prop. " +
					"Give it the path of a file this machine can read — optional file:// or a leading ~/ — not the bytes. " +
					"A connected CozyClay editor is required; the mesh cannot live in memory-only MCP. " +
					"Optional x and z are floor metres: if you set one, the omitted axis is 0. Omit both to stand the model in front of the shot camera. " +
					"facing is yaw in degrees (omitted is 0, like the Import button). height is standing height in metres. y lifts the model off the floor. " +
					"clay: true replaces file materials with matte clay. name labels the prop and defaults to the file name. " +
					"After import, use update_object for tilt, roll, scale or parenting.",
				inputSchema: {
					path: z.string().min(1).describe("filesystem path to a GLB, OBJ or FBX this machine can read"),
					clay: z.boolean().optional().describe("true replaces file materials with matte clay"),
					name: z.string().min(1).optional().describe("display name; defaults to the file name"),
					x: z.number().optional().describe("floor x in metres; if x or z is set, the omitted axis is 0"),
					z: z.number().optional().describe("floor z in metres"),
					y: z.number().optional().describe("height above the floor in metres"),
					facing: z.number().optional().describe("yaw in degrees; omitted is 0"),
					height: z.number().positive().optional().describe("standing height in metres; omitted uses the fitted size"),
				},
			},
			async ({ path, clay, name, x, z: zPos, y, facing, height, ...admission }) => {
				if (!liveHub?.connected) {
					return liveError(new Error(noLiveEditor("import_mesh requires a connected CozyClay editor.")));
				}
				let mesh;
				try {
					mesh = await readMeshFromPath(path);
				} catch (error) {
					return { content: [{ type: "text", text: error.message }], isError: true };
				}
				const liveArgs = {
					name: typeof name === "string" && name.trim() ? name.trim() : mesh.name,
					mimeType: mesh.mimeType,
					source: `data:${mesh.mimeType};base64,${Buffer.from(mesh.bytes).toString("base64")}`,
					placeAs: "mesh",
				};
				if (clay === true) liveArgs.clay = true;
				if (x !== undefined || zPos !== undefined) {
					liveArgs.x = x ?? 0;
					liveArgs.z = zPos ?? 0;
				}
				if (y !== undefined) liveArgs.y = y;
				if (facing !== undefined) liveArgs.rot = facing;
				if (height !== undefined) liveArgs.height = height;
				try {
					return await runStudioCommand({ ...admission, action: "asset.import", args: liveArgs });
				} catch (error) {
					return liveError(error);
				}
			},
		),

		tool(
			"sculpt_object",
			{
				title: "Sculpt a clay prop from a recipe of soft parts",
				description:
					"Unlike place_object, import_mesh and compare_sculpt, sculpt_object builds or changes a clay prop from a recipe of parts you write, typically after reading a reference image. It needs no file and no catalogue entry. " +
					"recipe = { version: 1, parts: [{ id, shape, size: [x, y, z], position?, rotation?, color?, parent?, mirror?, ...shape fields, material?, finish?, detail?, gradient?, op? }] }. " +
					"Units are metres and degrees. The floor is y = 0, front is +z, and the subject's own left is +x. size is the full extent; position is the part's centre, in its parent part's frame when parent is set. " +
					"shape: blob (soft superellipsoid: roundness 0 is an ellipsoid, 1 is a rounded box; taper narrows the top when positive and the bottom when negative), box (roundness bevels the edges), " +
					"cylinder (taper 1 is a cone), torus (size [outer, outer, tube]), frame (a rectangular ring in x/y with a border width, for glasses rims, windows and picture frames), " + "lathe { profile: [[r 0..1 of half-width, y 0..1 of height], ...] bottom to top, smooth? } for turned objects (pot, vase, bottle, bowl, lampshade, mushroom), " + "tube { path: [[x, y, z] each -0.5..0.5 of size], thickness (m, diameter), taper?, closed? } for ropes, vines, cables, handles, branches and bike frames, " + "extrude { outline: [[x, y] -0.5..0.5 of size], holes?, roundness? } for flat cut shapes pushed through size z (sign, leaf, gable, gear, star), " + "loft { sections: [{ y 0..1, points: [[x, z]...] } or { y, w, d, x?, z?, roundness? }] bottom to top (first y 0, last y 1), smooth? } for cross-sections that change (hull, car body, shoe, loaf; lay it down with rotation [-90,0,0]), " + "convex { points: [[x, y, z]...] or seed + facetCount?, facets? } for rocks, boulders, gems and crystals, " + "scatter { item: blade|tuft|flower|leaf|pebble|twig, count <= 4000, spread: ground|shell, seed? } for thousands of small items as ONE part (grass, flower beds, gravel; shell covers a crown or bush it is parented to; 12000 items per recipe). " + "Any part also takes material clay|wood|straw|stone|brick|concrete|metal|glass|ceramic|plastic|rubber|fabric|paper|foliage (real texture and shine; color tints it; never fake glass with opacity or thatch with stripes) and finish matte|satin|gloss; detail { amount 0..1, scale?, seed? } for a lumpy surface (clouds, bushes, rocks, hay, bread), gradient { color, axis? y|x|z, from?, to? } to blend into a second colour (sky-lit clouds, fruit, sunset walls), " + "and op: subtract|intersect, which makes the part an undrawn cutter of its parent (windows, doors, arches; hollow a lathe with a smaller lathe of the same profile; cut deeper than the wall; mirror cuts both sides). " +
					"mirror: true adds a copy reflected across x = 0 of the parent frame, with its children; author the subject's left (+x) side once. color is #rrggbb. At most 48 parts after mirrors. " +
					"To fix a sculpt, pass its id with edits instead of a whole recipe: [{ set: partId, ...fields }, { add: part }, { remove: partId }] (parent: null and mirror: false clear; remove takes the part's children). " +
					"capture: true also returns the editor's frame (connected editor only), so one call is one round. " +
					"Workflow: measure the reference's outline landmarks (limb tips, head top, feet as fractions of height) and place parts on them, compare_sculpt against the reference image, then rank 3-6 candidate edits with compare_sculpt { candidates } and apply the winner. Add small identity details (eyes, rims, plates) last as children of their parent part. " +
					"A recipe or edit that cannot be drawn is refused with the path of the bad field.",
				inputSchema: {
					recipe: z.object({}).passthrough().optional().describe("{ version: 1, parts: [...] }; the whole recipe, for a new sculpt or a full rewrite"),
					edits: z.array(z.object({}).passthrough()).min(1).max(48).optional().describe("part-level changes to the sculpt named by id"),
					id: z.string().min(1).optional().describe("an existing sculpt's id to re-sculpt or patch in place (keeps its position and turn)"),
					name: z.string().min(1).optional().describe("display name, e.g. 'Nerd turtle'"),
					x: z.number().optional().describe("floor x in metres"),
					z: z.number().optional().describe("floor z in metres"),
					y: z.number().optional().describe("height above the floor in metres"),
					facing: z.number().optional().describe("yaw in degrees"),
					parent: z.string().optional().describe("object id to attach the new sculpt to"),
					capture: z.boolean().optional().describe("true returns capture_frame's image with the result (connected editor only)"),
				},
			},
			async ({ recipe, edits, id, name, x, z: zPos, y, facing, parent, capture, ...admission }) => {
				if ((recipe === undefined) === (edits === undefined)) return { content: [{ type: "text", text: "Give exactly one of recipe (whole) or edits (part by part)." }], isError: true };
				if (edits !== undefined && id === undefined) return { content: [{ type: "text", text: "edits patch an existing sculpt: give its id." }], isError: true };
				const placement = {};
				if (x !== undefined) placement.x = x;
				if (zPos !== undefined) placement.z = zPos;
				if (y !== undefined) placement.y = y;
				if (facing !== undefined) placement.rot = facing;
				if (liveHub?.connected) {
					let result;
					try {
						result = await runStudioCommand({ ...admission, action: "object.sculpt", args: { ...(recipe === undefined ? { edits } : { recipe }), ...(id === undefined ? {} : { id }), ...(name === undefined ? {} : { name }), ...(Object.keys(placement).length ? { placement } : {}), ...(parent === undefined ? {} : { parent }) } });
					} catch (error) {
						return liveError(error);
					}
					if (capture !== true || result.isError) return result;
					// The sculpt is applied either way; a failed capture is reported beside it, not as a failure.
					const frame = await captureFrameResult(1_000_000);
					return { content: [...result.content, ...frame.content] };
				}
				if (capture === true) return liveError(new Error(noLiveEditor("capture: true needs a connected CozyClay editor; call sculpt_object without it, or compare_sculpt.")));
				const sc = scene();
				if (parent !== undefined && !sc.objects.some((o) => o.id === parent)) {
					return text(`No object "${parent}" to attach to. Call describe_scene for the current ids.`);
				}
				if (id !== undefined) {
					const target = sc.objects.find((o) => o.id === id);
					if (!target) return text(`No object "${id}". Call describe_scene for the current ids.`);
					if (target.renderer !== SCULPT_KIND) return { content: [{ type: "text", text: `${id} is a ${target.renderer}, not a sculpt; omit id to create a new sculpt.` }], isError: true };
					const next = edits !== undefined ? patchSculptRecipe(target.recipe, edits) : normalizeSculptRecipe(recipe);
					if (!next.ok) return { content: [{ type: "text", text: `Recipe refused at ${next.error}` }], isError: true };
					sc.objects = updateSceneObject(sc.objects, id, { ...placement, ...(name === undefined ? {} : { name }), recipe: next.recipe });
					const row = sc.objects.find((o) => o.id === id);
					const verb = edits !== undefined ? `Patched ${next.changed.join(", ")} on` : "Re-sculpted";
					return text(`${verb} ${row.name} as ${row.id}: ${row.footprint.width} x ${row.footprint.depth} m, ${row.height} m tall.\n\n${sceneReport()}`);
				}
				const made = createSculptObject({ recipe, name }, sc.objects, placement);
				if (made.error) return { content: [{ type: "text", text: `Recipe refused at ${made.error}` }], isError: true };
				sc.objects = [...sc.objects, made.object];
				if (parent !== undefined) sc.objects = setSceneObjectParent(sc.objects, made.object.id, parent);
				const row = sc.objects.find((o) => o.id === made.object.id);
				return text(`Sculpted ${row.name} as ${row.id}: ${row.footprint.width} x ${row.footprint.depth} m, ${row.height} m tall${parent !== undefined ? ` under ${parent}` : ""}.\n\n${sceneReport()}`);
			},
		),

		tool(
			"compare_sculpt",
			{
				title: "Compare a sculpt's silhouette with its reference image",
				description:
					"Unlike capture_frame and sculpt_object, compare_sculpt scores a sculpt's shape against a reference image instead of rendering the shot or changing the sculpt. " +
					"Give the sculpt's id and the path of the reference (PNG or JPEG on this machine; a flat background or transparency). It reads the reference's subject as a mask, draws the sculpt's silhouette from a view (yaw: the camera's azimuth, 0 in front, positive toward the subject's own left; elevation: degrees above), " +
					"fits it to the subject's height and position, and returns IoU, the width-to-height delta, which height band is missing area (top, middle, bottom) and which parts stick out, plus a sheet: reference | overlay (grey both, red missing, blue extra). " +
					"Omit yaw to try -45..45 and keep the best. Instead of reference, views [{ yaw, reference, weight? }] scores several views of the subject (a blueprint's front 0, side 90, back 180) and blends their IoUs by weight (default front 0.6, side 0.25, back 0.15; a view whose height:width differs from the front's by more than 35% gets 0), with one row per view. Pass candidates (up to 12 labelled edit sets) to score several fixes in one call without applying any; the answer ranks them against the current sculpt. Shape only: colour is not scored. Works without an editor.",
				inputSchema: {
					id: z.string().min(1).describe("the sculpt's object id"),
					reference: z.string().min(1).optional().describe("filesystem path to the reference PNG or JPEG; give this or views"),
					views: z.array(z.object({ yaw: z.number().min(-180).max(180), reference: z.string().min(1), weight: z.number().min(0).max(1).optional() })).min(1).max(4).optional().describe("several views of the subject (path + camera yaw each), scored together by weight; give this or reference"),
					yaw: z.number().min(-180).max(180).optional().describe("reference camera azimuth in degrees; omitted tries -45..45"),
					elevation: z.number().min(-60).max(60).optional().describe("reference camera elevation in degrees; default 0"),
					candidates: z.array(z.object({ label: z.string().min(1).max(60), edits: z.array(z.object({}).passthrough()).min(1).max(48) })).min(1).max(12).optional()
						.describe("alternative edit sets to score side by side without applying any; returns them ranked by IoU with the winner's sheet"),
				},
			},
			async ({ id, reference, views, yaw, elevation = 0, candidates }) => {
				const workspaceHandle = liveWorkspace.getStore();
				if (liveHub?.connected) {
					try { await refreshLiveDescription(workspaceHandle); } catch (error) { return liveError(error); }
				}
				const target = scene().objects.find((o) => o.id === id);
				if (!target) return text(`No object "${id}". Call describe_scene for the current ids.`);
				if (target.renderer !== SCULPT_KIND || !target.recipe) return { content: [{ type: "text", text: `${id} is a ${target.renderer}, not a sculpt.` }], isError: true };
				if ((reference === undefined) === (views === undefined)) return { content: [{ type: "text", text: "Give exactly one of reference (one view) or views (several weighted views)." }], isError: true };
				let image, result;
				try { image = views ? await Promise.all(views.map(async (view) => ({ ...view, image: await readImageFromPath(view.reference) }))) : await readImageFromPath(reference); } catch (error) { return { content: [{ type: "text", text: error.message }], isError: true }; }
				try {
					const scored = views ? scoreSculptAgainstViews(target.recipe, image, { elevation, candidates }) : scoreSculptAgainstReference(target.recipe, image, { yaw, elevation, candidates });
					result = scored.result;
					if (candidates) {
						const { ranked, refused } = scored;
						const best = ranked[0];
						const png = encodePng(best.result.sheet.width, best.result.sheet.height, best.result.sheet.data);
						const summary = { id, view: best.result.report.view, ranking: ranked.map((row) => rankingRow(row, result)), ...(refused.length ? { refused } : {}),
							note: `Nothing was applied. Apply the winner with sculpt_object { id: "${id}", edits }.` };
						return { content: [{ type: "text", text: JSON.stringify(summary) }, { type: "image", data: png.toString("base64"), mimeType: "image/png" }] };
					}
				} catch (error) {
					return { content: [{ type: "text", text: error.message }], isError: true };
				}
				const png = encodePng(result.sheet.width, result.sheet.height, result.sheet.data);
				return { content: [{ type: "text", text: JSON.stringify({ id, ...result.report }) }, { type: "image", data: png.toString("base64"), mimeType: "image/png" }] };
			},
		),

		tool(
			"group_objects",
			{
				title: "Group props so they move as one",
				description:
					"Attach objects to a parent object. The parent then carries them whenever it moves — in " +
					"the studio's gizmo as well as through update_object — so a set piece assembled from " +
					"primitives can be positioned as a single thing. Rotation and scale stay per-object. " +
					"Pass parent: null to detach.",
				inputSchema: {
					parent: z.string().nullable().describe("object id to attach to, or null to detach"),
					children: z.array(z.string()).min(1).describe("object ids to attach or detach"),
				},
			},
			async ({ parent, children, ...admission }) => {
				if (liveHub?.connected) {
					try {
						return await runStudioCommand({ ...admission, action: parent === null ? "object.ungroup" : "object.group", args: parent === null ? { children } : { parent, children } });
					} catch (error) {
						return liveError(error);
					}
				}
				const sc = scene();
				if (parent !== null && !sc.objects.some((o) => o.id === parent)) return text(`No object "${parent}".`);
				for (const child of children) {
					if (!sc.objects.some((o) => o.id === child)) return text(`No object "${child}".`);
				}
				sc.objects = children.reduce((acc, child) => setSceneObjectParent(acc, child, parent), sc.objects);
				return text(
					(parent === null ? `Detached ${children.length} object(s).` : `Grouped ${children.length} object(s) under ${parent}.`) +
						`\n\n${sceneReport()}`,
				);
			},
		),

		tool(
			"update_object",
			{
				title: "Move, rotate or scale an object",
				description:
					"Unlike place_object, update_object changes an existing prop instead of adding one. " +
					"Every field is optional; omitted fields are left alone. Transforms go through the same clamp/snap path the studio's gizmo uses. hidden shows or hides the prop without deleting it. opacity makes it see-through (glass, windows, water).",
				inputSchema: {
					id: z.string().describe("object id from place_object or describe_scene"),
					x: z.number().optional(),
					y: z.number().optional(),
					z: z.number().optional(),
					facing: z.number().optional().describe("yaw in degrees"),
					tilt: z.number().optional().describe("pitch in degrees (rotation about x)"),
					roll: z.number().optional().describe("roll in degrees (rotation about z)"),
					scale: z.number().positive().optional().describe("uniform scale factor"),
					scale_x: z.number().positive().optional().describe("width scale; overrides `scale` on this axis"),
					scale_y: z.number().positive().optional().describe("height scale; overrides `scale` on this axis"),
					scale_z: z.number().positive().optional().describe("depth scale; overrides `scale` on this axis"),
					color: z
						.string()
						.regex(/^#[0-9a-fA-F]{6}$/)
						.optional()
						.describe("hex colour, e.g. #d9b18c"),
					name: z.string().min(1).optional().describe("new display name, e.g. 'Building A'"),
					path: z
						.object({
							points: z
								.array(z.object({ x: z.number(), y: z.number().optional(), z: z.number() }))
								.min(2)
								.describe("route through the set; y lifts the object so it can climb"),
							speed: z.number().min(0).optional().describe("metres per second; 0 or omitted spans the whole take"),
							face_travel: z.boolean().optional().describe("turn to face the direction of travel (default true)"),
							loop: z.boolean().optional(),
							extend: z.boolean().optional().describe("keep going in the final direction after the route ends"),
							marks: z
								.array(z.union([
									z.number().min(0).max(1),
									z.object({ t: z.number().min(0).max(1), bank: z.number().min(-90).max(90).optional(), pitch: z.number().min(-90).max(90).optional() }),
								]))
								.max(6)
								.optional()
								.describe("dots along the route: an arc fraction 0-1, or { t, bank, pitch } (degrees, +-90) to lean there; level again at the neighbouring marks and ends"),
						})
						.nullable()
						.optional()
						.describe("travel path; null clears it and the object stands still again"),
					height: z.number().positive().optional().describe("cutout or mesh height in metres"),
					clay: z.boolean().optional().describe("mesh only: replace file materials with matte clay"),
					hidden: z.boolean().optional().describe("true hides the prop without deleting it"),
					opacity: z.number().min(0.05).max(1).optional().describe("1 is solid; lower is see-through, e.g. 0.3 for clear glass"),
				},
			},
			async ({ id, x, y, z: zPos, facing, tilt, roll, scale, scale_x, scale_y, scale_z, color, name, path, height, clay, hidden, opacity, ...admission }) => {
				const travelPath = path === null
					? null
					: path
						? { points: path.points.map((point) => ({ x: point.x, y: point.y ?? 0, z: point.z })), speed: path.speed ?? 0, faceTravel: path.face_travel !== false, loop: path.loop === true, extend: path.extend === true, ...(path.marks ? { marks: path.marks } : {}) }
						: undefined;
				if (liveHub?.connected) {
					try {
						return await runStudioCommand({ ...admission, action: "object.update", args: { id, patch: {
							x, y, z: zPos, rot: facing, rotX: tilt, rotZ: roll,
							scaleX: scale_x ?? scale, scaleY: scale_y ?? scale, scaleZ: scale_z ?? scale,
							color, name, path: travelPath, height, clay, hidden, opacity,
						} } });
					} catch (error) {
						return liveError(error);
					}
				}
				const sc = scene();
				if (!sc.objects.some((o) => o.id === id)) {
					return text(`No object "${id}" in this scene. Call describe_scene for the current ids.`);
				}
				const patch = {};
				if (x !== undefined) patch.x = x;
				if (y !== undefined) patch.y = y;
				if (zPos !== undefined) patch.z = zPos;
				if (facing !== undefined) patch.rot = facing;
				if (tilt !== undefined) patch.rotX = tilt;
				if (roll !== undefined) patch.rotZ = roll;
				if (scale !== undefined) {
					patch.scaleX = scale;
					patch.scaleY = scale;
					patch.scaleZ = scale;
				}
				if (scale_x !== undefined) patch.scaleX = scale_x;
				if (scale_y !== undefined) patch.scaleY = scale_y;
				if (scale_z !== undefined) patch.scaleZ = scale_z;
				if (color !== undefined) patch.color = color;
				if (name !== undefined) patch.name = name;
				if (height !== undefined) patch.height = height;
				if (clay !== undefined) patch.clay = clay;
				if (hidden !== undefined) patch.hidden = hidden;
				if (opacity !== undefined) patch.opacity = opacity;
				sc.objects = updateSceneObject(sc.objects, id, travelPath === undefined ? patch : { ...patch, path: travelPath });
				return text(`Updated ${id}.\n\n${sceneReport()}`);
			},
		),

		tool(
			"remove_object",
			{
				title: "Remove an object",
				description: "Take a prop out of the set.",
				inputSchema: { id: z.string().describe("object id") },
			},
			async ({ id, ...admission }) => {
				if (liveHub?.connected) {
					try {
						return await runStudioCommand({ ...admission, action: "object.remove", args: { ids: [id] } });
					} catch (error) {
						return liveError(error);
					}
				}
				const sc = scene();
				if (!sc.objects.some((o) => o.id === id)) {
					return text(`No object "${id}" in this scene.`);
				}
				sc.objects = removeSceneObject(sc.objects, id);
				return text(`Removed ${id}.\n\n${sceneReport()}`);
			},
		),

		tool(
			"apply_batch",
			{
				title: "Apply object mutations as one undo step",
				description:
					"Apply up to 100 object mutations in the connected CozyClay editor as one user-visible undo entry. " +
					"This v1 batch supports object mutations only: place_object, update_object, remove_object, group_objects, ungroup_objects. Character ops are not part of this schema because character history is a separate store. " +
					"atomic defaults to false; when true, any failed operation restores the whole batch. stopOnError defaults to true and independently controls whether later operations run after a failure.",
				inputSchema: {
					ops: z
						.array(
							z.object({
								name: z.enum([
									"place_object",
									"update_object",
									"remove_object",
									"group_objects",
									"ungroup_objects",
									"apply_batch",
								]),
								args: z.record(z.unknown()),
							}),
						)
						.max(100)
						.describe("existing mutation commands to execute in order; nested apply_batch is rejected"),
					atomic: z.boolean().default(false).describe("roll back all operations if any operation fails"),
					stopOnError: z.boolean().default(true).describe("stop executing later operations after a failure"),
					label: z.string().min(1).default("MCP batch").describe("the single editor undo entry name"),
				},
			},
			async ({ ops, atomic, stopOnError, label, ...admission }) => {
				if (!liveHub?.connected) return text(noLiveEditor("apply_batch requires a connected CozyClay editor."));
				try {
					// #446: the v1 alias is objects-only, so objects.batch (not a
					// generic run.batch) preserves its options and single undo entry.
					return await runStudioCommand({ ...admission, action: "objects.batch", args: { ops, atomic, stopOnError, label } });
				} catch (error) {
					return liveError(error);
				}
			},
		),

		tool(
			"render_prompt",
			{
				title: "Render the AI prompt for this shot",
				description:
					"Turn the current camera and cast into a prompt for an AI image or video model. " +
					"The prompt carries the real framing — shot size, lens, angle and level — so the " +
					"generated frame matches the blocking.",
				inputSchema: {
					mode: z.enum(["image", "video"]).default("video").describe("still or moving"),
					model: z
						.string()
						.optional()
						.describe(
							`target model id. video: ${VIDEO_MODELS.map((m) => m.id).join(", ")}. ` +
								`image: ${IMAGE_MODELS.map((m) => m.id).join(", ")}`,
						),
					environment: z
						.string()
						.describe('the real setting, e.g. "a rain-slicked Seoul side street at night"'),
					style: z
						.string()
						.default("")
						.describe('look and grade, e.g. "shot on 35mm film, warm practical light"; leave it out to add none'),
					camera_move: z
						.string()
						.default(CAMERA_MOVES[0])
						.describe(`camera move. Known: ${CAMERA_MOVES.filter((m) => m !== "Custom…").join(", ")}`),
					pose_phrase: z.string().default("").describe("what the framed character is doing"),
					pose2_phrase: z.string().default("").describe("what the next visible character in cast order is doing"),
				},
			},
			async ({ mode, model, environment, style, camera_move, pose_phrase, pose2_phrase }) => {
				if (liveHub?.connected) {
					try {
						await refreshLiveDescription();
					} catch (error) {
						return liveError(error);
					}
				}
				const st = stage();
				const known = CAMERA_MOVES.includes(camera_move);
				// The prompt describes the framed character first (even when hidden), then every
				// other visible character in cast order. pose_phrase and pose2_phrase go to the first two.
				const framed = findCharacter(state.focus) ?? st.characters[0];
				const described = [framed, ...st.characters.filter((c) => c !== framed && !c.hidden)];
				const prompt = composePrompt({
					mode,
					model: modelById(model) ?? undefined,
					shot: currentShot(),
					subjects: described.map((c, i) => ({ description: promptDescription(c?.subject), posePhrase: [pose_phrase, pose2_phrase][i] ?? "" })),
					environment,
					style,
					cameraMove: known ? camera_move : "Custom…",
					customMove: known ? "" : camera_move,
					hasCharSheet: st.hasCharSheet === true,
					hasEnvSheet: false, aspect: st.shotAspect,
				});
				return text(`${slateLine(currentShot())}\n\n${prompt}`);
			},
		),

		tool(
			"mark_camera_move",
			{
				title: "Mark the start of a camera move",
				description:
					"Snapshot the current framing as the A position of a camera move. Then move the camera " +
					"and call describe_camera_move to have the move named in film vocabulary.",
				inputSchema: {},
			},
			async () => {
				try {
					await refreshLiveDescription();
				} catch (error) {
					return liveError(error);
				}
				// describe carries the editor's previsMode into state.
				const refused = previsRefusal("mark_camera_move");
				if (refused) return refused;
				state.markedFraming = framing();
				return text(`Marked A position: ${slateLine(currentShot())}\n\nNow move the camera, then call describe_camera_move.`);
			},
		),

		tool(
			"describe_camera_move",
			{
				title: "Name the camera move",
				description:
					"Compare the marked A position against the camera's current B position and name the move " +
					"the way a crew would — dolly in, crane down, arc left, push, and so on.",
				inputSchema: {
					duration_s: z.number().positive().default(3).describe("how long the move takes, in seconds"),
				},
			},
			async ({ duration_s }) => {
				try {
					await refreshLiveDescription();
				} catch (error) {
					return liveError(error);
				}
				if (!state.markedFraming) {
					return text("No A position marked. Call mark_camera_move first, then move the camera.");
				}
				const move = classifyMove(state.markedFraming, framing(), subject(), { durationS: duration_s, ...filmback() });
				return text(
					[
						moveSlate(move),
						"",
						`from  ${slateLine(deriveShot(state.markedFraming.pos, subject(), (state.markedFraming.fovDeg * Math.PI) / 180, undefined, filmback()))}`,
						`to    ${slateLine(currentShot())}`,
						`over  ${duration_s}s`,
					].join("\n"),
				);
			},
		),

		tool(
			"add_scene",
			{
				title: "Add a scene",
				description:
					"Add another scene to the project and make it active. A connected editor runs scene.create then scene.rename " +
					"and returns both bus receipts; without one, this changes MCP memory only.",
				inputSchema: { name: z.string().default("SCENE 02").describe("scene name") },
			},
			async ({ name, ...admission }) => {
				if (liveHub?.connected) {
					let created;
					try {
						created = await executeStudioCommand({ ...admission, action: "scene.create" });
						if (!created.ok) return studioResult(created);
						// Creation is a document boundary; naming is a separate retained edit.
						const renamed = await executeStudioCommand({ ...admission, action: "scene.rename",
							commandId: admission.commandId ? createHash("sha256").update(`${admission.commandId}:rename`).digest("hex") : undefined,
							args: { sceneId: created.host.sceneId, name }, expectedRevision: created.revision.after });
						return studioResult(created, renamed);
					} catch (error) {
						const failure = liveError(error);
						if (created) failure.content.unshift(...studioResult(created).content);
						return failure;
					}
				}
				const document = JSON.parse(JSON.stringify(state.doc));
				document.scenes = addScene(document.scenes, name);
				document.activeSceneId = document.scenes[document.scenes.length - 1].id;
				state.doc = document;
				return text(`Added "${scene().name}".\n\n${sceneReport()}`);
			},
		),

		tool(
			"switch_scene",
			{
				title: "Switch the active scene",
				description:
					"Make a different scene active through scene.switch and return its bus receipt. Without a connected editor, this changes MCP memory only.",
				inputSchema: { name: z.string().describe("scene name to switch to") },
			},
			async ({ name, ...admission }) => {
				if (liveHub?.connected) {
					try {
						return await runStudioCommand({ ...admission, action: "scene.switch", args: async () => {
							await refreshLiveDescription();
							const target = state.doc.scenes.find(row => row.name.toLowerCase() === name.toLowerCase());
							if (!target) throw new Error(`No scene "${name}".`);
							return { sceneId: target.id };
						} });
					} catch (error) {
						return liveError(error);
					}
				}
				const target = state.doc.scenes.find((s) => s.name.toLowerCase() === name.toLowerCase());
				if (!target) {
					return text(`No scene "${name}". Have: ${state.doc.scenes.map((s) => s.name).join(", ")}`);
				}
				const document = JSON.parse(JSON.stringify(state.doc));
				document.activeSceneId = target.id;
				state.doc = document;
				return text(`Switched to "${scene().name}".\n\n${sceneReport()}`);
			},
		),

		tool(
			"open_project",
			{
				title: "Open a .cclayproject file",
				description:
					"Load a project authored in the CozyClay studio (or saved here). Replacing scene ids in a connected editor requires a Studio-issued confirmationToken; returns the load_scenes bus receipt.",
				inputSchema: {
					path: z.string().describe("path to a .cclayproject file"),
					confirmationToken: z.string().min(1).max(120).optional().describe("token issued by the Studio UI for this exact scene document"),
				},
			},
			async ({ path, ...admission }) => {
				let full;
				let raw;
				try {
					const resolved = await resolveProjectPath(path, { existing: true });
					full = resolved.displayPath;
					const file = await openFile(resolved.descriptorPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
					try {
						await requirePrivateProjectInode(file);
						raw = await file.readFile("utf8");
					} finally {
						await file.close();
					}
				} catch (error) {
					return text(`Could not read project: ${error.message}`);
				}
				const result = readProjectDocument(raw);
				if (!result.ok) return text(`Not a usable project file (${result.reason}): ${full}`);

				// Round-trip through readSceneDocument so an older document is migrated to
				// the current stage shape rather than trusted as-is.
				const scenes = readSceneDocument(serializeSceneDocument(result.project.scenesDocument));
				if (!scenes.document) return text(`That project was written by a newer CozyClay: ${full}`);
				const { document: nextDocument, camera: savedCamera } = splitSavedCamera(scenes.document);
				if (liveHub?.connected) {
					try {
						const loaded = await executeStudioCommand({ ...admission, action: "load_scenes", args: { document: nextDocument } });
						if (loaded.ok) {
							state.name = result.project.name;
							state.focus = null;
							state.focusLocked = false;
							state.markedFraming = null;
						}
						return studioResult(loaded);
					} catch (error) {
						return liveError(error);
					}
				}
				state.doc = nextDocument;
				Object.assign(state.camera, savedCamera);
				state.previsMode = result.project.previsMode ?? DEFAULT_PREVIS_MODE;
				state.name = result.project.name;
				Object.assign(state, { focus: null, focusLocked: false, markedFraming: null });
				return text(`Opened ${full}.\n\n${sceneReport()}`);
			},
		),

		tool(
			"save_project",
			{
				title: "Save a .cclayproject file",
				description:
					"Write the current state as a .cclayproject file. The CozyClay studio opens this file " +
					"directly, so a scene blocked here can be finished in the UI.",
				inputSchema: {
					path: z.string().describe("destination path, ending in .cclayproject"),
					name: z.string().optional().describe("project name recorded in the file"),
					overwrite: z.boolean().default(false).describe("explicitly replace an existing project file"),
				},
			},
			async ({ path, name, overwrite }) => {
				if (name) state.name = name;
				if (liveHub?.connected) {
					try {
						await refreshLiveDescription();
					} catch (error) {
						return liveError(error);
					}
				}
				let full;
				try {
					const resolved = await resolveProjectPath(path, { existing: false });
					full = resolved.displayPath;
					path = resolved.descriptorPath;
				} catch (error) {
					return text(`Could not write project: ${error.message}`);
				}
				const project = serializeSavedProject({
					document: state.doc, camera: state.camera,
					name: state.name,
				});
				try {
					if (overwrite) {
						try {
							const existing = await openFile(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
							try {
								await requirePrivateProjectInode(existing);
							} finally {
								await existing.close();
							}
						} catch (error) {
							if (error?.code !== "ENOENT") throw error;
						}
					}
					const temporaryPath = `.${path}.${randomUUID()}.tmp`;
					const file = await openFile(
						temporaryPath,
						fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
						0o600,
					);
					try {
						await requirePrivateProjectInode(file);
						await file.writeFile(project, "utf8");
					} finally {
						await file.close();
					}
					try {
						if (overwrite) {
							await rename(temporaryPath, path);
						} else {
							await link(temporaryPath, path);
							await unlink(temporaryPath);
						}
					} catch (error) {
						await unlink(temporaryPath).catch(() => {});
						throw error;
					}
				} catch (error) {
					return text(`Could not write ${full}: ${error.message}`);
				}
				return text(`Saved "${state.name}" to ${full} (${state.doc.scenes.length} scene(s)).`);
			},
		),

		tool(
			"studio_commands",
			{
				title: "List Studio commands",
				description:
					"List every command the connected editor registers, for studio_run: id, label, kind (mutation, transient, job, document), " +
					"exposure, whether it is available now (the reason when not), and timeoutMs where declared. The list carries " +
					"no schemas; pass ids to read those commands' full declarations, description and input schema included.",
				inputSchema: {
					ids: z.array(z.string().min(1).max(120)).min(1).max(32).optional().describe("command ids whose full declarations to read"),
				},
			},
			async ({ ids }) => {
				if (!liveHub?.connected) return liveError(new Error(noLiveEditor("studio_commands requires a connected CozyClay editor.")));
				try {
					const listed = await liveHub.command("inspect_studio", { scope: "actions", ...(ids ? { ids } : {}) }, liveWorkspace.getStore());
					return text(JSON.stringify({ actions: listed?.actions ?? [] }));
				} catch (error) {
					return liveError(error);
				}
			},
		),

		tool(
			"studio_run",
			{
				title: "Run a Studio command",
				description:
					"Run one command the connected editor registers, by id, through the editor's command bus: the same door its UI and agent use. " +
					"args must match the command's input schema (read it with studio_commands and ids). The command is admitted at the open " +
					"document and its current revision unless expectedRevision is given, and answers the editor's JSON receipt: status, summary, " +
					"affectedIds, undo, and output for a job. A refusal is a receipt with ok false and its code: STALE_SCENE means read again and " +
					"re-issue; CONFIRMATION_REQUIRED means obtain the user's approval in Studio and pass its confirmationToken. Reusing a commandId returns the receipt of " +
					"that earlier call instead of running again.",
				inputSchema: {
					action: z.string().min(1).max(120).describe("command id, as studio_commands lists it"),
					args: z.record(z.string(), z.unknown()).default({}).describe("the command's arguments, matching its input schema"),
					expectedRevision: z.number().int().min(0).optional().describe("the scene revision the command is admitted at; defaults to the current one"),
					commandId: z.string().min(1).max(120).optional().describe("idempotency key; a repeated id answers the first call's receipt"),
					timeoutMs: z.number().int().min(1).max(MAX_COMMAND_TIMEOUT_MS).optional().describe("how long the hub waits; defaults to the command's declared timeout"),
					confirmationToken: z.string().min(1).max(120).optional().describe("Studio UI approval token for this exact command; MCP cannot mint one"),
				},
			},
			async (args) => {
				if (!liveHub?.connected) return liveError(new Error(noLiveEditor("studio_run requires a connected CozyClay editor.")));
				try {
					return await runStudioCommand(args);
				} catch (error) {
					return liveError(error);
				}
			},
		),
	];
};
