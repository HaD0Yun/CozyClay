/**
 * Scene assets: the bytes an object points at.
 *
 * A cutout carries an `assetId`, never its picture. The scene document is one
 * JSON string in localStorage (`cozyclay.scenes.v2`), and a single base64 PNG
 * is bigger than the whole budget that string gets — so images live in
 * IndexedDB, keyed by an id the scene can hold on to.
 *
 * The id is derived from the bytes themselves (SHA-256), which buys three
 * things for free: the same picture imported twice is stored once, a
 * duplicated scene shares its originals instead of copying them, and an id is
 * meaningful across a reload, an export and another machine.
 *
 * Pictures and GLB models share this store. An `img-` id is a bitmap with a
 * pixel size; a `mesh-` id is a model with no pixel size. The prefix is what
 * keeps a GLB from being decoded as a picture.
 *
 * Everything above the storage adapter is pure and testable in node; the
 * adapter is the only part that needs a browser.
 */
import { isHdrAssetId, normalizeHdrAsset } from "./stage-hdr.js";
// A `sculpt-` id is a sculpt card on the shelf: the user's own library, never swept.
import { isSculptAssetId, normalizeSculptAsset } from "./sculpt-shelf-file.js";

/** Content-addressed, so the same bytes always land on the same id. */
export const ASSET_ID_PREFIX = "img-";
/** Mesh blobs share the digest but not the prefix: without this split every
 * GLB would be stored as `img-` and `normalizeAsset` would drop it as a
 * broken image. */
export const MESH_ID_PREFIX = "mesh-";
/** 128 bits of a SHA-256 digest: collision-proof for a project's worth of
 * pictures, and short enough to read in a scene file. */
const ASSET_ID_HEX = 32;

const ASSET_DB_NAME = "cozyclay.assets";
const ASSET_DB_VERSION = 1;
const ASSET_STORE_NAME = "images";

/** What an import will accept. SVG is excluded on purpose: it is a document
 * that can carry script, and a set piece is not worth that. */
export const ASSET_IMAGE_TYPES = Object.freeze(["image/png", "image/webp", "image/jpeg", "image/gif"]);
/** Stored mesh MIME. Drag-and-drop also accepts `application/gltf-binary` and
 * `text/plain` for an `.obj` or `.fbx`; once the bytes are in the store they are
 * one of these types, so a reader never has drop-fallbacks to branch on. */
export const ASSET_MESH_TYPES = Object.freeze(["model/gltf-binary", "model/obj", "model/fbx"]);
/** Source-file ceiling. A 40 MP phone photo is fine as an INPUT — it gets
 * decoded and downscaled before anything is stored — but the file itself has
 * to be readable in one bite first. */
export const ASSET_MAX_SOURCE_BYTES = 32 * 1024 * 1024;
/** Longest edge kept. A card is a staging surface, not a texture for a hero
 * render, and 2048 is the size every WebGL implementation can hold. */
export const ASSET_MAX_DIMENSION = 2048;

export function isSupportedImageType(type) {
	return typeof type === "string" && ASSET_IMAGE_TYPES.includes(type.toLowerCase());
}

export function isSupportedMeshType(type) {
	return typeof type === "string" && ASSET_MESH_TYPES.includes(type.toLowerCase());
}

function idFromDigest(prefix, hex) {
	if (typeof hex !== "string") return null;
	const clean = hex.trim().toLowerCase();
	if (!/^[0-9a-f]+$/.test(clean) || clean.length < ASSET_ID_HEX) return null;
	return `${prefix}${clean.slice(0, ASSET_ID_HEX)}`;
}

function isPrefixedAssetId(prefix, value) {
	return typeof value === "string" && new RegExp(`^${prefix}[0-9a-f]{${ASSET_ID_HEX}}$`).test(value);
}

/** An id from a hex digest, tolerant of the caller's case and length. */
export function assetIdFromDigest(hex) {
	return idFromDigest(ASSET_ID_PREFIX, hex);
}

