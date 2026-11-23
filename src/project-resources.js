/**
 * Project resource manifest: everything a project points at, and whether the
 * bytes are here.
 *
  * A `.cclayproject` is only portable when every picture, mesh and
 * workflow output it names travels with it (a compiled take is its motion
 * spec inside the scene document, so it always travels). This module answers "which
 * ones do, which ones live on a server, and which ones are gone" from the
 * documents already in memory. It is a runtime calculation: nothing here is
 * written to the file, and nothing here decodes or hashes bytes.
 *
 * Statuses:
  *   embedded  — the record is in `assets`, or the workflow
 *               output is a data: URL that will be interned on save.
 *   external  — reachable by URL only (an http(s) output).
 *   missing   — nothing to load. An image that the browser still holds in
 *               IndexedDB is flagged `stored: true` so the integrator can
 *               offer to embed it instead of reporting it lost.
 *
 * Inputs are never trusted: a scene document mid-migration, a half-written
 * library entry or a garbage id produce fewer items, never a throw.
 */
import { isImageAssetId, isMeshAssetId } from "./scene-assets.js";
import { isHdrAssetId } from "./stage-hdr.js";

/** Lineage fields on a scene object, in `assetUsageCounts` order: the card's
 * rendered picture, the photograph it was cut from, and the selection mask. */
const IMAGE_LINEAGE_FIELDS = Object.freeze(["assetId", "sourceAssetId", "matteAssetId"]);

const STATUS_RANK = Object.freeze({ embedded: 2, external: 1, missing: 0 });

function plainObject(value) {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value) {
	return typeof value === "string" && value ? value : null;
}

/** Decoded size of a base64 string, without decoding it. */
function base64ByteLength(text) {
	const clean = text.replace(/\s+/g, "");
	if (!clean) return 0;
	const padding = clean.endsWith("==") ? 2 : clean.endsWith("=") ? 1 : 0;
	return Math.max(0, Math.floor((clean.length * 3) / 4) - padding);
}

/** Byte count of a record's payload however it is held: a stored asset has
 * an ArrayBuffer, a project file has base64, a motion record has a number. */
function byteSize(value) {
	if (typeof value === "number") return Number.isFinite(value) && value >= 0 ? value : null;
	if (value instanceof ArrayBuffer) return value.byteLength;
	if (ArrayBuffer.isView(value)) return value.byteLength;
	if (typeof value === "string") return base64ByteLength(value);
	return null;
}

function dataUrlByteLength(url) {
	const comma = url.indexOf(",");
	if (comma < 0) return 0;
	const header = url.slice(0, comma);
	const payload = url.slice(comma + 1);
	return /;base64$/i.test(header) ? base64ByteLength(payload) : payload.length;
}

/** Records keyed by their id, from an array, a Map or an id-keyed object.
 * The first record wins so a duplicated id cannot flip a status. */
function recordsById(source, key) {
	const map = new Map();
	const add = (record, fallbackId) => {
		const id = nonEmptyString(record?.[key]) ?? nonEmptyString(fallbackId);
		if (id && !map.has(id)) map.set(id, plainObject(record) ? record : {});
	};
	if (source instanceof Map) for (const [id, record] of source) add(record, id);
	else if (Array.isArray(source)) for (const record of source) add(record);
	else if (plainObject(source)) for (const [id, record] of Object.entries(source)) add(record, id);
	return map;
}

function idSet(source) {
	const out = new Set();
	const iterable = source instanceof Map ? source.keys() : source;
	if (!iterable || typeof iterable === "string" || typeof iterable[Symbol.iterator] !== "function") return out;
	for (const id of iterable) if (typeof id === "string") out.add(id);
	return out;
}

function scenesOf(scenesDocument) {
	return Array.isArray(scenesDocument?.scenes) ? scenesDocument.scenes : [];
}

function objectsOf(scene) {
	return Array.isArray(scene?.objects) ? scene.objects : [];
}

/**
 * One item per (kind, id). A second sighting of the same resource only adds
 * a ref — unless it resolves BETTER, in which case the status is upgraded so
 * the manifest is not order-dependent.
 */
function collector(kind) {
	const items = new Map();
	return {
		items,
		note(id, resolution, ref) {
			let item = items.get(id);
			if (!item) {
				item = { kind, id, status: "missing", refs: [] };
				items.set(id, item);
			}
			if (STATUS_RANK[resolution.status] >= STATUS_RANK[item.status]) {
				item.status = resolution.status;
				if (Number.isFinite(resolution.bytes)) item.bytes = resolution.bytes;
				if (resolution.url) item.url = resolution.url;
			}
			if (resolution.stored) item.stored = true;
			if (ref) item.refs.push(ref);
			return item;
		},
	};
}

