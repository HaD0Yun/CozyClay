#!/usr/bin/env node
// GLB mesh-prop import: magic, POSITION bounds, the 0.05–10 m fit heuristic,
// drop splitting, and the mesh- vs img- id split. Fixtures are tiny cubes
// with accessor min/max so Node can measure them without three.js.
import { readFileSync } from "node:fs";
import { webcrypto } from "node:crypto";
import {
	ASSET_ID_PREFIX,
	ASSET_MAX_SOURCE_BYTES,
	ASSET_MESH_TYPES,
	MESH_ID_PREFIX,
	assetIdForBytes,
	isAssetId,
	isImageAssetId,
	isMeshAssetId,
	isSupportedMeshType,
	meshIdForBytes,
	normalizeAsset,
} from "../src/scene-assets.js";
import {
	MESH_DEFAULT_HEIGHT,
	MESH_HEIGHT_MAX,
	MESH_HEIGHT_MIN,
	fitMeshBounds,
	importMeshFile,
	isGlbMagic,
	meshFilesFrom,
	parseGlbBounds,
	parseObjBounds,
	meshBoundsFromAsset,
	compressedGlbReason,
	splitDroppedFiles,
	parseFbxBounds,
	isFbxBinaryMagic,
	readFbxVersion,
} from "../src/scene-mesh.js";
import { createMeshSceneCache } from "../src/scene-mesh-cache.js";

let failures = 0;
function expect(name, condition, detail = "") {
	console.log(`${condition ? "PASS" : "FAIL"} ${name}${condition ? "" : ` — ${detail}`}`);
	if (!condition) failures += 1;
}

const EPS = 1e-4;
const approx = (value, expected, eps = EPS) => Number.isFinite(value) && Math.abs(value - expected) <= eps;
// importMeshFile nests a footprint; fitMeshBounds itself returns width/depth
// next to height. Read either spelling so the heuristic is what we pin.
function fittedBox(result) {
	if (!result || typeof result !== "object") return null;
	const width = Number(result.footprint?.width ?? result.width);
	const depth = Number(result.footprint?.depth ?? result.depth);
	const height = Number(result.height);
	if (![width, height, depth].every(Number.isFinite)) return null;
	return { width, height, depth };
}

const fixtureBytes = (name) => new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));
const unitBytes = fixtureBytes("unit-cube.glb");
const giantBytes = fixtureBytes("giant-cube.glb");
const tinyBytes = fixtureBytes("tiny-cube.glb");
const unitObjBytes = fixtureBytes("unit-cube.obj");
const giantObjBytes = fixtureBytes("giant-cube.obj");
const tinyObjBytes = fixtureBytes("tiny-cube.obj");
const unitFbxBytes = fixtureBytes("unit-cube.fbx");
const giantFbxBytes = fixtureBytes("giant-cube.fbx");
const tinyFbxBytes = fixtureBytes("tiny-cube.fbx");
const glbFile = (bytes, name, type) => new File([bytes], name, { type });

const named = (name, type) => ({ name, type });
function padTo4(bytes, fill = 0x20) {
	const padding = (4 - (bytes.length % 4)) % 4;
	if (!padding) return bytes;
	const out = new Uint8Array(bytes.length + padding);
	out.set(bytes);
	out.fill(fill, bytes.length);
	return out;
}
function glbFromJson(json, jsonPad = 0x20) {
	const jsonBytes = padTo4(new TextEncoder().encode(JSON.stringify(json)), jsonPad);
	const total = 12 + 8 + jsonBytes.byteLength;
	const out = new Uint8Array(total);
	const view = new DataView(out.buffer);
	view.setUint32(0, 0x46546c67, true);
	view.setUint32(4, 2, true);
	view.setUint32(8, total, true);
	view.setUint32(12, jsonBytes.byteLength, true);
	view.setUint32(16, 0x4e4f534a, true);
	out.set(jsonBytes, 20);
	return out;
}
const measurableGlbJson = {
	asset: { version: "2.0" },
	meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
	accessors: [{ min: [0, 0, 0], max: [1, 1, 1], componentType: 5126, count: 8, type: "VEC3" }],
};
const box = (minY, maxY, halfXz) => ({
	min: { x: -halfXz, y: minY, z: -halfXz },
	max: { x: halfXz, y: maxY, z: halfXz },
});

/* ------------------------------------------------------------- magic ---- */

expect("the unit-cube fixture starts with the glTF magic", isGlbMagic(unitBytes) === true);
expect("ASCII glTF is the little-endian GLB magic", unitBytes[0] === 0x67 && unitBytes[1] === 0x6c && unitBytes[2] === 0x54 && unitBytes[3] === 0x46);
expect("PNG bytes are not a GLB", isGlbMagic(new Uint8Array([0x89, 0x50, 0x4e, 0x47])) === false);
expect("a short buffer is not a GLB", isGlbMagic(new Uint8Array([0x67, 0x6c, 0x54])) === false);
expect("empty bytes are not a GLB", isGlbMagic(new Uint8Array()) === false);

