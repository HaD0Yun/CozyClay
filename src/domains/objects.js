import { createObjectPath } from "../object-path.js";
import { useState, useRef } from "react";
import { createDocumentStore } from "../document-store.js";
import { useDocumentDomain } from "../store/use-document-store.js";
import { arrangement } from "../studio-agent-commands.js";
import { noteObjectCreated, noteObjectDeleted } from "../studio-telemetry.js";
import {
	readStoredObjectColors,
	rememberObjectColor,
	writeStoredObjectColors,
	sceneObjectIdFromHierarchy,
	updateSceneObject,
	removeSceneObject,
	dropToSurfacePatch,
	placementInFront,
	createSceneObject,
	createCutoutObject,
	CUTOUT_DEFAULT_HEIGHT,
	createMeshObject,
	CUTOUT_KIND,
	duplicateCutoutOptions,
	MESH_KIND,
	duplicateMeshOptions,
	createSculptObject,
	duplicateSculptOptions,
	SCULPT_KIND,
	objectSize,
	setSceneObjectAttach,
	setSceneObjectParent,
	rigidMotionBetween,
	carryPointByMotion,
	tidyAngle, normalizeSceneObject,
} from "../scene-objects.js";

import { ko } from "../locale.js";
import {
	sceneObjectNameDisplayKo,
	attachWorldMatrix,
	sceneObjectMatrix,
	ATTACH_BONE_ROWS,
	HIERARCHY_INSPECTOR_TITLES,
	attachPlacementPatch,
	placeSceneObject,
} from "../app-stage.jsx";
import { rememberAsset, assetRecord } from "../scene-asset-cache.js";
import { importImageFile, assetAspect, openAssetDb, putAsset } from "../scene-assets.js";
import { importMeshFile, compressedGlbReason, meshBoundsFromAsset, fitMeshBounds } from "../scene-mesh.js";
import { cutOutBackground, maskAsset } from "../matte.js";
import { parseRigNodeId } from "../hierarchy-model.js";
import { StudioProtocolError } from "../studio-agent-protocol.js";
import { assetDataUrl, sculptPlacement } from "../sculpt-mode.js";
import { settleUiRefusal } from "./ui-refusal.js";

// A stable owner across scene loads. App's remaining native history readers use
// the small store facade below; authored writes are owned by the document store.
export function createObjectsDomain(appContext, initial) {
	const listeners = new Set();
	const notify = () => { for (const listener of listeners) listener(); };
	let native = createDocumentStore({ owned: { objects: initial } });
	let release = native.subscribe(notify);
	const documentStore = {
		...Object.fromEntries(Object.keys(native).map(key => [key, (...args) => native[key](...args)])),
		subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
	};
	const read = () => documentStore.read("objects");
	function write(update) {
		let moved = null;
		const result = documentStore.write("objects", before => {
			let next = typeof update === "function" ? update(before) : update;
			for (const row of next.filter(row => row.remove === true)) next = removeSceneObject(next, row.id);
			if (JSON.stringify(next) === JSON.stringify(before)) return before;
			moved = { before, next };
			return next;
		});
		if (moved) carryGroupedCharacters(moved.before, moved.next);
		return result;
	}
	/** Characters grouped under an object ride it while authoring too: whatever
	 * motion an object took in this write (its own move or turn, or carried with
	 * its group), the characters under it take the same. A pure move shifts
	 * them by the same translation. A turn orbits them about the object's pivot
	 * (position by the object's Δ, like any carried child) and adds the yaw
	 * part of Δ to their facing — a character has only a yaw, so the pitch or
	 * roll of its parent moves where it stands and never tips it over.
	 * Joined to the open action, so one undo puts back the object and the
	 * riders together. */
	function carryGroupedCharacters(before, next) {
		const cast = appContext.storeDomain("cast");
		if (!cast) return;
		const was = new Map(before.map(row => [row.id, row]));
		const shifts = new Map();
		const turns = new Map();
		for (const row of next) {
			const prior = was.get(row.id);
			if (!prior || row.attach || prior.attach) continue;
			const turn = rigidMotionBetween(prior, row);
			if (turn) { turns.set(row.id, turn); continue; }
			const shift = { x: row.x - prior.x, y: (row.y ?? 0) - (prior.y ?? 0), z: row.z - prior.z };
			if (shift.x || shift.y || shift.z) shifts.set(row.id, shift);
		}
		if (!(shifts.size || turns.size) || !cast.read().some(entry => shifts.has(entry.parent) || turns.has(entry.parent))) return;
		appContext.recordAction("cast", () => cast.write(rows => rows.map(entry => {
			const turn = turns.get(entry.parent);
			if (turn) {
				const at = carryPointByMotion({ x: entry.x, y: entry.y ?? 0, z: entry.z }, turn);
				return { ...entry, x: at.x, y: Math.max(0, at.y), z: at.z, rot: tidyAngle((entry.rot ?? 0) + turn.yaw) };
			}
			const shift = shifts.get(entry.parent);
			return shift ? { ...entry, x: entry.x + shift.x, y: Math.max(0, (entry.y ?? 0) + shift.y), z: entry.z + shift.z } : entry;
		})), null, true);
	}
	const publish = () => { if (appContext.live.state) appContext.patchLive({ objects: read() }); };
	const unsubscribe = documentStore.subscribe(publish);
	function beginAction() { return documentStore.beginAction("objects"); }
	function stepHistory(redo) {
		domain.settle?.();
		return Boolean((redo ? documentStore.redo : documentStore.undo)());
	}
	const domain = { documentStore, read, write, beginAction, canUndo: id => documentStore.canUndo(id), stepHistory,
		document: () => ({ objects: read() }), publish: state => write(state.objects), commitDraft: write,
		load(objects) {
			domain.settle?.(); release(); native.dispose();
			// A loaded scene's records enter within the editor's limits (#1196); a record the normalizer cannot read stays as stored.
			native = createDocumentStore({ owned: { objects: objects.map(row => normalizeSceneObject(row) ?? row) } });
			release = native.subscribe(notify); notify();
		},
		arrange(args) {
			const state = appContext.ports.read();
			const plan = arrangement({ name: "arrange_objects", args }, { ...state, frame: state.view.frame }, { bounds: appContext.ports.bounds });
			write(plan.draft); return plan;
		},
		dispose() { domain.cancelGesture?.(); unregister(); unsubscribe(); release(); native.dispose(); listeners.clear(); },
	};
	const store = {
		get objects() { return read(); },
		present: () => documentStore.history().present.snapshot.objects,
		depths: documentStore.depths,
		applyAtomic: write,
		undo: () => stepHistory(false) ? read() : null,
		redo: () => stepHistory(true) ? read() : null,
		settle: () => domain.settle?.(),
		hasHistoryState: state => [...documentStore.history().past, documentStore.history().present, ...documentStore.history().future].some(entry => entry.snapshot.objects === state),
		beginCommand() {
			const session = beginAction();
			return { ...session, commit: () => Boolean(session.commit().historyEntryId) };
		},
	};
	domain.store = store;
	const unregister = appContext.registerStoreDomain("objects", domain);
	return domain;
}