export function meshIdFromDigest(hex) {
	return idFromDigest(MESH_ID_PREFIX, hex);
}

export function isImageAssetId(value) {
	return isPrefixedAssetId(ASSET_ID_PREFIX, value);
}

export function isMeshAssetId(value) {
	return isPrefixedAssetId(MESH_ID_PREFIX, value);
}

export function isAssetId(value) {
	return isImageAssetId(value) || isMeshAssetId(value) || isHdrAssetId(value) || isSculptAssetId(value);
}

async function sha256Hex(bytes, subtle) {
	if (!subtle?.digest) throw new Error("SubtleCrypto is unavailable — a secure context is required to import images");
	const buffer = bytes instanceof ArrayBuffer ? bytes : bytes?.buffer ? bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) : null;
	if (!buffer) return null;
	const digest = await subtle.digest("SHA-256", buffer);
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * The id these bytes will be stored under. `subtle` is injectable so the node
 * tests can hand in `crypto.webcrypto.subtle`; in the browser it is the page's
 * own SubtleCrypto, which needs a secure context (localhost counts).
 */
export async function assetIdForBytes(bytes, subtle = globalThis.crypto?.subtle) {
	const hex = await sha256Hex(bytes, subtle);
	if (!hex) throw new TypeError("assetIdForBytes needs an ArrayBuffer or a typed array");
	return assetIdFromDigest(hex);
}

/** Same digest as `assetIdForBytes`, `mesh-` prefix so a GLB cannot collide
 * with a picture in the store or in `normalizeAsset`. */
export async function meshIdForBytes(bytes, subtle = globalThis.crypto?.subtle) {
	const hex = await sha256Hex(bytes, subtle);
	if (!hex) throw new TypeError("meshIdForBytes needs an ArrayBuffer or a typed array");
	return meshIdFromDigest(hex);
}

/**
 * The stored size for a decoded image: the longest edge capped, aspect kept,
 * and never enlarged. Returns the source size unchanged (`scaled: false`) when
 * it already fits, so a small picture is stored exactly as it arrived.
 */
export function downscaleTarget(width, height, max = ASSET_MAX_DIMENSION) {
	const w = Math.max(0, Math.round(Number(width) || 0));
	const h = Math.max(0, Math.round(Number(height) || 0));
	if (!w || !h) return null;
	const longest = Math.max(w, h);
	if (longest <= max) return { width: w, height: h, scaled: false };
	const factor = max / longest;
	// Round to at least 1: a 4096 x 3 strip must not become 2048 x 0.
	return { width: Math.max(1, Math.round(w * factor)), height: Math.max(1, Math.round(h * factor)), scaled: true };
}

/** The card's width / height, from the picture the card wears. */
export function assetAspect(asset) {
	const width = Number(asset?.width);
	const height = Number(asset?.height);
	if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
	return width / height;
}

/**
 * Repair one stored asset record, or return null to drop it. Storage is never
 * trusted here either: a record without usable bytes or a usable size cannot
 * be drawn, and a card pointing at it is better shown as missing than as a
 * blank quad of the wrong shape.
 */
export function normalizeAsset(record) {
	if (!record || typeof record !== "object" || Array.isArray(record)) return null;
	const bytes = record.bytes instanceof ArrayBuffer ? record.bytes : null;
	if (!bytes || !bytes.byteLength) return null;
	// An `hdr-` id is an HDR environment file (stage-hdr.js), stored verbatim.
	if (isHdrAssetId(record.id)) return normalizeHdrAsset(record, bytes);
	if (isSculptAssetId(record.id)) return normalizeSculptAsset(record, bytes);
	// Prefix and MIME must agree: a mesh id with an image type (or the reverse)
	// is a cross-wired record and cannot be drawn as either kind.
	if (isMeshAssetId(record.id)) {
		if (!isSupportedMeshType(record.type)) return null;
		return {
			id: record.id,
			type: record.type.toLowerCase(),
			bytes,
			name: typeof record.name === "string" ? record.name : "",
			...(typeof record.role === "string" ? { role: record.role } : {}),
		};
	}
	if (!isImageAssetId(record.id)) return null;
	if (!isSupportedImageType(record.type)) return null;
	const width = Math.round(Number(record.width));
	const height = Math.round(Number(record.height));
	if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) return null;
	return {
		id: record.id,
		type: record.type.toLowerCase(),
		width,
		height,
		bytes,
		name: typeof record.name === "string" ? record.name : "",
		...(typeof record.role === "string" ? { role: record.role } : {}),
	};
}

