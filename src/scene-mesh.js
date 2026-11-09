/**
 * Mesh props: measure and import a model without drawing it.
 *
 * A mesh prop is the 3D analogue of a cutout — bytes in the asset store, a
 * scene record that points at them. The catch is scale: downloads are rarely
 * in metres. glTF already stores POSITION min/max on every accessor, and OBJ
 * boxes come from `v` rows, so those two stay three-free. FBX bounds go
 * through `scene-fbx.js` because they need `FBXLoader.parse`.
 */

import {
	ASSET_MAX_SOURCE_BYTES,
	imageFilesFrom,
	meshIdForBytes,
	normalizeAsset,
} from "./scene-assets.js";
import { bytesAsUint8, dataViewOf, isFbxBinaryMagic, isGlbMagic, readFbxVersion } from "./mesh-sniff.js";
import { parseFbxBounds } from "./scene-fbx.js";

export { isFbxBinaryMagic, isGlbMagic, readFbxVersion } from "./mesh-sniff.js";
export { parseFbxBounds } from "./scene-fbx.js";

export const MESH_HEIGHT_MIN = 0.05;
export const MESH_HEIGHT_MAX = 10;
export const MESH_DEFAULT_HEIGHT = 1;

/** glTF little-endian magic (`glTF`) and the JSON chunk type (`JSON`). BIN
 * is not read: the drawable box lives on the accessors. */
const GLB_MAGIC = 0x46546c67;
const GLB_JSON_CHUNK = 0x4e4f534a;
const GLB_HEADER_BYTES = 12;
const GLB_CHUNK_HEADER_BYTES = 8;

function glbJson(bytes) {
	const view = dataViewOf(bytes);
	if (!view || view.byteLength < GLB_HEADER_BYTES) return null;
	if (view.getUint32(0, true) !== GLB_MAGIC) return null;
	let offset = GLB_HEADER_BYTES;
	while (offset + GLB_CHUNK_HEADER_BYTES <= view.byteLength) {
		const chunkLength = view.getUint32(offset, true);
		const chunkType = view.getUint32(offset + 4, true);
		const start = offset + GLB_CHUNK_HEADER_BYTES;
		if (chunkLength > view.byteLength - start) return null;
		if (chunkType === GLB_JSON_CHUNK) {
			const jsonBytes = new Uint8Array(view.buffer, view.byteOffset + start, chunkLength);
			try {
				// Spec padding is spaces, but some exporters write trailing NULs.
				// JSON.parse rejects those, and a valid model would then look empty.
				let end = jsonBytes.length;
				while (end > 0 && jsonBytes[end - 1] === 0) end -= 1;
				return JSON.parse(new TextDecoder().decode(jsonBytes.subarray(0, end)));
			} catch {
				return null;
			}
		}
		offset = start + chunkLength;
	}
	return null;
}

/**
 * Union the POSITION accessor boxes declared in the JSON chunk.
 *
 * Only `primitives[].attributes.POSITION` counts: morph-target POSITION
 * accessors are deltas, and unioning them would shrink or inflate the
 * drawable box. Node transforms are ignored on purpose — the renderer fits
 * the stored height later, and this path must stay JSON-only.
 */
