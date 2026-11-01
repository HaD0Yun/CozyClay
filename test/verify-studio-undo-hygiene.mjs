#!/usr/bin/env node
// Undo hygiene for the studio surfaces that write CAST-SNAPSHOT state without
// a scene-store transaction of their own: the key light (Inspector sliders,
// sun puck, move gizmo), the character Transform rows and the environment.
//
// Like verify-studio-agent-binding, the App's own functions are extracted from
// src/App.jsx and executed — a second implementation of the history stack here
// would pass while the studio still silently reverts the light (#345). The JSX
// call sites cannot be mounted without a browser, so they are pinned against
// the source the way verify-number-field-scrub pins the object Transform rows.
//
// The Studio commands are read from their own modules (src/commands/*.js), not
// from App.jsx: each module registers its actions over the generic port object,
// and every mutation must land in exactly one entry of its declared undo domain.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseSync } from "rolldown/experimental";
import {
	createCharacterEntry,
	createSceneDocument,
	createSceneStage,
	readSceneDocument,
	serializeSceneDocument,
} from "../src/scenes.js";
import { createKeyLight } from "../src/stage-lighting.js";
import { createProjectDocument, readProjectDocument } from "../src/project.js";
import { createSceneHistoryStore } from "../src/document-store.js";
import { copyPhysicsKeys } from "../src/motion/physics-review.js";
import { HISTORY_LIMIT } from "../src/history.js";
import { createAppContext } from "../src/app-context.js";
import { createCommandBus } from "../src/command-bus.js";
import { createShot } from "../src/cuts.js";
import { createStudioCommandJournal, arrangement } from "../src/studio-agent-commands.js";
import { createStudioAppActions } from "../src/commands/index.js";
import { createSceneObject, setSceneObjectParent } from "../src/scene-objects.js";
import * as shotCommands from "../src/commands/shot.js";
import * as castCommands from "../src/commands/cast.js";
import * as motionCommands from "../src/commands/motion.js";
import * as objectCommands from "../src/commands/objects.js";
import * as viewCommands from "../src/commands/view.js";
import * as sceneCommands from "../src/commands/scene.js";
import * as projectCommands from "../src/commands/project.js";
import * as exportCommands from "../src/commands/export.js";
import * as aiCommands from "../src/commands/ai.js";

import { readStudioSource } from "./bus/verify-domain-modules.mjs";
import { attachStageHistory } from "./bus/stage-hygiene-fixture.mjs";
import { castFixture } from './bus/cast-fixture.mjs';
import { stageFixture } from './bus/stage-fixture.mjs';
import { motionHygieneDomain, motionCommandInputs } from './bus/motion-hygiene-fixture.mjs';
const source = readStudioSource();
const parsed = parseSync("App.jsx", source);
assert.deepEqual(parsed.errors, []);
const declarations = new Map();
const initializers = new Map();
function visit(value) {
	if (!value || typeof value !== "object") return;
	if (value.type === "FunctionDeclaration") declarations.set(value.id.name, source.slice(value.start, value.end));
	if (value.type === "VariableDeclarator" && value.id.type === "Identifier" && value.init) {
		initializers.set(value.id.name, source.slice(value.init.start, value.init.end));
	}
	for (const [key, child] of Object.entries(value)) if (key !== "parent") Array.isArray(child) ? child.forEach(visit) : visit(child);
}
visit(parsed.program);
assert.equal(declarations.has('restoreCast'), false, 'native cast restoration is retired; only owned history restores documents');

// The App functions this suite drives. Missing ones are a failure, not a skip:
// the RED state of #345 is exactly "no such recording seam exists".
const APP_FUNCTIONS = [
	"snapshotIkKeys", "undoScene", "redoScene",
	"updateCharacterAt", "beginGestureUndo", "endGestureUndo", "changeKeyLight", "resetKeyLight",
	"changeKeyLightFromGizmo", "changeInspectorCharacter", "changeEnvironmentImage",
];
const ref = (current) => ({ current });