/**
 * The image files in a drop (or a paste), in the order they were dropped.
 *
 * Two quirks make this worth a function rather than a filter inline. A file
 * dragged from some applications arrives with an EMPTY type — the browser has
 * a name and bytes but no sniffed MIME — so the extension is the fallback, not
 * a shortcut. And a drag can carry directories and text as well as files, which
 * `files` reports as entries with no type and no extension; those are dropped
 * rather than handed to a decoder that will fail on them.
 */
export function imageFilesFrom(transfer) {
	const files = Array.from(transfer?.files ?? []);
	return files.filter((file) => {
		if (!file) return false;
		if (isSupportedImageType(file.type)) return true;
		if (file.type) return false;
		const extension = String(file.name ?? "").toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
		return ["png", "webp", "jpg", "jpeg", "gif"].includes(extension);
	});
}

/**
 * The images on a clipboard.
 *
 * "Copy image" in a browser puts the picture's BYTES on the clipboard, which is
 * why paste reaches pictures a drag cannot: dragging one out of a search result
 * hands over a URL, and a cross-origin URL cannot be read back into a canvas —
 * the matte needs pixels, so a URL would import something the editor could not
 * then cut. Bytes have no origin, so this path works on any picture the browser
 * will copy, and it is the same `File` the file dialog produces.
 *
 * A clipboard item carries no filename, so one is synthesised from its type.
 */
export function imageFilesFromClipboard(clipboardData) {
	const out = [];
	const items = Array.from(clipboardData?.items ?? []);
	for (const item of items) {
		if (item.kind !== "file") continue;
		if (!isSupportedImageType(item.type)) continue;
		const file = item.getAsFile?.();
		if (!file) continue;
		out.push(
			file.name && file.name !== "image.png"
				? file
				: new File([file], `pasted-${Date.now()}.${item.type.split("/")[1] || "png"}`, { type: item.type }),
		);
	}
	// Some browsers expose the same picture only through `files`.
	if (!out.length) return imageFilesFrom(clipboardData);
	return out;
}

/* ------------------------------------------------------------- import ---- */

/** Scaling a picture re-encodes it, and the encoder has to be one that can
 * still carry alpha — a cutout IS its transparency. JPEG has none to lose, so
 * a photo stays a photo instead of tripling in size as a PNG. */
function storedTypeFor(sourceType) {
	return sourceType === "image/jpeg" ? "image/jpeg" : "image/png";
}

function defaultCanvas(width, height) {
	if (typeof OffscreenCanvas === "function") return new OffscreenCanvas(width, height);
	throw new Error("this browser cannot resize images — OffscreenCanvas is unavailable");
}

/**
 * One imported file as a storable asset record: decoded, capped to
 * ASSET_MAX_DIMENSION, and identified by the bytes that will actually be
 * stored (so two imports of the same photo dedupe even after a resize).
 *
 * Every browser API it needs is injectable, which is what lets the node tests
 * drive the whole path with stubs. Failures throw with a sentence fit to show
 * in a toast — the caller has no way to explain "NotReadableError" to anyone.
 */
