import { useState, useEffect, useSyncExternalStore, useRef, useMemo } from "react";
import { createDocumentStore } from '../document-store.js';
import { useDocumentDomain } from '../store/use-document-store.js';
import {
	hierarchyIdForIkFocus,
	REST_BONES,
} from "../app-stage.jsx";
import { copyPhysicsKeys } from "../motion/physics-review.js";
import {
	createIkState,
	ikTouch,
	ikKeyframes,
	ikRemoveKeyframe,
	ikSeedTargets,
	MID_TRACKS,
	solveEffectorSwing,
	ikPlantFeet,
	solveHipsTranslateToFloor,
	solveHipsTranslate,
	solveSwingAngle,
	ikSolvePlantedFeet,
	applyBodyContact,
	ikBakeKeyframe,
	ikEvaluate,
	resolveIkRig,
} from "../motion/ik.js";
import * as THREE from "three";
import { StudioProtocolError } from "../studio-agent-protocol.js";
import { applyTakeFrame } from "../motion3/playback.js";
import { advancePlayback, installPlaybackApplier } from "./playback.js";
import { ko } from "../locale.js";
import { isProxyFigure } from "../scenes.js";
import { refuseRigOnly } from "../character-kind.js";
import { restoreBindPositions, applyPose, applyHipsOffset } from "../poses.js";
import { bakeIkDragKey, bakeIkDragRange, chainsChangedBy, clampDragTarget, ikDragRecord, ikDragTouch, solveDragTarget } from "../motion/ik-drag.js";
import { fingersOf, solveFingerGesture, restFingers } from "../motion/fingers.js";
import { ikKeyJson, ikTrackKeyFromJson } from "../motion/ik-key-json.js";
import { chooseIkEntryPose } from "../ik-camera.js";
import { applyRangePin, captureRangePinTarget, normalizeRangePin, rangePinTargetWorld, rangePinTracks, removeRangePinKeys } from "../motion/range-pin.js";
import { rangePinObjectMatrixAt } from "../range-pin-object-transform.js";
import { PLACEMENT_TRACK, placementRows } from "../motion/placement-keys.js"; import { createPoseKeys } from "./motion/pose-keys.js";
import { ensureRangePinState, overlappingRangePin, rangePinConflictFrames, rangePinOverlapMessage } from "./motion/motion-range-pin-rules.js";