function fixture() {
	const characters = [createCharacterEntry({ id: "actor", x: 0, z: 0 }, 0)];
	const scope = {
		HISTORY_LIMIT,
		keyLight: createKeyLight(null),
		environmentImage: null,
		environment: "a sunlit modern living room",
		style: "moody cinematic lighting, 35mm film look",
		hasEnvSheet: false,
		characters,
		charactersRef: ref(characters),
		activeCharIndex: 0,
		shots: [],
		committedIkEdits: [],
		bufferRef: ref({ waypoints: [], motion: null }),
		loadedLayerCharRef: ref("actor"),
		ikStateRef: ref({ keys: new Map(), tracked: new Set() }),
		ikStatesRef: ref(new Map()),
		charHistoryRef: ref({ past: [], future: [] }),
		opClockRef: ref(0),
		lastObjectOpRef: ref(0),
		gestureUndoRef: ref(null),
		environmentTextSessionRef: ref(null),
		studioBindingRef: ref(null),
		suppressObjectClockRef: ref(false),
		store: createSceneHistoryStore([], { onObjects: () => {}, onCommit: () => {} }),
		objectDeleteUndo: null,
		selectedSceneObjectId: null,
		createKeyLight,
		createIkState: () => ({ keys: new Map(), tracked: new Set() }),
		copyPhysicsKeys,
		ko: (english) => english,
	};
	scope.appContext = createAppContext({ clock: scope.opClockRef, history: scope.charHistoryRef, objectClock: scope.lastObjectOpRef, suppressObjectClock: scope.suppressObjectClockRef, characters: scope.charactersRef, notify: (...args) => scope.setToast(...args) }).forRender(scope);
	scope.stageDomain = scope;
	scope.castDomain = scope;
	scope.motionDomain = scope;
	Object.defineProperty(scope, "activeChar", { get: () => scope.characters[0] });
	const assign = (key) => (value) => {
		scope[key] = typeof value === "function" ? value(scope[key]) : value;
		if (key === "characters") scope.charactersRef.current = scope.characters;
	};
	scope.setKeyLight = assign("keyLight");
	scope.setEnvironmentImage = assign("environmentImage");
	scope.setEnvironment = assign("environment");
	scope.setStyle = assign("style");
	scope.setHasEnvSheet = assign("hasEnvSheet");
	scope.setCharacters = assign("characters");
	// editCharacters is the semantic-state writer the Inspector rows go through.
	scope.editCharacters = (next) => assign("characters")(typeof next === "function" ? next(scope.characters) : next);
	for (const name of ["setShots", "setWaypoints", "setPromptClips", "setMotion", "setActiveCharacterId", "setCommittedIkEdits", "setIkTick", "setToast", "setSelectedHierarchyId", "setObjectDeleteUndo"]) scope[name] = () => {};
	// `with` re-reads the scope on every access, so the extracted functions see
	// the live values the fake setters write — a parameter list would freeze them.
	const evaluate = (code) => new Function("scope", `with (scope) { return (${code}); }`)(scope);
	assert.ok(initializers.has("snapshotCast"), "App must keep snapshotCast as the cast history snapshot");
	scope.snapshotCast = evaluate(initializers.get("snapshotCast"));
	for (const name of APP_FUNCTIONS) {
		assert.ok(declarations.has(name), `App must declare ${name}`);
		scope[name] = evaluate(declarations.get(name));
	}
	attachStageHistory(scope);
	return { scope, depth: () => scope.charHistoryRef.current.past.length + scope.documentStore.depths().past };
}