export async function importImageFile(file, {
	subtle = globalThis.crypto?.subtle,
	createBitmap = globalThis.createImageBitmap,
	makeCanvas = defaultCanvas,
	maxDimension = ASSET_MAX_DIMENSION,
	maxSourceBytes = ASSET_MAX_SOURCE_BYTES,
} = {}) {
	if (!file || typeof file.arrayBuffer !== "function") throw new TypeError("importImageFile needs a File or Blob");
	const sourceType = typeof file.type === "string" ? file.type.toLowerCase() : "";
	if (!isSupportedImageType(sourceType)) throw new Error("that file is not an image CozyClay can import (PNG, WebP, JPEG or GIF)");
	if (Number(file.size) > maxSourceBytes) throw new Error(`that image is larger than ${Math.round(maxSourceBytes / (1024 * 1024))} MB`);
	if (typeof createBitmap !== "function") throw new Error("this browser cannot decode images — createImageBitmap is unavailable");

	const bitmap = await createBitmap(file);
	try {
		const target = downscaleTarget(bitmap.width, bitmap.height, maxDimension);
		if (!target) throw new Error("that image has no usable size");
		let type = sourceType;
		let bytes;
		if (target.scaled) {
			const canvas = makeCanvas(target.width, target.height);
			const context = canvas.getContext("2d");
			if (!context) throw new Error("this browser cannot resize images — no 2D context");
			context.drawImage(bitmap, 0, 0, target.width, target.height);
			type = storedTypeFor(sourceType);
			const blob = await canvas.convertToBlob({ type });
			bytes = await blob.arrayBuffer();
		} else {
			// Unscaled, the original bytes are stored verbatim: no re-encode means
			// no generation loss, and an untouched PNG keeps its exact alpha.
			bytes = await file.arrayBuffer();
		}
		const asset = normalizeAsset({
			id: await assetIdForBytes(bytes, subtle),
			type,
			width: target.width,
			height: target.height,
			bytes,
			name: typeof file.name === "string" ? file.name : "",
		});
		if (!asset) throw new Error("that image could not be prepared for the set");
		return asset;
	} finally {
		bitmap?.close?.();
	}
}

/* ------------------------------------------------------- reachability ---- */

/**
 * Every asset id the scenes still point at. Assets outlive the object that
 * imported them — undo brings a deleted cutout back, and two scenes can wear
 * the same picture — so nothing is deleted on the strength of one object
 * going away. This is the reachable set; `unreachableAssetIds` is the sweep.
 */
export function referencedAssetIds(scenes) {
	const ids = new Set(assetUsageCounts(scenes).keys());
	// A storyboard panel's stylized picture is held by its shot, not by an object;
	// a scene's HDR environment file by its stage look (stage.lighting.hdr).
	for (const scene of Array.isArray(scenes) ? scenes : []) {
		for (const shot of Array.isArray(scene?.shotDocument?.shots) ? scene.shotDocument.shots : []) if (isImageAssetId(shot?.stylizedAssetId)) ids.add(shot.stylizedAssetId);
		// and an imported character's file by the character (character-rig.js rigImport.assetId)
		if (isHdrAssetId(scene?.stage?.lighting?.hdr)) ids.add(scene.stage.lighting.hdr); for (const c of Array.isArray(scene?.stage?.characters) ? scene.stage.characters : []) if (isMeshAssetId(c?.rigImport?.assetId)) ids.add(c.rigImport.assetId);
	}
	return ids;
}

/**
 * The number of scene objects that point at each asset. A cutout may name the
 * same image in more than one lineage field, but it is still one object's use
 * of that image; the per-object Set keeps that relationship unambiguous.
 */
export function assetUsageCounts(scenes) {
	const counts = new Map();
	for (const scene of Array.isArray(scenes) ? scenes : []) {
		for (const object of Array.isArray(scene?.objects) ? scene.objects : []) {
			const objectAssetIds = new Set();
			// A matted cutout needs all three stored images to remain editable:
			// its rendered result, original picture and matte.
			for (const assetId of [object?.assetId, object?.sourceAssetId, object?.matteAssetId]) {
				if (isAssetId(assetId)) objectAssetIds.add(assetId);
			}
			for (const assetId of objectAssetIds) counts.set(assetId, (counts.get(assetId) ?? 0) + 1);
		}
	}
	return counts;
}

/**
 * A deterministic snapshot of the asset-reference graph. This deliberately
 * preserves scene and object identity as well as every lineage edge: a usage
 * count can stay the same while a cutout is swapped or moved to another scene.
 * Invalid ids collapse to null because they are not graph edges.
 */