/* ------------------------------------------------------ parse bounds ---- */

const unitBounds = parseGlbBounds(unitBytes);
const unitHeight = unitBounds ? unitBounds.max.y - unitBounds.min.y : NaN;
const unitWidth = unitBounds ? unitBounds.max.x - unitBounds.min.x : NaN;
const unitDepth = unitBounds ? unitBounds.max.z - unitBounds.min.z : NaN;
expect(
	"the unit cube's POSITION box is 1 m tall, sitting on y = 0, 1 m across XZ",
	Boolean(unitBounds) && approx(unitHeight, 1) && approx(unitBounds.min.y, 0) && approx(unitWidth, 1) && approx(unitDepth, 1),
	JSON.stringify(unitBounds),
);

const giantBounds = parseGlbBounds(giantBytes);
const tinyBounds = parseGlbBounds(tinyBytes);
expect(
	"the parser still sees the giant cube as 50 m — fitting is import-only",
	Boolean(giantBounds) && approx(giantBounds.max.y - giantBounds.min.y, 50),
	JSON.stringify(giantBounds),
);
expect(
	"the parser still sees the tiny cube as 0.01 m — fitting is import-only",
	Boolean(tinyBounds) && approx(tinyBounds.max.y - tinyBounds.min.y, 0.01),
	JSON.stringify(tinyBounds),
);
expect("unreadable bytes have no box", parseGlbBounds(new Uint8Array([0x67, 0x6c, 0x54, 0x46, 0, 0, 0, 0])) === null);

/* ------------------------------------------------------ fit heuristic ---- */
// Heights inside [0.05, 10] were already metres; everything else is an outlier
// (a centimetre export, a 90 m hall) and is scaled so the result is 1 m tall.
// Width and depth share that factor so the object's proportions survive.

expect("the fit window is 5 cm through 10 m, defaulting to 1 m", MESH_HEIGHT_MIN === 0.05 && MESH_HEIGHT_MAX === 10 && MESH_DEFAULT_HEIGHT === 1);

const inRange = fittedBox(fitMeshBounds(box(0, 0.9, 0.45)));
expect(
	"a 0.9 m height is left unchanged",
	Boolean(inRange) && approx(inRange.height, 0.9) && approx(inRange.width, 0.9) && approx(inRange.depth, 0.9),
	JSON.stringify(inRange),
);

const floor = fittedBox(fitMeshBounds(box(0, MESH_HEIGHT_MIN, 0.5)));
expect("the 5 cm floor is inclusive — no rescale", Boolean(floor) && approx(floor.height, MESH_HEIGHT_MIN), JSON.stringify(floor));
const ceiling = fittedBox(fitMeshBounds({ min: { x: 0, y: 0, z: 0 }, max: { x: 2, y: MESH_HEIGHT_MAX, z: 3 } }));
expect(
	"the 10 m ceiling is inclusive — width and depth stay put",
	Boolean(ceiling) && approx(ceiling.height, MESH_HEIGHT_MAX) && approx(ceiling.width, 2) && approx(ceiling.depth, 3),
	JSON.stringify(ceiling),
);

const hall = fittedBox(fitMeshBounds(box(0, 90, 45)));
expect(
	"a 90 m height is scaled to 1 m, and the 90 m footprint with it",
	Boolean(hall) && approx(hall.height, 1) && approx(hall.width, 1) && approx(hall.depth, 1),
	JSON.stringify(hall),
);

const speck = fittedBox(fitMeshBounds(box(0, 0.01, 0.005)));
expect(
	"a 0.01 m height is scaled to 1 m, and the millimetre footprint with it",
	Boolean(speck) && approx(speck.height, 1) && approx(speck.width, 1) && approx(speck.depth, 1),
	JSON.stringify(speck),
);

expect(
	"a non-positive height cannot be fitted",
	fitMeshBounds(box(0, 0, 0.5)) === null &&
		fitMeshBounds(box(1, 0.5, 0.5)) === null &&
		fitMeshBounds({ min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: Number.NaN, z: 1 } }) === null,
);

/* ---------------------------------------------------------- import ---- */