const COMMAND_MODULES = {
	shot: shotCommands, cast: castCommands, motion: motionCommands, objects: objectCommands, view: viewCommands,
	scene: sceneCommands, project: projectCommands, export: exportCommands, ai: aiCommands,
};
// The undo domains the editor's native history owns (App's recordStudioAction).
const HISTORY_DOMAINS = ["shot", "cast", "motion", "objects", "scenes"];
const unit = { x: 0, y: 0, z: 0, w: 1 };
// One valid call per command the hygiene cases run through the bus.
const COMMAND_INPUTS = {
	...motionCommandInputs,
	"shot.create": {}, "shot.split": { shotId: "shot-1" }, "shot.duplicate": { shotId: "shot-1" }, "shot.remove": { shotId: "shot-1" },
	"shot.setRange": { shotId: "shot-1", range: { startFrame: 1, endFrameExclusive: 15 } }, "shot.reorder": { shotId: "shot-1", startFrame: 2 },
	"shot.setCameraRail": { shotId: "shot-1", points: [{ x: -2, z: 4 }, { x: 3, z: 4 }] }, "shot.clearCameraRail": { shotId: "shot-1" },
	"shot.createStill": { caption: "Panel" }, "shot.setCaption": { shotId: "shot-1", caption: "Panel" },
	"shot.setCastOverride": { shotId: "shot-1", characterId: "actor", override: { x: 1, z: 2, rot: 0 } }, "shot.setHold": { shotId: "shot-1", hold: 24 },
	"shot.set": { id: "shot-1", set: { targetModel: "seedance-2.5" } }, "shot.rename": { shotId: "shot-1", name: "Renamed" },
	"shot.setCamera": { shotId: "shot-1", patch: { mode: "follow" } }, "shot.setCameraMode": { shotId: "shot-1", mode: "follow" }, "shot.addKey": { shotId: "shot-1", frame: 8 },
	"shot.moveKey": { shotId: "shot-1", keyId: "key-1", frame: 8 }, "shot.removeKey": { shotId: "shot-1", keyId: "key-1" },
	"shot.clearKeys": { shotId: "shot-1" }, "shot.setTimeline": { frameCount: 96 }, "shot.setLens": { fovDeg: 35 },
	"shot.frame": { preset: "mocapInteraction" }, "shot.replace": { shots: [createShot("Replacement", 0, 23)] },
	"shot.captureCamera": { shotId: "shot-1" }, "shot.placeCamera": { x: 2 }, "shot.setStylized": { shotId: "shot-1", assetId: `img-${"e".repeat(32)}` },
	'character.set': { id: 'actor', set: { subject: 'Generic' } },
	'character.add': { character: { id: 'actor-new', subject: 'New' } },
	'character.remove': { characterId: 'actor-other' },
	'character.update': { characterId: 'actor', patch: { x: 2 } },
	'character.move': { characterId: 'actor', x: 2, z: 0, rot: 0 },
	'character.setPose': { characterId: 'actor', pose: { id: 'new-pose', bones: {} } },
	'characters.arrange': { ops: [{ op: 'remove', characterId: 'actor-other' }] },
	'cast.replace': { characters: [createCharacterEntry({ id: 'replacement' })] },
	'cast.setCustomPoses': { poses: [] },
	'cast.savePose': { pose: { id: 'saved', bones: {} }, characterId: 'actor' },
	'cast.removePose': { id: 'saved' },
	'cast.showExtras': { show: true },
	'cast.setLayer': { characterId: 'actor', layer: { waypoints: [] } },
	'motion.clear': { characterId: 'actor' },
	"character.addWaypoint": { characterId: "actor", position: { x: 0, z: 2 }, frame: 40 },
	"character.moveWaypoint": { characterId: "actor", position: { x: 0, z: 1.1 }, frame: 24 },
	"character.removeWaypoint": { characterId: "actor", frame: 24 }, "character.clearWaypoints": { characterId: "actor" },
	"character.setIkKey": { characterId: "actor", frame: 12, tracks: { head: { q: [unit] } } },
	"character.removeIkKey": { characterId: "actor", frame: 12 }, "character.clearIkKeys": { characterId: "actor" },
	"object.attach": { objectId: "object-1", characterId: "actor" }, "object.detach": { objectId: "object-1" }, "object.duplicate": { objectId: "object-1" },
	"asset.import": { source: "https://assets.example.test/poster.png", name: "poster.png", placeAs: "cutout" },
	"object.set": { id: "object-1", set: { name: "Generic" } }, "object.add": { kind: "cone" },
	"object.sculpt": { recipe: { parts: [{ id: "body", shape: "blob", size: [0.4, 0.6, 0.4], position: [0, 0.3, 0] }] } },
	"object.remove": { ids: ["object-1"] }, "object.rename": { id: "object-1", name: "Renamed" },
	"object.update": { id: "object-1", patch: { x: 2 } },
	"object.group": { parent: "group-2", children: ["object-1"] }, "object.ungroup": { children: ["object-1"] },
	"object.groupUnderEmpty": { id: "object-1" },
	"objects.arrange": { ops: [{ op: "remove", id: "object-1" }] }, "objects.replace": { objects: [createSceneObject("cone")] },
	"view.setPartColours": { mode: "flat" }, "view.setGuideMode": { mode: "thirds" }, "view.setInset": { collapsed: true }, "view.setGhosts": { mode: "step", count: 3 }, "view.frame": { position: { x: 3, y: 1.6, z: 3 }, lookAt: { x: 0, y: 1, z: 0 } },
	"view.select": { selection: { kind: 'character', id: 'actor' } }, "timeline.seek": { frame: 12 }, "timeline.play": { playing: true },
	"view.setMode": { mode: 'camera' }, "view.update": { frame: 8, playing: false, mode: 'motion' },
	"scene.create": {}, "scene.duplicate": { sceneId: "scene-1" }, "scene.rename": { sceneId: "scene-1", name: "Renamed" },
	"scene.delete": { sceneId: "scene-2" }, "scene.switch": { sceneId: "scene-2" }, "project.save": {},
	"scene.set": { id: "scene-1", set: { name: "Generic" } }, "scene.reorder": { sceneId: "scene-1", order: 1 },
	"project.rename": { name: "Renamed project" }, "project.saveAs": {}, "project.exportAsAnimation": {}, "project.new": { name: "New project" },
	"project.open": { serialized: "project" }, "project.openStarter": { id: "starter" }, "project.restore": { handleToken: "handle" }, "project.browse": {},
	"load_scenes": { document: { version: 4, activeSceneId: "scene-1", scenes: [{ id: "scene-1", name: "ONE" }] } },
};