import { takeSource, normalizeTakeSource, compileTakeSource, renderTakeEdit } from "./motion/take-source.js";
import { sameMotionIntent, emptyMotionLayer, encodeMotionKeys, decodeMotionKeys, cloneRangePin, encodeRangePins, decodeRangePins, encodeRangePinResiduals, decodeRangePinResiduals } from "./motion/motion-intent-codec.js";
// Plain intent owns take identities and JSON keys. Decoded buffers and rig
// preimages are copy-on-record runtime resources, never mutable store values.
export function createMotionDomain(appContext, characters) {
	const takes = new Map(), decoded = new WeakMap(), rigImages = new WeakMap();
	let running = 0;
	const references = entries => entries.map(entry => {
		const saved = normalizeTakeSource(entry.motionTake), take = saved ? restoredTake(entry.id, saved) : null;
		// The saved Pose-mode / IK edits come back with the scene (scenes.js ikEdits).
		const edits = entry.ikEdits;
		return { id: entry.id, take, fullTake: take, ikKeys: edits?.keys ?? [], ikPins: edits?.pins ?? [], ikPinResiduals: edits?.pinResiduals ?? [] };
	});
	// A take v3 keeps its source (spec, placement, scene) in the authored layer, so a reload
	// or an undo past a pruned resource compiles the same bones again (take-source.js).
	function snapshotTake(take, resourceId = crypto.randomUUID(), source = null, stored = true) {
		if (!take) return null;
		if (take.resourceId) return { ...take };
		if (stored) takes.set(resourceId, structuredClone(take));
		source ??= takeSource(take, appContext.shared.storeRef?.current?.objects ?? appContext.shared.sceneObjects);
		return { resourceId, frames: take.frames, fps: take.fps, prompt: take.prompt ?? '', studioTakeId: take.studioTakeId ?? resourceId, ...(source ? { source } : {}), ...(take.edit ? { edit: take.edit } : {}) };
	}
	const restoredTake = (id, { takeId, edit, ...source }) => snapshotTake({ schema: source.schema, frames: Math.round(source.spec.frames), fps: 24,
		prompt: source.spec.label ?? '', studioTakeId: takeId, edit }, `restore:${id}:${takeId ?? 'take-v3'}`, source, false);
	const normalize = rows => rows.map(row => ({ ...emptyMotionLayer(row.id), ...row,
		take: snapshotTake(row.take), fullTake: snapshotTake(row.fullTake ?? row.take),
		ikKeys: row.ikKeys ?? [], ikPins: row.ikPins ?? [], ikPinResiduals: row.ikPinResiduals ?? [], committedIkEdits: row.committedIkEdits ?? [] }));
	let native = createDocumentStore({ owned: { motion: normalize(references(characters)) } });
	const listeners = new Set(), notify = () => { for (const listener of listeners) listener(); };
	let release = native.subscribe(notify), viewRevision = 0;
	const documentStore = { ...Object.fromEntries(Object.keys(native).map(key => [key, (...args) => native[key](...args)])),
		subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); } };
	const read = () => documentStore.read('motion'), layer = id => read().find(row => row.id === id) ?? emptyMotionLayer(id);
	function materialize(take) {
		if (take?.source && !takes.has(take.resourceId)) {
			try { const compiled = compileTakeSource(take.source); if (compiled) takes.set(take.resourceId, compiled); }
			catch (error) { console.warn('[cozyclay] could not compile the saved take', error); }
		}
		if (!take || !takes.has(take.resourceId)) return null;
		if (!decoded.has(take)) {
			const { resourceId, ...metadata } = take;
			decoded.set(take, renderTakeEdit({ ...takes.get(resourceId), ...metadata }));
		}
		return decoded.get(take);
	}
	const motionFor = id => materialize(layer(id).take), fullMotionFor = id => materialize(layer(id).fullTake), visibleMotion = motionFor;
	const frame = () => appContext.live.state?.timeline.currentFrame ?? 0, rigFor = id => appContext.shared.rigs[id];
	// Rig-only tools refuse a capsule figure by name before looking for its rig.
	const rigOnly = (id, feature) => refuseRigOnly(appContext.storeDomain('cast')?.read().find(row => row.id === id), feature);
	function rigSnapshots() {
		return new Map(Object.entries(appContext.shared.rigs).map(([id, rig]) => [id, appContext.shared.snapshotExportRig(rig)]));
	}
	let publishedIds = new Set();
	function project() {
		const cast = appContext.storeDomain('cast'), states = appContext.shared.ikStatesRef.current, savedRigs = rigImages.get(read());
		const ids = new Set([...publishedIds, ...read().map(row => row.id)]);
		for (const id of ids) {
			const row = layer(id), take = visibleMotion(id), full = fullMotionFor(id);
			cast.publishMotion(id, take); cast.publishPlacement?.(id, placementRows(row.ikKeys));
			if (full) appContext.shared.motionFullRef.current.set(id, full); else appContext.shared.motionFullRef.current.delete(id);
			const state = states.get(id) ?? createIkState();
			state.keys = decodeMotionKeys(row.ikKeys); state.tracked = new Set([...state.keys.values()].flatMap(entry => [...entry.keys()]).filter(track => track !== PLACEMENT_TRACK));
			state.pins = decodeRangePins(row.ikPins);
			state.pinResiduals = decodeRangePinResiduals(row.ikPinResiduals);
			states.set(id, state);
			const rig = rigFor(id);
			if (rig) {
				const resolved = resolveIkRig(rig); if (resolved) Object.assign(state, resolved, { rig });
				if (savedRigs?.has(id)) appContext.shared.restoreExportRig(savedRigs.get(id));
				else if (resolved) poseKeys.poseRig(id, rig, resolved, state, take, frame());
			}
		}
		publishedIds = new Set(read().map(row => row.id));
		const id = appContext.shared.loadedLayerCharRef.current;
		// A character without a motion row keeps its live IK state in the map, so its first drag bakes.
		appContext.shared.ikStateRef.current = states.get(id) ?? states.set(id, createIkState()).get(id);
		appContext.shared.bufferRef.current = { ...appContext.shared.bufferRef.current, motion: visibleMotion(id), ik: appContext.shared.ikStateRef.current };
		domain.onProject?.(); viewRevision++;
	}
	const poseKeys = createPoseKeys({ appContext, rigFor, visibleMotion: id => visibleMotion(id), editKeys: (id, mutate) => editKeys(id, mutate), run: (id, args) => run(id, args) });
	const unsubscribe = documentStore.subscribe(project);
	function write(update) {
		return documentStore.write('motion', before => {
			const next = normalize(typeof update === 'function' ? update(before) : update);
			return sameMotionIntent(before, next) ? before : next;
		});
	}
	function writeLayer(id, patch) {
		return write(rows => rows.some(row => row.id === id) ? rows.map(row => row.id === id ? { ...row, ...patch } : row) : [...rows, { ...emptyMotionLayer(id), ...patch }]);
	}
	function pruneTakes() {
		const history = documentStore.history(), ids = new Set([read(), ...[...history.past, history.present, ...history.future].map(entry => entry.snapshot.motion)]
			.flatMap(rows => rows.flatMap(row => [row.take?.resourceId, row.fullTake?.resourceId])).filter(Boolean));
		for (const id of takes.keys()) if (!ids.has(id)) takes.delete(id);
	}
	function beginAction(preimages = null) {
		// The bus passes a target id; an explicit preview commit can override
		// only its rig's preimage without retaining the preview in Undo.
		rigImages.set(read(), new Map([...(gesture?.rigs ?? rigSnapshots()), ...(preimages instanceof Map ? preimages : [])]));
		const session = documentStore.beginAction('motion');
		return { ...session,
			run(fn) { return session.run(() => { running++; try { return fn(); } finally { running--; } }); },
			commit() { const result = session.commit(); rigImages.set(read(), rigSnapshots()); pruneTakes(); return result; },
		};
	}
	function setKeys(id, keys) { return writeLayer(id, { ikKeys: encodeMotionKeys(keys) }); }
	function setRangePinState(id, state) {
		return writeLayer(id, { ikKeys: encodeMotionKeys(state.keys), ikPins: encodeRangePins(state.pins), ikPinResiduals: encodeRangePinResiduals(state.pinResiduals) });
	}
	function rangePinState(id) {
		const row = layer(id), keys = decodeMotionKeys(row.ikKeys);
		return { ...createIkState(), keys, tracked: new Set([...keys.values()].flatMap(entry => [...entry.keys()])), pins: decodeRangePins(row.ikPins), pinResiduals: decodeRangePinResiduals(row.ikPinResiduals) };
	}
	function removePin(id, pinId) {
		const state = rangePinState(id);
		removeRangePinKeys(state, pinId); state.pins.delete(pinId); state.pinResiduals.delete(pinId);
		setRangePinState(id, state);
	}
	function bakeRangePin(id, spec, replaceExisting = false, projectionOnly = false) {
		rigOnly(id, 'ik');
		const motion = motionFor(id), rig = rigFor(id), resolved = rig && resolveIkRig(rig);
		if (!motion || !resolved) throw new StudioProtocolError('TARGET_NOT_READY', 'Load a take and rig for this character first.');
		const pin = normalizeRangePin(spec, { clipFrames: motion.frames }), state = rangePinState(id);
		const tracks = rangePinTracks(pin);
		const overlap = [...state.pins.values()].find(other => other.id !== pin.id && rangePinTracks(other).some(track => tracks.includes(track)) && Math.max(pin.startFrame, other.startFrame) <= Math.min(pin.endFrame, other.endFrame));
		if (overlap) throw new StudioProtocolError('INVALID_ARGUMENT', 'A required track already has an overlapping pin.');
		for (let at = pin.startFrame; at <= pin.endFrame; at++) {
			const entry = state.keys.get(at); if (!entry) continue;
			for (const track of tracks) if (entry.has(track) && entry.get(track).pin !== pin.id) {
				if (!replaceExisting) throw new StudioProtocolError('INVALID_ARGUMENT', 'Confirm Replace existing keys before applying this pin.');
				entry.delete(track);
			}
			if (!entry.size) state.keys.delete(at);
		}
		const objectWorldMatrix = (objectId, at) => {
			const object = appContext.shared.sceneObjects.find(entry => entry.id === objectId);
			if (!object) return null;
			const local = rangePinObjectMatrixAt(object, at, { frameCount: motion.frames, fps: motion.fps }, new THREE.Matrix4());
			const parent = object.attach && appContext.shared.attachFrameRef?.current?.(object.attach.characterId, object.attach.bone ?? null, new THREE.Matrix4());
			return parent ? parent.multiply(local) : local;
		};
		const applyRaw = at => appContext.shared.poseMemberAtFrame(rig, motion, null, at);
		const savedKeys = state.keys;
		let result;
		try {
			result = applyRangePin({ ...resolved, ikState: state, pin, objectWorldMatrix, applyRaw,
				applyLayer(at) { applyRaw(at); ikEvaluate(resolved.chains, state, at, resolved.fkJoints, 6); } });
		} finally { state.keys = savedKeys; }
		removeRangePinKeys(state, pin.id);
		for (const [at, entry] of result.entries) {
			let frameEntry = state.keys.get(at); if (!frameEntry) state.keys.set(at, (frameEntry = new Map()));
			for (const [track, key] of entry) { frameEntry.set(track, key); state.tracked.add(track); }
		}
		state.pins.set(pin.id, cloneRangePin(pin));
		state.pinResiduals.set(pin.id, result.residuals.map(entry => ({ ...entry })));
		// A reload refreshes only the projected bake; authored edits use the bus.
		if (projectionOnly) Object.assign(appContext.shared.ikStatesRef.current.get(id), state);
		else setRangePinState(id, state);
		return { residuals: result.residuals };
	}
	function editKeys(id, mutate) {
		const state = { ...createIkState(), keys: decodeMotionKeys(layer(id).ikKeys) };
		state.tracked = new Set([...state.keys.values()].flatMap(entry => [...entry.keys()]));
		const result = mutate(state); setKeys(id, state.keys); return result;
	}
	function setKey(id, at, tracks) {
		editKeys(id, state => {
			const incoming = decodeMotionKeys([{ frame: at, tracks }]).get(at), entry = state.keys.get(at) ?? new Map();
			for (const [track, key] of incoming) entry.set(track, key); state.keys.set(at, entry);
		});
	}
	function synchronizeTimeline() { appContext.storeDomain('cast').syncTimeline(); }
	// Install a take (motion.compile): one descriptor serves as both the visible and the full take.
	function replace(id, take, { ikKeys = [], ikPins = [], ikPinResiduals = [] } = {}) {
		const descriptor = snapshotTake(take);
		writeLayer(id, { take: descriptor, fullTake: descriptor, ikKeys, ikPins, ikPinResiduals, committedIkEdits: [] });
		synchronizeTimeline();
	}
	function clear(id) {
		writeLayer(id, { take: null, fullTake: null, ikKeys: [], ikPins: [], ikPinResiduals: [], committedIkEdits: [] });
		synchronizeTimeline();
	}
	// `preimage` is the rig before a drag: by drag end the rig already shows the drag, so the
	// image the action records for Undo would otherwise be the dragged pose.
	function bakeCurrentKey(id, at, dragIds = null, preimage = null) { const before = read(), receipt = bakeKey(id, at, dragIds); if (receipt?.ok && read() !== before && preimage) rigImages.get(before)?.set(id, preimage); return receipt; }
	function bakeKey(id, at, dragIds) {
		const rig = rigFor(id), resolved = rig && resolveIkRig(rig);
		if (!resolved) return null;
		const take = motionFor(id);
		if (dragIds) {
			const keyed = bakeIkDragKey(resolved.chains, resolved.fkJoints, at, dragIds, take
				? (rawRig) => applyTakeFrame(rawRig, take, at)
				: null);
			if (keyed && take) for (const key of keyed.values()) key.blend = 6;
			return keyed ? run('ik.setKey', { characterId: id, frame: at, tracks: ikKeyJson(keyed) }) : null;
		}
		// The loaded character's tracks are on the live slot, as in ikStateFor.
		const scratch = { ...createIkState(), tracked: new Set((id === appContext.shared.loadedLayerCharRef.current ? appContext.shared.ikStateRef.current : appContext.shared.ikStatesRef.current.get(id))?.tracked) };
		ikBakeKeyframe(resolved.chains, scratch, at, resolved.fkJoints);
		const keyed = encodeMotionKeys(scratch.keys)[0];
		return keyed ? run('ik.setKey', { characterId: id, frame: at, tracks: keyed.tracks }) : null;
	}
	function keyPose(id, at, pose) {
		rigOnly(id, 'pose');
		const rig = rigFor(id), resolved = rig && resolveIkRig(rig);
		if (!resolved) throw new StudioProtocolError('TARGET_NOT_READY', 'The character rig is not loaded.');
		restoreBindPositions(rig); restFingers(resolved.fkJoints); applyPose(rig, { ...REST_BONES, ...pose.bones }); applyHipsOffset(rig, pose.rootY ?? 0);
		editKeys(id, state => {
			state.tracked = new Set([...resolved.chains.keys(), ...resolved.fkJoints.keys()]);
			ikBakeKeyframe(resolved.chains, state, at, resolved.fkJoints);
		});
	}
	function run(id, args) {
		const result = appContext.bus.run(id, args);
		const checked = receipt => { if (!receipt.ok) throw new StudioProtocolError(receipt.code, receipt.message); return receipt; };
		return result?.then ? result.then(checked) : checked(result);
	}
	let gesture = null;
	function finishGesture(cancel = false) {
		if (!gesture) return;
		const active = gesture; gesture = null; active.unsubscribe?.(); active.release?.();
		if (cancel && !active.txId) for (const image of active.rigs.values()) appContext.shared.restoreExportRig(image);
		if (active.txId) return run(cancel ? 'run.cancel' : 'run.commit', { txId: active.txId });
	}
	function beginGesture() {
		if (gesture) return;
		const commit = () => finishGesture(), cancel = () => finishGesture(true), key = event => { if (event.key === 'Escape') cancel(); };
		const events = { pointerup: commit, pointercancel: cancel, blur: commit, keydown: key };
		for (const [name, handler] of Object.entries(events)) globalThis.window?.addEventListener?.(name, handler);
		gesture = { rigs: rigSnapshots(), release() { for (const [name, handler] of Object.entries(events)) globalThis.window?.removeEventListener?.(name, handler); } };
	}
	function edit(id, args) {
		if (!gesture) return run(id, args);
		if (gesture.id && gesture.id !== id) { finishGesture(); beginGesture(); }
		if (!gesture.txId) {
			gesture.id = id; gesture.txId = run('run.begin', { id, args }).txId;
			gesture.unsubscribe = appContext.bus.subscribe(event => { if (event.type === 'transaction.cancelled' && event.txId === gesture?.txId) { const current = gesture; gesture = null; current.unsubscribe(); current.release(); } });
		}
		return run('run.update', { txId: gesture.txId, args });
	}
	const domain = { documentStore, read, write, layer, writeLayer, motionFor, fullMotionFor, visibleMotion, snapshotTake, project,
		setKeys, setRangePinState, bakeRangePin, removePin, editKeys, setKey, ...poseKeys, replace, clear, run, edit, beginGesture, finishGesture, beginAction,
		insideAction: () => running > 0, bakeCurrentKey, keyPose,
		bindRender(context) { appContext = context; },
		viewRevision: () => viewRevision, canUndo: id => documentStore.canUndo(id),
		stepHistory: redo => { finishGesture(); return Boolean((redo ? documentStore.redo : documentStore.undo)()); },
		document: () => ({ motion: read().map(row => {
			const take = motionFor(row.id);
			return take ? { ...row, take: { ...row.take, frames: take.frames, fps: take.fps } } : row;
		}) }), sceneSlice: slices => slices.motion ?? references(slices.cast),
		publish: rows => write(rows), commitDraft: write,
		switchLayer(id) { appContext.shared.loadedLayerCharRef.current = id; project(); notify(); },
		snapshotLegacy: () => read(), restoreLegacy: write,
		snapshotTarget(id) {
			const state = appContext.shared.readStudioState(), keys = decodeMotionKeys(layer(id).ikKeys), rig = rigFor(id);
			return { character: state.characters.find(row => row.id === id), fullMotion: fullMotionFor(id),
				ikState: { ...createIkState(), keys, tracked: new Set([...keys.values()].flatMap(entry => [...entry.keys()])) },
				frameCount: state.frameCount, committedIkEdits: layer(id).committedIkEdits, renderer: rig ? appContext.shared.snapshotExportRig(rig) : null };
		},
		removeLayer(id) { write(rows => rows.filter(row => row.id !== id)); },
		load(rows) { finishGesture(true); release(); native.dispose(); native = createDocumentStore({ owned: { motion: normalize(rows) } }); release = native.subscribe(notify); pruneTakes(); notify(); },
		dispose() { finishGesture(true); unregister(); unsubscribe(); release(); native.dispose(); listeners.clear(); takes.clear(); },
	};
	const unregister = appContext.registerStoreDomain('motion', domain);
	return domain;
}