const unitImport = await importMeshFile(glbFile(unitBytes, "unit-cube.glb", "model/gltf-binary"), webcrypto.subtle);
expect(
	"a unit cube imports as a mesh asset, 1 m tall, 1 m × 1 m on the floor",
	isMeshAssetId(unitImport.asset.id) &&
		unitImport.asset.type === "model/gltf-binary" &&
		approx(unitImport.height, 1) &&
		approx(unitImport.footprint.width, 1) &&
		approx(unitImport.footprint.depth, 1),
	JSON.stringify({ id: unitImport.asset?.id, type: unitImport.asset?.type, height: unitImport.height, footprint: unitImport.footprint }),
);
expect(
	"the imported record is normalizeAsset-ready without pixel size",
	normalizeAsset(unitImport.asset)?.id === unitImport.asset.id && unitImport.asset.bytes instanceof ArrayBuffer && unitImport.asset.bytes.byteLength > 0,
	JSON.stringify({ ...unitImport.asset, bytes: unitImport.asset?.bytes?.byteLength }),
);

const giantImport = await importMeshFile(glbFile(giantBytes, "giant-cube.glb", "model/gltf-binary"), webcrypto.subtle);
const tinyImport = await importMeshFile(glbFile(tinyBytes, "tiny-cube.glb", "model/gltf-binary"), webcrypto.subtle);
expect("a 50 m cube is fitted to 1 m on import", approx(giantImport.height, 1), String(giantImport.height));
expect("a 0.01 m cube is fitted to 1 m on import", approx(tinyImport.height, 1), String(tinyImport.height));

const octetImport = await importMeshFile(glbFile(unitBytes, "cooker.glb", "application/octet-stream"), webcrypto.subtle);
expect(
	"octet-stream plus a .glb name is still a mesh — browsers often omit the glTF MIME",
	isMeshAssetId(octetImport.asset.id) && approx(octetImport.height, 1) && octetImport.asset.name === "cooker.glb",
	JSON.stringify({ id: octetImport.asset?.id, name: octetImport.asset?.name, height: octetImport.height }),
);

const refuses = async (name, file, pattern) => {
	try {
		await importMeshFile(file, webcrypto.subtle);
		expect(name, false, "resolved instead of throwing");
	} catch (error) {
		expect(name, error instanceof Error && pattern.test(error.message), error.message);
	}
};
const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
await refuses("PNG bytes are refused as not a 3D model", glbFile(pngBytes, "photo.png", "image/png"), /not a 3D model/i);
await refuses("plain text named .glb is refused as not a GLB", glbFile(new TextEncoder().encode("hello"), "hello.glb", "model/gltf-binary"), /not a GLB/i);
await refuses("a non-file is refused with a readable reason", null, /file/i);
await refuses(
	"a file past the source ceiling is refused before it is parsed",
	{ name: "huge.glb", type: "model/gltf-binary", size: 64 * 1024 * 1024, arrayBuffer: async () => unitBytes.buffer.slice(0) },
	/too large|larger than 32/i,
);
expect("the source ceiling is the same 32 MiB pictures already use", ASSET_MAX_SOURCE_BYTES === 32 * 1024 * 1024);

const nulPadded = glbFromJson({ ...measurableGlbJson, extras: { note: "pad" } }, 0);
const nulBounds = parseGlbBounds(nulPadded);
expect(
	"JSON chunk NULs (illegal padding some exporters write) still parse",
	Boolean(nulBounds) && approx(nulBounds.max.y - nulBounds.min.y, 1),
	JSON.stringify(nulBounds),
);

const dracoJson = {
	...measurableGlbJson,
	extensionsUsed: ["KHR_draco_mesh_compression"],
	meshes: [{ primitives: [{ attributes: { POSITION: 0 }, extensions: { KHR_draco_mesh_compression: { bufferView: 0 } } }] }],
};
const dracoBytes = glbFromJson(dracoJson);
expect("Draco is supported by the mesh loader", compressedGlbReason(dracoBytes) === null);
const dracoImported = await importMeshFile(glbFile(dracoBytes, "draco-cube.glb", "model/gltf-binary"));
expect("Draco import retains bytes and measures the declared POSITION box", dracoImported.height === 1 && dracoImported.asset.bytes.byteLength === dracoBytes.byteLength);
const meshoptBytes = glbFromJson({ ...measurableGlbJson, extensionsRequired: ["EXT_meshopt_compression"] });
const meshoptImported = await importMeshFile(glbFile(meshoptBytes, "meshopt-cube.glb", "model/gltf-binary"));
expect("meshopt import retains bytes and measures the declared POSITION box", meshoptImported.height === 1 && meshoptImported.asset.bytes.byteLength === meshoptBytes.byteLength);
const unsupportedBytes = glbFromJson({ ...measurableGlbJson, extensionsRequired: ["KHR_texture_basisu"] });
await refuses(
	"compression without a configured decoder is still refused",
	glbFile(unsupportedBytes, "basis.glb", "model/gltf-binary"),
	/unsupported compression.*KHR_texture_basisu/i,
);
expect("an ordinary cube is not compressed", compressedGlbReason(unitBytes) === null);
expect("OBJ bytes are not a compressed GLB", compressedGlbReason(unitObjBytes) === null);