// Every command module registered over one generic port object and driven
// through the real command bus. The history stand-in records which domain each
// entry is opened in, and the ports record whether a write landed inside it.
function commandFixture({ frame = 8, still = false } = {}) {
	const host = { workspaceId: "workspace", documentEpoch: "document", sceneId: "scene-1", sceneEpoch: "epoch" };
	const state = {
		shots: [{ ...createShot("Shot 1", 0, 15, [{ id: "key-1", frame: 0, framing: { pos: { x: 0, y: 1.6, z: 5 }, yaw: 0, pitch: 0, fovDeg: 40 } }], { mode: "rail", cameraRail: [{ x: -2, z: 4 }, { x: 2, z: 4 }] }), id: "shot-1", ...(still ? { kind: "still" } : {}) }],
		objects: [{ ...createSceneObject("sphere"), id: "parent-1" }, { ...createSceneObject("cube"), id: "object-1", parent: "parent-1" }, { ...createSceneObject("cylinder"), id: "group-2" }],
		characters: [createCharacterEntry({ id: 'actor', subject: 'Ada', layer: { waypoints: [] } }), createCharacterEntry({ id: 'actor-other' })], customPoses: [], frame, frameCount: 48, selectedObjectId: null, activeCharacterId: "actor",
		promptBlockCount: 0, generating: false, motionReady: true, exporting: false, canExportVideo: true,
		scenes: [{ id: "scene-1", name: "ONE" }, { id: "scene-2", name: "TWO" }], activeSceneId: "scene-1",
		project: { name: "Heist", previsMode: "animation", hasFile: true, fileAccess: false, gesture: false },
		aiShot: { mode: "image", imageModel: "gpt_image_2" }, i2vMotion: { enabled: false, status: "idle", dailyRemaining: null },
	};
	const entries = [], writes = [];
	let recording = null, revision = 0, objectDomain, sceneDomain, shotDomain, castDomain, motionDomain;
	const answers = {
		// Like the editor's, every read is a fresh snapshot of the document.
		state: () => ({ ...state }),
		readView: () => ({ ...state, host, selection: state.selection ?? null,
			view: state.view ?? { mode: 'scene', frame, playing: false, lookThrough: false, grid: false, autoColor: false } }),
		publishView: value => Object.assign(state, value),
		storeDomain: name => name === 'objects' ? objectDomain : name === 'scenes' ? sceneDomain : name === 'shot' ? shotDomain : name === 'cast' ? castDomain : name === 'motion' ? motionDomain : undefined,
		writeCharacters: rows => { state.characters = rows; },
		writeCastState: next => { Object.assign(state, next); },
		writePose: (id, pose) => { state.characters = state.characters.map(entry => entry.id === id ? { ...entry, pose } : entry); },
		writeShots: rows => { state.shots = rows; },
		writeShotState: value => { Object.assign(state, value); },
		writeObjects: rows => { state.objects = rows; },
		writeScenes: rows => { state.scenes = rows; },
		writeProject: name => { state.project = { ...state.project, name }; },
		renameSceneDocument: (id, name) => { state.scenes = state.scenes.map(row => row.id === id ? { ...row, name } : row); },
		projectAction: () => true,
		loadScenes: args => ({ activeSceneId: args.document.activeSceneId }),
		duplicateSelectedSceneObject: id => { state.objects = [...state.objects, { ...state.objects.find(row => row.id === id), id: 'object-2' }]; },
		addCharacterWaypoint: (id, position, frame) => ({ waypoint: { frame: frame ?? 12, ...position }, index: 0, warnings: [] }),
		moveCharacterWaypoint: (id, frame, position) => ({ waypoint: { frame, ...position }, warnings: [] }),
		clearCharacterWaypoints: () => 1, clearCharacterIkKeys: () => 1,
		fetchImportSource: async () => "data:image/png;base64,AAAA",
		importAsset: async () => ({ objectId: "object-2", assetId: "img-1" }),
		saveProject: async () => ({ saved: true, name: "Heist", fileName: "Heist.cclayproject" }),
		afterRender: async () => {},
	};
	const ports = new Proxy({}, {
		get: (_, name) => ["state", "storeDomain", "readView"].includes(name) ? answers[name] : (...args) => {
			writes.push({ name, inside: recording });
			// A write republishes the document, so a diff of rows sees the edit.
			state.shots = state.shots.map(row => ({ ...row }));
			state.objects = state.objects.map(row => ({ ...row }));
			return answers[name]?.(...args);
		},
	});
	castDomain = {
		read: () => state.characters, state: () => ({ characters: state.characters, customPoses: state.customPoses }),
		write: update => ports.writeCharacters(typeof update === 'function' ? update(state.characters) : update),
		update: (id, patch) => ports.writeCharacters(state.characters.map(entry => entry.id === id ? { ...entry, ...patch } : entry)),
		writeState: update => ports.writeCastState(typeof update === 'function' ? update(castDomain.state()) : update),
		applyPose: (id, pose) => ports.writePose(id, pose), showExtras: () => ports.writeCharacters([...state.characters]),
		extendTimeline: () => ports.writeCharacters([...state.characters]), poses: () => [],
		arrange: args => { const plan = arrangement({ name: 'arrange_characters', args }, state, { bounds: () => [] }); ports.writeCharacters(plan.draft); return plan; },
	};
	shotDomain = {
		read: () => state.shots, state: () => ({ frameCount: state.frameCount }),
		write: update => ports.writeShots(typeof update === 'function' ? update(state.shots) : update),
		writeState: update => ports.writeShotState(typeof update === 'function' ? update(state) : update),
		capture: () => ({ pos: { x: 0, y: 1.6, z: 5 }, yaw: 0, pitch: 0, fovDeg: 40 }),
		// This fixture measures the history boundary. The real framing planner
		// and renderer publication are exercised by verify-shots-commands.
		frame: () => { ports.writeShots([...state.shots]); return { affectedIds: ['shot-1'], checks: { coverage: 'same-frame-subject-bounds-projection', derivedSize: 'wide shot' }, warnings: [], details: { shotId: 'shot-1', frame: 0 } }; },
		setLens: fovDeg => ports.writeShotState({ fovDeg }),
		captureCamera: () => ports.writeShotState({ manual: true }),
		placeCamera: camera => ports.writeShotState({ camera }),
		setCastOverride: (shotId, characterId, override) => ports.writeShots(state.shots.map(shot => shot.id === shotId ? { ...shot, cast: { ...shot.cast, [characterId]: override } } : shot)),
	};
	objectDomain = {
		read: () => state.objects,
		write: rows => ports.writeObjects(rows),
		group: (parent, children) => ports.writeObjects(children.reduce((rows, id) => setSceneObjectParent(rows, id, parent), state.objects)),
		arrange: args => {
			const plan = arrangement({ name: 'arrange_objects', args }, state, { bounds: () => [] });
			ports.writeObjects(plan.draft); return plan;
		},
	};
	sceneDomain = {
		read: () => state.scenes,
		write: rows => ports.writeScenes(rows),
		metadata: () => ({ name: state.project.name, activeSceneId: state.activeSceneId, previsMode: state.project.previsMode }),
		renameProject: name => ports.writeProject(name),
		fileState: () => state.project,
		save: args => ports.saveProject(args.saveAs),
		exportAsAnimationProject: async () => ({ saved: true, name: "Heist - Animation", fileName: "Heist - Animation.cclayproject", downloaded: true }),
		projectAction: (...args) => ports.projectAction(...args),
		loadScenes: args => ports.loadScenes(args),
	};
	motionDomain = motionHygieneDomain(ports);
	motionDomain.setVideoDraft = patch => { state.i2vMotion = { ...state.i2vMotion, ...patch }; };
	const registries = Object.fromEntries(Object.entries(COMMAND_MODULES).map(([name, module]) => [name, createStudioAppActions(ports, { [name]: module })]));
	const journal = createStudioCommandJournal({ host });
	const bus = registry => createCommandBus({ registry, ports: {
		read: () => ({ host, revision, domainRevisions: {} }), journal: () => journal,
		recordAction(domain, run) {
			const entry = { domain, id: `entry-${entries.length + 1}` };
			entries.push(entry);
			recording = entry;
			const close = result => { recording = null; revision++; return { result, historyEntryId: entry.id }; };
			const result = run();
			return result?.then ? result.then(close, error => { recording = null; throw error; }) : close(result);
		},
	} });
	return { registries, bus, entries, writes };
}