function resolveImage(id, assetsById, storedIds) {
	const stored = storedIds.has(id);
	const asset = assetsById.get(id);
	if (asset) return { status: "embedded", bytes: byteSize(asset.bytes), stored };
	return { status: "missing", stored };
}



function defaultWorkflowOutputRefs() {
	return [];
}

/**
 * The manifest.
 *
 * `workflowOutputRefs(graph)` is injected rather than imported so this module
 * does not depend on the workflow track landing first; without it, the
 * workflow contributes nothing. Its contract: an array of
 * `{ nodeId, field, value, kind: "data-url"|"http"|"asset-ref"|"blob"|"other" }`.
 */
export function resourceManifest(options) {
	const {
		scenesDocument,
		workflow,
		assets,
		storedAssetIds,
		workflowOutputRefs,
	} = plainObject(options) ? options : {};

	const assetsById = recordsById(assets, "id");
	
	const storedIds = idSet(storedAssetIds);
	const scenes = scenesOf(scenesDocument);

	const images = collector("image");
	const meshes = collector("mesh");
	const environments = collector("environment");
	
	const outputs = collector("workflow-output");

	/* ---- images: every lineage id on every scene object ---- */
	for (const scene of scenes) {
		const sceneId = nonEmptyString(scene?.id) ?? undefined;
		for (const object of objectsOf(scene)) {
			if (!plainObject(object)) continue;
			const objectId = nonEmptyString(object.id) ?? undefined;
			for (const field of IMAGE_LINEAGE_FIELDS) {
				const id = object[field];
				if (!isImageAssetId(id)) continue;
				images.note(id, resolveImage(id, assetsById, storedIds), { sceneId, objectId, field });
			}
			if (object.renderer === "mesh" && isMeshAssetId(object.assetId)) {
				meshes.note(object.assetId, resolveImage(object.assetId, assetsById, storedIds), { sceneId, objectId, field: "assetId" });
			}
		}
	}

	/* ---- environments: a scene look's HDR file (stage.lighting.hdr) ---- */
	for (const scene of scenes) {
		const id = scene?.stage?.lighting?.hdr;
		if (isHdrAssetId(id)) environments.note(id, resolveImage(id, assetsById, storedIds), { sceneId: nonEmptyString(scene?.id) ?? undefined, field: "stage.lighting.hdr" });
	}

	/* ---- workflow outputs: what a node is holding on to ---- */
	const refs = (typeof workflowOutputRefs === "function" ? workflowOutputRefs : defaultWorkflowOutputRefs)(workflow);
	for (const ref of Array.isArray(refs) ? refs : []) {
		if (!plainObject(ref)) continue;
		const nodeId = nonEmptyString(ref.nodeId);
		const field = nonEmptyString(ref.field);
		if (!nodeId || !field) continue;
		const location = { nodeId, field };
		const id = `${nodeId}:${field}`;
		const { value } = ref;
		if (ref.kind === "data-url" && typeof value === "string") {
			outputs.note(id, { status: "embedded", bytes: dataUrlByteLength(value) }, location);
		} else if (ref.kind === "http" && typeof value === "string") {
			outputs.note(id, { status: "external", url: value }, location);
		} else if (ref.kind === "asset-ref") {
			// An interned output IS an image: the picture item gains the node as
			// a ref, and the output mirrors its status without recounting bytes.
			// Mesh ids must not appear as kind image — they share the store but
			// not the lineage walk.
			const assetId = typeof value === "string" ? value : value?.assetRef;
			if (isMeshAssetId(assetId)) {
				const resolution = resolveImage(assetId, assetsById, storedIds);
				meshes.note(assetId, resolution, location);
				outputs.note(id, { status: resolution.status, stored: resolution.stored }, location);
			} else if (isImageAssetId(assetId)) {
				const resolution = resolveImage(assetId, assetsById, storedIds);
				images.note(assetId, resolution, location);
				outputs.note(id, { status: resolution.status, stored: resolution.stored }, location);
			} else {
				outputs.note(id, { status: "missing" }, location);
			}
		} else {
			// blob: URLs die with the page; anything else is unrecognisable.
			outputs.note(id, { status: "missing", url: typeof value === "string" && !value.startsWith("data:") ? value : undefined }, location);
		}
	}

	const items = [...images.items.values(), ...meshes.items.values(), ...environments.items.values(), ...outputs.items.values()];
	const totals = { embedded: 0, external: 0, missing: 0, bytes: 0 };
	for (const item of items) {
		totals[item.status] += 1;
		if (Number.isFinite(item.bytes)) totals.bytes += item.bytes;
	}
	return { items, totals, missing: items.filter((item) => item.status === "missing") };
}