/* -------------------------------------------------------------- drop -- */

expect(
	"stored mesh MIMEs are glTF binary, Wavefront OBJ and FBX — octet-stream is a drop-fallback, not a stored type",
	isSupportedMeshType("model/gltf-binary") &&
		isSupportedMeshType("MODEL/GLTF-BINARY") &&
		isSupportedMeshType("model/obj") &&
		isSupportedMeshType("model/fbx") &&
		isSupportedMeshType("MODEL/FBX") &&
		!isSupportedMeshType("application/octet-stream") &&
		!isSupportedMeshType("text/plain") &&
		!isSupportedMeshType("image/png") &&
		ASSET_MESH_TYPES.includes("model/gltf-binary") &&
		ASSET_MESH_TYPES.includes("model/obj") &&
		ASSET_MESH_TYPES.includes("model/fbx"),
);
expect(
	"meshFilesFrom keeps a .glb and leaves pictures and documents behind",
	JSON.stringify(meshFilesFrom({ files: [named("cooker.glb", "model/gltf-binary"), named("a.png", "image/png"), named("notes.pdf", "application/pdf")] }).map((file) => file.name)) === '["cooker.glb"]',
);
expect(
	"a GLB with no MIME, octet-stream, or application/gltf-binary still counts by extension",
	meshFilesFrom({ files: [named("Stove.GLB", ""), named("pot.glb", "application/octet-stream"), named("pan.glb", "application/gltf-binary")] }).length === 3,
);
expect("an empty drop is not fatal", meshFilesFrom({ files: [] }).length === 0 && meshFilesFrom(null).length === 0);

const png = named("a.png", "image/png");
const glb = named("b.glb", "model/gltf-binary");
const pdf = named("c.pdf", "application/pdf");
const split = splitDroppedFiles([png, glb, pdf]);
expect(
	"a mixed drop splits into one picture, one mesh and one reject",
	split.images.length === 1 && split.meshes.length === 1 && split.rejected.length === 1,
	JSON.stringify(split),
);
expect(
	"the GLB is the mesh, never an image — useImageDrop must not toast it as an unsupported picture",
	split.meshes[0].name === "b.glb" && split.images[0].name === "a.png" && split.rejected[0].name === "c.pdf" && !split.images.some((file) => /\.glb$/i.test(file.name)),
	JSON.stringify(split),
);
const splitFromTransfer = splitDroppedFiles({ files: [png, glb, pdf] });
expect(
	"a DataTransfer-shaped drop splits the same way",
	splitFromTransfer.images.length === 1 && splitFromTransfer.meshes.length === 1 && splitFromTransfer.rejected.length === 1,
);

/* --------------------------------------------------------------- ids ---- */

const meshId = await meshIdForBytes(unitBytes, webcrypto.subtle);
const meshIdAgain = await meshIdForBytes(unitBytes.slice(), webcrypto.subtle);
const imageId = await assetIdForBytes(unitBytes, webcrypto.subtle);
expect("the same GLB bytes always get the same mesh id", meshId === meshIdAgain && isMeshAssetId(meshId), `${meshId} vs ${meshIdAgain}`);
expect(
	"mesh and image ids share the digest and differ only by prefix — otherwise the GLB would be stored as a broken picture",
	meshId.startsWith(MESH_ID_PREFIX) &&
		imageId.startsWith(ASSET_ID_PREFIX) &&
		meshId.slice(MESH_ID_PREFIX.length) === imageId.slice(ASSET_ID_PREFIX.length) &&
		meshId !== imageId,
	`${meshId} vs ${imageId}`,
);
expect("isAssetId is the union of both prefixes", isAssetId(meshId) && isAssetId(imageId));
expect("a mesh id is not an image id", isImageAssetId(meshId) === false && isMeshAssetId(meshId) === true);
expect("an image id is not a mesh id", isMeshAssetId(imageId) === false && isImageAssetId(imageId) === true);
expect(
	"short or junk values fail both predicates",
	!isMeshAssetId("") &&
		!isMeshAssetId("mesh-nope") &&
		!isMeshAssetId(`${MESH_ID_PREFIX}abcdef`) &&
		!isImageAssetId(null) &&
		!isAssetId("mesh-nope"),
);

/* --------------------------------------------------------------- obj ---- */

expect("the unit OBJ fixture is not a GLB", isGlbMagic(unitObjBytes) === false);
expect("the unit OBJ fixture contains vertex rows", /\bv\s/.test(new TextDecoder().decode(unitObjBytes)));