const cases = {
	"each command module registers exactly its declarations, with their undo domains"() {
		const { registries } = commandFixture();
		for (const [name, module] of Object.entries(COMMAND_MODULES)) {
			const registry = registries[name];
			assert.deepEqual(registry.ids(), module.declarations.map(entry => entry.id), `${name}.js registers its declared actions`);
			for (const declaration of module.declarations) {
				const entry = registry.get(declaration.id);
				assert.equal(entry.kind, declaration.kind, `${declaration.id} keeps its kind`);
				assert.equal(entry.undoDomain, declaration.undoDomain, `${declaration.id} keeps its declared undo domain`);
				if (entry.kind === "mutation") assert.ok(HISTORY_DOMAINS.includes(entry.undoDomain), `${entry.id} names a history domain`);
				else assert.equal(entry.undoDomain, entry.id === 'asset.import' ? 'objects' : undefined, `${entry.id} retains its declared owner when promoted to a committing job`);
			}
		}
	},
	async "every command mutation writes inside one entry of its undo domain"() {
		const mutations = Object.values(COMMAND_MODULES).flatMap(module => module.declarations).filter(entry => entry.kind === "mutation");
		assert.equal(mutations.length, 78);
		for (const declaration of mutations) {
			// A new shot needs free room at the playhead; the others act inside shot-1.
			const f = commandFixture({ frame: declaration.id === "shot.create" ? 24 : 8, still: ["shot.setHold", "shot.createStill"].includes(declaration.id) }), [name] = Object.entries(COMMAND_MODULES).find(([, module]) => module.declarations.includes(declaration));
			const receipt = await f.bus(f.registries[name]).run(declaration.id, COMMAND_INPUTS[declaration.id]);
			assert.equal(receipt.ok, true, `${declaration.id}: ${JSON.stringify(receipt)}`);
			assert.deepEqual(f.entries.map(entry => entry.domain), [declaration.undoDomain], `${declaration.id} opens one ${declaration.undoDomain} entry`);
			assert.ok(f.writes.length > 0, `${declaration.id} writes through the ports`);
			for (const write of f.writes) assert.equal(write.inside, f.entries[0], `${declaration.id}: ${write.name} lands inside its entry`);
			assert.equal(receipt.undo?.historyEntryId, f.entries[0].id, `${declaration.id}'s receipt undoes that entry`);
		}
	},
	async "transient and document actions never open an undo entry"() {
		const outside = Object.values(COMMAND_MODULES).flatMap(module => module.declarations).filter(entry => ["transient", "document"].includes(entry.kind));
		assert.deepEqual(outside.map(entry => entry.id).sort(), Object.keys(COMMAND_INPUTS).filter(id => (/^(view|timeline|scene|project)\./.test(id) || ['load_scenes'].includes(id)) && !['scene.set', 'scene.rename', 'scene.reorder', 'project.rename'].includes(id)).sort());
		for (const declaration of outside) {
			const f = commandFixture(), [name] = Object.entries(COMMAND_MODULES).find(([, module]) => module.declarations.includes(declaration));
			const receipt = await f.bus(f.registries[name]).run(declaration.id, COMMAND_INPUTS[declaration.id]);
			assert.equal(receipt.ok, true, `${declaration.id}: ${JSON.stringify(receipt)}`);
			assert.deepEqual(f.entries, [], `${declaration.id} records no history`);
			assert.equal(receipt.undo, null, `${declaration.id} answers without an undo`);
		}
	},
	"an unrelated cast undo cannot revert the light"() {
		const f = castFixture(stageFixture());
		try {
			const { txId } = f.run('run.begin', { id: 'stage.setKeyLight', args: {} });
			for (const intensity of [2, 2.5]) assert.equal(f.run('run.update', { txId, args: { keyLight: { intensity } } }).ok, true);
			assert.equal(f.stage.documentStore.depths().past, 0, 'stage preview is uncommitted until gesture end');
			f.run('run.commit', { txId });
			f.cast.changeInspectorCharacter('x', { x: 1 });
			assert.equal(f.cast.read()[0].x, 1);
			f.actual.undoScene();
			assert.equal(f.cast.read()[0].x, 0, 'the cast edit undoes');
			assert.equal(f.stage.read().keyLight.intensity, 2.5, 'cast undo preserves the earlier light edit');
			f.actual.undoScene(); assert.deepEqual(f.stage.read().keyLight, createKeyLight(null));
		} finally { f.dispose(); }
	},
	"every key-light surface records one entry per gesture"() {
		const gestures = {
			"foldout brightness": [(s) => s.changeKeyLight("intensity", { intensity: 3 }), (s) => s.changeKeyLight("intensity", { intensity: 3.5 })],
			"foldout warmth": [(s) => s.changeKeyLight("warmth", { warmth: 0.1 }), (s) => s.changeKeyLight("warmth", { warmth: 0.9 })],
			"sun puck": [(s) => s.changeKeyLight("puck", { x: 7, y: 8, z: 3 }), (s) => s.changeKeyLight("puck", { x: 9, y: 8, z: 3 })],
			"move gizmo": [(s) => s.changeKeyLightFromGizmo("__keylight__", { x: 2, y: 5 }), (s) => s.changeKeyLightFromGizmo("__keylight__", { x: 3, y: 6 })],
		};
		for (const [name, ticks] of Object.entries(gestures)) {
			const f = fixture();
			const before = { ...f.scope.keyLight };
			for (const tick of ticks) tick(f.scope);
			assert.equal(f.depth(), 0, `${name}: a drag previews in the owned transaction`);
			const after = { ...f.scope.keyLight };
			assert.notDeepEqual(after, before, `${name}: the gesture moved the light`);
			f.scope.endGestureUndo();
			for (const tick of ticks) tick(f.scope);
			assert.equal(f.depth(), 1, `${name}: the second preview leaves the first committed entry`);
			f.scope.endGestureUndo();
			assert.equal(f.depth(), 2, `${name}: the next gesture commits a fresh entry`);
			f.scope.undoScene();
			assert.deepEqual(f.scope.keyLight, after, `${name}: undo returns the previous gesture's light`);
			f.scope.undoScene();
			assert.deepEqual(f.scope.keyLight, before, `${name}: undo returns the untouched light`);
			f.scope.redoScene();
			assert.deepEqual(f.scope.keyLight, after, `${name}: redo replays the gesture`);
		}
	},
	"the gizmo keeps the puck's half-height offset"() {
		const f = fixture();
		f.scope.changeKeyLightFromGizmo("__keylight__", { x: 2, y: 5, z: -1 });
		f.scope.endGestureUndo();
		assert.deepEqual(
			{ x: f.scope.keyLight.x, y: f.scope.keyLight.y, z: f.scope.keyLight.z },
			{ x: 2, y: 5.2, z: -1 },
			"routing the gizmo through the recorder must not change the geometry",
		);
	},
	"Reset light is one entry and undoes"() {
		const f = fixture();
		f.scope.changeKeyLight("intensity", { intensity: 3 });
		f.scope.endGestureUndo();
		f.scope.resetKeyLight();
		assert.equal(f.depth(), 2);
		assert.deepEqual(f.scope.keyLight, createKeyLight(null));
		f.scope.undoScene();
		assert.equal(f.scope.keyLight.intensity, 3, "Reset undoes back to the brightness that was set");
	},
	"Inspector character rows record once per scrub and per typed commit"() {
		for (const [axis, patch, read] of [
			["x", (value) => ({ x: value }), (entry) => entry.x],
			["y", (value) => ({ y: Math.max(0, value) }), (entry) => entry.y],
			["z", (value) => ({ z: value }), (entry) => entry.z],
			["rot", (value) => ({ rot: value }), (entry) => entry.rot],
			["scale", (value) => ({ scale: value }), (entry) => entry.scale],
		]) {
			const f = castFixture();
			try {
				const before = read(f.cast.read()[0]);
				f.cast.beginGesture();
				for (const value of [1, 1.5, 2]) f.cast.changeInspectorCharacter(axis, patch(value));
				assert.equal(f.cast.documentStore.depths().past, 0, `${axis}: a scrub is a store preview`);
				f.cast.finishGesture();
				assert.equal(f.cast.documentStore.depths().past, 1, `${axis}: the whole scrub is one entry`);
				const scrubbed = read(f.cast.read()[0]); assert.equal(scrubbed, 2);
				f.cast.changeInspectorCharacter(axis, patch(2.5));
				assert.equal(f.cast.documentStore.depths().past, 2, `${axis}: a typed commit records`);
				f.actual.undoScene(); assert.equal(read(f.cast.read()[0]), scrubbed);
				f.actual.undoScene(); assert.equal(read(f.cast.read()[0]), before);
				f.actual.redoScene(); assert.equal(read(f.cast.read()[0]), scrubbed);
			} finally { f.dispose(); }
		}
	},
	"the environment reference image records, undoes and redoes"() {
		const f = fixture();
		const a = "data:image/png;base64,YQ==";
		const b = "data:image/png;base64,Yg==";
		f.scope.changeEnvironmentImage(a);
		f.scope.changeEnvironmentImage(b);
		f.scope.changeEnvironmentImage(null);
		assert.equal(f.depth(), 3, "set, replace and clear are three entries");
		for (const expected of [b, a, null]) {
			f.scope.undoScene();
			assert.equal(f.scope.environmentImage, expected);
		}
		for (const expected of [a, b, null]) {
			f.scope.redoScene();
			assert.equal(f.scope.environmentImage, expected);
		}
	},
	"typed environment text is one entry per editing session"() {
		const f = fixture();
		const start = f.scope.environment;
		const { txId } = f.scope.run("run.begin", { id: "stage.setEnvironment", args: {} });
		for (const text of ["r", "ra", "rainy alley"]) {
			f.scope.run("run.update", { txId, args: { environment: text } });
		}
		assert.equal(f.depth(), 0, "typing previews until the session closes");
		f.scope.run("run.commit", { txId });
		assert.equal(f.depth(), 1, "typing is not one entry per keystroke");
		f.scope.run("stage.setStyle", { style: "watercolour" });
		assert.equal(f.depth(), 2, "a different field is a different session");
		f.scope.undoScene();
		assert.equal(f.scope.style, "moody cinematic lighting, 35mm film look");
		assert.equal(f.scope.environment, "rainy alley");
		f.scope.undoScene();
		assert.equal(f.scope.environment, start);
	},
	"environment description, style and sheet flag live in the stage document"() {
		const fields = { environment: "rainy alley", style: "watercolour", hasEnvSheet: true };
		const document = createSceneDocument();
		document.scenes[0].stage = createSceneStage(fields);
		const sceneRead = readSceneDocument(serializeSceneDocument(document));
		assert.equal(sceneRead.status, "valid");
		const projectRead = readProjectDocument(JSON.stringify(createProjectDocument({ scenesDocument: document })));
		assert.equal(projectRead.ok, true);
		for (const stage of [sceneRead.document.scenes[0].stage, projectRead.project.scenesDocument.scenes[0].stage]) {
			for (const [key, value] of Object.entries(fields)) assert.equal(stage[key], value, `${key} survives the round trip`);
		}
		const defaults = createSceneStage();
		assert.equal(typeof defaults.environment, "string");
		assert.ok(defaults.environment.length, "a new stage names a location");
		assert.equal(typeof defaults.style, "string");
		assert.ok(defaults.style.length, "a new stage names a look");
		assert.equal(defaults.hasEnvSheet, false);
		const malformed = createSceneStage({ environment: 7, style: {}, hasEnvSheet: "true" });
		for (const key of Object.keys(fields)) assert.deepEqual(malformed[key], defaults[key], `${key} repairs to the default`);
		const empty = createSceneStage({ environment: "", style: "" });
		assert.equal(empty.environment, "", "a deliberately empty description is kept");
		assert.equal(empty.style, "");
		// Old documents carry no such fields at all.
		const legacy = readSceneDocument(JSON.stringify({ version: 4, activeSceneId: "scene", scenes: [{ id: "scene", name: "OLD", objects: [], shotDocument: null, stage: { characters: [] } }] }));
		for (const key of Object.keys(fields)) assert.deepEqual(legacy.document.scenes[0].stage[key], defaults[key], `a pre-#345 document defaults ${key}`);
	},
	"the App save, load and live-describe paths carry the environment fields"() {
		const stageBuilder = source.slice(source.indexOf("actorStageRef.current = {"), source.indexOf("function snapshotActiveScene"));
		const liveStage = source.slice(source.indexOf("stage: { shotAspect: shotAspectKey"), source.indexOf("stage: { shotAspect: shotAspectKey") + 200);
		const openScene = source.slice(source.indexOf("function openScene"), source.indexOf("function openScene") + 4000);
		const snapshot = initializers.get("snapshotCast");
		for (const field of ["environment", "style", "hasEnvSheet"]) {
			assert.ok(new RegExp(`\\b${field}\\b`).test(stageBuilder), `the scene save builder writes ${field}`);
			assert.ok(new RegExp(`\\b${field}\\b`).test(liveStage), `the live describe stage reports ${field}`);
			assert.ok(/stageDomain\.load\(stage\)/.test(openScene), `opening a scene restores ${field} through the owned load boundary`);
			assert.equal(new RegExp(`\\b${field}\\b`).test(snapshot), false, `cast history no longer carries ${field}`);
		}
		assert.ok(/normalizeStage\(appContext.shared.startupStage\)/.test(source), "the first painted session reads the normalized stored stage");
	},
	"the studio call sites are wired to the recording seams"() {
		const lightFoldout = readFileSync(new URL('../src/panels/LightPanel.jsx', import.meta.url), 'utf8');
		assert.ok(/run\("run.update", .*intensity: value/.test(lightFoldout), "the Brightness slider previews through the bus");
		assert.ok(/run\("run.update", .*warmth: value/.test(lightFoldout), "the Warm/Cool slider previews through the bus");
		assert.ok(/onClick=\{\(\) => run\("stage.setKeyLight"/.test(lightFoldout), "Reset light records");
		const puck = source.slice(source.indexOf("<KeyLightPuck"), source.indexOf("<KeyLightPuck") + 900);
		assert.ok(/onChange=\{\(patch\) => changeKeyLight\("puck", patch\)\}/.test(puck), "the sun puck records on its first move");
		assert.ok(/onDragEnd=\{endGestureUndo\}/.test(puck), "the sun puck closes its gesture with the prop it already accepts");
		const gizmo = source.slice(source.indexOf("<ObjectGizmo"), source.indexOf("onGroundClick={waypointMode"));
		assert.ok(/id === "__keylight__" \? changeKeyLightFromGizmo/.test(gizmo), "the gizmo still routes the light through its own writer");
		assert.ok(/if \(lightGizmoObject\) endGestureUndo\(\);/.test(gizmo), "the light gizmo closes its gesture on drag end");
		const transform = readFileSync(new URL('../src/panels/CharacterTransformPanel.jsx', import.meta.url), 'utf8');
		for (const axis of ["x", "y", "z"]) {
			assert.ok(new RegExp(`onChange: \\(${axis}\\) => run\\('character.update'`).test(transform), `the ${axis} row records through run`);
			assert.ok(/onScrubStart: begin/.test(transform), `the ${axis} row arms its owned transaction`);
		}
		assert.equal((transform.match(/onScrubEnd: commit/g) ?? []).length, 5, 'every character position field commits its scrub');
		assert.ok(/onChange=\{\(rot\) => run\('character.update'/.test(transform), 'Rotation goes through run');
		assert.ok(/onChange=\{\(scale\) => run\('character.update'/.test(transform), 'Scale goes through run');
		const environmentFoldout = readFileSync(new URL('../src/panels/EnvironmentPanel.jsx', import.meta.url), 'utf8');
		assert.ok(/run\("stage.setEnvironment", \{ environmentImage: dataUrl \}\)/.test(environmentFoldout), "picking an environment reference records");
		assert.ok(/onClear=\{\(\) => run\("stage.setEnvironment", \{ environmentImage: null \}\)\}/.test(environmentFoldout), "clearing the environment reference records");
		assert.ok(/begin\("stage.setEnvironment"\)/.test(environmentFoldout), "the description records one entry per typing session");
		assert.ok(/begin\("stage.setStyle"\)/.test(environmentFoldout), "the look records one entry per typing session");
		assert.ok(/run\("stage.setEnvironment", \{ hasEnvSheet:/.test(environmentFoldout), "the environment sheet toggle records");
		assert.ok(/window\.addEventListener\("pointerup", end, true\)/.test(source), "a pointer release ends the open gesture");
		assert.ok(/window\.addEventListener\("keyup", end, true\)/.test(source), "a key release ends the open gesture");
	},
};

let failures = 0;
for (const [name, run] of Object.entries(cases)) {
	try {
		await run();
		console.log("PASS", name);
	} catch (error) {
		failures += 1;
		console.error("FAIL", name, "\n  " + String(error?.message).split("\n").join("\n  "));
	}
}
const total = Object.keys(cases).length;
console.log(`Studio undo hygiene: ${total - failures}/${total} passed`);
process.exit(failures ? 1 : 0);