export function parseGlbBounds(bytes) {
	const json = glbJson(bytes);
	if (!json || typeof json !== "object") return null;
	const accessors = Array.isArray(json.accessors) ? json.accessors : [];
	const positionIndices = new Set();
	for (const mesh of Array.isArray(json.meshes) ? json.meshes : []) {
		for (const primitive of Array.isArray(mesh?.primitives) ? mesh.primitives : []) {
			const index = primitive?.attributes?.POSITION;
			if (Number.isInteger(index)) positionIndices.add(index);
		}
	}
	let bounds = null;
	for (const index of positionIndices) {
		const accessor = accessors[index];
		const min = accessor?.min;
		const max = accessor?.max;
		if (!Array.isArray(min) || !Array.isArray(max) || min.length !== 3 || max.length !== 3) continue;
		const mn = [Number(min[0]), Number(min[1]), Number(min[2])];
		const mx = [Number(max[0]), Number(max[1]), Number(max[2])];
		if (mn.some((value) => !Number.isFinite(value)) || mx.some((value) => !Number.isFinite(value))) continue;
		if (!bounds) {
			bounds = { min: { x: mn[0], y: mn[1], z: mn[2] }, max: { x: mx[0], y: mx[1], z: mx[2] } };
			continue;
		}
		bounds.min.x = Math.min(bounds.min.x, mn[0]);
		bounds.min.y = Math.min(bounds.min.y, mn[1]);
		bounds.min.z = Math.min(bounds.min.z, mn[2]);
		bounds.max.x = Math.max(bounds.max.x, mx[0]);
		bounds.max.y = Math.max(bounds.max.y, mx[1]);
		bounds.max.z = Math.max(bounds.max.z, mx[2]);
	}
	return bounds;
}

const COMPRESSED_GLB_EXTENSIONS = new Set(["KHR_draco_mesh_compression", "EXT_meshopt_compression"]);

function glbExtensionNames(json) {
	const names = new Set();
	if (!json || typeof json !== "object") return names;
	for (const list of [json.extensionsUsed, json.extensionsRequired]) {
		if (!Array.isArray(list)) continue;
		for (const name of list) if (typeof name === "string") names.add(name);
	}
	for (const mesh of Array.isArray(json.meshes) ? json.meshes : []) {
		for (const primitive of Array.isArray(mesh?.primitives) ? mesh.primitives : []) {
			const extensions = primitive?.extensions;
			if (!extensions || typeof extensions !== "object") continue;
			for (const name of Object.keys(extensions)) names.add(name);
		}
	}
	return names;
}

/** Refuse compression that our three.js loader cannot decode. */
export function compressedGlbReason(bytes) {
	const json = glbJson(bytes);
	if (!json) return null;
	for (const name of glbExtensionNames(json)) {
		if (!COMPRESSED_GLB_EXTENSIONS.has(name) && /compression|basisu/i.test(name)) return `That model uses unsupported compression — export it uncompressed (${name})`;
	}
	return null;
}

function decodeObjText(bytes) {
	const view = bytesAsUint8(bytes);
	if (!view || !view.byteLength) return "";
	let text = new TextDecoder("utf-8").decode(view);
	if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
	return text;
}

/**
 * Union the `v x y z` rows of a Wavefront OBJ.
 *
 * `vn` / `vt` / `vp` are not vertices. Vertex colours after xyz are ignored.
 * Node tests measure here without three.js, the same way `parseGlbBounds`
 * reads accessor min/max.
 */
export function parseObjBounds(bytes) {
	const text = decodeObjText(bytes);
	if (!text) return null;
	let bounds = null;
	for (const raw of text.split(/\r?\n/)) {
		const line = raw.trim();
		if (!/^v(?:\s|$)/.test(line)) continue;
		const parts = line.split(/\s+/);
		if (parts[0] !== "v") continue;
		const x = Number(parts[1]);
		const y = Number(parts[2]);
		const z = Number(parts[3]);
		if (![x, y, z].every(Number.isFinite)) continue;
		if (!bounds) {
			bounds = { min: { x, y, z }, max: { x, y, z } };
			continue;
		}
		bounds.min.x = Math.min(bounds.min.x, x);
		bounds.min.y = Math.min(bounds.min.y, y);
		bounds.min.z = Math.min(bounds.min.z, z);
		bounds.max.x = Math.max(bounds.max.x, x);
		bounds.max.y = Math.max(bounds.max.y, y);
		bounds.max.z = Math.max(bounds.max.z, z);
	}
	return bounds;
}

/** Measure stored mesh bytes by the record's MIME. Shelf spawn uses this
 * instead of assuming every blob is a GLB JSON chunk. */
export function meshBoundsFromAsset(record) {
	const type = String(record?.type ?? "").toLowerCase();
	if (type === "model/obj") return parseObjBounds(record?.bytes);
	if (type === "model/fbx") return parseFbxBounds(record?.bytes);
	if (type === "model/gltf-binary") return parseGlbBounds(record?.bytes);
	return null;
}