const unitObjBounds = parseObjBounds(unitObjBytes);
expect(
	"the unit OBJ box is 1 m tall, sitting on y = 0, 1 m across XZ",
	Boolean(unitObjBounds) &&
		approx(unitObjBounds.max.y - unitObjBounds.min.y, 1) &&
		approx(unitObjBounds.min.y, 0) &&
		approx(unitObjBounds.max.x - unitObjBounds.min.x, 1) &&
		approx(unitObjBounds.max.z - unitObjBounds.min.z, 1),
	JSON.stringify(unitObjBounds),
);
expect(
	"OBJ fitting is import-only — giant stays 50 m, tiny stays 0.01 m at parse",
	approx(parseObjBounds(giantObjBytes).max.y - parseObjBounds(giantObjBytes).min.y, 50) &&
		approx(parseObjBounds(tinyObjBytes).max.y - parseObjBounds(tinyObjBytes).min.y, 0.01),
);

const bomText = `\uFEFFv 0 0 0\nv 1 1 1\n`;
const bomBounds = parseObjBounds(new TextEncoder().encode(bomText));
expect(
	"a UTF-8 BOM in front of the first vertex still measures",
	Boolean(bomBounds) && approx(bomBounds.max.y - bomBounds.min.y, 1) && approx(bomBounds.max.x - bomBounds.min.x, 1),
	JSON.stringify(bomBounds),
);
const tabBounds = parseObjBounds(new TextEncoder().encode("v\t0\t0\t0\nv\t1\t1\t1\n"));
expect(
	"tabs between v and numbers count as Wavefront whitespace",
	Boolean(tabBounds) && approx(tabBounds.max.y - tabBounds.min.y, 1),
	JSON.stringify(tabBounds),
);
const colored = parseObjBounds(new TextEncoder().encode("v 0 0 0 1 0 0\nv 1 1 1 0 1 0\n"));
expect(
	"vertex colours after xyz are ignored for the box",
	Boolean(colored) && approx(colored.max.x - colored.min.x, 1) && approx(colored.max.y - colored.min.y, 1),
	JSON.stringify(colored),
);
expect(
	"mtllib, normals and faces without vertices are not a box",
	parseObjBounds(new TextEncoder().encode("mtllib cube.mtl\nvn 0 1 0\nf 1 2 3\n")) === null,
);
expect("empty OBJ text has no box", parseObjBounds(new TextEncoder().encode("")) === null);

const unitObjImport = await importMeshFile(glbFile(unitObjBytes, "unit-cube.obj", "text/plain"), webcrypto.subtle);
expect(
	"a unit OBJ imports as model/obj, 1 m tall, mesh- id",
	isMeshAssetId(unitObjImport.asset.id) &&
		unitObjImport.asset.type === "model/obj" &&
		approx(unitObjImport.height, 1) &&
		approx(unitObjImport.footprint.width, 1) &&
		approx(unitObjImport.footprint.depth, 1),
	JSON.stringify({ id: unitObjImport.asset?.id, type: unitObjImport.asset?.type, height: unitObjImport.height, footprint: unitObjImport.footprint }),
);
expect(
	"the imported OBJ record is normalizeAsset-ready without pixel size",
	normalizeAsset(unitObjImport.asset)?.id === unitObjImport.asset.id && unitObjImport.asset.type === "model/obj",
);

const giantObjImport = await importMeshFile(glbFile(giantObjBytes, "giant-cube.obj", ""), webcrypto.subtle);
const tinyObjImport = await importMeshFile(glbFile(tinyObjBytes, "tiny-cube.obj", "application/octet-stream"), webcrypto.subtle);
expect("a 50 m OBJ is fitted to 1 m on import", approx(giantObjImport.height, 1), String(giantObjImport.height));
expect("a 0.01 m OBJ is fitted to 1 m on import", approx(tinyObjImport.height, 1), String(tinyObjImport.height));

const objAgain = await importMeshFile(glbFile(unitObjBytes, "copy.obj", "model/obj"), webcrypto.subtle);
expect("the same OBJ bytes always get the same mesh id", unitObjImport.asset.id === objAgain.asset.id);

const glbNamedObj = await importMeshFile(glbFile(unitBytes, "trick.obj", "text/plain"), webcrypto.subtle);
expect(
	"glTF magic under an .obj name is stored as GLB, not OBJ",
	glbNamedObj.asset.type === "model/gltf-binary" && approx(glbNamedObj.height, 1),
	glbNamedObj.asset?.type,
);

await refuses("PNG bytes named .obj are refused as not an OBJ", glbFile(pngBytes, "photo.obj", ""), /not an OBJ/i);
await refuses("plain text named .obj is refused as not an OBJ", glbFile(new TextEncoder().encode("hello"), "hello.obj", "text/plain"), /not an OBJ/i);
await refuses("plain text named .glb is still refused as not a GLB, not as OBJ", glbFile(new TextEncoder().encode("hello"), "hello.glb", "model/gltf-binary"), /not a GLB/i);
await refuses(
	"octet-stream with no extension and no geometry is not a 3D model",
	glbFile(new TextEncoder().encode("????"), "blob.bin", "application/octet-stream"),
	/not a 3D model/i,
);

