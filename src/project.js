/**
 * CozyClay project files — game-engine style.
 *
 * A project is ONE file (`.cclayproject`, JSON) holding the full authoring
 * state: the scene document (scenes + cast + animation layers), the
  * workspace layout, the custom pose library, the workflow graph, and the
 * embedded resources (images and meshes) the scenes point at. A compiled
 * take travels inside the scene document as its motion spec. Editor
 * preferences (theme, locale) deliberately stay OUT — they belong to the
 * operator, not the project.
 *
 * Files are read/written with the File System Access API when available,
 * with a plain download/upload fallback. The last-used handle is kept in
 * IndexedDB so a refresh can re-open the same project when the browser
 * still grants access.
 */

import { SCENES_VERSION } from "./scenes.js";
import { ASSET_MAX_SOURCE_BYTES, assetIdForBytes, isAssetId, isImageAssetId, isMeshAssetId, meshIdForBytes, normalizeAsset, referencedAssetIds } from "./scene-assets.js";
import { ko } from "./locale.js"; import { hdrIdForBytes, isHdrAssetId } from "./stage-hdr.js"; import { decodeWorkflowDraft, encodeWorkflowDraft } from "./workflow-draft-codec.js";

export const PROJECT_VERSION = 5;
// A project is authored either as a storyboard (stills) or as animation
// (clips). v5 records the choice on the envelope; v2-v4 files are animation.
export const PREVIS_MODES = Object.freeze(["storyboard", "animation"]);
export const DEFAULT_PREVIS_MODE = "animation";

export const normalizePrevisMode = (value) => (PREVIS_MODES.includes(value) ? value : DEFAULT_PREVIS_MODE);
// Which bodies the project is cast with: rigged humanoids for detailed previs,
// capsule figures for simple previs, or a mix. A file without the field
// predates the choice and already holds a rig character, so it reads as hybrid.
export const CAST_STYLES = Object.freeze(["rig", "capsule", "hybrid"]), DEFAULT_CAST_STYLE = "hybrid";
export const normalizeCastStyle = (value) => (CAST_STYLES.includes(value) ? value : DEFAULT_CAST_STYLE);
export const PROJECT_EXTENSION = ".cclayproject";
export const WORKFLOW_VERSION = 1;
export const WORKFLOW_STORAGE_KEY = "cozyclay.workflow.v1";
const IDB_NAME = "cozyclay.project-handle.v1";
const IDB_STORE = "kv";
const IDB_KEY = "lastProjectHandle";

// Embedded resources are bounded: the file is JSON, so every raw byte costs
// 4/3 on disk and the whole file has to fit in one string on the way in.
export const PROJECT_MAX_RESOURCE_BYTES = 256 * 1024 * 1024;