export function assetGraphSignature(scenes) {
	return JSON.stringify(
		(Array.isArray(scenes) ? scenes : []).map((scene) => [
			typeof scene?.id === "string" ? scene.id : null,
			(Array.isArray(scene?.objects) ? scene.objects : []).map((object) => [
				typeof object?.id === "string" ? object.id : null,
				...[object?.assetId, object?.sourceAssetId, object?.matteAssetId].map((id) => (isAssetId(id) ? id : null)),
			]),
		]),
	);
}

/**
 * Complete a destructive write only while the asset graph stays at the
 * authorized snapshot. IndexedDB commits asynchronously, so a scene edit can
 * race the transaction after the caller's pre-check; restore the record before
 * reporting a conflict.
 */
export async function deleteAssetWithGraphGuard({
	expectedGraphSignature,
	deleteRecord,
	restoreRecord,
	readGraphSignature,
}) {
	await deleteRecord();
	if (readGraphSignature() === expectedGraphSignature) return true;
	await restoreRecord();
	return false;
}

// Stored ids that nothing points at any more, ready to be swept. A sculpt card
// is referenced by no scene on purpose: the shelf, not Manage storage, deletes it.
export function unreachableAssetIds(storedIds, scenes) {
	const reachable = referencedAssetIds(scenes);
	return (Array.isArray(storedIds) ? storedIds : []).filter((id) => isAssetId(id) && !isSculptAssetId(id) && !reachable.has(id));
}

/* ------------------------------------------------------------ storage ---- */

// A readwrite transaction settles on complete, error or abort.
const committed = (tx) =>
	new Promise((resolve, reject) => {
		tx.oncomplete = resolve;
		tx.onerror = () => reject(tx.error);
		tx.onabort = () => reject(tx.error);
	});

const request = (req) =>
	new Promise((resolve, reject) => {
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error);
	});

/** Open (and create) the asset database. Injectable factory so a test or a
 * non-browser host can hand in its own IndexedDB implementation. */
export function openAssetDb(factory = globalThis.indexedDB) {
	if (!factory) return Promise.reject(new Error("IndexedDB is unavailable"));
	return new Promise((resolve, reject) => {
		const open = factory.open(ASSET_DB_NAME, ASSET_DB_VERSION);
		open.onupgradeneeded = () => {
			if (!open.result.objectStoreNames.contains(ASSET_STORE_NAME)) {
				open.result.createObjectStore(ASSET_STORE_NAME, { keyPath: "id" });
			}
		};
		open.onsuccess = () => resolve(open.result);
		open.onerror = () => reject(open.error);
		open.onblocked = () => reject(new Error("the asset database is blocked by another tab"));
	});
}

/** Store a record. Content-addressed ids make this idempotent: re-importing
 * the same picture overwrites it with identical bytes. */
export async function putAsset(db, record) {
	const asset = normalizeAsset(record);
	if (!asset) throw new TypeError("putAsset needs a normalizable asset record");
	const tx = db.transaction(ASSET_STORE_NAME, "readwrite");
	tx.objectStore(ASSET_STORE_NAME).put(asset);
	await committed(tx);
	return asset;
}

export async function getAsset(db, id) {
	if (!isAssetId(id)) return null;
	const tx = db.transaction(ASSET_STORE_NAME, "readonly");
	return normalizeAsset(await request(tx.objectStore(ASSET_STORE_NAME).get(id)));
}

export async function listAssetIds(db) {
	const tx = db.transaction(ASSET_STORE_NAME, "readonly");
	const keys = await request(tx.objectStore(ASSET_STORE_NAME).getAllKeys());
	return (keys ?? []).filter(isAssetId);
}

export async function deleteAsset(db, id) {
	if (!isAssetId(id)) return false;
	const tx = db.transaction(ASSET_STORE_NAME, "readwrite");
	tx.objectStore(ASSET_STORE_NAME).delete(id);
	await committed(tx);
	return true;
}