expect(
	"meshFilesFrom keeps stove.obj with empty type, text/plain, octet-stream, text/x-obj and application/object",
	meshFilesFrom({ files: [
		named("stove.obj", ""),
		named("pan.obj", "text/plain"),
		named("pot.obj", "application/octet-stream"),
		named("lid.obj", "text/x-obj"),
		named("knob.obj", "application/object"),
	] }).length === 5,
);
expect(
	"a .glb is not classified as OBJ just because both are meshes",
	JSON.stringify(meshFilesFrom({ files: [named("stove.glb", "model/gltf-binary"), named("stove.obj", "text/plain")] }).map((file) => file.name)) === '["stove.glb","stove.obj"]',
);

const objSplit = splitDroppedFiles([png, glb, named("d.obj", "text/plain"), pdf]);
expect(
	"PNG / GLB / OBJ / PDF split into images, two meshes, one reject",
	objSplit.images.length === 1 && objSplit.meshes.length === 2 && objSplit.rejected.length === 1 &&
		objSplit.meshes.some((file) => file.name === "d.obj") &&
		objSplit.meshes.some((file) => file.name === "b.glb") &&
		!objSplit.images.some((file) => /\.obj$/i.test(file.name)),
	JSON.stringify(objSplit),
);

const objMeasured = meshBoundsFromAsset({ type: "model/obj", bytes: unitObjBytes.buffer });
const glbMeasured = meshBoundsFromAsset({ type: "model/gltf-binary", bytes: unitBytes.buffer });
expect(
	"meshBoundsFromAsset dispatches OBJ vs GLB",
	Boolean(objMeasured) && approx(objMeasured.max.y - objMeasured.min.y, 1) &&
		Boolean(glbMeasured) && approx(glbMeasured.max.y - glbMeasured.min.y, 1),
	JSON.stringify({ objMeasured, glbMeasured }),
);
expect("meshBoundsFromAsset ignores a picture MIME", meshBoundsFromAsset({ type: "image/png", bytes: unitObjBytes.buffer }) === null);

{
	let parseGlbCalls = 0;
	let parseObjCalls = 0;
	const objRecord = { id: unitObjImport.asset.id, type: "model/obj", bytes: unitObjBytes.buffer, name: "unit-cube.obj" };
	const glbRecord = { id: unitImport.asset.id, type: "model/gltf-binary", bytes: unitBytes.buffer, name: "unit-cube.glb" };
	const records = { [objRecord.id]: objRecord, [glbRecord.id]: glbRecord };
	const cache = createMeshSceneCache({
		getRecord: async (id) => records[id],
		parseGlb: async () => {
			parseGlbCalls += 1;
			return { scene: { name: "from-glb" } };
		},
		parseObj: () => {
			parseObjCalls += 1;
			return { name: "from-obj" };
		},
	});
	const objScene = await cache.loadMeshScene(objRecord.id);
	expect("OBJ type calls parseObj, never parseGlb", parseObjCalls === 1 && parseGlbCalls === 0, `${parseObjCalls} obj / ${parseGlbCalls} glb`);
	expect("cached OBJ scene is the Group itself, not group.scene", objScene?.name === "from-obj");
	const glbScene = await cache.loadMeshScene(glbRecord.id);
	expect("GLB type still calls parseGlb, never a second parseObj", parseGlbCalls === 1 && parseObjCalls === 1, `${parseGlbCalls} glb / ${parseObjCalls} obj`);
	expect("cached GLB scene is gltf.scene", glbScene?.name === "from-glb");
}

/* --------------------------------------------------------------- fbx ---- */

const FBX_BINARY_MAGIC = "Kaydara FBX Binary  \0";
const fakeFbxBinary = new Uint8Array(FBX_BINARY_MAGIC.length + 8);
for (let i = 0; i < FBX_BINARY_MAGIC.length; i++) fakeFbxBinary[i] = FBX_BINARY_MAGIC.charCodeAt(i);

expect("the unit FBX fixture is not a GLB", isGlbMagic(unitFbxBytes) === false);
expect("ASCII unit FBX is not binary-magic", isFbxBinaryMagic(unitFbxBytes) === false);
expect("Kaydara FBX Binary magic is recognised", isFbxBinaryMagic(fakeFbxBinary) === true);
expect("GLB bytes are not FBX binary", isFbxBinaryMagic(unitBytes) === false);
expect("the unit ASCII FBX declares version 7400", readFbxVersion(unitFbxBytes) === 7400);
expect("OBJ bytes do not declare an FBX version", readFbxVersion(unitObjBytes) == null);