export function useObjects(appContext) {
	// Hand-mixed object tints, newest first. An editor preference like the
	// guides above — it belongs to this browser, never to the scene, so it is
	// kept out of the scene document and written straight back to storage.
	const [recentObjectColors, setRecentObjectColors] = useState(() => readStoredObjectColors(globalThis.localStorage));

	// What is being typed into the hex field right now, or null when nobody is
	// typing. Held apart from the record so a half-written "#ff3" survives on
	// screen without ever repainting the prop, and so the field snaps back to
	// the object's real colour the moment the edit ends.
	const [objectColorDraft, setObjectColorDraft] = useState(null);

	function rememberSceneObjectColor(hex) {
		setRecentObjectColors((previous) => {
			const next = rememberObjectColor(previous, hex);
			// rememberObjectColor returns the same array when nothing changed, so a
			// re-pick of the same tint neither writes storage nor re-renders.
			if (next !== previous) writeStoredObjectColors(globalThis.localStorage, next);
			return next;
		});
	}

	const [objectDeleteUndo, setObjectDeleteUndo] = useState(null);

	// StrictMode replays initializers: reuse this editor's registered owner,
	// rather than registering a second store whose React result is discarded.
	const [domain] = useState(() => appContext.storeDomain("objects") ?? createObjectsDomain(appContext, appContext.shared.startupScene.objects));
	const sceneObjects = useDocumentDomain(domain.documentStore, "objects");
	const storeRef = useRef(domain.store);
	const store = storeRef.current;
	const gesture = useRef(null);
	function run(id, args = {}) {
		const receipt = appContext.bus.run(id, args);
		const check = result => { if (!result.ok) throw new StudioProtocolError(result.code, result.message); return result; };
		return receipt?.then ? receipt.then(check) : check(receipt);
	}

	const selectedSceneObjectId = sceneObjectIdFromHierarchy(appContext.shared.selectedHierarchyId);

	const selectedSceneObject = sceneObjects.find((object) => object.id === selectedSceneObjectId) ?? null;

	// Producer drag lifecycle (plan §6.1): begin issues a token the producer
	// presents on every apply and on close; end commits the drag as one
	// history entry, or rolls it back when commit is false (Escape).
	function beginSceneTransaction({ owner, cancel }) {
		domain.settle();
		const { txId } = run("run.begin", { id: "object.update", args: {} });
		const release = appContext.bus.subscribe(event => {
			if (event.type !== "transaction.cancelled" || event.txId !== txId) return;
			gesture.current = null; release(); cancel();
		});
		gesture.current = { txId, owner, cancel, release };
		return txId;
	}

	function endSceneTransaction(token, { commit }) {
		if (gesture.current?.txId !== token) return;
		gesture.current.release();
		gesture.current = null;
		return run(commit ? "run.commit" : "run.cancel", { txId: token });
	}
	domain.settle = () => {
		const active = gesture.current;
		if (!active) return;
		const receipt = endSceneTransaction(active.txId, { commit: true });
		active.cancel();
		return receipt;
	};
	domain.cancelGesture = () => {
		const active = gesture.current;
		if (!active) return;
		endSceneTransaction(active.txId, { commit: false }); active.cancel();
	};

	// App's single scene-object mutation entry (plan §6.1). A token means a
	// producer drag stream: apply inside the open transaction so the change
	// lands in the live array without its own history entry. No token is an
	// atomic edit — one entry. updateSceneObject returns the same array when
	// nothing changed, so a no-op can never create an entry.
	function changeSceneObject(id, patch, token) {
		return token != null
			? run("run.update", { txId: token, args: { id, patch } })
			: run("object.update", { id, patch });
	}

	function deleteSelectedSceneObject() {
		deleteSceneObject(selectedSceneObjectId);
	}

	/** Delete by id — the hierarchy context menu's Delete. Unlike the
	 * selection-based path above, removing a row that is not the selection
	 * must leave the selection alone. */
	function deleteSceneObject(id) {
		if (!id) return;
		const wasSelected = id === selectedSceneObjectId;
		run("object.remove", { ids: [id] });
		noteObjectDeleted(id);
		setObjectDeleteUndo({ id, pastDepth: store.depths().past });
		appContext.shared.setInspectorActionsOpen(false);
		if (wasSelected) {
			appContext.shared.setSelectedHierarchyId("props");
		}
	}

	/** Drop-to-surface (plan §9.2/§9.3): End, no modifier. Strict drop-down —
	 * the selection falls until its base touches the highest support top at or
	 * below it, or the floor. dropToSurfacePatch is pure and returns null when
	 * already resting, so a redundant press never creates a history entry, and
	 * x/z are never written. One applyAtomic = one undo entry. */
	function dropSelectedSceneObject() {
		const object = sceneObjects.find((item) => item.id === selectedSceneObjectId) ?? null;
		if (!object) return;
		const patch = dropToSurfacePatch(object, sceneObjects.filter((item) => item.id !== object.id), appContext.shared.characters);
		if (patch === null) {
			appContext.notify(ko("Nothing to drop", "내려놓을 대상이 없어요"));
			return;
		}
		changeSceneObject(object.id, patch);
		appContext.notify(ko(`${sceneObjectNameDisplayKo(object.name)} dropped to surface`, `${sceneObjectNameDisplayKo(object.name)}을 표면 위에 내려놓았어요`, `${sceneObjectNameDisplayKo(object.name)}已放到表面`));
	}

	// How much of the wall counts as the wall, and how wide the brush that
	// argues with the answer is.
	const [matteTolerance, setMatteTolerance] = useState(0.18);

	const [matteBrush, setMatteBrush] = useState(18);

	// Edge cleanup for the cut: shrink eats the blended rim, feather softens
	// what is left. Both ride into applyMask; the defaults match applyMask's.
	const [matteShrink, setMatteShrink] = useState(1);

	const [matteFeather, setMatteFeather] = useState(1);

	const [matteMode, setMatteMode] = useState("paint");

	const [matteStats, setMatteStats] = useState({ painted: 0, coverage: 0, zoom: 1, canUndo: false, canRedo: false });

	const [matteBusy, setMatteBusy] = useState(false);

	const [gizmoMode, setGizmoMode] = useState("move");

	// An Empty is nothing but its name: the moment one is made, its Outliner
	// row opens for naming (a nonce, so a second Empty re-opens it).
	const [renameRequest, setRenameRequest] = useState(null);

	// Snap is a preference, not a law: with it on the gizmo blocks on the plan
	// board's grid, and Ctrl/Cmd during a drag gives a free one. Off, it is the
	// other way round. (docs/unity-reference.md §9.5)
	const [snapEnabled, setSnapEnabled] = useState(true);

	/** `at` overrides the floor point: the Assets-shelf drop already knows
	 * where the pointer hit. + Add puts everything at the world origin, so a
	 * new object lands in the same known place whatever the view is looking at. */
	function addSceneObject(kind, at) {
		const placement = at ?? { x: 0, z: 0 };
		const receipt = run("object.add", { kind, placement, first: true });
		const object = domain.read().find(row => row.id === receipt.affectedIds[0]);
		noteObjectCreated(object.id);
		appContext.shared.markCraftAction("object");
		appContext.shared.setSelectedHierarchyId(`object:${object.id}`);
		if (object.renderer === "empty") setRenameRequest({ id: `object:${object.id}`, nonce: Date.now() });
		// Deliberate divergence from Unity's rename-on-create: creating an object
		// here is followed by placing it, and dropping focus into a text field
		// swallows the very next W/E/R. Renaming stays on F2/Return and the row's
		// context menu. (docs/unity-reference.md §9.7)
		setGizmoMode("move");
		appContext.notify(ko(`${sceneObjectNameDisplayKo(object.name)} added — W move, E rotate, R scale`, `${sceneObjectNameDisplayKo(object.name)} 추가됨 — W 이동, E 회전, R 크기`, `${sceneObjectNameDisplayKo(object.name)}已添加 — W 移动，E 旋转，R 缩放`));
	}

	/** "Sofa 2.png" reads as a set piece; "sofa-2.png" does not. The extension
	 * goes, the rest is the user's own name for the thing. */
	function cutoutNameFromFile(fileName) {
		const base = String(fileName ?? "").replace(/\.[^.]+$/, "").trim();
		return base || ko("Cutout", "컷아웃");
	}

	/**
	 * Import one image and stand it up in the set. The card arrives at the
	 * figure's own height, because a standee whose scale is a guess is worse
	 * than useless in a tool where every camera level is a height in metres —
	 * 1.8 m is at least an honest starting point to correct from.
	 */
	async function importCutout(file, commandContext) {
		if (!file) return;
		if (!commandContext) return importFile(file, "cutout");
		try {
			const asset = await rememberAsset(await importImageFile(file));
			const camera = (appContext.shared.lookThroughShot ? appContext.shared.shotCamRef : appContext.shared.editorCamRef).current;
			const placement = camera
				? placementInFront({ x: camera.position.x, z: camera.position.z }, (appContext.shared.lookThroughShot ? appContext.shared.look : appContext.shared.editorLook).current.yaw)
				: {};
			const object = createCutoutObject(
				{ assetId: asset.id, aspect: assetAspect(asset) ?? 1, height: CUTOUT_DEFAULT_HEIGHT, name: cutoutNameFromFile(asset.name) },
				domain.read(),
				placement,
			);
			const imported = publishImported(object, commandContext);
			appContext.notify(ko(`${object.name} added — type its real height in metres to set the scale`,
				`${object.name} 추가됨 — 실제 높이(m)를 입력하면 크기가 맞습니다`,
				`${object.name} 已添加 — 输入实际高度（米）即可匹配尺寸`));
			return imported;
		} catch (error) {
			throw new StudioProtocolError(error.code ?? "INVALID_ARGUMENT", `Could not import that image: ${error.message}`);
		}
	}

	/** A drop can carry several pictures. They go in one at a time so each
	 * lands in its own place and the last one is the one left selected. */
	async function importCutouts(files) {
		for (const file of files) await importCutout(file);
	}

	/**
	 * Stand an ALREADY-STORED picture up as a fresh cutout — the Assets-shelf
	 * drop. The bytes are content-addressed and in the store, so this is
	 * `importCutout` without the import: read the record for its true aspect
	 * and name, mint the card, one atomic history entry.
	 */
	async function spawnCutoutAt(assetId, placement, commandContext) {
		if (!commandContext) return importStoredAsset(assetId, "cutout", placement);
		appContext.shared.markCraftAction("cutout");
		const record = await assetRecord(assetId);
		if (!record) throw new StudioProtocolError("TARGET_NOT_READY", "That image is no longer stored.");
		const object = createCutoutObject(
			{ assetId: record.id, aspect: assetAspect(record) ?? 1, height: CUTOUT_DEFAULT_HEIGHT, name: cutoutNameFromFile(record.name) },
			domain.read(),
			placement,
		);
		const imported = publishImported(object, commandContext);
		appContext.notify(ko(`${object.name} added — type its real height in metres to set the scale`,
			`${object.name} 추가됨 — 실제 높이(m)를 입력하면 크기가 맞습니다`,
			`${object.name} 已添加 — 输入实际高度（米）即可匹配尺寸`));
		return imported;
	}

	const importFiles = useRef(new Map());
	async function importFile(file, placeAs) {
		const fileToken = crypto.randomUUID();
		importFiles.current.set(fileToken, file);
		try {
			const receipt = await appContext.bus.run("asset.import", { fileToken, placeAs });
			if (!receipt.ok) appContext.notify(receipt.message);
			return receipt;
		} finally { importFiles.current.delete(fileToken); }
	}
	async function importStoredAsset(assetId, placeAs, placement) {
		const receipt = await appContext.bus.run("asset.import", { assetId, placeAs, ...(placement ? { placement } : {}) });
		if (!receipt.ok) appContext.notify(receipt.message);
		return receipt;
	}
	function publishImported(object, commandContext) {
		if (!object) throw new StudioProtocolError("INVALID_ARGUMENT", "Could not create the imported object.");
		commandContext.commit(() => domain.write(objects => [...objects, object]));
		appContext.shared.setSelectedHierarchyId(`object:${object.id}`);
		setGizmoMode("move");
		return { assetId: object.assetId, objectId: object.id };
	}
	domain.importAsset = async (args, context) => {
		if (args.fileToken) {
			if (context.origin !== "ui") throw new StudioProtocolError("CAPABILITY_MISSING", "File imports belong to the UI.");
			const file = importFiles.current.get(args.fileToken);
			if (!file) throw new StudioProtocolError("STALE_TARGET", "The selected import file is no longer available.");
			return args.placeAs === "mesh" ? importMesh(file, context) : importCutout(file, context);
		}
		if (args.assetId) return args.placeAs === "mesh" ? spawnMeshAt(args.assetId, args.placement, context) : spawnCutoutAt(args.assetId, args.placement, context);
		return importCommandAsset(args, context);
	};
	domain.applyMatte = applyMatte;

	function meshNameFromFile(fileName) {
		const base = String(fileName ?? "").replace(/\.[^.]+$/, "").trim();
		return base || ko("Model", "모델");
	}

	async function persistMeshAsset(asset) {
		const db = await openAssetDb();
		try {
			return await putAsset(db, asset);
		} finally {
			db.close?.();
		}
	}

	/** Sculpt mode's Place in scene (#739): the sculpt stands on the ground in
	 * front of the scene camera, where + Add puts a new object, and ends up
	 * selected. One object.update, so one undo. */
	function placeSculptInScene(id) {
		const camera = (appContext.shared.lookThroughShot ? appContext.shared.shotCamRef : appContext.shared.editorCamRef).current;
		const yaw = (appContext.shared.lookThroughShot ? appContext.shared.look : appContext.shared.editorLook).current.yaw;
		const receipt = run("object.update", { id, patch: camera ? sculptPlacement(camera.position, yaw) : { y: 0 } });
		appContext.shared.setSelectedHierarchyId(`object:${id}`);
		return receipt;
	}

	/** A sculpt reference goes into the asset store like a cutout's picture;
	 * the run reads it back as a data URL of the stored bytes. */
	async function storeSculptReference(file) {
		const prepared = await importImageFile(file);
		const stored = await rememberAsset(prepared);
		return { dataUrl: assetDataUrl(prepared), name: prepared.name || file.name || "reference", assetId: stored.id };
	}

	function placementInFrontOfShot() {
		const camera = (appContext.shared.lookThroughShot ? appContext.shared.shotCamRef : appContext.shared.editorCamRef).current;
		return camera
			? placementInFront({ x: camera.position.x, z: camera.position.z }, (appContext.shared.lookThroughShot ? appContext.shared.look : appContext.shared.editorLook).current.yaw)
			: {};
	}

	/**
	 * Import one GLB and stand it on the floor. Bytes go through putAsset —
	 * never rememberAsset — because the texture cache would decode them as a
	 * bitmap. Height and footprint come from the import heuristic once;
	 * later instances reuse those stored metres.
	 */
	async function importMesh(file, commandContext) {
		if (!file) return;
		if (!commandContext) return importFile(file, "mesh");
		try {
			const { asset, height, footprint } = await importMeshFile(file);
			await persistMeshAsset(asset);
			const object = createMeshObject(
				{ assetId: asset.id, height, footprint, name: meshNameFromFile(asset.name) },
				domain.read(),
				placementInFrontOfShot(),
			);
			const imported = publishImported(object, commandContext);
			appContext.notify(ko(`${object.name} added — type its real height in metres to set the scale`,
				`${object.name} 추가됨 — 실제 높이(m)를 입력하면 크기가 맞습니다`,
				`${object.name} 已添加 — 输入实际高度（米）即可匹配尺寸`));
			return imported;
		} catch (error) {
			throw new StudioProtocolError(error.code ?? "INVALID_ARGUMENT", `Could not import that model: ${error.message}`);
		}
	}

	async function importMeshes(files) {
		for (const file of files) await importMesh(file);
	}

	/**
	 * Stand an already-stored GLB up as a fresh instance. The shelf drop does
	 * not keep a previous object's size: it re-reads the blob and fits once,
	 * the same as a first import, because there is no prior record to copy.
	 */
	async function spawnMeshAt(assetId, placement, commandContext) {
		if (!commandContext) return importStoredAsset(assetId, "mesh", placement);
		appContext.shared.markCraftAction("object");
		const record = await assetRecord(assetId);
		if (!record) throw new StudioProtocolError("TARGET_NOT_READY", "That model is no longer stored.");
		const compressed = compressedGlbReason(record.bytes);
		if (compressed) throw new StudioProtocolError("INVALID_ARGUMENT", compressed);
		const bounds = meshBoundsFromAsset(record);
		const fitted = bounds ? fitMeshBounds(bounds) : null;
		if (!fitted) throw new StudioProtocolError("INVALID_ARGUMENT", "That model has no measurable geometry.");
		const object = createMeshObject(
			{
				assetId: record.id,
				height: fitted.height,
				footprint: fitted.footprint,
				name: meshNameFromFile(record.name),
			},
			domain.read(),
			placement,
		);
		const imported = publishImported(object, commandContext);
		appContext.notify(ko(`${object.name} added — type its real height in metres to set the scale`,
			`${object.name} 추가됨 — 실제 높이(m)를 입력하면 크기가 맞습니다`,
			`${object.name} 已添加 — 输入实际高度（米）即可匹配尺寸`));
		return imported;
	}

	/**
	 * Apply what the background editor is showing.
	 *
	 * Nothing is destroyed. The card keeps three things: the photograph it was
	 * imported from, the purple someone painted on it, and the cut picture the
	 * set actually renders — so the next edit starts from the original with the
	 * selection still on it, however many times it is re-cut.
	 *
	 * Trimming the dead margin changes how much of the frame the subject fills,
	 * so the card's height is scaled with it. The scale is stored rather than
	 * multiplied in, or a second cut would compound one trim onto the last.
	 */
	async function applyMatte(id = selectedSceneObjectId, commandContext) {
		if (!commandContext) return run("object.matte", { objectId: id });
		const object = domain.read().find((item) => item.id === id) ?? null;
		const options = appContext.shared.matteEditorRef.current?.options();
		// Nothing purple means nothing was asked for. Removing "the background"
		// on a picture nobody has marked would be a guess applied to their set.
		if (!object || object.renderer !== CUTOUT_KIND || !options || matteBusy) throw new StudioProtocolError("TARGET_NOT_READY", "Select a cutout with a painted matte first.");
		setMatteBusy(true);
		try {
			const sourceId = object.sourceAssetId || object.assetId;
			const source = await assetRecord(sourceId);
			if (!source) throw new Error(ko("its picture is missing from the store", "저장소에 사진이 없습니다"));
			const [cut, matte] = await Promise.all([
				cutOutBackground(source, { mask: options.mask, shrink: matteShrink, feather: matteFeather }),
				maskAsset(options.mask, { width: options.maskWidth, height: options.maskHeight, name: `${source.name || "cutout"} matte` }),
			]);
			await Promise.all([
				rememberAsset({ ...cut.asset, role: "derived" }),
				rememberAsset({ ...matte, role: "derived" }),
			]);
			const fullFrameHeight = object.height / (object.matteScale || 1);
			commandContext.commit(() => domain.write(objects => updateSceneObject(objects, object.id, {
				assetId: cut.asset.id,
				sourceAssetId: source.id,
				matteAssetId: matte.id,
				matteScale: cut.heightScale,
				aspect: cut.asset.width / cut.asset.height,
				height: fullFrameHeight * cut.heightScale,
			})));
			appContext.notify(ko(`${object.name} — ${Math.round(cut.removed * 100)}% removed. The original and your selection are kept`,
				`${object.name} 배경 제거 — ${Math.round(cut.removed * 100)}% 지움. 원본과 칠한 영역은 그대로 남습니다`,
				`${object.name} 背景已移除 — 清除 ${Math.round(cut.removed * 100)}%。原图和选区仍保留`));
			return { objectId: object.id };
		} catch (error) {
			throw new StudioProtocolError(error.code ?? "TARGET_NOT_READY", `Could not remove the background: ${error.message}`);
		} finally {
			setMatteBusy(false);
		}
	}

	function duplicateSelectedSceneObject(id = selectedSceneObjectId) {
		// Defaults to the selection (Ctrl/Cmd+D); the hierarchy context menu
		// passes a specific row's id. Same result either way: the copy is
		// selected, offset one grid step, and toasted.
		const objects = domain.read();
		const object = objects.find((item) => item.id === id) ?? null;
		if (!object) return;
		const placement = { x: object.x, z: object.z, rot: object.rot };
		// A cutout cannot be minted from the catalogue — it needs the picture the
		// original is already wearing — so the copy is created through its own
		// door and shares the asset rather than importing it twice.
		const copy = object.renderer === CUTOUT_KIND
			? createCutoutObject(duplicateCutoutOptions(object), objects, placement)
			: object.renderer === MESH_KIND
				? createMeshObject(duplicateMeshOptions(object), objects, placement)
				: object.renderer === SCULPT_KIND
					? createSculptObject(duplicateSculptOptions(object), objects, placement).object
					: createSceneObject(object.renderer, objects, placement);
		if (!copy) return;
		// Unity drops the duplicate exactly on top of the original; for blocking,
		// one grid step to the side means you can see that it worked.
		const placed = { ...object, id: copy.id, name: copy.name, x: object.x + 0.5 };
		domain.write((objects) => [...objects, placed]);
		appContext.shared.setSelectedHierarchyId(`object:${placed.id}`);
		appContext.notify((isKo, ko) => ko(`${placed.name} duplicated`, `${sceneObjectNameDisplayKo(placed.name)} 복제됨`, `${sceneObjectNameDisplayKo(placed.name)}已复制`));
	}

	function frameSelection(id = selectedSceneObjectId) {
		const object = sceneObjects.find((item) => item.id === id) ?? null;
		if (!object) return;
		const size = objectSize(object);
		appContext.shared.frameWorldTarget(
			{ x: object.x, y: (object.y ?? 0) + size.height / 2, z: object.z },
			Math.max(size.width, size.height, size.depth, 0.5),
		);
	}

	/** Outliner "Group under new Empty": the object's parent node, made on the
	 * spot. One command, one write, so one undo takes back the Empty and the
	 * reparent together. Selection follows the Empty, the new handle. */
	function groupObjectUnderNewEmpty(id = selectedSceneObjectId) {
		if (!id) return null;
		try {
			const receipt = run("object.groupUnderEmpty", { id });
			const emptyId = receipt.affectedIds[0];
			appContext.shared.setSelectedHierarchyId(`object:${emptyId}`);
			setRenameRequest({ id: `object:${emptyId}`, nonce: Date.now() });
			setGizmoMode("move");
			appContext.notify(ko("Grouped under a new Empty", "빈 오브젝트로 묶었어요"));
			return emptyId;
		} catch (error) {
			appContext.notify(error?.message || ko("Could not group this object", "이 오브젝트는 묶을 수 없어요"));
			return null;
		}
	}

	/** In-place rename commit from the hierarchy (F2 / Return / rename on
	 * create). The row label lives in the tree; the object name is shared
	 * state, so this is just the inspector's rename through another door. */
	function renameSceneObject(id, name) {
		return run("object.rename", { id, name });
	}

	/** The prop's live world matrix, falling back to its authored numbers while
	 * it is unattached (those ARE world) and the set has not mounted it yet. */
	function sceneObjectWorldMatrix(object) {
		return appContext.shared.propWorldRef.current?.(object.id, attachWorldMatrix)
			?? ((object.attach ?? null) ? null : sceneObjectMatrix(object, attachWorldMatrix));
	}

	/** The attachment a hierarchy row offers, or null when the row is not a
	 * frame. A character row means the whole body's animated root; a bone row
	 * means that one frame. Bone rows are namespaced per character (#76), so
	 * the row itself names whose frame it is. */
	function attachTargetForRow(rowId) {
		const charId = appContext.shared.charIdFromHierarchyId(rowId);
		if (charId) return appContext.shared.characters.some((entry) => entry.id === charId) ? { characterId: charId, bone: null } : null;
		const rig = parseRigNodeId(rowId);
		const owner = rig ? appContext.shared.charIdFromHierarchyId(rig.rowId) : null;
		const bone = rig ? ATTACH_BONE_ROWS.get(rig.token) : null;
		if (!bone || !owner || !appContext.shared.characters.some((entry) => entry.id === owner)) return null;
		return { characterId: owner, bone };
	}

	/** "Character 1 · Right Hand" — the same words the rows the user dropped on
	 * carry, so the Inspector names the target the way the tree does. */
	function attachTargetLabel(attach) {
		const index = appContext.shared.characters.findIndex((entry) => entry.id === attach.characterId);
		const who = index < 0
			? ko("Missing character", "없는 인물")
			: index === 0
				? ko("Character 1", "인물 1")
				: index === 1
					? ko("Character 2", "인물 2")
					: ko(`Character ${index + 1}`, `인물 ${index + 1}`, `角色 ${index + 1}`);
		const bone = attach.bone
			? HIERARCHY_INSPECTOR_TITLES[`rig.${attach.bone}`] ?? attach.bone
			: ko("Root", "루트");
		return `${who} · ${bone}`;
	}

	/** Carry a prop on a character's root (`bone` null) or one of its bones, or
	 * put it back in the world with `attach` null — the Hierarchy's character,
	 * bone and Props drops, the Inspector's Detach and run_action
	 * object.attach/detach. */
	function attachSceneObject(id, attach) {
		const object = storeRef.current.objects.find((entry) => entry.id === id);
		if (!object) throw new StudioProtocolError("STALE_TARGET", `Object ${id} is not in this scene.`);
		if (attach) appContext.shared.castMemberOf(attach.characterId);
		// Where the prop is on screen right now, expressed in the frame it is
		// joining (or left as world when it joins none). ONE conversion, whether
		// the prop is coming from the world or from another frame.
		const shown = appContext.shared.animatedSceneObjects.find((entry) => entry.id === id) ?? object;
		const placement = attachPlacementPatch(sceneObjectWorldMatrix(shown), attach, appContext.shared.attachFrameRef.current);
		// A placement that could not be computed refuses the attachment, not just
		// the numbers: attaching without converting would silently reinterpret the
		// old frame's numbers in the new frame, which is the jump itself.
		if (!placement) {
			throw new StudioProtocolError("TARGET_NOT_READY", attach
				? `The ${attach.bone ?? "root"} frame of character ${attach.characterId} is not on stage (its rig has not loaded).`
				: `${object.name || id} is not on stage, so where it is now cannot be read.`);
		}
		// ONE atomic: a single undo puts back both the field and the numbers.
		storeRef.current.applyAtomic((objects) => {
			let next = setSceneObjectAttach(objects, id, attach);
			// Back to the world means "world-anchored again", which drops the
			// grouping parent too — attach and parent are the same slot.
			if (attach === null) next = setSceneObjectParent(next, id, null);
			if (next === objects) return objects;
			return placeSceneObject(next, id, placement);
		});
	}
	async function importCommandAsset(args, commandContext) {
		const IMPORT_BACKDROP_DISTANCE_M = 12, IMPORT_BACKDROP_HEIGHT_M = 5;
		if (typeof args.name !== "string" || !args.name.trim()) throw new Error("Invalid name");
		if (args.placeAs === "mesh") {
			const dataUrl = args.dataUrl;
			if (typeof dataUrl !== "string") throw new Error("dataUrl must be a 3D model data URL");
			const nameLower = String(args.name).toLowerCase();
			const headerMime = dataUrl.slice(5, dataUrl.search(/[;,]/)).toLowerCase();
			const mime = (typeof args.mimeType === "string" && args.mimeType
				? args.mimeType
				: headerMime).toLowerCase();
			const objPlain = mime === "text/plain" && nameLower.endsWith(".obj");
			const fbxPlain = mime === "text/plain" && nameLower.endsWith(".fbx");
			const headerOk = dataUrl.startsWith("data:model/gltf-binary")
				|| dataUrl.startsWith("data:application/octet-stream")
				|| dataUrl.startsWith("data:model/obj")
				|| dataUrl.startsWith("data:model/fbx")
				|| (dataUrl.startsWith("data:text/plain") && (nameLower.endsWith(".obj") || nameLower.endsWith(".fbx")));
			const mimeOk = mime === "model/gltf-binary" || mime === "application/octet-stream"
				|| mime === "model/obj" || mime === "model/fbx" || objPlain || fbxPlain;
			if (!headerOk && !mimeOk) throw new Error("dataUrl must be a 3D model data URL");
			const bytes = await (await fetch(dataUrl)).arrayBuffer();
			const fileType = mime || headerMime || "application/octet-stream";
			const file = new File([bytes], args.name, { type: fileType });
			const { asset, height, footprint } = await importMeshFile(file);
			const db = await openAssetDb();
			try {
				await putAsset(db, asset);
			} finally {
				db.close?.();
			}
			const live = appContext.live.state;
			const camera = appContext.shared.shotCamRef.current;
			const hasFloor = Number.isFinite(args.x) || Number.isFinite(args.z);
			const placement = hasFloor
				? {
					x: Number.isFinite(args.x) ? args.x : 0,
					z: Number.isFinite(args.z) ? args.z : 0,
				}
				: camera
					? placementInFront({ x: camera.position.x, z: camera.position.z }, appContext.shared.look.current.yaw)
					: {};
			if (Number.isFinite(args.rot)) placement.rot = args.rot;
			let object = createMeshObject(
				{
					assetId: asset.id,
					height,
					footprint,
					name: args.name,
					clay: args.clay === true,
				},
				live.objects,
				placement,
			);
			if (!object) throw new Error("Could not create the mesh object");
			// Inspector height edits scale the stored footprint. Do the same
			// here so a 50 cm import is a smaller cube, not a squat 1×1×0.5 box.
			if (Number.isFinite(args.height) && args.height > 0) {
				object = updateSceneObject([object], object.id, { height: args.height })[0];
			}
			if (Number.isFinite(args.y)) object.y = args.y;
			commandContext.commit(() => domain.write((objects) => [...objects, object]));
			return { assetId: asset.id, objectId: object.id };
		}
		if (args.placeAs !== "cutout" && args.placeAs !== "backdrop") throw new Error('placeAs must be "cutout", "backdrop" or "mesh"');
		if (typeof args.dataUrl !== "string" || !args.dataUrl.startsWith("data:image/")) throw new Error("dataUrl must be an image data URL");
		const mime = typeof args.mimeType === "string" && args.mimeType
			? args.mimeType
			: args.dataUrl.slice(5, args.dataUrl.search(/[;,]/));
		const bytes = await (await fetch(args.dataUrl)).arrayBuffer();
		const file = new File([bytes], args.name, { type: mime });
		const live = appContext.live.state;
		const asset = await rememberAsset(await importImageFile(file));
		const backdrop = args.placeAs === "backdrop";
		const camera = appContext.shared.shotCamRef.current;
		const placement = camera
			? placementInFront(
				{ x: camera.position.x, z: camera.position.z },
				appContext.shared.look.current.yaw,
				backdrop ? IMPORT_BACKDROP_DISTANCE_M : undefined,
			)
			: {};
		if (backdrop) {
			// The card's face is its +z; rotate by the camera's own yaw so the
			// plate faces the lens instead of standing edge-on to it.
			placement.rot = (appContext.shared.look.current.yaw * 180) / Math.PI;
		}
		const object = createCutoutObject(
			{
				assetId: asset.id,
				aspect: assetAspect(asset) ?? 1,
				height: backdrop ? IMPORT_BACKDROP_HEIGHT_M : CUTOUT_DEFAULT_HEIGHT,
				name: args.name,
			},
			live.objects,
			placement,
		);
		if (!object) throw new Error("Could not create the cutout object");
		commandContext.commit(() => domain.write((objects) => [...objects, object]));
		return { assetId: asset.id, objectId: object.id };
	}
	function applyObjectBatch(args) {
		let batchObjects = domain.read();
		const finitePatch = (args, fields) => Object.fromEntries(fields.filter(field => args[field] !== undefined).map(field => {
			if (!Number.isFinite(args[field])) throw new Error(`Invalid ${field}`);
			return [field, args[field]];
		}));
		function syncObjects() { appContext.patchLive({ objects: storeRef.current.objects }); }
		function applyObjectMutation(mutation) { batchObjects = mutation(batchObjects); }
		const liveObjects = () => ({ ...appContext.live.state, objects: batchObjects });
		function placeObject(args) {
			if (typeof args.kind !== "string") throw new Error("Invalid kind");
			const live = liveObjects();
			// The parent is checked before anything is created: a bad id must
			// not leave a half-made part lying around unattached.
			if (args.parent !== undefined) {
				if (typeof args.parent !== "string" || !live.objects.some((o) => o.id === args.parent)) {
					throw new Error(`Parent object not found: ${args.parent}`);
				}
			}
			if (args.name !== undefined && (typeof args.name !== "string" || !args.name.trim())) {
				throw new Error("Invalid name");
			}
			const placement = finitePatch(args, ["x", "z", "rot"]);
			const object = createSceneObject(args.kind, live.objects, placement);
			if (!object) throw new Error(`Unknown object kind: ${args.kind}`);
			const patch = finitePatch(args, ["y"]);
			if (args.name !== undefined) patch.name = args.name;
			const placed = updateSceneObject([object], object.id, patch)[0];
			// One atomic entry: create, name and attach undo together, as the
			// single "place part" gesture they are to the caller.
			applyObjectMutation((objects) => {
				const next = [...objects, placed];
				return args.parent !== undefined ? setSceneObjectParent(next, placed.id, args.parent) : next;
			});
			return { id: placed.id };
		}
		function updateObject(args) {
			const live = liveObjects();
			if (typeof args.id !== "string" || !live.objects.some((object) => object.id === args.id)) throw new Error("Object not found");
			const patch = finitePatch(args, ["x", "y", "z", "rot", "rotX", "rotZ"]);
			// A uniform `scale` is the common case; per-axis values are what a
			// squashed disc or a stretched column needs, exactly as the
			// inspector's three sliders provide. Per-axis wins when both come.
			if (args.scale !== undefined) {
				if (!Number.isFinite(args.scale)) throw new Error("Invalid scale");
				patch.scaleX = args.scale;
				patch.scaleY = args.scale;
				patch.scaleZ = args.scale;
			}
			Object.assign(patch, finitePatch(args, ["scaleX", "scaleY", "scaleZ"]));
			if (args.color !== undefined) {
				if (typeof args.color !== "string") throw new Error("Invalid color");
				patch.color = args.color;
			}
			if (args.name !== undefined) {
				if (typeof args.name !== "string" || !args.name.trim()) throw new Error("Invalid name");
				patch.name = args.name;
			}
			// A travel path arrives whole (or null to clear it); the object
			// schema repairs or refuses it, so a bad route cannot land.
			if (args.path !== undefined) {
				if (args.path !== null && createObjectPath(args.path) === null) throw new Error("Invalid path: needs two or more distinct points");
				patch.path = args.path;
			}
			if (Number.isFinite(args.height)) patch.height = args.height;
			if (typeof args.clay === "boolean") patch.clay = args.clay;
			if (typeof args.hidden === "boolean") patch.hidden = args.hidden;
			applyObjectMutation((objects) => updateSceneObject(objects, args.id, patch));
			return { id: args.id };
		}
		function removeObject(args) {
			const live = liveObjects();
			if (typeof args.id !== "string" || !live.objects.some((object) => object.id === args.id)) throw new Error("Object not found");
			applyObjectMutation((objects) => removeSceneObject(objects, args.id));
			return { id: args.id };
		}
		function groupObjects(args) {
			const live = liveObjects();
			if (typeof args.parent !== "string" || !live.objects.some((o) => o.id === args.parent)) {
				throw new Error("Parent object not found");
			}
			if (!Array.isArray(args.children) || !args.children.length) throw new Error("No children given");
			for (const child of args.children) {
				if (!live.objects.some((o) => o.id === child)) throw new Error(`Object not found: ${child}`);
			}
			applyObjectMutation((objects) =>
				args.children.reduce((acc, child) => setSceneObjectParent(acc, child, args.parent), objects),
			);
			return { parent: args.parent, children: args.children.length };
		}
		function ungroupObjects(args) {
			const live = liveObjects();
			if (!Array.isArray(args.children) || !args.children.length) throw new Error("No children given");
			for (const child of args.children) {
				if (!live.objects.some((o) => o.id === child)) throw new Error(`Object not found: ${child}`);
			}
			applyObjectMutation((objects) =>
				args.children.reduce((acc, child) => setSceneObjectParent(acc, child, null), objects),
			);
			return { children: args.children.length };
		}
		function executeBatch(args) {
			if (!Array.isArray(args.ops)) throw new Error("Invalid batch operations");
			if (args.ops.length > 100) throw new Error("A batch may contain at most 100 operations");
			if (args.atomic !== undefined && typeof args.atomic !== "boolean") throw new Error("Invalid atomic flag");
			if (args.stopOnError !== undefined && typeof args.stopOnError !== "boolean") throw new Error("Invalid stopOnError flag");
			if (args.label !== undefined && (typeof args.label !== "string" || !args.label.trim())) throw new Error("Invalid batch label");
			const objectCommands = new Set(["place_object", "update_object", "remove_object", "group_objects", "ungroup_objects"]);
			for (const operation of args.ops) {
				if (!operation || typeof operation !== "object" || Array.isArray(operation)) throw new Error("Invalid batch operation");
				if (operation.name === "apply_batch") throw new Error("Nested batches are not supported");
				if (!objectCommands.has(operation.name)) {
					throw new Error("Batch v1 supports object mutations only; character mutations are not supported");
				}
				if (!operation.args || typeof operation.args !== "object" || Array.isArray(operation.args)) throw new Error("Invalid batch operation arguments");
			}
			const atomic = args.atomic === true;
			const stopOnError = args.stopOnError !== false;
			batchObjects = domain.read();
			const applied = [];
			const failed = [];
			let rolledBack = false;
			try {
				for (const [index, operation] of args.ops.entries()) {
					try {
						handlers[operation.name](operation.args);
						applied.push(index + 1);
					} catch (error) {
						failed.push({ index: index + 1, error: error instanceof Error ? error.message : "Command failed" });
						if (stopOnError) break;
					}
				}
				rolledBack = atomic && failed.length > 0;
				if (!rolledBack) domain.write(batchObjects);
			} finally {
				batchObjects = null;
			}
			syncObjects();
			return { label: args.label?.trim() || "MCP batch", applied, failed, rolledBack };
		}
		const handlers = { place_object: placeObject, update_object: updateObject, remove_object: removeObject, group_objects: groupObjects, ungroup_objects: ungroupObjects };
		return executeBatch(args);
	}
	domain.batch = applyObjectBatch;
	function canReparentSceneObject(sourceRowId, targetRowId) {
		const id = sceneObjectIdFromHierarchy(String(sourceRowId ?? ""));
		if (!id || sourceRowId === targetRowId) return false;
		const object = sceneObjects.find((entry) => entry.id === id);
		if (!object) return false;
		const targetObjectId = sceneObjectIdFromHierarchy(String(targetRowId ?? ""));
		// Grouping keeps its own rules (self, cycles, unknown ids) — asking the
		// store is the only way to stay honest about them.
		if (targetObjectId) return setSceneObjectParent(sceneObjects, id, targetObjectId) !== sceneObjects;
		// Props takes an object out of its group (or off a character) and lists
		// it first, so the drop always shows; a top-level object moves up too.
		if (targetRowId === "props") return (object.attach ?? null) !== null || (object.parent ?? null) !== null || sceneObjects[0]?.id !== id;
		const attach = attachTargetForRow(targetRowId);
		if (!attach) return false;
		const current = object.attach ?? null;
		return !current || current.characterId !== attach.characterId || (current.bone ?? null) !== attach.bone;
	}
	function reparentSceneObject(sourceRowId, targetRowId) {
		if (!canReparentSceneObject(sourceRowId, targetRowId)) return;
		const id = sceneObjectIdFromHierarchy(String(sourceRowId));
		const targetObjectId = sceneObjectIdFromHierarchy(String(targetRowId));
		// Grouping moves nothing on screen — the set places every prop at its
		// own absolute transform. Taking a parent DOES cancel an attachment
		// (the store's exclusivity rule), so a carried prop dropped into a
		// group comes back to world numbers on the way, exactly as the Props
		// row would put it back.
		if (targetObjectId) return run("object.group", { parent: targetObjectId, children: [id] });
		const object = sceneObjects.find((entry) => entry.id === id);
		if (targetRowId === "props" && !object?.attach) {
			// Out of its group and to the top of Props in one write (one undo):
			// records are world-space, so clearing the parent moves nothing.
			const rows = setSceneObjectParent(domain.read(), id, null);
			const moved = rows.find((entry) => entry.id === id);
			return run("objects.replace", { objects: [moved, ...rows.filter((entry) => entry.id !== id)] });
		}
		const attach = targetRowId === "props" ? null : attachTargetForRow(targetRowId);
		appContext.shared.runStudioAction(attach ? "object.attach" : "object.detach", attach
			? { objectId: id, characterId: attach.characterId, ...(attach.bone ? { bone: attach.bone } : {}) }
			: { objectId: id });
	}
	domain.group = (parent, children) => {
		const placements = new Map(children.map(id => {
			const object = domain.read().find(row => row.id === id);
			const shown = appContext.shared.animatedSceneObjects.find(row => row.id === id) ?? object;
			const placement = object.attach ? attachPlacementPatch(sceneObjectWorldMatrix(shown), null, appContext.shared.attachFrameRef.current) : null;
			if (object.attach && !placement) throw new StudioProtocolError("TARGET_NOT_READY", `Object ${id} is not on stage.`);
			return [id, placement];
		}));
		domain.write(objects => children.reduce((rows, id) => placeSceneObject(setSceneObjectParent(rows, id, parent), id, placements.get(id)), objects));
	};
	function settleObjects() { return storeRef.current.settle(); }
	function beginStudioObjectAction() { return storeRef.current.beginCommand(); }
	function stepObjectHistory(redo) { return (redo ? storeRef.current.redo : storeRef.current.undo)(); }
	// Runs from the cross-tab scene subscription: a refusal ends here, logged, never in window.onerror (#1185).
	function applyExternalObjects(objects) { return settleUiRefusal("the objects from another tab were not applied", () => run("objects.replace", { objects: Array.isArray(objects) ? objects : [] })); }

	return {
		...domain, run, beginStudioObjectAction, stepObjectHistory, applyExternalObjects,
		canReparentSceneObject, reparentSceneObject, settleObjects,
		recentObjectColors, objectColorDraft, setObjectColorDraft, rememberSceneObjectColor, objectDeleteUndo,
		setObjectDeleteUndo, sceneObjects, storeRef, store, selectedSceneObjectId,
		selectedSceneObject, beginSceneTransaction, endSceneTransaction, changeSceneObject,
		deleteSelectedSceneObject, deleteSceneObject, dropSelectedSceneObject, matteTolerance, setMatteTolerance,
		matteBrush, setMatteBrush, matteShrink, setMatteShrink, matteFeather, setMatteFeather, matteMode,
		setMatteMode, matteStats, setMatteStats, matteBusy, gizmoMode, setGizmoMode, snapEnabled, setSnapEnabled,
		addSceneObject, importCutout, importCutouts, spawnCutoutAt, persistMeshAsset, importMesh, importMeshes,
		spawnMeshAt, applyMatte, duplicateSelectedSceneObject, frameSelection, groupObjectUnderNewEmpty, renameRequest, renameSceneObject,
		sceneObjectWorldMatrix, attachTargetLabel, attachSceneObject,
		placeSculptInScene, storeSculptReference,
	};
}