export { decodeObjText };

/**
 * Map a measured box into metres the set can stand next to a 1.8 m figure.
 *
 * Downloads are often authored in centimetres or city-scale units. Between
 * 5 cm and 10 m the file is trusted as metres; outside that the height is
 * fitted to 1 m and the footprint follows, so a bead and a stadium both
 * arrive as a grab-able prop. The heuristic runs at import only — stored
 * height is afterwards the truth.
 */
export function fitMeshBounds({ min, max } = {}) {
	const width = Number(max?.x) - Number(min?.x);
	const height = Number(max?.y) - Number(min?.y);
	const depth = Number(max?.z) - Number(min?.z);
	if (!Number.isFinite(height) || !(height > 0)) return null;
	const fitScale = height < MESH_HEIGHT_MIN || height > MESH_HEIGHT_MAX ? MESH_DEFAULT_HEIGHT / height : 1;
	const fittedWidth = width * fitScale;
	const fittedHeight = height * fitScale;
	const fittedDepth = depth * fitScale;
	return {
		width: fittedWidth,
		height: fittedHeight,
		depth: fittedDepth,
		fitScale,
		// Same numbers as `width`/`depth`: callers that speak footprint (the
		// scene record) and callers that speak the raw box both read here.
		footprint: { width: fittedWidth, depth: fittedDepth },
	};
}

function isGlbFile(file) {
	if (!file) return false;
	const type = typeof file.type === "string" ? file.type.toLowerCase() : "";
	if (type === "model/gltf-binary" || type === "application/gltf-binary") return true;
	// Empty type is a drag from an app that did not sniff; octet-stream is
	// the generic binary fallback. Either way the extension is the gate —
	// a .gltf JSON sidecar or a renamed PNG must not sneak through.
	if (type === "" || type === "application/octet-stream") {
		return String(file.name ?? "").toLowerCase().endsWith(".glb");
	}
	return false;
}

function isObjFile(file) {
	if (!file) return false;
	const type = typeof file.type === "string" ? file.type.toLowerCase() : "";
	if (type === "model/obj") return true;
	const name = String(file.name ?? "").toLowerCase();
	if (!name.endsWith(".obj")) return false;
	return type === "" || type === "text/plain" || type === "application/octet-stream"
		|| type === "text/x-obj" || type === "application/object";
}

function isFbxFile(file) {
	if (!file) return false;
	const type = typeof file.type === "string" ? file.type.toLowerCase() : "";
	if (type === "model/fbx") return true;
	const name = String(file.name ?? "").toLowerCase();
	if (!name.endsWith(".fbx")) return false;
	return type === "" || type === "text/plain" || type === "application/octet-stream";
}

/** The GLB, OBJ and FBX files in a drop, in the order they were dropped. Same
 * shape as `imageFilesFrom`: a DataTransfer-like `{ files }`. */
export function meshFilesFrom(transfer) {
	return Array.from(transfer?.files ?? []).filter((file) => isGlbFile(file) || isObjFile(file) || isFbxFile(file));
}

function listedFiles(filesOrTransfer) {
	if (!filesOrTransfer) return [];
	if (Array.isArray(filesOrTransfer)) return filesOrTransfer;
	// FileList is array-like and has no `.files`; a DataTransfer / drop
	// payload carries the list on `.files`.
	if (typeof filesOrTransfer.length === "number" && filesOrTransfer.files == null) {
		return Array.from(filesOrTransfer);
	}
	return Array.from(filesOrTransfer.files ?? []);
}

/**
 * Partition a mixed drop so a GLB never toasts as an unsupported image.
 *
 * Each file lands in exactly one bucket. Meshes are classified first:
 * `imageFilesFrom` would ignore a .glb, but a mis-typed file that matches
 * both rules still belongs with the models.
 */