const unitFbxBounds = parseFbxBounds(unitFbxBytes);
expect(
	"the unit FBX box is 1 m tall, sitting on y = 0, 1 m across XZ",
	Boolean(unitFbxBounds) &&
		approx(unitFbxBounds.max.y - unitFbxBounds.min.y, 1) &&
		approx(unitFbxBounds.min.y, 0) &&
		approx(unitFbxBounds.max.x - unitFbxBounds.min.x, 1) &&
		approx(unitFbxBounds.max.z - unitFbxBounds.min.z, 1),
	JSON.stringify(unitFbxBounds),
);
expect("unreadable bytes do not throw from parseFbxBounds", parseFbxBounds(pngBytes) === null);
expect("a junk model/fbx record has no shelf box", meshBoundsFromAsset({ type: "model/fbx", bytes: pngBytes.buffer }) === null);
expect(
	"FBX fitting is import-only — giant stays 50 m, tiny stays 0.01 m at parse",
	approx(parseFbxBounds(giantFbxBytes).max.y - parseFbxBounds(giantFbxBytes).min.y, 50) &&
		approx(parseFbxBounds(tinyFbxBytes).max.y - parseFbxBounds(tinyFbxBytes).min.y, 0.01),
);

const { cubeFbx } = await import("./fixtures/write-cube-fbx.mjs");
const flatFbxBytes = new TextEncoder().encode(cubeFbx(0));
expect("a zero-height FBX has no measurable box", parseFbxBounds(flatFbxBytes) === null);

const unitFbxImport = await importMeshFile(glbFile(unitFbxBytes, "unit-cube.fbx", "text/plain"), webcrypto.subtle);
expect(
	"a unit FBX imports as model/fbx, 1 m tall, mesh- id",
	isMeshAssetId(unitFbxImport.asset.id) &&
		unitFbxImport.asset.type === "model/fbx" &&
		approx(unitFbxImport.height, 1) &&
		approx(unitFbxImport.footprint.width, 1) &&
		approx(unitFbxImport.footprint.depth, 1),
	JSON.stringify({ id: unitFbxImport.asset?.id, type: unitFbxImport.asset?.type, height: unitFbxImport.height, footprint: unitFbxImport.footprint }),
);
expect(
	"the imported FBX record is normalizeAsset-ready without pixel size",
	normalizeAsset(unitFbxImport.asset)?.id === unitFbxImport.asset.id && unitFbxImport.asset.type === "model/fbx",
);

const giantFbxImport = await importMeshFile(glbFile(giantFbxBytes, "giant-cube.fbx", ""), webcrypto.subtle);
const tinyFbxImport = await importMeshFile(glbFile(tinyFbxBytes, "tiny-cube.fbx", "application/octet-stream"), webcrypto.subtle);
expect("a 50 m FBX is fitted to 1 m on import", approx(giantFbxImport.height, 1), String(giantFbxImport.height));
expect("a 0.01 m FBX is fitted to 1 m on import", approx(tinyFbxImport.height, 1), String(tinyFbxImport.height));

const fbxAgain = await importMeshFile(glbFile(unitFbxBytes, "copy.fbx", "model/fbx"), webcrypto.subtle);
expect("the same FBX bytes always get the same mesh id", unitFbxImport.asset.id === fbxAgain.asset.id);

const unnamedFbx = await importMeshFile(glbFile(unitFbxBytes, "blob.bin", "application/octet-stream"), webcrypto.subtle);
expect(
	"octet-stream FBX without a .fbx name still stores model/fbx — sniff, not the filename",
	unnamedFbx.asset.type === "model/fbx" && approx(unnamedFbx.height, 1),
	unnamedFbx.asset?.type,
);

const glbNamedFbx = await importMeshFile(glbFile(unitBytes, "trick.fbx", "text/plain"), webcrypto.subtle);
expect(
	"glTF magic under an .fbx name is stored as GLB, not FBX",
	glbNamedFbx.asset.type === "model/gltf-binary" && approx(glbNamedFbx.height, 1),
	glbNamedFbx.asset?.type,
);

await refuses("PNG bytes named .fbx are refused as not an FBX", glbFile(pngBytes, "photo.fbx", ""), /not an FBX/i);
await refuses("plain text named .fbx is refused as not an FBX", glbFile(new TextEncoder().encode("hello"), "hello.fbx", "text/plain"), /not an FBX/i);
await refuses("an OBJ fixture named .fbx is refused as not an FBX, not stored as OBJ", glbFile(unitObjBytes, "stove.fbx", "text/plain"), /not an FBX/i);
await refuses(
	"ASCII FBX older than 7.0 is refused as too old, not as OBJ",
	glbFile(new TextEncoder().encode("FBXHeaderExtension:  {\n\tFBXVersion: 6100\n}\nv 0 0 0\nv 1 1 1\n"), "old.fbx", "text/plain"),
	/too old/i,
);
await refuses(
	"a flat FBX has no measurable geometry",
	glbFile(flatFbxBytes, "flat.fbx", "model/fbx"),
	/no measurable geometry/i,
);
await refuses("plain text named .glb is still refused as not a GLB, not as FBX", glbFile(new TextEncoder().encode("hello"), "hello.glb", "model/gltf-binary"), /not a GLB/i);

