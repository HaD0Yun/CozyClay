/**
 * Classify GLB / OBJ / FBX by header bytes without three.js or FBXLoader.
 *
 * MCP import_mesh has to reject a .txt before it builds a 32 MB data URL.
 * scene-mesh.js / scene-fbx.js pull the loader; this file must stay importable
 * from the MCP process.
 */
const GLB_MAGIC = 0x46546c67;
/** Same 23-ish prefix three.js uses (`Kaydara FBX Binary  \\0`). */
const FBX_BINARY_MAGIC = "Kaydara\u0020FBX\u0020Binary\u0020\u0020\0";
const FBX_SNIFF_BYTES = 64 * 1024;
const OBJ_SNIFF_BYTES = 256 * 1024;

const MIME_FOR_KIND = Object.freeze({
	glb: "model/gltf-binary",
	obj: "model/obj",
	fbx: "model/fbx",
});

export function bytesAsUint8(bytes) {
	if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes);
	if (ArrayBuffer.isView(bytes)) return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	return null;
}

export function dataViewOf(bytes) {
	if (bytes instanceof ArrayBuffer) return new DataView(bytes);
	if (ArrayBuffer.isView(bytes)) return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	return null;
}

/** MIME lies (empty, octet-stream, a renamed screenshot). The first four
 * bytes are the only honest gate that this is a GLB. */
export function isGlbMagic(bytes) {
	const view = dataViewOf(bytes);
	return Boolean(view && view.byteLength >= 4 && view.getUint32(0, true) === GLB_MAGIC);
}

export function isFbxBinaryMagic(bytes) {
	const view = bytesAsUint8(bytes);
	if (!view || view.byteLength < FBX_BINARY_MAGIC.length) return false;
	for (let i = 0; i < FBX_BINARY_MAGIC.length; i++) {
		if (view[i] !== FBX_BINARY_MAGIC.charCodeAt(i)) return false;
	}
	return true;
}

/** ASCII `FBXVersion:` in the first 64 KB, or null when the header is silent. */
export function readFbxVersion(bytes) {
	const view = bytesAsUint8(bytes);
	if (!view || !view.byteLength) return null;
	const slice = view.subarray(0, Math.min(view.byteLength, FBX_SNIFF_BYTES));
	const text = new TextDecoder("utf-8").decode(slice);
	const match = text.match(/FBXVersion: (\d+)/);
	if (!match) return null;
	const version = Number(match[1]);
	return Number.isFinite(version) ? version : null;
}

function looksLikeObj(bytes) {
	const view = bytesAsUint8(bytes);
	if (!view || !view.byteLength) return false;
	const text = new TextDecoder("utf-8").decode(view.subarray(0, Math.min(view.byteLength, OBJ_SNIFF_BYTES)));
	for (const raw of text.split(/\r?\n/)) {
		const line = raw.trim();
		if (!/^v\s+/.test(line)) continue;
		const parts = line.split(/\s+/);
		if ([parts[1], parts[2], parts[3]].every((part) => Number.isFinite(Number(part)))) return true;
	}
	return false;
}

/** `glb` | `fbx` | `fbx-old` | `obj` | null. Same order as importMeshFile. */
export function classifyMeshBytes(bytes) {
	if (isGlbMagic(bytes)) return "glb";
	const fbxVersion = readFbxVersion(bytes);
	if (isFbxBinaryMagic(bytes) || (fbxVersion ?? 0) >= 7000) return "fbx";
	if (fbxVersion != null && fbxVersion < 7000) return "fbx-old";
	if (looksLikeObj(bytes)) return "obj";
	return null;
}

export function meshMimeForKind(kind) {
	return MIME_FOR_KIND[kind] ?? null;
}