export function splitDroppedFiles(filesOrTransfer) {
	const images = [];
	const meshes = [];
	const rejected = [];
	for (const file of listedFiles(filesOrTransfer)) {
		if (meshFilesFrom({ files: [file] }).length) meshes.push(file);
		else if (imageFilesFrom({ files: [file] }).length) images.push(file);
		else rejected.push(file);
	}
	return { images, meshes, rejected };
}

/**
 * One imported GLB, OBJ or FBX as a storable asset plus the fitted standing size.
 *
 * Failures throw a sentence fit to show in a toast — the caller has no way
 * to explain a missing magic number, empty vertices, or a JSON chunk with
 * no POSITION box. glTF magic wins over the filename so a renamed GLB is
 * still a GLB; a `.glb` without magic never falls through to FBX or OBJ.
 */
export async function importMeshFile(file, subtle = globalThis.crypto?.subtle) {
	if (!file || typeof file.arrayBuffer !== "function") throw new Error("importMeshFile needs a File or Blob");
	if (Number(file.size) > ASSET_MAX_SOURCE_BYTES) {
		throw new Error(`That model is too large to import — larger than ${Math.round(ASSET_MAX_SOURCE_BYTES / (1024 * 1024))} MB`);
	}
	const bytes = await file.arrayBuffer();
	const name = typeof file.name === "string" ? file.name : "";
	const namedGlb = isGlbFile(file) || name.toLowerCase().endsWith(".glb");
	const namedFbx = isFbxFile(file) || name.toLowerCase().endsWith(".fbx");
	const namedObj = isObjFile(file) || name.toLowerCase().endsWith(".obj");

	if (isGlbMagic(bytes)) {
		const compressed = compressedGlbReason(bytes);
		if (compressed) throw new Error(compressed);
		const bounds = parseGlbBounds(bytes);
		const fitted = bounds ? fitMeshBounds(bounds) : null;
		if (!fitted) throw new Error("That model has no measurable geometry");
		const asset = normalizeAsset({
			id: await meshIdForBytes(bytes, subtle),
			type: "model/gltf-binary",
			bytes,
			name,
		});
		if (!asset) throw new Error("That model could not be prepared for the set");
		return { asset, height: fitted.height, footprint: fitted.footprint };
	}

	if (namedGlb) throw new Error("That file is not a GLB model");

	const fbxVersion = readFbxVersion(bytes);
	if (isFbxBinaryMagic(bytes) || (fbxVersion ?? 0) >= 7000) {
		try {
			const bounds = parseFbxBounds(bytes);
			const fitted = bounds ? fitMeshBounds(bounds) : null;
			if (!fitted) throw new Error("That model has no measurable geometry");
			const asset = normalizeAsset({
				id: await meshIdForBytes(bytes, subtle),
				type: "model/fbx",
				bytes,
				name,
			});
			if (!asset) throw new Error("That model could not be prepared for the set");
			return { asset, height: fitted.height, footprint: fitted.footprint };
		} catch (error) {
			throw fbxImportError(error);
		}
	}

	if (fbxVersion != null && fbxVersion < 7000) {
		throw new Error("That FBX file is too old to import");
	}

	if (namedFbx) throw new Error("That file is not an FBX model");

	const objBounds = parseObjBounds(bytes);
	if (!objBounds) {
		if (namedObj) throw new Error("That file is not an OBJ model");
		throw new Error("That file is not a 3D model");
	}
	const fitted = fitMeshBounds(objBounds);
	if (!fitted) throw new Error("That model has no measurable geometry");
	const asset = normalizeAsset({
		id: await meshIdForBytes(bytes, subtle),
		type: "model/obj",
		bytes,
		name,
	});
	if (!asset) throw new Error("That model could not be prepared for the set");
	return { asset, height: fitted.height, footprint: fitted.footprint };
}

function fbxImportError(error) {
	const message = String(error?.message ?? error);
	if (/too old to import/i.test(message) || /no measurable geometry/i.test(message) || /not an FBX/i.test(message)) {
		return error instanceof Error ? error : new Error(message);
	}
	if (/version not supported|FileVersion/i.test(message)) {
		return new Error("That FBX file is too old to import");
	}
	return new Error("That file is not an FBX model");
}