expect("OBJ bytes are not a compressed GLB", compressedGlbReason(unitObjBytes) === null);
expect("FBX bytes are not a compressed GLB", compressedGlbReason(unitFbxBytes) === null);
expect("binary-looking FBX bytes are not a compressed GLB", compressedGlbReason(fakeFbxBinary) === null);

expect(
	"meshFilesFrom keeps stove.fbx with empty type, text/plain, octet-stream and model/fbx",
	meshFilesFrom({ files: [
		named("stove.fbx", ""),
		named("pan.fbx", "text/plain"),
		named("pot.fbx", "application/octet-stream"),
		named("lid.FBX", "model/fbx"),
	] }).length === 4,
);
expect(
	"a .glb and .obj are not classified as FBX just because all three are meshes",
	JSON.stringify(meshFilesFrom({ files: [
		named("stove.glb", "model/gltf-binary"),
		named("stove.obj", "text/plain"),
		named("stove.fbx", "text/plain"),
	] }).map((file) => file.name)) === '["stove.glb","stove.obj","stove.fbx"]',
);

const fbxSplit = splitDroppedFiles([png, glb, named("d.obj", "text/plain"), named("e.fbx", "text/plain"), pdf]);
expect(
	"PNG / GLB / OBJ / FBX / PDF split into images, three meshes, one reject",
	fbxSplit.images.length === 1 && fbxSplit.meshes.length === 3 && fbxSplit.rejected.length === 1 &&
		fbxSplit.meshes.some((file) => file.name === "e.fbx") &&
		fbxSplit.meshes.some((file) => file.name === "d.obj") &&
		fbxSplit.meshes.some((file) => file.name === "b.glb") &&
		!fbxSplit.images.some((file) => /\.fbx$/i.test(file.name)),
	JSON.stringify(fbxSplit),
);

const fbxMeasured = meshBoundsFromAsset({ type: "model/fbx", bytes: unitFbxBytes.buffer });
expect(
	"meshBoundsFromAsset dispatches FBX through parseFbxBounds",
	Boolean(fbxMeasured) && approx(fbxMeasured.max.y - fbxMeasured.min.y, 1) &&
		approx(fbxMeasured.min.y, 0),
	JSON.stringify(fbxMeasured),
);
expect("meshBoundsFromAsset ignores a picture MIME even when the bytes are FBX", meshBoundsFromAsset({ type: "image/png", bytes: unitFbxBytes.buffer }) === null);

{
	let parseGlbCalls = 0;
	let parseObjCalls = 0;
	let parseFbxCalls = 0;
	const fbxRecord = { id: unitFbxImport.asset.id, type: "model/fbx", bytes: unitFbxBytes.buffer, name: "unit-cube.fbx" };
	const objRecord = { id: unitObjImport.asset.id, type: "model/obj", bytes: unitObjBytes.buffer, name: "unit-cube.obj" };
	const records = { [fbxRecord.id]: fbxRecord, [objRecord.id]: objRecord };
	const cache = createMeshSceneCache({
		getRecord: async (id) => records[id],
		parseGlb: async () => {
			parseGlbCalls += 1;
			return { scene: { name: "from-glb" } };
		},
		parseObj: () => {
			parseObjCalls += 1;
			return { name: "from-obj" };
		},
		parseFbx: () => {
			parseFbxCalls += 1;
			return { name: "from-fbx" };
		},
	});
	const fbxScene = await cache.loadMeshScene(fbxRecord.id);
	expect("FBX type calls parseFbx, never parseGlb or parseObj", parseFbxCalls === 1 && parseGlbCalls === 0 && parseObjCalls === 0, `${parseFbxCalls} fbx / ${parseGlbCalls} glb / ${parseObjCalls} obj`);
	expect("cached FBX scene is the Group itself, not group.scene", fbxScene?.name === "from-fbx");
	const objScene = await cache.loadMeshScene(objRecord.id);
	expect("OBJ type still calls parseObj, never parseFbx", parseObjCalls === 1 && parseFbxCalls === 1, `${parseObjCalls} obj / ${parseFbxCalls} fbx`);
	expect("cached OBJ scene is still the Group itself", objScene?.name === "from-obj");
}

if (failures) process.exit(1);
console.log("all scene mesh checks PASS");