export function useMotion(appContext) {
	const [domain] = useState(() => appContext.storeDomain('motion') ?? createMotionDomain(appContext, appContext.shared.characters));
	domain.bindRender(appContext);
	useDocumentDomain(domain.documentStore, 'motion');
	useSyncExternalStore(domain.documentStore.subscribe, domain.viewRevision, domain.viewRevision);
	useEffect(() => {
		domain.switchLayer(appContext.shared.activeChar.id);
		const start = () => { if (ikDragRef.current?.characterId === null) ikDragRef.current = null; domain.beginGesture(); }; window.addEventListener('pointerdown', start, true);
		return () => { window.removeEventListener('pointerdown', start, true); domain.finishGesture(true); };
	}, [domain, appContext.shared.activeChar.id]);
	// IK posing for Subject 1: dragging a wrist/ankle handle FOCUSES that
	// joint and solves its chain backward (two-bone analytic IK) on top of
	// the current pose; joints never dragged stay purely on the FK pose.
	// Keys land on the Full-Body lane as sparse per-chain world targets and
	// evaluate as the playhead moves. State lives in a ref — it changes
	// every drag tick and must not re-render the scene; ikTick re-renders
	// only the timeline markers.
	const [ikMode, setIkMode] = useState(false);
	// A drag records only the tracks it actually writes. The record is kept
	// outside React renders so pointer moves stay cheap and the drag-end bake
	// can create a delta key over the raw clip.
	const ikDragRef = useRef(null);
	const ikPreDragRef = useRef(null);
	const pendingIkEditRef = useRef(null);
	const ikCameraMemoryRef = useRef(new Map());

	const [ikChains, setIkChains] = useState(null);

	const [ikFkJoints, setIkFkJoints] = useState(null);

	const [ikFocus, setIkFocus] = useState(null);
	const [pendingIkEdit, setPendingIkEdit] = useState(null);

	// Foot snap (ground plant): while ON, body (hips) drags keep the feet at
	// the positions captured when the drag started — the knees bend instead
	// of the feet sinking through the floor. Toggleable in the timeline.
	const [footSnap, setFootSnap] = useState(true);

	const [bodyContact, setBodyContact] = useState(true);

	// How far (in frames) a correction eases back to the underlying motion
	// outside its keyed range. 6 frames @ 24 fps = 0.25 s — long enough to
	// hide the seam, short enough that a mid-clip fix stays visibly local.
	const IK_CORRECTION_BLEND_FRAMES = 6;

	const [ikTick, setIkTick] = useState(0);

	const committedIkEdits = domain.layer(appContext.shared.activeChar.id).committedIkEdits;
	const setCommittedIkEdits = update => domain.writeLayer(appContext.shared.activeChar.id, { committedIkEdits: typeof update === 'function' ? update(domain.layer(appContext.shared.activeChar.id).committedIkEdits) : update });
	domain.onProject = () => setIkTick(value => value + 1);

	// The Pose-mode tool: "ik" (drag handles) or "pin" (range pins).
	const [ikEditTool, setIkEditTool] = useState("ik");
	const [rangePinSelection, setRangePinSelection] = useState(null);
	const [rangePinPartPick, setRangePinPartPick] = useState(null);
	const [rangePinPreview, setRangePinPreview] = useState(null);
	const pinLayer = domain.layer(appContext.shared.activeChar.id);
	const rangePins = useMemo(() => encodeRangePins(pinLayer.ikPins), [pinLayer.ikPins]);
	const rangePinResiduals = useMemo(() => decodeRangePinResiduals(pinLayer.ikPinResiduals), [pinLayer.ikPinResiduals]);

	function focusIkHandle(focus) {
		setIkFocus(focus);
		const hierarchyId = hierarchyIdForIkFocus(focus, appContext.shared.rowIdForCharIndex(appContext.shared.activeCharIndex));
		if (hierarchyId) {
			appContext.shared.setSelectedHierarchyId(hierarchyId);
		}
	}

	// An IK correction applies across the whole installed take.
	function selectedIkRange() {
		const count = Math.max(1, motion?.frames ?? appContext.shared.tlFrameCount ?? 1);
		return { startFrame: 0, endFrame: count - 1 };
	}

	function setPendingIkEditValue(value) {
		pendingIkEditRef.current = value;
		setPendingIkEdit(value);
	}

	function restorePendingIkState(pending) {
		// A replaced take or another authored edit owns the newer state.
		if (domain.layer(pending.characterId) !== pending.sourceLayer) return false;
		const state = pending.state;
		state.keys = copyPhysicsKeys(pending.beforeKeys);
		state.tracked = new Set(pending.beforeTracked);
		state.targets = new Map([...pending.beforeTargets].map(([id, target]) => [id, target.clone()]));
		state.plants = new Map([...pending.beforePlants].map(([id, target]) => [id, target.clone()]));
		if (pending.rig) {
			if (pending.beforeFrame === appContext.shared.tlFrame) appContext.shared.restoreExportRig(pending.beforeRig);
			else appContext.shared.poseMemberAtFrame(pending.rig, pending.motion, state, appContext.shared.tlFrame, IK_CORRECTION_BLEND_FRAMES);
			if (state.chains) ikSeedTargets(state.chains, state);
		}
		return true;
	}

	// true when the preview was backed out; a preview an authored edit made stale is dropped without restoring anything
	function cancelPendingIkEdit() {
		const pending = pendingIkEditRef.current;
		if (!pending) return false;
		const restored = restorePendingIkState(pending);
		setPendingIkEditValue(null);
		ikDragRef.current = ikPreDragRef.current = null;
		setIkTick((value) => value + 1);
		return restored;
	}

	function applyPendingIkEdit() {
		const pending = pendingIkEditRef.current;
		if (!pending) return false;
		if (domain.layer(pending.characterId) !== pending.sourceLayer) {
			cancelPendingIkEdit();
			return false;
		}
		const session = domain.beginAction(new Map([[pending.characterId, pending.beforeRig]]));
		try {
			session.run(() => domain.setKeys(pending.characterId, pending.candidate.keys));
			session.commit();
		} catch (error) {
			session.cancel();
			throw error;
		}
		setPendingIkEditValue(null);
		ikDragRef.current = ikPreDragRef.current = null;
		if (pending.rig) appContext.shared.poseMemberAtFrame(pending.rig, pending.motion, pending.state, appContext.shared.tlFrame, IK_CORRECTION_BLEND_FRAMES);
		setIkTick((value) => value + 1);
		// Applied on a selection switch: name the character (its Outliner label) the edit landed on.
		const owner = pending.characterId !== appContext.shared.activeChar.id && appContext.shared.characters.findIndex(entry => entry.id === pending.characterId) + 1;
		appContext.notify(owner ? ko(`Applied Character ${owner}'s IK edit`, `인물 ${owner}의 IK 보정을 적용했어요`, `已应用角色 ${owner} 的 IK 修正`)
			: ko(`Applied IK correction across frames ${pending.startFrame}–${pending.endFrame}`, `IK 보정을 ${pending.startFrame}–${pending.endFrame}프레임에 적용했어요`, `已在第 ${pending.startFrame}–${pending.endFrame} 帧应用 IK 修正`));
		return true;
	}

	function rangePinObjectWorldMatrix(objectId, frame) {
		const object = appContext.shared.sceneObjects.find((entry) => entry.id === objectId);
		if (!object) return null;
		const local = rangePinObjectMatrixAt(object, frame, { frameCount: motion?.frames ?? appContext.shared.tlFrameCount, fps: motion?.fps ?? appContext.shared.tlFps }, new THREE.Matrix4());
		if (!object.attach) return local;
		const attachRef = appContext.shared.attachFrameRef?.current;
		if (!attachRef) return local;
		const parent = attachRef(object.attach.characterId, object.attach.bone ?? null, new THREE.Matrix4());
		return parent ? parent.multiply(local) : local;
	}
	function rangePinApplyFrame(frame, state = appContext.shared.ikStateRef.current) {
		appContext.shared.poseMemberAtFrame(appContext.shared.activeRig, motion, null, frame);
		if (ikChains && state.keys.size > 0) ikEvaluate(ikChains, state, frame, ikFkJoints, IK_CORRECTION_BLEND_FRAMES);
	}
	function captureRangePinTargetForDraft(draft) {
		if (!motion || !appContext.shared.activeRig || !ikChains) return null;
		const objectWorldMatrix = draft.targetKind === "object" ? (objectId, frame) => rangePinObjectWorldMatrix(objectId, frame) : null;
		const target = captureRangePinTarget({
			chains: ikChains, track: draft.track, frame: draft.startFrame,
			applyFrame: (frame) => rangePinApplyFrame(frame),
			space: draft.targetKind === "object" ? "object" : "world",
			objectId: draft.targetKind === "object" ? draft.objectId : null,
			objectWorldMatrix,
		});
		const pin = normalizeRangePin({ id: draft.id, track: draft.track, startFrame: draft.startFrame, endFrame: draft.endFrame, blend: draft.blend, reach: draft.reach ?? "body", target }, { clipFrames: motion.frames });
		return { pin, targetWorld: rangePinTargetWorld(pin, appContext.shared.tlFrame, { objectWorldMatrix }) };
	}
	function previewRangePinDraft(draft) {
		const state = ensureRangePinState(appContext.shared.ikStateRef.current);
		const conflictFrames = rangePinConflictFrames(draft, state);
		const overlapping = overlappingRangePin(draft, state);
		try {
			const resolved = captureRangePinTargetForDraft(draft);
			setRangePinPreview({ draft, track: draft.track, target: resolved?.targetWorld?.toArray() ?? null, conflictFrames, overlapError: rangePinOverlapMessage(overlapping) });
		} catch {
			setRangePinPreview({ draft, track: draft.track, target: null, conflictFrames, overlapError: rangePinOverlapMessage(overlapping) });
		}
	}
	function applyRangePinDraft(draft) {
		if (!motion || !appContext.shared.activeRig || !ikChains) return;
		const state = ensureRangePinState(appContext.shared.ikStateRef.current);
		const overlap = overlappingRangePin(draft, state);
		if (overlap) { appContext.notify(rangePinOverlapMessage(overlap)); return; }
		const conflicts = rangePinConflictFrames(draft, state);
		if (conflicts.length && !draft.replaceExisting) { appContext.notify(ko("Confirm Replace existing keys before applying this pin.", "이 고정을 적용하려면 기존 키 교체를 확인하세요.")); return; }
		try {
			const resolved = captureRangePinTargetForDraft(draft);
			domain.run('motion.rangePin.apply', { characterId: appContext.shared.activeChar.id, pin: resolved.pin, replaceExisting: Boolean(draft.replaceExisting) });
			setRangePinSelection(resolved.pin.id);
			setRangePinPreview({ draft: { ...draft, id: resolved.pin.id }, track: resolved.pin.track, target: resolved.targetWorld.toArray(), conflictFrames: [], overlapError: "" });
			appContext.shared.setTlPlaying(false);
			appContext.notify(ko(`Applied ${resolved.pin.track} pin · frames ${resolved.pin.startFrame}–${resolved.pin.endFrame}`, `${resolved.pin.track} 고정을 적용했어요 · ${resolved.pin.startFrame}–${resolved.pin.endFrame}프레임`, `已应用 ${resolved.pin.track} 固定 · 第 ${resolved.pin.startFrame}–${resolved.pin.endFrame} 帧`));
		} catch (error) { appContext.notify(ko(`Could not apply pin — ${error.message}`, `고정을 적용하지 못했어요 — ${error.message}`, `无法应用固定 — ${error.message}`)); }
	}
	function deleteRangePin(pinId) {
		const state = ensureRangePinState(appContext.shared.ikStateRef.current), pin = state.pins.get(pinId);
		if (!pin) return;
		domain.run('motion.rangePin.remove', { characterId: appContext.shared.activeChar.id, pinId });
		// Persisting the command updates the document before React publishes the
		// next render. Clear the live evaluator now too, so a draft preview made
		// during that transition cannot report the deleted pin as overlapping.
		const liveState = ensureRangePinState(appContext.shared.ikStateRef.current);
		removeRangePinKeys(liveState, pinId);
		liveState.pins.delete(pinId);
		liveState.pinResiduals.delete(pinId);
		liveState.tracked = new Set([...liveState.keys.values()].flatMap((entry) => [...entry.keys()]));
		setRangePinSelection(null); setRangePinPreview(null); setIkTick((value) => value + 1);
		appContext.notify(ko(`Deleted ${pin.track} pin`, `${pin.track} 고정을 삭제했어요`, `已删除 ${pin.track} 固定`));
	}

	/** Deep copy of an IK state's key map: frame → Map(trackId → {q,p}), with
	 * every quaternion/position cloned so a snapshot never shares references
	 * with the live rig state (a later bake would otherwise rewrite history). */
	function snapshotIkKeys(ikState) {
		return copyPhysicsKeys(ikState?.keys ?? new Map());
	}

	function editIkKeys(mutate) {
		const before = snapshotIkKeys(appContext.shared.ikStateRef.current);
		const result = mutate();
		const owned = appContext.storeDomain('motion');
		if (owned) owned.setKeys(appContext.shared.loadedLayerCharRef.current, appContext.shared.ikStateRef.current.keys);
		else appContext.shared.markSemanticEdit("pose", before, appContext.shared.ikStateRef.current.keys);
		return result;
	}

	/* One IK-key core for every cast member, shared by the Key button, a pose
	 * drag's bake, the Full-Body lane's delete and run_action. The loaded
	 * layer's keys live on the live IK state, every other character's on its
	 * stored one (created on its first key). */
	function ikStateFor(characterId) {
		if (characterId === appContext.shared.loadedLayerCharRef.current) return appContext.shared.ikStateRef.current;
		let state = appContext.shared.ikStatesRef.current.get(characterId);
		if (!state) appContext.shared.ikStatesRef.current.set(characterId, (state = createIkState()));
		return state;
	}

	function editCharacterIkKeys(characterId, mutate) {
		if (appContext.storeDomain('motion')) return appContext.storeDomain('motion').editKeys(characterId, mutate);
		const state = ikStateFor(characterId);
		const before = snapshotIkKeys(state);
		mutate(state);
		appContext.shared.markSemanticEdit("pose", before, state.keys);
		setIkTick((value) => value + 1);
	}

	/** Write one key from its JSON form (studio-actions.js character.setIkKey):
	 * each named track replaces its key at `frame` and joins the tracked set. */
	function setCharacterIkKey(characterId, frame, tracks) {
		refuseRigOnly(appContext.shared.castMemberOf(characterId), 'ik');
		if (appContext.storeDomain('motion')) return appContext.storeDomain('motion').setKey(characterId, frame, tracks);
		editCharacterIkKeys(characterId, (state) => {
			let entry = state.keys.get(frame);
			if (!entry) state.keys.set(frame, (entry = new Map()));
			for (const [track, key] of Object.entries(tracks)) {
				entry.set(track, ikTrackKeyFromJson(key));
				ikTouch(state, track);
			}
		});
	}

	function removeCharacterIkKey(characterId, frame) {
		const character = appContext.shared.castMemberOf(characterId);
		const state = ikStateFor(characterId);
		if (!state.keys.has(frame)) {
			const keyed = ikKeyframes(state);
			throw new StudioProtocolError("STALE_TARGET", `${character.subject || character.id} has no IK key at frame ${frame}${keyed.length ? `; keyed frames: ${keyed.join(", ")}` : ""}.`);
		}
		editCharacterIkKeys(characterId, (target) => ikRemoveKeyframe(target, frame));
	}

	function clearCharacterIkKeys(characterId) {
		appContext.shared.castMemberOf(characterId);
		const count = ikStateFor(characterId).keys.size;
		if (!count) return 0;
		editCharacterIkKeys(characterId, (target) => {
			target.keys.clear();
			target.tracked.clear();
			target.plants.clear();
			target.pins?.clear();
			target.pinResiduals?.clear();
		});
		return count;
	}

	// Loaded motion: decoded arrays plus the world anchor captured at load.
	const motion = domain.visibleMotion(appContext.shared.activeChar.id);
	useEffect(() => {
		if (ikDragRef.current && ikDragRef.current.characterId !== appContext.shared.activeChar.id) abortIkDrag(true);
		const pending = pendingIkEditRef.current, id = pending?.characterId, other = id !== appContext.shared.activeChar.id;
		const current = pending && pending.rig === appContext.shared.rigs[id] && pending.motion === domain.visibleMotion(id) && pending.sourceLayer === domain.layer(id) && ikMode && ikEditTool === "ik";
		// Selecting another character applies a still-current preview, as leaving Pose mode does.
		if (current && other) applyPendingIkEdit();
		else if (pending && (!current || other || pending.rig !== appContext.shared.activeRig || pending.motion !== motion)) cancelPendingIkEdit();
	}, [appContext.shared.activeChar.id, appContext.shared.activeRig, motion, pinLayer, ikMode, ikEditTool]);
	const rangePinRebuildRef = useRef(null);
	const rangePinSourceStamp = JSON.stringify([pinLayer.take, appContext.shared.activeChar.id]);
	// Object-bound pins follow edited prop transforms and paths, as in the
	// source branch. Rebuilding derived keys must not create an undo entry.
	useEffect(() => {
		if (!motion || !ikChains || rangePinRebuildRef.current === rangePinSourceStamp) return;
		const timer = setTimeout(() => {
			rangePinRebuildRef.current = rangePinSourceStamp;
			const state = ensureRangePinState(appContext.shared.ikStateRef.current);
			for (const pin of [...state.pins.values()].filter(pin => pin.target.space === "object")) {
				if (!appContext.shared.sceneObjects.some(object => object.id === pin.target.objectId)) {
					removeRangePinKeys(state, pin.id);
					state.pinResiduals.set(pin.id, []);
				} else {
					try { domain.bakeRangePin(appContext.shared.activeChar.id, pin, false, true); }
					catch { /* A prop can be unavailable while its transform remounts. */ }
				}
			}
		}, 150);
		return () => clearTimeout(timer);
	}, [rangePinSourceStamp, ikChains]);




	function advanceFrame(steps = 1) {
		advancePlayback(appContext.shared, steps);
	}

	function stepFrame(delta) {
		appContext.shared.setTlFrame((f) => Math.max(0, Math.min(f + delta, appContext.shared.frameCountRef.current - 1)));
	}

	function leaveIkMode() {
		cancelPendingIkEdit();
		const poserCam = appContext.shared.poserCamRef?.current;
		if (ikMode && poserCam && appContext.shared.activeChar?.id) {
			const look = appContext.shared.poserLook?.current ?? {};
			ikCameraMemoryRef.current.set(appContext.shared.activeChar.id, {
				position: poserCam.position.clone(),
				quaternion: poserCam.quaternion.clone(),
				yaw: look.yaw ?? poserCam.rotation.y,
				pitch: look.pitch ?? poserCam.rotation.x,
			});
		}
		setIkMode(false);
		setIkFocus(null);
	}

	

	/** Drop the ACTIVE character's take and its IK corrections. One Ctrl+Z
	 * entry brings both back; nothing to clear records nothing, so the shortcut
	 * never becomes a dead press.
	 *
	 * The pose flows (studio Apply/Reset, pose tiles, photo pose) call this
	 * first and then write the pose: the snapshot taken here predates both, so
	 * one undo restores the take AND the pose it replaced. */
	function clearMotion() {
		return appContext.storeDomain('motion').clear(appContext.shared.activeChar.id);
	}

	// Everyone EXCEPT the active character, posed at an absolute frame from
	// their own session clips and their STORED IK corrections (#77).
	const poseOtherCastMembers = (frame) => {
		for (const entry of appContext.shared.characters) {
			if (entry.id === appContext.shared.activeChar.id || isProxyFigure(entry)) continue;
			appContext.shared.poseMemberAtFrame(appContext.shared.rigs[entry.id], entry.sessionMotion, appContext.shared.ikStatesRef.current.get(entry.id), frame, IK_CORRECTION_BLEND_FRAMES);
		}
	};
	installPlaybackApplier(appContext, motion, poseOtherCastMembers, ikEvaluate, IK_CORRECTION_BLEND_FRAMES);

	function toggleIkMode() {
		const next = !ikMode;
		// Authoring modes are mutually exclusive: IK mode swaps the main pane to
		// the poser camera, which would silently invalidate any pulled path
		// anyway. Leaving the line mode explicitly says so instead.
		if (next) {
			// Always enter on the safe, detailed IK tool. Range pins are an
			// explicit second tool and must never leave the regular handles
			// locked when the user re-enters IK mode.
			setIkEditTool("ik");
			// With a motion loaded, IK edits ON TOP of it: the motion is the
			// rough base layer, the IK keys the correction layer. Every frame
			// applies the clip first and the keyed corrections after, so the
			// composite is what gets pinned for re-generation. Pause playback
			// so a running playhead cannot fight the drag.
			appContext.shared.setTlPlaying(false);
			// Self-heal the ref after a hot-reload with an older state shape:
			// a missing `tracked` set would throw on the first drag.
			if (!appContext.shared.ikStateRef.current.tracked) appContext.shared.ikStateRef.current = createIkState();
			appContext.shared.ikStateRef.current.chains = ikChains;
			appContext.shared.ikStateRef.current.fkJoints = ikFkJoints;
			appContext.shared.ikStateRef.current.rig = appContext.shared.activeRig;
			// Handles open exactly on the effectors of the CURRENT pose —
			// non-destructive entry. (The evaluate effect applies the keyed
			// pose at this frame right after ikMode flips, so re-seating on
			// frame changes is handled there.)
			if (ikChains) ikSeedTargets(ikChains, appContext.shared.ikStateRef.current);
			// The main view switches to the poser camera: start it exactly on
			// the shot camera's pose so nothing jumps, then navigation moves
			// the POSER only — the shot camera (inset) stays frozen.
			const shotCam = appContext.shared.shotCamRef.current;
			const editorCam = appContext.shared.editorCamRef?.current;
			const poserCam = appContext.shared.poserCamRef.current;
			const pose = chooseIkEntryPose({
				rememberedPose: ikCameraMemoryRef.current.get(appContext.shared.activeChar.id) ?? null,
				editorPose: editorCam ? { position: editorCam.position, quaternion: editorCam.quaternion, yaw: appContext.shared.editorLook?.current?.yaw, pitch: appContext.shared.editorLook?.current?.pitch } : null,
				shotPose: shotCam ? { position: shotCam.position, quaternion: shotCam.quaternion, yaw: shotCam.rotation.y, pitch: shotCam.rotation.x } : null,
				lookThroughShot: appContext.shared.lookThroughShot,
			});
			if (pose && poserCam) {
				poserCam.position.copy(pose.position);
				poserCam.quaternion.copy(pose.quaternion);
				poserCam.rotation.order = "YXZ";
				appContext.shared.poserLook.current = { yaw: pose.yaw ?? poserCam.rotation.y, pitch: pose.pitch ?? poserCam.rotation.x };
			}
			setIkMode(true);
			appContext.notify(motion
				? ko("Pose mode — preview the correction, then apply it to the selected motion block", "포즈 모드 — 보정을 미리 본 뒤 선택한 모션 구간에 적용하세요")
				: ko("Pose mode — drag handles in the main view; the shot camera stays frozen in the inset", "포즈 모드 — 메인 뷰에서 핸들을 드래그하세요. 샷 카메라는 인셋에 고정됩니다"));
			return;
		}
		// Exit: the keyed pose stays — the evaluate effect re-applies the
		// current frame's keyed rotations the moment ikMode flips, so nothing
		// the user authored is lost by toggling. Untracked/unkeyed parts keep
		// their current (FK) pose. A correction still in preview is applied, as
		// Apply range would: leaving the mode (the Stage tab, a mode key) is not
		// a Cancel, and dropping it threw away what the user just posed.
		if (!applyPendingIkEdit()) appContext.notify(ko("Pose mode off — keyed poses keep playing", "포즈 모드 꺼짐 — 키로 찍은 포즈는 계속 재생됩니다"));
		leaveIkMode();
	}

	// Drag solve, routed by handle kind: chain targets solve the two-bone
	// chain toward the target; mid joints reposition the elbow/knee with both
	// ends pinned (the handle snaps to the clamped position); FK joints swing
	// toward the pointer. The solved pose stays a preview until Apply.
	function ikSolve(kind, trackId, targetWorld, input = null) {
		if (ikDragRef.current && ikDragRef.current.characterId !== appContext.shared.activeChar.id) return;
		const state = appContext.shared.ikStateRef.current;
		const ikChains = state.chains;
		const ikFkJoints = state.fkJoints;
		if (!ikDragRef.current) {
			const pending = pendingIkEditRef.current;
			ikPreDragRef.current = pending ?? {
				characterId: appContext.shared.activeChar.id,
				beforeFrame: appContext.shared.tlFrame,
				sourceLayer: domain.layer(appContext.shared.activeChar.id),
				state, rig: appContext.shared.activeRig, motion,
				beforeRig: appContext.shared.snapshotExportRig(appContext.shared.activeRig),
				beforeKeys: snapshotIkKeys(state),
				beforeTracked: new Set(state.tracked),
				beforeTargets: new Map([...state.targets].map(([id, target]) => [id, target.clone()])),
				beforePlants: new Map([...state.plants].map(([id, target]) => [id, target.clone()])),
			};
			ikDragRef.current = { frame: appContext.shared.tlFrame, ids: new Set(pending?.ids ?? []) };
		}
		ikDragRef.current = Object.assign(ikDragRecord(ikDragRef.current, appContext.shared.tlFrame), { characterId: appContext.shared.activeChar.id });
		const touch = (id) => ikDragTouch(appContext.shared.ikStateRef.current, ikDragRef.current, id), activeId = appContext.shared.activeChar.id;
		const clamp = () => clampDragTarget({ kind, trackId, targetWorld, bodyContact, chains: ikChains, record: ikDragRef.current, bypass: input?.bypass, open: () => ({ rigs: appContext.shared.rigs, activeId, cast: appContext.shared.characters, allow: domain.layer(activeId).take?.source?.spec?.checks?.allow, notify: appContext.notify }) });
		if (kind === "finger") return solveFingerGesture(fingersOf(appContext.shared.ikStateRef.current.fkJoints)?.get(trackId), targetWorld, touch);
		if (kind === "chain") {
			const chain = appContext.shared.ikStateRef.current.chains?.get(trackId);
			if (!chain) return;
			touch(trackId);
			const clampedTarget = clamp();
			appContext.shared.ikStateRef.current.targets.set(trackId, clampedTarget.clone());
			solveDragTarget(kind, chain, clampedTarget);
			return;
		}
		if (kind === "mid") {
			// Mid tracks reference their parent chain through MID_TRACKS.
			const midDef = MID_TRACKS.find((t) => t.id === trackId);
			const chain = midDef ? appContext.shared.ikStateRef.current.chains?.get(midDef.chain) : null;
			if (!chain) return;
			touch(chain.track.id);
			solveDragTarget(kind, chain, clamp());
			return;
		}
		// Effector swing: the rotation ring on a focused hand/foot. Rotates
		// only the end bone — the solved limb position is untouched — and the
		// bake on drag end now stores b2's quaternion with the chain's.
		if (kind === "swing") {
			const chain = appContext.shared.ikStateRef.current.chains?.get(trackId);
			if (!chain || !targetWorld?.axis) return;
			touch(trackId);
			solveEffectorSwing(chain, targetWorld.axis, targetWorld.angle, targetWorld.startQuat, targetWorld.startParentQuat);
			return;
		}
		// Body root (hips): arrow drags translate ({ worldDelta, startLocalPos
		// }), the centre sphere swings ({ axis, angle, startQuat, ... }). With
		// foot snap ON the feet stay at the positions captured when the drag
		// started — the legs re-solve after every hips transform so the knees
		// bend instead of the feet sinking through the floor.
		if (kind === "body") {
			const joint = ikFkJoints?.get(trackId);
			if (!joint) return;
			touch(trackId);
			if (footSnap && !appContext.shared.ikBodyDragRef.current && ikChains) {
				// Capture the plant points once, BEFORE the first hips move.
				ikPlantFeet(ikChains, appContext.shared.ikStateRef.current);
				appContext.shared.ikBodyDragRef.current = true;
			}
			if (targetWorld?.worldDelta && targetWorld?.startLocalPos) {
				if (bodyContact) solveHipsTranslateToFloor(joint, targetWorld.worldDelta, targetWorld.startLocalPos, 0, ikChains?.get("leftHand")?.contactHeights);
				else solveHipsTranslate(joint, targetWorld.worldDelta, targetWorld.startLocalPos);
			} else if (targetWorld?.axis) solveSwingAngle(joint, targetWorld.axis, targetWorld.angle, targetWorld.startQuat, targetWorld.startParentQuat);
			if (footSnap && ikChains) {
				ikSolvePlantedFeet(ikChains, appContext.shared.ikStateRef.current);
				// the planted re-solve wrote the leg bones — key them too
				touch("leftFoot");
				touch("rightFoot");
			}
			if (bodyContact && ikChains) {
				for (const id of chainsChangedBy(ikChains, () => applyBodyContact(ikChains, ikFkJoints, 0, { skipFeet: footSnap }))) touch(id);
			}
			return;
		}
		// FK swing: targetWorld is the trackball payload { axis, angle,
		// startQuat, startParentQuat } from the drag layer.
		const joint = ikFkJoints?.get(trackId);
		if (!joint || !targetWorld?.axis) return;
		touch(trackId);
		solveSwingAngle(joint, targetWorld.axis, targetWorld.angle, targetWorld.startQuat, targetWorld.startParentQuat);
	}

	// A drag belongs to the character it started on. Switching away mid-drag
	// restores that rig and leaves an inert record (no owner) so the rest of
	// the stroke cannot pose the newly selected character.
	function abortIkDrag(inert = false) {
		if (ikPreDragRef.current?.beforeRig) appContext.shared.restoreExportRig(ikPreDragRef.current.beforeRig);
		ikDragRef.current = inert ? { characterId: null, frame: null, ids: new Set() } : null;
		ikPreDragRef.current = null;
		appContext.shared.ikBodyDragRef.current = false;
	}

	// Drag end: retain the solved pose as a preview. Apply creates keys at both
	// boundaries of the selected timeline motion segment.
	function ikDragEnd() {
		appContext.shared.ikBodyDragRef.current = false;
		const drag = ikDragRef.current, pre = ikPreDragRef.current;
		if (drag && drag.characterId !== appContext.shared.activeChar.id) return abortIkDrag();
		ikDragRef.current = null;
		if (!motion) {
			keyIkPoseAtPlayhead(null, pre?.characterId === appContext.shared.activeChar.id ? pre.beforeRig : null);
			ikPreDragRef.current = null;
			setIkTick((n) => n + 1);
			return;
		}
		if (!drag?.ids?.size) return void (ikPreDragRef.current = null);
		const state = appContext.shared.ikStateRef.current;
		const raw = (rawRig, at) => appContext.shared.poseMemberAtFrame(rawRig, motion, null, at);
		const keyed = bakeIkDragKey(state.chains, state.fkJoints, drag.frame, drag.ids, raw);
		if (!keyed) return void (ikPreDragRef.current = null);
		const before = ikPreDragRef.current;
		const range = pendingIkEditRef.current ?? selectedIkRange(drag.frame);
		const next = copyPhysicsKeys(before.beforeKeys);
		const boundaries = bakeIkDragRange(state.chains, state.fkJoints, keyed, range.startFrame, range.endFrame, drag.ids, raw);
		for (const [at, entry] of boundaries) {
			if (!entry) continue;
			let frameEntry = next.get(at);
			if (!frameEntry) next.set(at, (frameEntry = new Map()));
			for (const [track, key] of entry) frameEntry.set(track, { ...key, blend: IK_CORRECTION_BLEND_FRAMES });
		}
		setPendingIkEditValue({
			...before,
			frame: drag.frame,
			startFrame: range.startFrame,
			endFrame: range.endFrame,
			ids: [...drag.ids],
			candidate: { ...state, keys: next, tracked: new Set([...state.tracked, ...drag.ids]) },
		});
	}

	/** Bake the current tracked rotations at the playhead into a scratch layer
	 * and set them as a key through the shared registry. A bake only writes
	 * TRACKED parts: with nothing dragged yet there is no key, nothing is
	 * dispatched and Ctrl+Z never goes dead. */
	function keyIkPoseAtPlayhead(dragIds = null, preimage = null) {
		if (appContext.storeDomain('motion')) return appContext.storeDomain('motion').bakeCurrentKey(appContext.shared.activeChar.id, appContext.shared.tlFrame, dragIds, preimage);
		const scratch = { ...createIkState(), tracked: new Set(appContext.shared.ikStateRef.current.tracked) };
		ikBakeKeyframe(ikChains, scratch, appContext.shared.tlFrame, ikFkJoints);
		const baked = scratch.keys.get(appContext.shared.tlFrame);
		return baked ? appContext.shared.runStudioAction("character.setIkKey", { characterId: appContext.shared.activeChar.id, frame: appContext.shared.tlFrame, tracks: ikKeyJson(baked) }) : null;
	}

	// Manual key: bake the current tracked rotations at the playhead.
	function ikAddKeyframe() {
		if (!ikChains) return;
		if (!keyIkPoseAtPlayhead()) return;
		appContext.notify(ko(`Full-body IK key at frame ${appContext.shared.tlFrame}`, `${appContext.shared.tlFrame}프레임에 전신 IK 키를 추가했어요`, `已在第 ${appContext.shared.tlFrame} 帧添加全身 IK 关键帧`));
	}

	function ikDeleteKeyframe(frame) {
		if (!appContext.shared.ikStateRef.current.keys.has(frame)) return;
		appContext.shared.runStudioAction("character.removeIkKey", { characterId: appContext.shared.activeChar.id, frame });
	}

	/** With IK mode on over a loaded take, a pose pick is a CORRECTION, not a
	 * replacement: write the saved pose onto the rig and bake every IK part
	 * into a full-body key at the current frame. The take survives, and the
	 * key blends back into the clip outside its window exactly like a dragged
	 * key would. Returns false when there is nothing to key against so the
	 * caller can fall through to the plain pose-apply path. */
	function ikApplyPoseAsKey(pose) {
		if (!appContext.shared.activeRig || !motion) return false;
		if (appContext.storeDomain('motion')) { appContext.storeDomain('motion').run('ik.applyPose', { characterId: appContext.shared.activeChar.id, frame: appContext.shared.tlFrame, pose }); return true; }
		if (!ikChains) return false;
		// The clip's positional skinning left per-bone translations the FK pose
		// math never produced. The bake below stores every FK joint's position
		// (p) as-is, so posing rotations over those clip translations would key
		// a torn-apart body — bind translations first, ALWAYS.
		restoreBindPositions(appContext.shared.activeRig);
		// Reset-then-pose, the same shape the Character effect applies: unlisted
		// joints return to rest instead of keeping stale limbs from the clip.
		restFingers(ikFkJoints); applyPose(appContext.shared.activeRig, { ...REST_BONES, ...pose.bones });
		// The hips' measured height rides into the bake: the hips FK joint keys
		// its local position (p), so a crouched pose keys a crouched body.
		applyHipsOffset(appContext.shared.activeRig, pose.rootY ?? 0);
		// The pose authors the whole body, so every part is tracked — an
		// untracked chain would silently keep the clip's limb.
		for (const id of ikChains.keys()) ikTouch(appContext.shared.ikStateRef.current, id);
		if (ikFkJoints) for (const id of ikFkJoints.keys()) ikTouch(appContext.shared.ikStateRef.current, id);
		editIkKeys(() => ikBakeKeyframe(ikChains, appContext.shared.ikStateRef.current, appContext.shared.tlFrame, ikFkJoints));
		// Handles re-seat on the posed effectors, ready to drag into a refinement.
		ikSeedTargets(ikChains, appContext.shared.ikStateRef.current);
		setIkTick((n) => n + 1);
		appContext.notify(ko(`Pose keyed as a full-body IK correction at frame ${appContext.shared.tlFrame} — the take stays`,
			`${appContext.shared.tlFrame}프레임에 포즈를 전신 IK 보정 키로 추가했어요 — 모션은 그대로예요`,
			`已在第 ${appContext.shared.tlFrame} 帧将姿势记录为全身 IK 修正关键帧 — 动作保持不变`));
		return true;
	}

	
	appContext.updateActionPorts({ clearMotionNative: clearMotion, setCharacterIkKey, removeCharacterIkKey, clearCharacterIkKeys });
	return {
		...domain,
		ikMode, ikChains, setIkChains, ikFkJoints, setIkFkJoints, ikFocus, setIkFocus, footSnap, setFootSnap,
		bodyContact, setBodyContact, IK_CORRECTION_BLEND_FRAMES,
		ikTick, setIkTick, committedIkEdits, setCommittedIkEdits, ikEditTool, setIkEditTool, focusIkHandle, snapshotIkKeys,
		pendingIkEdit, applyPendingIkEdit, cancelPendingIkEdit,
		rangePinApplySpec: (pin) => {
			domain.run('motion.rangePin.apply', { characterId: appContext.shared.activeChar.id, pin });
			return { residuals: decodeRangePinResiduals(domain.layer(appContext.shared.activeChar.id).ikPinResiduals).get(pin.id) };
		},
		rangePins, rangePinResiduals, rangePinSelection, setRangePinSelection, rangePinPartPick, setRangePinPartPick, rangePinPreview, previewRangePinDraft, applyRangePinDraft, deleteRangePin,
		setCharacterIkKey, removeCharacterIkKey, clearCharacterIkKeys, motion,
		advanceFrame, stepFrame,
		leaveIkMode, clearMotion: () => appContext.bus.run('motion.clear', { characterId: appContext.shared.activeChar.id }), clearMotionNative: clearMotion,
		poseOtherCastMembers, toggleIkMode, ikSolve, ikDragEnd, ikAddKeyframe, ikDeleteKeyframe, ikApplyPoseAsKey,
	};
}