function plainRecord(value) {
	if (!value || typeof value !== "object") return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function jsonValue(value, depth = 0) {
	if (value === null || typeof value === "string" || typeof value === "boolean") return value;
	if (typeof value === "number") return Number.isFinite(value) ? value : null;
	if (depth > 32) return null;
	if (Array.isArray(value)) return value.map((entry) => jsonValue(entry, depth + 1));
	if (!plainRecord(value)) return null;
	const result = {};
	for (const [key, entry] of Object.entries(value)) {
		// These keys can mutate an object's prototype when a graph is consumed
		// by a less defensive host.
		if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
		if (entry !== undefined && typeof entry !== "function" && typeof entry !== "symbol") result[key] = jsonValue(entry, depth + 1);
	}
	return result;
}

function normalizedPosition(value) {
	return {
		x: Number.isFinite(value?.x) ? value.x : 0,
		y: Number.isFinite(value?.y) ? value.y : 0,
	};
}

/** Return a fresh empty graph for new projects and legacy-file migration. */
export function createWorkflowGraph() {
	return { version: WORKFLOW_VERSION, nodes: [], edges: [] };
}

/**
 * Validate the persisted graph envelope. Node data is intentionally opaque;
 * it is copied and JSON-sanitized by normalizeWorkflowGraph below.
 */
export function isWorkflowGraph(value) {
	if (!plainRecord(value) || value.version !== WORKFLOW_VERSION || !Array.isArray(value.nodes) || !Array.isArray(value.edges)) return false;
	const ids = new Set();
	for (const node of value.nodes) {
		if (!plainRecord(node) || typeof node.id !== "string" || !node.id.trim() || ids.has(node.id)) return false;
		if (node.type !== undefined && (typeof node.type !== "string" || !node.type.trim())) return false;
		if (!plainRecord(node.position) || !Number.isFinite(node.position.x) || !Number.isFinite(node.position.y)) return false;
		if (node.data !== undefined && !plainRecord(node.data)) return false;
		ids.add(node.id);
	}
	const edgeIds = new Set();
	for (const edge of value.edges) {
		if (!plainRecord(edge) || typeof edge.source !== "string" || typeof edge.target !== "string" || !ids.has(edge.source) || !ids.has(edge.target)) return false;
		if (edge.id !== undefined && (typeof edge.id !== "string" || !edge.id.trim() || edgeIds.has(edge.id))) return false;
		if (edge.sourceHandle !== undefined && typeof edge.sourceHandle !== "string") return false;
		if (edge.targetHandle !== undefined && typeof edge.targetHandle !== "string") return false;
		if (edge.data !== undefined && !plainRecord(edge.data)) return false;
		if (edge.id !== undefined) edgeIds.add(edge.id);
	}
	return true;
}

/**
 * Sanitize an arbitrary graph before it crosses the project-file boundary.
 * Invalid nodes/edges are dropped, dangling edges are removed, and every
 * returned object is detached from the caller's mutable input.
 */
export function normalizeWorkflowGraph(value) {
	if (!plainRecord(value) || (value.version !== undefined && value.version !== WORKFLOW_VERSION)) return createWorkflowGraph();
	const nodes = [];
	const nodeIds = new Set();
	for (const node of Array.isArray(value.nodes) ? value.nodes : []) {
		if (!plainRecord(node) || typeof node.id !== "string" || !node.id.trim() || nodeIds.has(node.id)) continue;
		const data = jsonValue(node.data);
		nodes.push({
			id: node.id,
			type: typeof node.type === "string" && node.type.trim() ? node.type : "default",
			position: normalizedPosition(node.position),
			data: plainRecord(data) ? data : {},
		});
		nodeIds.add(node.id);
	}
	const edges = [];
	const edgeIds = new Set();
	for (let index = 0; index < (Array.isArray(value.edges) ? value.edges.length : 0); index += 1) {
		const edge = value.edges[index];
		if (!plainRecord(edge) || typeof edge.source !== "string" || typeof edge.target !== "string" || !nodeIds.has(edge.source) || !nodeIds.has(edge.target)) continue;
		const candidateId = typeof edge.id === "string" && edge.id.trim() ? edge.id : `${edge.source}->${edge.target}:${index}`;
		if (edgeIds.has(candidateId)) continue;
		const normalized = { id: candidateId, source: edge.source, target: edge.target };
		if (typeof edge.sourceHandle === "string" && edge.sourceHandle) normalized.sourceHandle = edge.sourceHandle;
		if (typeof edge.targetHandle === "string" && edge.targetHandle) normalized.targetHandle = edge.targetHandle;
		const data = jsonValue(edge.data);
		if (plainRecord(data)) normalized.data = data;
		edges.push(normalized);
		edgeIds.add(candidateId);
	}
	return { version: WORKFLOW_VERSION, nodes, edges };
}

/** Read the browser-local workflow draft used by the standalone canvas.
 * A corrupt draft reads as an empty graph unless `strict`, which rethrows the
 * parse error so a caller about to write can refuse to overwrite it. */
export function loadWorkflowGraph(storage = globalThis.localStorage, { strict = false } = {}) {
	try {
		return normalizeWorkflowGraph(decodeWorkflowDraft(storage?.getItem(WORKFLOW_STORAGE_KEY)));
	} catch (error) {
		if (strict) throw error;
		return createWorkflowGraph();
	}
}

/** Persist a sanitized workflow draft without allowing storage failures to
 * take down the Studio (private browsing and full quotas are both common). */
export function storeWorkflowGraph(graph, storage = globalThis.localStorage) {
	const normalized = normalizeWorkflowGraph(graph);
	try {
		storage?.setItem(WORKFLOW_STORAGE_KEY, encodeWorkflowDraft(normalized));
	} catch {
		// localStorage is an optional session cache; the project file remains the
		// durable source of truth.
	}
	try { globalThis.dispatchEvent?.(new CustomEvent("cozyclay:workflow-change")); } catch { /* non-browser runtime */ }
	return normalized;
}

function asArrayBuffer(bytes) {
	if (bytes instanceof ArrayBuffer) return bytes;
	if (ArrayBuffer.isView(bytes)) return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
	return null;
}

function bytesToBase64(bytes) {
	const view = new Uint8Array(bytes);
	let binary = "";
	for (let offset = 0; offset < view.length; offset += 0x8000) {
		binary += String.fromCharCode(...view.subarray(offset, offset + 0x8000));
	}
	return btoa(binary);
}

/**
 * Structural check of a base64 payload without decoding it: character set,
 * padding, and the byte length the string implies. Returns `{ bytes }` or
 * `{ code }` with a problem code.
 */
function base64Shape(value, limit) {
	if (typeof value !== "string" || value.length < 4 || value.length % 4) return { code: "bad-base64" };
	if (value.length > Math.ceil(limit / 3) * 4) return { code: "too-large" };
	const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
	for (let index = 0; index < value.length - padding; index += 1) {
		const code = value.charCodeAt(index);
		const base64Character = (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || (code >= 48 && code <= 57) || code === 43 || code === 47;
		if (!base64Character) return { code: "bad-base64" };
	}
	const bytes = (value.length / 4) * 3 - padding;
	return bytes > limit ? { code: "too-large" } : { bytes };
}

/** Decode a base64 payload. Returns `{ buffer }` or `{ code }`. */
function base64ToBytes(value, limit) {
	const shape = base64Shape(value, limit);
	if (shape.code) return shape;
	try {
		const binary = atob(value);
		const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
		// Only the canonical encoding is accepted so a payload has one spelling.
		if (bytesToBase64(bytes) !== value) return { code: "bad-base64" };
		return { buffer: bytes.buffer };
	} catch {
		return { code: "bad-base64" };
	}
}

function resourcesTooLarge(bytes, limit, what) {
	const error = new Error(`${what} (${bytes} bytes) exceeds the ${limit}-byte limit.`);
	error.code = "resources-too-large";
	error.bytes = bytes;
	error.limit = limit;
	return error;
}

function embeddedAsset(record) {
	const bytes = asArrayBuffer(record?.bytes);
	const asset = normalizeAsset({ ...record, bytes });
	if (!asset || asset.bytes.byteLength > ASSET_MAX_SOURCE_BYTES) return null;
	// Base64 keeps JSON's asset payload unambiguous; a data URL would duplicate
	// MIME metadata already carried by `type` and force every reader to strip it.
	return { record: { ...asset, bytes: bytesToBase64(asset.bytes) }, bytes: asset.bytes.byteLength };
}

function workflowAssetIds(workflow) {
	const ids = new Set();
	const visit = (value) => {
		if (Array.isArray(value)) {
			for (const entry of value) visit(entry);
			return;
		}
		if (!plainRecord(value)) return;
		if (isImageAssetId(value.assetRef)) ids.add(value.assetRef);
		for (const entry of Object.values(value)) visit(entry);
	};
	visit(workflow);
	return ids;
}

/** Verify that an embedded record still belongs at its content-addressed id. */
export async function verifyEmbeddedAsset(record, subtle) {
	const bytes = asArrayBuffer(record?.bytes);
	if (!bytes) return false;
	try {
		const expected = isHdrAssetId(record.id) ? await hdrIdForBytes(bytes, subtle) : isMeshAssetId(record.id) ? await meshIdForBytes(bytes, subtle) : await assetIdForBytes(bytes, subtle);
		return expected === record.id;
	} catch {
		return false;
	}
}

const PROBLEM_DETAILS = {
	"bad-id": "its id is not a content address",
	duplicate: "the same id appears earlier in the file",
	"bad-encoding": "its encoding is not base64",
	"bad-base64": "its payload is not valid base64",
	"length-mismatch": "its payload does not match the recorded byte length",
	"too-large": "its payload exceeds the size limit",
	"bad-record": "its metadata is incomplete",
};

function readEmbeddedAssets(value, report) {
	const assets = [];
	if (!Array.isArray(value)) return assets;
	const seen = new Set();
	for (const entry of value) {
		const id = typeof entry?.id === "string" ? entry.id : null;
		if (!isAssetId(id)) {
			report("image", id, "bad-id");
			continue;
		}
		if (seen.has(id)) {
			report("image", id, "duplicate");
			continue;
		}
		const decoded = base64ToBytes(entry.bytes, ASSET_MAX_SOURCE_BYTES);
		if (decoded.code) {
			report("image", id, decoded.code);
			continue;
		}
		const asset = normalizeAsset({ ...entry, bytes: decoded.buffer });
		if (!asset) {
			report("image", id, "bad-record");
			continue;
		}
		seen.add(id);
		assets.push(asset);
	}
	return assets;
}

/**
 * Build the v5 envelope. Images are embedded when a scene or workflow
 * assetRef references them. Throws `resources-too-large` when the whole
 * manifest exceeds its budget.
 */
export function createProjectDocument({ scenesDocument, workspaceLayout, customPoses, name, previsMode, castStyle, assets, savedAt, workflow }) {
	const assetRecords = new Map();
	for (const record of Array.isArray(assets) ? assets : []) {
		const asset = embeddedAsset(record);
		if (asset) assetRecords.set(asset.record.id, asset);
	}
	const embeddedAssets = [];
	let resourceBytes = 0;
	const referencedIds = referencedAssetIds(scenesDocument?.scenes);
	for (const id of workflowAssetIds(workflow)) referencedIds.add(id);
	for (const id of referencedIds) {
		const asset = assetRecords.get(id);
		if (!asset) continue;
		embeddedAssets.push(asset.record);
		resourceBytes += asset.bytes;
	}
		if (resourceBytes > PROJECT_MAX_RESOURCE_BYTES) throw resourcesTooLarge(resourceBytes, PROJECT_MAX_RESOURCE_BYTES, "Embedded resources");
	return {
		app: "cozyclay",
		kind: "project",
		version: PROJECT_VERSION,
		name: typeof name === "string" && name.trim() ? name.trim() : "Untitled",
		previsMode: normalizePrevisMode(previsMode), castStyle: normalizeCastStyle(castStyle),
		...(Number.isFinite(savedAt) && savedAt > 0 ? { savedAt } : {}),
		scenes: scenesDocument,
		workspace: workspaceLayout ?? null,
		poseLibrary: Array.isArray(customPoses) ? customPoses : [],
		workflow: normalizeWorkflowGraph(workflow),
		resources: { assets: embeddedAssets },
	};
}

/** Convert a normalized storyboard project into a fresh animation envelope.
 * The source remains untouched: still shot records are copied with their
 * ranges, camera keys, captions, cast overrides and stylized asset references.
 */
export function buildAnimationProjectFromStoryboard(project) {
	const scenesDocument = structuredClone(project?.scenesDocument ?? { version: SCENES_VERSION, activeSceneId: null, scenes: [] });
	scenesDocument.scenes = (scenesDocument.scenes ?? []).map((scene) => ({
		...scene,
		shotDocument: scene.shotDocument && typeof scene.shotDocument === "object"
			? {
				...scene.shotDocument,
				shots: Array.isArray(scene.shotDocument.shots)
					? scene.shotDocument.shots.map((shot) => ({ ...shot, ...(shot.kind === "still" ? { kind: "clip" } : {}) }))
					: scene.shotDocument.shots,
			}
			: scene.shotDocument,
	}));
	return createProjectDocument({
		scenesDocument,
		workspaceLayout: structuredClone(project?.workspaceLayout ?? null),
		customPoses: structuredClone(project?.customPoses ?? []),
		name: `${project?.name || "Untitled"} - ${ko("Animation", "애니메이션")}`,
		previsMode: "animation", castStyle: project?.castStyle,
				assets: project?.assets ?? [],
		workflow: structuredClone(project?.workflow ?? createWorkflowGraph()),
		savedAt: Date.now(),
	});
}

/**
 * Parse + validate a project file. Returns { ok, reason?, warnings?,
 * problems?, project? }. Invalid embedded records are skipped, each one
 * reported as a warning string and a `{ kind, id, code, message }` problem.
 * v2/v3 files carry images at the top-level `assets`; v4 moves everything
 * under `resources`; v5 adds the top-level `previsMode` and `castStyle`
 * (absent or unknown reads as the default). Older files are read as-is, never rewritten.
 */
export function readProjectDocument(raw) {
	let parsed;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return { ok: false, reason: "corrupt" };
	}
	if (!parsed || typeof parsed !== "object") return { ok: false, reason: "corrupt" };
	if (parsed.app !== "cozyclay" || parsed.kind !== "project") return { ok: false, reason: "not-a-project" };
	if (typeof parsed.version !== "number") return { ok: false, reason: "corrupt" };
	if (parsed.version > PROJECT_VERSION) return { ok: false, reason: "future" };
	const scenes = parsed.scenes;
	if (!scenes || typeof scenes !== "object" || scenes.version > SCENES_VERSION || !Array.isArray(scenes.scenes)) {
		return { ok: false, reason: "scenes-invalid" };
	}
	const warnings = [];
	const problems = [];
	const report = (kind, id, code) => {
		const message = `Skipped embedded ${kind} ${id ?? "(no id)"}: ${PROBLEM_DETAILS[code]}.`;
		problems.push({ kind, id, code, message });
		warnings.push(message);
	};
	const assetRecords = parsed.version >= 4 ? parsed.resources?.assets : parsed.version >= 2 ? parsed.assets : undefined;
	const assets = readEmbeddedAssets(assetRecords, report);
	
	const workflow = normalizeWorkflowGraph(parsed.workflow);
	return {
		ok: true,
		warnings,
		problems,
		project: {
			name: typeof parsed.name === "string" && parsed.name.trim() ? parsed.name.trim() : "Untitled",
			previsMode: normalizePrevisMode(parsed.previsMode), castStyle: normalizeCastStyle(parsed.castStyle),
			savedAt: Number.isFinite(parsed.savedAt) && parsed.savedAt > 0 ? parsed.savedAt : null,
			scenesDocument: { version: scenes.version, activeSceneId: scenes.activeSceneId ?? null, scenes: scenes.scenes },
			workspaceLayout: parsed.workspace && typeof parsed.workspace === "object" ? parsed.workspace : null,
			customPoses: Array.isArray(parsed.poseLibrary)
				? parsed.poseLibrary.filter((p) => p && typeof p === "object" && typeof p.id === "string" && p.bones && typeof p.bones === "object")
				: [],
						assets,
			workflow,
		},
	};
}

export function hasFileSystemAccess() {
	return typeof window !== "undefined" && typeof window.showSaveFilePicker === "function" && typeof window.showOpenFilePicker === "function";
}

const PICKER_TYPES = [
	{
		description: "CozyClay Project",
		accept: { "application/json": [PROJECT_EXTENSION, ".json"] },
	},
];

export async function pickProjectFileForSave(suggestedName) {
	const handle = await window.showSaveFilePicker({
		suggestedName: `${suggestedName || "Untitled"}${PROJECT_EXTENSION}`,
		types: PICKER_TYPES,
	});
	return handle;
}

export async function pickProjectFileForOpen() {
	const [handle] = await window.showOpenFilePicker({ types: PICKER_TYPES, multiple: false });
	return handle;
}

export async function writeProjectFile(handle, serialized) {
	const writable = await handle.createWritable();
	await writable.write(serialized);
	await writable.close();
}

export async function readProjectFile(handle) {
	const file = await handle.getFile();
	return { name: file.name.replace(/\.cclayproject$|\.json$/i, ""), text: await file.text(), savedAt: file.lastModified };
}

export function downloadProjectFallback(serialized, name) {
	const blob = new Blob([serialized], { type: "application/json" });
	const url = URL.createObjectURL(blob);
	const anchor = document.createElement("a");
	anchor.href = url;
	anchor.download = `${name || "Untitled"}${PROJECT_EXTENSION}`;
	anchor.click();
	setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function openProjectFallback() {
	return new Promise((resolve) => {
		const input = document.createElement("input");
		input.type = "file";
		input.accept = `${PROJECT_EXTENSION},.json,application/json`;
		input.onchange = async () => {
			const file = input.files?.[0];
			if (!file) return resolve(null);
			resolve({ name: file.name.replace(/\.cclayproject$|\.json$/i, ""), text: await file.text(), savedAt: file.lastModified });
		};
		input.oncancel = () => resolve(null);
		input.click();
	});
}

function openIdb() {
	return new Promise((resolve, reject) => {
		const request = indexedDB.open(IDB_NAME, 1);
		request.onupgradeneeded = () => request.result.createObjectStore(IDB_STORE);
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});
}

async function storeProjectHandle(handle, name) {
	try {
		const db = await openIdb();
		await new Promise((resolve, reject) => {
			const tx = db.transaction(IDB_STORE, "readwrite");
			tx.objectStore(IDB_STORE).put({ handle, name }, IDB_KEY);
			tx.oncomplete = resolve;
			tx.onerror = () => reject(tx.error);
		});
		db.close();
	} catch {
		/* private mode etc.: the session just won't remember the handle */
	}
}

export async function loadStoredProjectHandle() {
	try {
		const db = await openIdb();
		const record = await new Promise((resolve, reject) => {
			const tx = db.transaction(IDB_STORE, "readonly");
			const request = tx.objectStore(IDB_STORE).get(IDB_KEY);
			request.onsuccess = () => resolve(request.result ?? null);
			request.onerror = () => reject(request.error);
		});
		db.close();
		return record;
	} catch {
		return null;
	}
}

export async function clearStoredProjectHandle() {
	try {
		const db = await openIdb();
		await new Promise((resolve, reject) => {
			const tx = db.transaction(IDB_STORE, "readwrite");
			tx.objectStore(IDB_STORE).delete(IDB_KEY);
			tx.oncomplete = resolve;
			tx.onerror = () => reject(tx.error);
		});
	db.close();
	} catch {
		/* ignore */
	}
}

/* --------------------- recent projects + projects folder ---------------------
 * The browser (game-engine style project picker) needs two things the File
 * System Access API cannot give for free: a HISTORY of what was opened
 * (stored here), and an optional directory handle it can enumerate. */

const RECENTS_KEY = "recentProjects";
const FOLDER_KEY = "projectsDirectory";
const RECENTS_MAX = 8;
// The portable .cclayproject file is the durable source of truth, while this
// tiny browser-local record keeps an in-progress project identifiable between
// launches before the user has chosen a file location. Scene data itself is
// already autosaved by App through its scene document store.
export const PROJECT_SESSION_KEY = "cozyclay.project-session.v1";

export function loadProjectSession(storage = globalThis.localStorage) {
	try {
		const value = JSON.parse(storage?.getItem(PROJECT_SESSION_KEY) || "null");
		if (!value || typeof value !== "object") return null;
		const name = typeof value.name === "string" ? value.name.trim() : "";
		return name ? { name, previsMode: normalizePrevisMode(value.previsMode), castStyle: normalizeCastStyle(value.castStyle), updatedAt: Number.isFinite(value.updatedAt) ? value.updatedAt : 0 } : null;
	} catch {
		return null;
	}
}

// `identity` is the previs mode, or `{ previsMode, castStyle }`.
export function storeProjectSession(name, identity = DEFAULT_PREVIS_MODE, storage = globalThis.localStorage) {
	const normalized = typeof name === "string" ? name.trim() : "";
	if (!normalized) return false;
	try {
		storage?.setItem(PROJECT_SESSION_KEY, JSON.stringify({ name: normalized, previsMode: normalizePrevisMode(identity?.previsMode ?? identity), castStyle: normalizeCastStyle(identity?.castStyle), updatedAt: Date.now() }));
		return true;
	} catch {
		return false;
	}
}

async function idbSet(key, value) {
	try {
		const db = await openIdb();
		await new Promise((resolve, reject) => {
			const tx = db.transaction(IDB_STORE, "readwrite");
			tx.objectStore(IDB_STORE).put(value, key);
			tx.oncomplete = resolve;
			tx.onerror = () => reject(tx.error);
		});
		db.close();
	} catch {
		/* private mode etc. */
	}
}

async function idbGet(key) {
	try {
		const db = await openIdb();
		const record = await new Promise((resolve, reject) => {
			const tx = db.transaction(IDB_STORE, "readonly");
			const request = tx.objectStore(IDB_STORE).get(key);
			request.onsuccess = () => resolve(request.result ?? null);
			request.onerror = () => reject(request.error);
		});
	db.close();
		return record;
	} catch {
		return null;
	}
}

/** Record a project open/save in the recents list (most recent first), with its projectSummary when known. */
export async function rememberRecentProject(handle, name, summary = null) {
	const list = (await idbGet(RECENTS_KEY)) ?? [];
	const next = [
		{ handle, name, openedAt: Date.now(), ...summary },
		...list.filter((entry) => entry.name !== name),
	].slice(0, RECENTS_MAX);
	await idbSet(RECENTS_KEY, next);
	await storeProjectHandle(handle, name);
}

export async function loadRecentProjects() {
	return (await idbGet(RECENTS_KEY)) ?? [];
}

export async function removeRecentProject(name) {
	const list = (await idbGet(RECENTS_KEY)) ?? [];
	await idbSet(RECENTS_KEY, list.filter((entry) => entry.name !== name));
}

/* Projects directory: optional; when set, the browser can LIST the folder. */

export function hasDirectoryPicker() {
	return typeof window !== "undefined" && typeof window.showDirectoryPicker === "function";
}

export async function pickProjectsDirectory() {
	return window.showDirectoryPicker({ mode: "readwrite" });
}

export async function storeProjectsDirectory(handle) {
	await idbSet(FOLDER_KEY, { handle });
}

export async function loadProjectsDirectory() {
	const record = await idbGet(FOLDER_KEY);
	return record?.handle ?? null;
}

/** Enumerate `.cclayproject` files in a directory handle, newest first. */
export async function listProjectsInDirectory(dirHandle) {
	const out = [];
	try {
		for await (const [name, handle] of dirHandle.entries()) {
			if (handle.kind !== "file" || !name.endsWith(PROJECT_EXTENSION)) continue;
			const file = await handle.getFile();
			out.push({ name: name.slice(0, -PROJECT_EXTENSION.length), handle, lastModified: file.lastModified });
		}
	} catch {
		return [];
	}
	return out.sort((a, b) => b.lastModified - a.lastModified);
}

/** "granted" | "prompt" | "denied" — never throws. */
export async function queryHandlePermission(handle) {
	try {
		return await handle.queryPermission({ mode: "readwrite" });
	} catch {
		return "denied";
	}
}

/** Escalate a stored handle back to "granted". Chromium demotes a persisted
 * handle's permission to "prompt" when the page is next opened; inside a user
 * gesture the browser answers requestPermission() with a one-click prompt.
 * "granted" | "prompt" | "denied" — never throws. */
export async function requestHandlePermission(handle) {
	try {
		if ((await handle.queryPermission({ mode: "readwrite" })) === "granted") return "granted";
		return await handle.requestPermission({ mode: "readwrite" });
	} catch {
		return "denied";
	}
}
