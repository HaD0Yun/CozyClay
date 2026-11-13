#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { buildHierarchyNodes } from "../src/hierarchy-model.js";
import {
	SCENE_QUARANTINE_KEY,
	SCENE_STORAGE_KEY,
	SCENE_VERSION,
	loadScene,
	normalizeSceneObject,
	serializeScene,
	DEFAULT_SCENE_OBJECTS,
	OBJECT_COLORS,
	OBJECT_LIBRARY,
	normalizeObjectColor,
	rememberObjectColor,
	createSceneObject,
	supportHeightForObject,
	createCutoutObject,
	duplicateCutoutOptions,
	cutoutFootprint,
	CUTOUT_KIND,
	CUTOUT_THICKNESS,
	MESH_KIND,
	createMeshObject,
	duplicateMeshOptions,
	dropToSurfacePatch,
	placementInFront,
	objectSize,
	objectFootprintBounds,
	removeSceneObject,
	rotatePatch,
	scalePatch,
	screenRotatePatch,
	sceneObjectHierarchyId,
	sceneObjectIdFromHierarchy,
	SCENE_ATTACH_BONES,
	setSceneObjectAttach,
	setSceneObjectParent,
	translatePatch,
	updateSceneObject,
	isEffectivelyHidden,
	wrapAngle,
	OBJECT_MENU_ENTRIES,
} from "../src/scene-objects.js";
import { retireObjectKind } from "../src/retired-kinds.js";
import { readSceneDocument } from "../src/scenes.js";

let failures = 0;
const propsSource = readFileSync(new URL("../src/props.jsx", import.meta.url), "utf8");
function expect(name, condition, detail = "") {
	console.log(`${condition ? "PASS" : "FAIL"} ${name}${condition ? "" : ` — ${detail}`}`);
	if (!condition) failures += 1;
}
function findNode(nodes, id) {
	for (const node of nodes) {
		if (node.id === id) return node;
		const child = node.children && findNode(node.children, id);
		if (child) return child;
	}
	return null;
}

const objects = [
	{ id: "asset-17", name: "Desk Lamp", renderer: "lamp", x: 1, z: 2, rot: 15, footprint: { width: 0.4, depth: 0.4 } },
	{ id: "generated-bike", name: "Bike", renderer: "bike", x: -2, z: 0, rot: -30, footprint: { width: 0.7, depth: 1.8 } },
];
const defaultIds = new Set(DEFAULT_SCENE_OBJECTS.map((object) => object.id));
expect("default objects have unique IDs", defaultIds.size === DEFAULT_SCENE_OBJECTS.length);
expect("default player scene contains no props", DEFAULT_SCENE_OBJECTS.length === 0);
const hierarchy = buildHierarchyNodes(objects);
const props = findNode(hierarchy, "props");
expect("Props children come from live scene objects", props.children.length === 2, JSON.stringify(props.children));
expect("arbitrary object name appears in hierarchy", props.children[0].label === "Desk Lamp");
expect("arbitrary object ID is namespaced", props.children[0].id === "object:asset-17");
expect("hierarchy ID round-trips to object ID", sceneObjectIdFromHierarchy(sceneObjectHierarchyId("asset-17")) === "asset-17");
expect("non-object hierarchy ID is rejected", sceneObjectIdFromHierarchy("camera") === null);

const moved = updateSceneObject(objects, "asset-17", { x: 3.25, z: -1.5, rot: 90 });
expect("transform update returns a new collection", moved !== objects);
expect("transform update preserves untouched object identity", moved[1] === objects[1]);
expect("transform update changes only requested object", moved[0].x === 3.25 && moved[0].z === -1.5 && moved[0].rot === 90);
expect("transform update preserves renderer metadata", moved[0].renderer === "lamp" && moved[0].footprint === objects[0].footprint);
expect("invalid numeric update is ignored", updateSceneObject(objects, "asset-17", { x: Number.NaN }) === objects);
expect("unknown object update is ignored", updateSceneObject(objects, "missing", { x: 4 }) === objects);

const removed = removeSceneObject(objects, "asset-17");
expect("object removal returns a new collection", removed !== objects);
expect("object removal removes only the requested object", removed.length === 1 && removed[0] === objects[1]);
expect("unknown object removal is ignored", removeSceneObject(objects, "missing") === objects);

/* ------------------------------------------------------ creation ---- */

expect("catalogue offers the Unity primitive set", ["cube", "sphere", "capsule", "cylinder", "cone", "plane"].every((kind) => OBJECT_LIBRARY.some((entry) => entry.kind === kind)));
expect("the retired set pieces are gone from the catalogue and the menu", ["car", "small-plane", "chair"].every((kind) => !OBJECT_MENU_ENTRIES.some((entry) => entry.kind === kind) && createSceneObject(kind, []) === null));
expect("no Set pieces group is left", !OBJECT_MENU_ENTRIES.some((entry) => entry.group === "Set pieces"));
expect("the renderer no longer draws the retired kinds", !/"car"|"small-plane"|"chair"/.test(propsSource));
expect("every catalogue entry carries a footprint and a height", OBJECT_LIBRARY.every((entry) => entry.footprint.width > 0 && entry.footprint.depth > 0 && entry.height >= 0));

const cube = createSceneObject("cube", []);
expect("created object starts neutral on the floor", cube.y === 0 && cube.rotX === 0 && cube.rotZ === 0 && cube.scaleX === 1 && cube.scaleY === 1 && cube.scaleZ === 1);
expect("primitives are grey-box grey", cube.color === "#c2c6c8");
expect("created object carries its own footprint copy", cube.footprint !== OBJECT_LIBRARY[0].footprint && cube.footprint.width === 1);
expect("unknown kinds create nothing", createSceneObject("teapot", []) === null);

const twoCubes = [cube, createSceneObject("cube", [cube])];
expect("repeat creation gets a unique id", twoCubes[0].id !== twoCubes[1].id);
expect("repeat creation gets a numbered name", twoCubes[1].name === "Cube 2", twoCubes[1].name);

const placed = createSceneObject("cube", [], { x: 999, z: -999, rot: 540 });
expect("a primitive's support datum is its top", supportHeightForObject(placed) === 1);
expect("creation clamps placement onto the stage", placed.x === 240 && placed.z === -240);
expect("an explicit placement angle is still wrapped", placed.rot === -180, String(placed.rot));

// camera at the origin looking down -Z (yaw 0): the drop point is 2.6 m ahead
const drop = placementInFront({ x: 0, z: 0 }, 0);
expect("new objects land down the lens, not on the lens", Math.abs(drop.z + 2.6) < 1e-9 && Math.abs(drop.x) < 1e-9, JSON.stringify(drop));
// Unity creates primitives axis-aligned. Anything else breaks the invariant
// the user reads off the inspector: equal rotation values face the same way.
expect("placement never rotates the new object", drop.rot === undefined);
const angled = placementInFront({ x: 0, z: 0 }, Math.PI / 3);
expect("a turned camera still creates an unrotated object", angled.rot === undefined, JSON.stringify(angled));
expect("an object created from any angle starts at zero rotation", (() => {
	const made = createSceneObject("cube", [], angled);
	return made.rot === 0 && made.rotX === 0 && made.rotZ === 0;
})());

/* --------------------------------------------------- gizmo maths ---- */

const start = { x: 1, y: 0.5, z: -2, rot: 10, rotX: 0, rotZ: 0 };
expect("axis drag is absolute from the drag start", translatePatch(start, "x", 0.5).x === 1.5);
expect("axis drag snaps to the 5 cm grid", translatePatch(start, "z", 0.32).z === -1.7, JSON.stringify(translatePatch(start, "z", 0.32)));
expect("height drags write the Y channel", translatePatch(start, "y", 0.25).y === 0.75);
expect("a non-axis drag writes nothing", translatePatch(start, "w", 1) === null && translatePatch(start, "x", Number.NaN) === null);
expect("the Y ring drives the yaw the plan board reads", rotatePatch(start, "y", 33).rot === 45, JSON.stringify(rotatePatch(start, "y", 33)));
expect("the X ring drives tilt and the Z ring roll", rotatePatch(start, "x", 20).rotX === 20 && rotatePatch(start, "z", -20).rotZ === -20);
expect("ring rotation wraps instead of running away", rotatePatch({ rot: 170 }, "y", 30).rot === -160, JSON.stringify(rotatePatch({ rot: 170 }, "y", 30)));
expect("angles fold into [-180, 180)", wrapAngle(360) === 0 && wrapAngle(-190) === 170 && wrapAngle(180) === -180);

expect("an axis scale knob scales only its own axis", JSON.stringify(scalePatch({ scaleX: 1, scaleY: 1, scaleZ: 1 }, "x", 2)) === JSON.stringify({ scaleX: 2 }));
expect("the centre knob scales all three axes", JSON.stringify(scalePatch({ scaleX: 1, scaleY: 2, scaleZ: 1 }, null, 1.5)) === JSON.stringify({ scaleX: 1.5, scaleY: 3, scaleZ: 1.5 }));
expect("scale snaps to 5 percent steps", scalePatch({ scaleX: 1 }, "x", 1.234).scaleX === 1.25, JSON.stringify(scalePatch({ scaleX: 1 }, "x", 1.234)));
expect("scale never collapses to nothing", scalePatch({ scaleX: 1 }, "x", 0.001).scaleX === 0.01);
expect("a degenerate scale drag writes nothing", scalePatch({ scaleX: 1 }, "x", 0) === null && scalePatch({ scaleX: 1 }, "w", 2) === null);
expect("world size folds scale into the footprint", JSON.stringify(objectSize({ footprint: { width: 2, depth: 3 }, height: 4, scaleX: 0.5, scaleY: 2, scaleZ: 1 })) === JSON.stringify({ width: 1, height: 8, depth: 3 }));

// The screen ring spins about an arbitrary world axis and has to write all
// three Euler channels back coherently.
const upright = { rotX: 0, rot: 0, rotZ: 0 };
const spun = screenRotatePatch(upright, { x: 0, y: 1, z: 0 }, 90);
expect("a view-axis spin about world Y lands on the Y channel", spun.rot === 90 && spun.rotX === 0 && spun.rotZ === 0, JSON.stringify(spun));
const rolled = screenRotatePatch(upright, { x: 0, y: 0, z: 1 }, 30);
expect("a view-axis spin about world Z lands on the Z channel", rolled.rotZ === 30 && rolled.rotX === 0 && rolled.rot === 0, JSON.stringify(rolled));
expect("the screen ring snaps to the 5 degree grid", screenRotatePatch(upright, { x: 0, y: 1, z: 0 }, 33).rot === 35, JSON.stringify(screenRotatePatch(upright, { x: 0, y: 1, z: 0 }, 33)));
expect("an unsnapped screen spin keeps the exact angle", screenRotatePatch(upright, { x: 0, y: 1, z: 0 }, 33, 0).rot === 33);
expect("a degenerate screen spin writes nothing", screenRotatePatch(upright, null, 10) === null && screenRotatePatch(upright, { x: 0, y: 1, z: 0 }, Number.NaN) === null);

/* ------------------------------------------------------- clamping --- */

const bounded = updateSceneObject([cube], cube.id, { x: 999, y: -3, z: -999, scaleX: 400, scaleY: 0 })[0];
expect("transforms stay on the stage and above the floor", bounded.x === 240 && bounded.z === -240 && bounded.y === 0);
expect("scale stays within a usable range", bounded.scaleX === 100 && bounded.scaleY === 0.01);
const renamed = updateSceneObject([cube], cube.id, { name: "Crate", color: "#123456" })[0];
expect("name and colour are editable", renamed.name === "Crate" && renamed.color === "#123456");
expect("empty names are rejected", updateSceneObject([cube], cube.id, { name: "" })[0] === cube);

/* ------------------------------------------------ persistence ---- */

const fullRecord = createSceneObject("cube", []);
const roundTrip = loadScene(serializeScene([fullRecord]));
expect(
	"a serialized scene round-trips",
	roundTrip.status === "valid" && JSON.stringify(roundTrip.objects) === JSON.stringify([fullRecord]),
	JSON.stringify(roundTrip),
);

expect(
	"an absent payload is tagged absent",
	loadScene(null).status === "absent" && loadScene("").status === "absent" && loadScene(undefined).status === "absent",
);

expect(
	"malformed JSON is tagged corrupt",
	loadScene("{").status === "corrupt" && loadScene("[1,2]").status === "corrupt" && loadScene('{"version":1}').status === "corrupt",
);

expect(
	"a non-integer or non-positive version is corrupt, not future",
	['{"version":"1","objects":[]}', '{"version":1.5,"objects":[]}', '{"version":0,"objects":[]}', '{"version":-1,"objects":[]}'].every(
		(raw) => loadScene(raw).status === "corrupt",
	),
);

expect(
	"only an integer newer than SCENE_VERSION is future",
	loadScene('{"version":2,"objects":[]}').status === "future" &&
		loadScene('{"version":99,"objects":[]}').status === "future" &&
		loadScene('{"version":2,"objects":[]}').objects.length === 0,
);

expect(
	"the supported version range is exactly 1..SCENE_VERSION",
	Array.from({ length: SCENE_VERSION }, (_, index) => index + 1).every((version) =>
		loadScene(JSON.stringify({ version, objects: [] })).status === "valid",
	),
);

expect(
	"an unknown renderer is dropped, not fatal",
	(() => {
		const result = loadScene(
			JSON.stringify({ version: 1, objects: [createSceneObject("cube", []), { id: "ghost", renderer: "ghost" }] }),
		);
		return result.objects.length === 1 && result.dropped === 1;
	})(),
);

expect(
	"footprint and height are rebuilt from the library",
	(() => {
		const result = loadScene(
			JSON.stringify({ version: 1, objects: [{ id: "cube", renderer: "cube", footprint: { width: 99, depth: 99 }, height: 42 }] }),
		);
		return result.objects[0].footprint.width === 1 && result.objects[0].footprint.depth === 1 && result.objects[0].height === 1;
	})(),
);

expect(
	"a single scale field fans out to three axes",
	(() => {
		const result = loadScene(JSON.stringify({ version: 1, objects: [{ id: "cube", renderer: "cube", scale: 2 }] }));
		const object = result.objects[0];
		return object.scaleX === 2 && object.scaleY === 2 && object.scaleZ === 2;
	})(),
);

expect(
	"out-of-room values are clamped on load",
	(() => {
		const result = loadScene(JSON.stringify({ version: 1, objects: [{ id: "cube", renderer: "cube", x: 999, y: -3, scaleX: 500 }] }));
		const object = result.objects[0];
		return object.x === 240 && object.y === 0 && object.scaleX === 100;
	})(),
);

expect(
	"duplicate ids are dropped and counted",
	(() => {
		const cube = createSceneObject("cube", []);
		const result = loadScene(JSON.stringify({ version: 1, objects: [cube, { ...cube, name: "Cube 2" }] }));
		return result.objects.length === 1 && result.dropped === 1;
	})(),
);

expect(
	"the storage keys are namespaced, versioned and distinct",
	SCENE_STORAGE_KEY === "cozyclay.scene.v1" &&
		SCENE_VERSION === 1 &&
		SCENE_QUARANTINE_KEY.startsWith(SCENE_STORAGE_KEY) &&
		SCENE_QUARANTINE_KEY !== SCENE_STORAGE_KEY,
);
/* ------------------------------------------------ drop-to-surface ---- */

// Strict drop-down (plan §9.2): a surface supports the falling object only
// when its top is at or below the object's current base, so an object that
// is already inside a box is NOT supported by it and falls through. The
// patch touches only Y; the caller's updateSceneObject clamp owns the limits.
const cubeAt = (id, x, z, y, height = 1) => ({
	id,
	x,
	y,
	z,
	rot: 0,
	rotX: 0,
	rotZ: 0,
	scaleX: 1,
	scaleY: 1,
	scaleZ: 1,
	footprint: { width: 0.5, depth: 0.5 },
	height,
});
const box = {
	id: "box",
	x: 0,
	y: 0,
	z: 0,
	rot: 0,
	rotX: 0,
	rotZ: 0,
	scaleX: 1,
	scaleY: 1,
	scaleZ: 1,
	footprint: { width: 1, depth: 1 },
	height: 1,
};

const floater = cubeAt("floater", 0, 0, 2);
const floaterBefore = JSON.stringify(floater);
const floorPatch = dropToSurfacePatch(floater, []);
expect("an object over empty floor drops to zero", floorPatch !== null && floorPatch.y === 0, JSON.stringify(floorPatch));
expect("a drop never mutates its inputs", JSON.stringify(floater) === floaterBefore);

const boxPatch = dropToSurfacePatch(cubeAt("faller", 0, 0, 1.5), [box]);
expect("an object over a box rests on its top", boxPatch !== null && boxPatch.y === 1, JSON.stringify(boxPatch));

const tallBox = { ...box, id: "tall", scaleY: 2 };
expect("scaleY raises the support surface", dropToSurfacePatch(cubeAt("faller2", 0, 0, 3), [tallBox]).y === 2);

expect("a non-overlapping neighbour is not a support", dropToSurfacePatch(cubeAt("far", 5, 5, 1), [box]).y === 0);
// The 0.5 m cube's edge touches the 1 m box's edge at x = 0.5 exactly: the
// EPS tolerance keeps the abutment from counting as overlap.
expect("an edge-touching neighbour is not a support", dropToSurfacePatch(cubeAt("edge", 0.75, 0, 1), [box]).y === 0);

const raisedBox = { ...box, id: "raised", y: 1 };
expect("a support above the object is ignored", dropToSurfacePatch(cubeAt("low", 0, 0, 0.5), [raisedBox]).y === 0);

// Base 0.4 is below the box top 1, so strict drop-down says the box is NOT
// support and the object lands on the floor — not on the box top.
expect("an object already inside a box falls through it", dropToSurfacePatch(cubeAt("buried", 0, 0, 0.4), [box]).y === 0);

// Composition: the patch carries only Y, so snapped X/Z survive byte-for-byte
// and the exact (un-snapped) contact height comes through updateSceneObject.
const offGrid = { ...box, id: "offgrid", x: 1.25, z: -0.4, height: 1.13 };
const snapStart = cubeAt("drop", 1.25, -0.4, 2);
const composed = dropToSurfacePatch(snapStart, [offGrid]);
expect("a drop preserves snapped X and Z byte-for-byte", composed !== null && composed.y === 1.13, JSON.stringify(composed));
const rested = updateSceneObject([snapStart, offGrid], snapStart.id, composed);
expect(
	"the applied drop lands exactly on the off-grid top, not on the 5 cm grid",
	rested[0].x === 1.25 && rested[0].z === -0.4 && rested[0].y === 1.13,
	JSON.stringify(rested[0]),
);
const noOp = dropToSurfacePatch(rested[0], [offGrid]);
expect("a drop is idempotent — the second drop changes nothing", noOp === null, JSON.stringify(noOp));
expect(
	"a redundant drop keeps the SAME array reference, so no history entry is possible",
	updateSceneObject(rested, rested[0].id, noOp ?? {}) === rested,
);

// The clamp lives in updateSceneObject alone: the pure patch reports the raw
// contact (a support top a hair above the headroom limit, admitted by the EPS
// tolerance because the object's base sits exactly at that limit) and the
// applied record is capped at the limit. Derived from the limit rather than
// written as a literal, so raising the headroom cannot silently void this.
const HEADROOM = updateSceneObject([cubeAt("probe", 0, 0, 0)], "probe", { y: 1e6 })[0].y;
const tallStack = { ...box, id: "stack", height: HEADROOM + 0.00005 };
const overCeiling = dropToSurfacePatch(cubeAt("up", 0, 0, HEADROOM), [tallStack]);
expect(
	"the drop patch itself is not clamped",
	overCeiling !== null && overCeiling.y === HEADROOM + 0.00005,
	JSON.stringify(overCeiling),
);
const clamped = updateSceneObject([cubeAt("up", 0, 0, HEADROOM), tallStack], "up", overCeiling)[0];
expect("a composed drop still hits the ceiling clamp", clamped.y === HEADROOM, JSON.stringify(clamped));

// A 0.5 x 4 m plank at 45 degrees: the yawed AABB is a ~3.18 m square, so a
// cube at x = 0.5 (which the unrotated 0.5 m-wide footprint would miss) is
// supported, while one beyond the projected square is not.
const plank = {
	id: "plank",
	x: 0,
	y: 0,
	z: 0,
	rot: 45,
	rotX: 0,
	rotZ: 0,
	scaleX: 1,
	scaleY: 1,
	scaleZ: 1,
	footprint: { width: 0.5, depth: 4 },
	height: 0.1,
};
const plankBounds = objectFootprintBounds(plank);
expect(
	"the yawed AABB widens the plank beyond its unrotated footprint",
	plankBounds.maxX > 1.5 && plankBounds.maxZ > 1.5 && plankBounds.baseY === 0 && plankBounds.topY === 0.1,
	JSON.stringify(plankBounds),
);
expect(
	"a 45-degree long support widens the overlap window",
	dropToSurfacePatch(cubeAt("grazing", 0.5, 0, 1), [plank]).y === 0.1,
);
expect(
	"a 45-degree support does not create phantom overlap beyond its AABB",
	dropToSurfacePatch(cubeAt("clear", 2.5, 0, 1), [plank]).y === 0,
);

/* ----------------------------------------------------------- cutouts --- */

const sofa = createCutoutObject({ assetId: "asset-sofa", aspect: 2, height: 0.9, name: "Sofa" });
expect(
	"a cutout is sized by its measured height and its picture's aspect",
	sofa.height === 0.9 && sofa.footprint.width === 1.8 && sofa.footprint.depth === CUTOUT_THICKNESS,
	JSON.stringify(sofa),
);
expect("a cutout keeps the asset id its picture lives under", sofa.assetId === "asset-sofa" && sofa.renderer === CUTOUT_KIND);
expect(
	"a cutout without a picture is refused",
	createCutoutObject({ assetId: "" }) === null && createCutoutObject({}) === null && createCutoutObject() === null,
);
expect("cutouts are not creatable from the catalogue", createSceneObject(CUTOUT_KIND, []) === null);
expect(
	"the catalogue menu does not offer cutouts",
	!OBJECT_LIBRARY.some((entry) => entry.kind === CUTOUT_KIND),
);
expect(
	"cutout names and ids stay unique against the scene",
	createCutoutObject({ assetId: "asset-2", name: "Sofa" }, [sofa]).name === "Sofa 2" &&
		createCutoutObject({ assetId: "asset-2", name: "Sofa" }, [sofa]).id === "cutout-2",
);

const resized = updateSceneObject([sofa], sofa.id, { height: 1.8 })[0];
expect(
	"editing a cutout's height rederives its footprint",
	resized.height === 1.8 && resized.footprint.width === 3.6,
	JSON.stringify(resized),
);
expect(
	"a cutout's footprint cannot be patched directly",
	updateSceneObject([sofa], sofa.id, { footprint: { width: 99, depth: 99 } })[0] === sofa,
);
expect(
	"a cutout height has no upper limit and stays above zero",
	updateSceneObject([sofa], sofa.id, { height: 1e6 })[0].height === 1e6 &&
		updateSceneObject([sofa], sofa.id, { height: 0 })[0].height === 0.05,
);
expect(
	"a nonsense height or aspect leaves the card alone",
	updateSceneObject([sofa], sofa.id, { height: "tall" })[0] === sofa &&
		updateSceneObject([sofa], sofa.id, { aspect: Number.NaN })[0] === sofa,
);
expect(
	"a library object ignores the cutout channels",
	updateSceneObject([cube], cube.id, { height: 3, aspect: 2 })[0] === cube,
);

expect(
	"a fresh cutout is its own original, with no selection on it",
	sofa.sourceAssetId === sofa.assetId && sofa.matteAssetId === "" && sofa.matteScale === 1,
	JSON.stringify(sofa),
);

const cut = updateSceneObject([sofa], sofa.id, {
	assetId: "asset-sofa-cut",
	sourceAssetId: "asset-sofa",
	matteAssetId: "asset-sofa-matte",
	matteScale: 0.5,
	aspect: 1.4,
	height: 0.45,
})[0];
expect(
	"a cut card keeps the picture it renders, the photograph it came from and the selection",
	cut.assetId === "asset-sofa-cut" && cut.sourceAssetId === "asset-sofa" && cut.matteAssetId === "asset-sofa-matte" && cut.matteScale === 0.5,
	JSON.stringify(cut),
);
expect(
	"a stored cut card round-trips with all three",
	(() => {
		const back = loadScene(serializeScene([cut]));
		return JSON.stringify(back.objects) === JSON.stringify([cut]);
	})(),
);
expect(
	"a record from before the cut editor still loads, as its own original",
	(() => {
		const { sourceAssetId, matteAssetId, matteScale, ...old } = sofa;
		const back = normalizeSceneObject(old);
		return back.sourceAssetId === back.assetId && back.matteAssetId === "" && back.matteScale === 1;
	})(),
);
expect(
	"a nonsense trim factor is clamped, not trusted",
	normalizeSceneObject({ ...cut, matteScale: 9 }).matteScale === 1 && normalizeSceneObject({ ...cut, matteScale: "half" }).matteScale === 1,
);

const repointed = updateSceneObject([sofa], sofa.id, { assetId: "asset-sofa-cut", aspect: 1.4, height: 0.9 })[0];
expect(
	"a card can be pointed at a new picture, resizing with it",
	repointed.assetId === "asset-sofa-cut" && repointed.aspect === 1.4 && Math.abs(repointed.footprint.width - 1.26) < 1e-9,
	JSON.stringify(repointed),
);
expect(
	"an empty or unchanged asset id writes nothing",
	updateSceneObject([sofa], sofa.id, { assetId: "" })[0] === sofa && updateSceneObject([sofa], sofa.id, { assetId: sofa.assetId })[0] === sofa,
);

// The renderer's half of the same argument: the card is alpha-CUT so it keeps
// writing depth, but the cut is resolved by MSAA coverage rather than by a
// per-pixel yes/no, or the silhouette staircases and the matte's soft edge is
// thrown away at the threshold.
const cutoutSource = propsSource.slice(propsSource.indexOf("function Cutout"), propsSource.indexOf("const PRIMITIVE_KINDS"));
expect(
	"a cutout resolves its edge with coverage, not with a hard threshold",
	/alphaToCoverage=\{!!texture\}/.test(cutoutSource) && /alphaTest=\{texture \? 0\.15 : 0\}/.test(cutoutSource),
	cutoutSource.slice(cutoutSource.indexOf("<meshStandardMaterial"), cutoutSource.indexOf("</mesh>")),
);
expect("and still writes depth — no transparent blending on a card", !/transparent/.test(cutoutSource));

const cutoutTrip = loadScene(serializeScene([sofa]));
expect(
	"a cutout round-trips through storage",
	cutoutTrip.status === "valid" && JSON.stringify(cutoutTrip.objects) === JSON.stringify([sofa]),
	JSON.stringify(cutoutTrip),
);
expect(
	"a stored cutout footprint is rebuilt from height and aspect, never trusted",
	(() => {
		const stale = { ...sofa, footprint: { width: 99, depth: 99 } };
		const repaired = normalizeSceneObject(stale);
		return repaired.footprint.width === 1.8 && repaired.footprint.depth === CUTOUT_THICKNESS;
	})(),
);
expect(
	"a cutout record with no asset id is dropped like an unknown renderer",
	(() => {
		const { assetId, ...orphan } = sofa;
		const result = loadScene(JSON.stringify({ version: 1, objects: [orphan] }));
		return result.objects.length === 0 && result.dropped === 1;
	})(),
);
expect(
	"a cutout stored at an extreme height keeps that height",
	(() => {
		const repaired = normalizeSceneObject({ ...sofa, height: 1e6, aspect: -4 });
		return (
			repaired.height === 1e6 &&
			repaired.aspect === 0.02 &&
			repaired.footprint.width === cutoutFootprint(1e6, 0.02).width
		);
	})(),
);
expect(
	"a card stands on a box like any other object",
	dropToSurfacePatch({ ...sofa, y: 1.5 }, [box]).y === 1,
);

/* ------------------------------------------------------ cutout stretch --- */
// A card's width is a measurement, not a scale multiplier: the inspector field
// and the gizmo's X handle both write it, and the picture's own aspect is kept
// untouched so a re-cut cannot silently lose or compound a widening.

const stretchCard = createCutoutObject({ assetId: "stretch-a", aspect: 2, height: 1.8 }, []);
expect("a new card wears the picture's proportions", stretchCard.stretch === 1 && stretchCard.footprint.width === 3.6);

let stretched = updateSceneObject([stretchCard], stretchCard.id, { width: 7.2 });
expect("a width in metres is accepted as given", stretched[0].footprint.width === 7.2, String(stretched[0].footprint.width));
expect("widening records the factor", Math.abs(stretched[0].stretch - 2) < 1e-9, String(stretched[0].stretch));
expect("widening leaves the height alone", stretched[0].height === 1.8);
expect("widening does not touch scaleX", stretched[0].scaleX === 1);
expect("the picture's own aspect is preserved", stretched[0].aspect === 2);

const taller = updateSceneObject(stretched, stretchCard.id, { height: 3 });
expect(
  "height and width stay independent",
  taller[0].height === 3 && Math.abs(taller[0].footprint.width - 12) < 1e-9,
  `${taller[0].height} / ${taller[0].footprint.width}`,
);

const reset = updateSceneObject(taller, stretchCard.id, { stretch: 1 });
expect("resetting returns to the picture's proportions", Math.abs(reset[0].footprint.width - 6) < 1e-9, String(reset[0].footprint.width));

expect("an absurd width is clamped", updateSceneObject(reset, stretchCard.id, { width: 99999 })[0].stretch === 10);
expect("a negative width is clamped", updateSceneObject(reset, stretchCard.id, { width: -5 })[0].stretch === 0.1);

const revivedStretch = normalizeSceneObject(JSON.parse(JSON.stringify(stretched[0])));
expect("a stretch survives a storage round trip", revivedStretch.stretch === 2 && revivedStretch.footprint.width === 7.2);

const preStretchRecord = JSON.parse(JSON.stringify(stretchCard));
delete preStretchRecord.stretch;
const upgraded = normalizeSceneObject(preStretchRecord);
expect("a record written before stretching reads as unstretched", upgraded.stretch === 1 && upgraded.footprint.width === 3.6);

/* ------------------------------------------------------- corner resize --- */
// A corner drag sends both dimensions in one patch, so the picture keeps its
// shape. `width` is divided by the NEW height, which is what makes a
// proportional resize leave `stretch` untouched.

const cornerCard = createCutoutObject({ assetId: "corner-a", aspect: 2, height: 1.8 }, []);
const cornerDrag = (object, factor) =>
  updateSceneObject([object], object.id, {
    height: Math.max(0.05, object.height * factor),
    width: Math.max(0.05, object.footprint.width * factor),
  })[0];
const shapeOf = (object) => +(object.footprint.width / object.height).toFixed(6);

const grown = cornerDrag(cornerCard, 2);
expect("a corner drag grows both dimensions", grown.footprint.width === 7.2 && grown.height === 3.6, `${grown.footprint.width} x ${grown.height}`);
expect("a corner drag keeps the picture's shape", shapeOf(grown) === shapeOf(cornerCard));
expect("a proportional resize leaves the stretch alone", grown.stretch === 1, String(grown.stretch));

const shrunk = cornerDrag(cornerCard, 0.5);
expect("a corner drag shrinks too", shrunk.footprint.width === 1.8 && shrunk.height === 0.9);
expect("shrinking keeps the shape", shapeOf(shrunk) === shapeOf(cornerCard));

// a card deliberately pulled off its proportions keeps that through a corner drag
const widened = updateSceneObject([cornerCard], cornerCard.id, { width: 7.2 })[0];
const widenedGrown = cornerDrag(widened, 1.5);
expect("a stretched card keeps its stretch through a corner drag", Math.abs(widenedGrown.stretch - 2) < 1e-9, String(widenedGrown.stretch));
expect(
  "and both of its dimensions still scale together",
  Math.abs(widenedGrown.footprint.width - 10.8) < 1e-9 && Math.abs(widenedGrown.height - 2.7) < 1e-9,
  `${widenedGrown.footprint.width} x ${widenedGrown.height}`,
);

/* -------------------------------------------------- duplicate ---- */

// A matted cutout is a three-id record: the picture it renders, the photo it
// came from, and the selection mask, plus the trim factor and any stretch.
// Duplicating it must carry ALL of that through `createCutoutObject` — the
// same door an import uses — so the copy stays re-editable instead of
// silently resetting its matte. The option bundle comes from the pure
// `duplicateCutoutOptions` helper, which is the very same call App.jsx makes,
// so this guards the real production path, not a hand-rolled copy.

const matted = updateSceneObject([sofa], sofa.id, {
	assetId: "img-aaa-render",
	sourceAssetId: "img-bbb-original",
	matteAssetId: "img-ccc-matte",
	matteScale: 0.5,
	aspect: 1.4,
	height: 0.9,
	width: 2.52,
})[0];
const mattedDup = createCutoutObject(duplicateCutoutOptions(matted), [matted], { x: matted.x + 0.5, z: matted.z, rot: matted.rot });
expect(
	"a matted cutout duplicate keeps the picture, the original and the mask",
	mattedDup !== null &&
		mattedDup.assetId === "img-aaa-render" &&
		mattedDup.sourceAssetId === "img-bbb-original" &&
		mattedDup.matteAssetId === "img-ccc-matte",
	JSON.stringify(mattedDup),
);
expect(
	"a matted cutout duplicate keeps the trim factor",
	mattedDup.matteScale === 0.5,
	JSON.stringify(mattedDup),
);
expect(
	"a matted cutout duplicate keeps the stretch and its derived footprint",
	mattedDup.stretch === matted.stretch && Math.abs(mattedDup.footprint.width - matted.footprint.width) < 1e-9,
	`${mattedDup.stretch}/${mattedDup.footprint.width} vs ${matted.stretch}/${matted.footprint.width}`,
);
expect(
	"a matted duplicate is a NEW record (fresh id and offset name), not the original",
	mattedDup.id !== matted.id && mattedDup.name !== matted.name,
	JSON.stringify({ id: mattedDup.id, name: mattedDup.name }),
);

// A never-matted card has an empty mask and is its own original; duplicating
// it must keep those defaults without crashing or inventing a matte.
const plain = createCutoutObject({ assetId: "img-plain", aspect: 2, height: 1.8, name: "Plain" }, []);
const plainDup = createCutoutObject(duplicateCutoutOptions(plain), [plain]);
expect(
	"a never-matted duplicate keeps empty mask and self-as-original",
	plainDup.sourceAssetId === plain.assetId && plainDup.matteAssetId === "" && plainDup.matteScale === 1,
	JSON.stringify(plainDup),
);

/* ------------------------------------------------------------ meshes --- */
// A mesh prop is the 3D cousin of a cutout: imported, not in the Add-object
// catalogue, sized per instance from the fitted GLB box, clay optional.

expect(
	"a mesh without a picture (asset id) is refused",
	createMeshObject({ assetId: "" }) === null && createMeshObject({}) === null && createMeshObject() === null,
);
expect("meshes are not creatable from the catalogue", createSceneObject("mesh", []) === null && createSceneObject(MESH_KIND, []) === null);
expect(
	"auto-color tints file-material meshes the same way it tints a cube",
	!/MESH_KIND && !object\.clay/.test(readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8")),
);
expect(
	"the catalogue menu does not offer meshes",
	!OBJECT_LIBRARY.some((entry) => entry.kind === MESH_KIND) && MESH_KIND === "mesh",
);

const cooker = createMeshObject({
	assetId: "mesh-asset-cooker",
	height: 1,
	footprint: { width: 1, depth: 0.5 },
	name: "Cooker",
});
expect(
	"a mesh keeps the fitted height and footprint it was given",
	cooker !== null &&
		cooker.renderer === MESH_KIND &&
		cooker.assetId === "mesh-asset-cooker" &&
		cooker.height === 1 &&
		cooker.footprint.width === 1 &&
		cooker.footprint.depth === 0.5 &&
		cooker.y === 0 &&
		cooker.clay === false,
	JSON.stringify(cooker),
);
expect("a mesh footprint is its own copy", cooker.footprint !== undefined && cooker.footprint.width === 1);

const cooker2 = createMeshObject({
	assetId: "mesh-asset-cooker",
	height: 1,
	footprint: { width: 1, depth: 0.5 },
	name: "Cooker",
}, [cooker]);
expect(
	"repeat mesh creation gets a unique id and a numbered name",
	cooker.id === "mesh" && cooker2.id === "mesh-2" && cooker2.name === "Cooker 2",
	JSON.stringify({ first: cooker.id, second: cooker2?.id, name: cooker2?.name }),
);
expect(
	"an explicit clay flag sticks on create",
	createMeshObject({ assetId: "mesh-asset-cooker", height: 1, footprint: { width: 1, depth: 1 }, clay: true }).clay === true,
);

const revivedMesh = normalizeSceneObject({
	id: "mesh",
	renderer: "mesh",
	assetId: "mesh-asset-cooker",
	height: 3,
	footprint: { width: 2, depth: 0.5 },
	name: "Cooker",
});
expect(
	"a stored mesh keeps per-instance footprint and height, and missing clay reads as false",
	revivedMesh !== null &&
		revivedMesh.assetId === "mesh-asset-cooker" &&
		revivedMesh.height === 3 &&
		revivedMesh.footprint.width === 2 &&
		revivedMesh.footprint.depth === 0.5 &&
		revivedMesh.clay === false,
	JSON.stringify(revivedMesh),
);
expect(
	"a mesh record with no asset id is dropped like an unknown renderer",
	normalizeSceneObject({ id: "mesh", renderer: "mesh", height: 1, footprint: { width: 1, depth: 1 } }) === null,
);
expect(
	"a deliberately 12 m mesh is not refitted on load — the 0.05–10 m heuristic is import-only",
	normalizeSceneObject({
		id: "truck",
		renderer: "mesh",
		assetId: "mesh-asset-truck",
		height: 12,
		footprint: { width: 3, depth: 8 },
	})?.height === 12,
);
expect("a ghost renderer is still dropped", normalizeSceneObject({ id: "ghost", renderer: "ghost" }) === null);

const grownMesh = updateSceneObject([cooker], cooker.id, { height: 2 })[0];
expect(
	"raising a mesh's height scales its footprint uniformly so the import box's ratio survives",
	grownMesh.height === 2 && grownMesh.footprint.width === 2 && grownMesh.footprint.depth === 1,
	JSON.stringify(grownMesh),
);
const shrunkMesh = updateSceneObject([cooker], cooker.id, { height: 0.5 })[0];
expect(
	"lowering a mesh's height scales its footprint uniformly",
	shrunkMesh.height === 0.5 && Math.abs(shrunkMesh.footprint.width - 0.5) < 1e-9 && Math.abs(shrunkMesh.footprint.depth - 0.25) < 1e-9,
	JSON.stringify(shrunkMesh.footprint),
);
const clayed = updateSceneObject([grownMesh], cooker.id, { clay: true })[0];
expect("clay true sticks on a mesh", clayed.clay === true);
expect("clay false is writable too", updateSceneObject([clayed], cooker.id, { clay: false })[0].clay === false);

const meshDup = createMeshObject(duplicateMeshOptions(clayed), [clayed]);
expect(
	"duplicating a mesh copies assetId, clay, height and footprint onto a new record",
	meshDup !== null &&
		meshDup.id !== clayed.id &&
		meshDup.assetId === clayed.assetId &&
		meshDup.clay === clayed.clay &&
		meshDup.height === clayed.height &&
		meshDup.footprint.width === clayed.footprint.width &&
		meshDup.footprint.depth === clayed.footprint.depth,
	JSON.stringify(meshDup),
);

const meshParent = createSceneObject("cube", []);
const meshChild = createMeshObject({ assetId: "mesh-asset-cooker", height: 1, footprint: { width: 1, depth: 1 } }, [meshParent]);
const meshedGroup = setSceneObjectParent([meshParent, meshChild], meshChild.id, meshParent.id);
expect(
	"a mesh can parent under a cube like any other prop",
	meshedGroup.find((object) => object.id === meshChild.id).parent === meshParent.id,
);
const meshedAttach = setSceneObjectAttach(meshedGroup, meshChild.id, { characterId: "characterA", bone: "rightHand" });
expect(
	"a mesh can attach to a character bone, which drops the group parent",
	meshedAttach.find((object) => object.id === meshChild.id).attach.bone === "rightHand" &&
		meshedAttach.find((object) => object.id === meshChild.id).parent === null,
	JSON.stringify(meshedAttach.find((object) => object.id === meshChild.id)),
);
const meshedPath = updateSceneObject([cooker], cooker.id, { path: { points: [{ x: 0, z: 0 }, { x: 1, z: 1 }] } })[0];
expect("a mesh can wear a travel path like a cube", Array.isArray(meshedPath.path?.points) && meshedPath.path.points.length >= 2);

/* --- the delete-undo toast is an offer, not a permanent banner ------------- */
// It sat on screen forever because nothing ever cleared it: only pressing Undo
// or a later restore did. An undo offer has a window, and when the window
// closes the toast has to go with it.
const appSource = readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8")
	+ readFileSync(new URL("../src/use-asset-shelf.js", import.meta.url), "utf8");

expect(
	"the object delete-undo offer expires on its own",
	appSource.includes("OBJECT_DELETE_UNDO_MS") && appSource.includes("setObjectDeleteUndo(null)"),
);
expect(
	"the expiry is a timer effect keyed to the pending deletion",
	appSource.includes("}, [objectDeleteUndo]);"),
);
expect(
	"the offer is withdrawn the moment a newer edit invalidates it",
	appSource.includes("store.depths().past !== objectDeleteUndo.pastDepth"),
);
expect(
	"the image delete-undo offer expires the same way",
	appSource.includes("ASSET_DELETE_UNDO_MS"),
);

if (failures) process.exit(1);
console.log("all scene object checks PASS");

/* ------------------------------------------------------- grouping --- */

// A group is an editing convenience: the parent carries its children when it
// moves, and nothing else about them changes.
const gParent = createSceneObject("cube", [], { x: 0, z: 0 });
const gChildA = createSceneObject("sphere", [gParent], { x: 2, z: 1 });
const gChildB = createSceneObject("cone", [gParent, gChildA], { x: -1, z: 3 });
let grouped = setSceneObjectParent([gParent, gChildA, gChildB], gChildA.id, gParent.id);
grouped = setSceneObjectParent(grouped, gChildB.id, gChildA.id); // nested one level deeper

expect("a new object starts unparented", gParent.parent === null);
expect(
	"parenting records the parent",
	grouped.find((o) => o.id === gChildA.id).parent === gParent.id,
);

const movedGroup = updateSceneObject(grouped, gParent.id, { x: 5, z: -2 });
const movedA = movedGroup.find((o) => o.id === gChildA.id);
const movedB = movedGroup.find((o) => o.id === gChildB.id);
expect("moving a parent carries its child", movedA.x === 7 && movedA.z === -1, JSON.stringify(movedA));
expect("the carry reaches grandchildren", movedB.x === 4 && movedB.z === 1, JSON.stringify(movedB));
expect(
	"a child keeps its own rotation and scale",
	movedA.rot === gChildA.rot && movedA.scaleX === gChildA.scaleX,
);

const movedChild = updateSceneObject(grouped, gChildA.id, { x: 4 });
expect(
	"moving a child leaves the parent alone",
	movedChild.find((o) => o.id === gParent.id).x === 0,
);

// Rotating a group turns it rigidly about the parent (test/verify-group-rotation.mjs
// covers the math); scaling is NOT propagated — only translation and rotation are claimed.
const groupSpun = updateSceneObject(grouped, gParent.id, { rot: 90, scaleX: 2 });
const spunA = groupSpun.find((o) => o.id === gChildA.id);
expect(
	"rotation turns the child with the parent (its rot gains the parent's yaw) while scale stays on the parent alone",
	Math.abs((((spunA.rot - (gChildA.rot + 90)) % 360) + 540) % 360 - 180) < 1e-6 && spunA.scaleX === gChildA.scaleX,
	JSON.stringify(spunA),
);

expect("an object cannot parent itself", setSceneObjectParent(grouped, gParent.id, gParent.id) === grouped);
expect(
	"a cycle is refused",
	setSceneObjectParent(grouped, gParent.id, gChildB.id) === grouped,
);
expect(
	"an unknown parent is refused",
	setSceneObjectParent(grouped, gChildA.id, "no-such-object") === grouped,
);
expect(
	"detaching clears the parent",
	setSceneObjectParent(grouped, gChildA.id, null).find((o) => o.id === gChildA.id).parent === null,
);

const orphaned = removeSceneObject(grouped, gParent.id);
expect(
	"deleting a parent promotes its children instead of orphaning them",
	orphaned.length === 2 && orphaned.every((o) => o.parent === null || o.parent === gChildA.id),
	JSON.stringify(orphaned.map((o) => [o.id, o.parent])),
);

expect(
	"parent survives a serialize/load round trip",
	loadScene(serializeScene(grouped)).objects.find((o) => o.id === gChildA.id).parent === gParent.id,
);

/* ----------------------------------------------------- attachment --- */

// A prop can ride a character's animated frame instead of the floor — the
// "carry the baseball bat" case. `attach` is the pin; the numbers on the
// record stay opaque to the store (the App owns the world<->local maths), so
// everything checked here is about the pin itself: its shape, its exclusivity
// with grouping, and its survival through storage.

const aParent = createSceneObject("cube", []);
const aProp = createSceneObject("cone", [aParent]);
const aScene = [aParent, aProp];

expect(
	"the attach bone list is exactly the app's IK track ids",
	JSON.stringify(SCENE_ATTACH_BONES) ===
		JSON.stringify([
			"hips", "spine", "chest", "neck", "head",
			"leftShoulder", "leftElbow", "leftHand",
			"rightShoulder", "rightElbow", "rightHand",
			"leftKnee", "leftFoot", "rightKnee", "rightFoot",
		]),
	JSON.stringify(SCENE_ATTACH_BONES),
);
expect("the bone list is frozen, so no caller can edit the vocabulary", Object.isFrozen(SCENE_ATTACH_BONES));
expect(
	"a new object — primitive or cutout — starts world-anchored",
	aProp.attach === null && createCutoutObject({ assetId: "attach-img" }, []).attach === null,
);

const rooted = setSceneObjectAttach(aScene, aProp.id, { characterId: "characterA" });
expect("attaching returns a NEW collection and leaves the others identical", rooted !== aScene && rooted[0] === aScene[0]);
expect(
	"an omitted bone means the character's animated ROOT frame",
	JSON.stringify(rooted[1].attach) === JSON.stringify({ characterId: "characterA", bone: null }),
	JSON.stringify(rooted[1].attach),
);
expect(
	"an explicit null bone is the same root frame",
	JSON.stringify(setSceneObjectAttach(aScene, aProp.id, { characterId: "characterA", bone: null })[1].attach) ===
		JSON.stringify({ characterId: "characterA", bone: null }),
);

const handed = setSceneObjectAttach(rooted, aProp.id, { characterId: "characterA", bone: "rightHand" });
expect(
	"a bone attach records the track id, not a three.js bone name",
	handed[1].attach.characterId === "characterA" && handed[1].attach.bone === "rightHand",
	JSON.stringify(handed[1].attach),
);
expect(
	"extra keys are stripped, never stored",
	JSON.stringify(
		setSceneObjectAttach(aScene, aProp.id, { characterId: "characterA", bone: "head", offset: 3, parent: "x" })[1].attach,
	) === JSON.stringify({ characterId: "characterA", bone: "head" }),
);
// The store owns the scene's objects and has never known the cast, so a
// character id it cannot check is accepted here and read as detached by the App.
expect(
	"an unknown character id is NOT the store's business to refuse",
	setSceneObjectAttach(aScene, aProp.id, { characterId: "ghost-actor" })[1].attach.characterId === "ghost-actor",
);

expect("an unknown object id is refused", setSceneObjectAttach(aScene, "no-such-object", { characterId: "characterA" }) === aScene);
expect(
	"a malformed attach is refused, leaving the SAME array",
	[
		undefined,
		"characterA",
		7,
		[],
		{},
		{ characterId: "" },
		{ characterId: 5 },
		{ bone: "head" },
		{ characterId: "characterA", bone: "elbow" },
		{ characterId: "characterA", bone: "torso" },
		{ characterId: "characterA", bone: "" },
		{ characterId: "characterA", bone: 3 },
	].every((bad) => setSceneObjectAttach(aScene, aProp.id, bad) === aScene),
);
expect(
	"re-attaching to the very same frame keeps the SAME array, so no history entry is possible",
	setSceneObjectAttach(handed, aProp.id, { characterId: "characterA", bone: "rightHand" }) === handed,
);
expect("detaching an already-detached object keeps the SAME array", setSceneObjectAttach(aScene, aProp.id, null) === aScene);

// Grouping and attachment are alternative parents: a prop follows exactly one
// frame, so each one cancels the other.
const aGrouped = setSceneObjectParent(aScene, aProp.id, aParent.id);
const aFromGroup = setSceneObjectAttach(aGrouped, aProp.id, { characterId: "characterA", bone: "leftHand" });
expect(
	"attaching drops the object out of its group",
	aFromGroup[1].parent === null && aFromGroup[1].attach.bone === "leftHand",
	JSON.stringify({ parent: aFromGroup[1].parent, attach: aFromGroup[1].attach }),
);
const aRegrouped = setSceneObjectParent(aFromGroup, aProp.id, aParent.id);
expect(
	"taking an object parent cancels the attachment",
	aRegrouped[1].parent === aParent.id && aRegrouped[1].attach === null,
	JSON.stringify({ parent: aRegrouped[1].parent, attach: aRegrouped[1].attach }),
);
expect(
	"ungrouping is not detaching — a null parent leaves the attachment alone",
	setSceneObjectParent(handed, aProp.id, null) === handed && handed[1].attach.bone === "rightHand",
);
const aDetached = setSceneObjectAttach(handed, aProp.id, null);
expect(
	"detaching clears only the attachment",
	aDetached[1].attach === null && aDetached[1].parent === null && aDetached !== handed,
);

expect(
	"a world-anchored scene round-trips with attach:null intact",
	(() => {
		const back = loadScene(serializeScene(aScene));
		return back.status === "valid" && JSON.stringify(back.objects) === JSON.stringify(aScene);
	})(),
	JSON.stringify(loadScene(serializeScene(aScene)).objects),
);
expect(
	"a bone attachment survives a serialize/load round trip byte-for-byte",
	(() => {
		const back = loadScene(serializeScene(handed));
		return back.status === "valid" && JSON.stringify(back.objects) === JSON.stringify(handed);
	})(),
	JSON.stringify(loadScene(serializeScene(handed)).objects),
);

// Storage is never trusted: a pin that cannot name a real frame reads as
// detached rather than nailing the prop to somewhere that does not exist.
expect(
	"a malformed stored attach decodes to detached",
	["nope", 7, [], {}, { characterId: "" }, { bone: "head" }, { characterId: "characterA", bone: "elbow" }].every(
		(bad) => normalizeSceneObject({ ...aProp, attach: bad }).attach === null,
	),
);
expect(
	"a stored bone is validated against the track list and stripped to two keys",
	(() => {
		const revived = normalizeSceneObject({ ...aProp, attach: { characterId: "characterA", bone: "rightHand", junk: 1 } });
		return revived.attach.bone === "rightHand" && Object.keys(revived.attach).length === 2;
	})(),
);
expect(
	"a record written before attachment existed reads as world-anchored",
	(() => {
		const { attach, ...old } = aProp;
		return normalizeSceneObject(old).attach === null;
	})(),
);

/* ------------------------------------------------- object colours ---- */
// Issue #88: the palette was six neutrals, so a blockout could not even say
// "the red ball". The chromatics are part of the contract now.
expect(
	"the palette keeps its six neutrals first",
	OBJECT_COLORS.slice(0, 6).join() === ["#e2e5e6", "#c2c6c8", "#9aa1a5", "#767d81", "#d9b18c", "#8fae9b"].join(),
	JSON.stringify(OBJECT_COLORS),
);
expect(
	"the palette offers red, blue, yellow and green for blocking",
	["#d94a4a", "#4a7bd9", "#e2c04a", "#4fa86a"].every((color) => OBJECT_COLORS.includes(color)),
	JSON.stringify(OBJECT_COLORS),
);
expect(
	"every palette entry is a normalized lowercase #rrggbb",
	OBJECT_COLORS.every((color) => normalizeObjectColor(color) === color),
	JSON.stringify(OBJECT_COLORS),
);

// The hex field takes what a human types — shorthand, no hash, upper case —
// and everything else is a typo, not a colour: it must not reach the record.
expect(
	"a hex field accepts #rgb, #rrggbb and bare digits, folded to lowercase #rrggbb",
	normalizeObjectColor("#F36") === "#ff3366" &&
		normalizeObjectColor("#FF3366") === "#ff3366" &&
		normalizeObjectColor("ff3366") === "#ff3366" &&
		normalizeObjectColor("  f36 ") === "#ff3366",
	JSON.stringify([normalizeObjectColor("#F36"), normalizeObjectColor("#FF3366"), normalizeObjectColor("ff3366"), normalizeObjectColor("  f36 ")]),
);
expect(
	"malformed hex reads as no colour at all",
	["zzz", "#12345", "#gggggg", "", "#", "red", null, undefined, 255, {}].every((bad) => normalizeObjectColor(bad) === null),
	JSON.stringify(["zzz", "#12345", "#gggggg", "", "red"].map(normalizeObjectColor)),
);

// Recent colours are a memory of what the author mixed, not a second palette:
// presets stay out of it, the newest is first, and the list never grows.
expect(
	"a remembered colour moves to the front and never duplicates",
	(() => {
		const once = rememberObjectColor([], "#ff3366");
		const twice = rememberObjectColor(rememberObjectColor(once, "#123456"), "#FF3366");
		return once.join() === "#ff3366" && twice.join() === ["#ff3366", "#123456"].join();
	})(),
	JSON.stringify(rememberObjectColor(rememberObjectColor(rememberObjectColor([], "#ff3366"), "#123456"), "#FF3366")),
);
expect(
	"the recent list caps at six, dropping the oldest",
	(() => {
		const hexes = ["#111111", "#222222", "#333333", "#444444", "#555555", "#666666", "#777777"];
		const list = hexes.reduce((acc, hex) => rememberObjectColor(acc, hex), []);
		return list.length === 6 && list[0] === "#777777" && !list.includes("#111111");
	})(),
	JSON.stringify(["#111111", "#222222", "#333333", "#444444", "#555555", "#666666", "#777777"].reduce((acc, hex) => rememberObjectColor(acc, hex), [])),
);
expect(
	"a preset is already on the palette, so it is never remembered twice",
	rememberObjectColor(["#ff3366"], OBJECT_COLORS[0]).join() === "#ff3366" &&
		rememberObjectColor(["#ff3366"], "#D94A4A").join() === "#ff3366",
	JSON.stringify(rememberObjectColor(["#ff3366"], OBJECT_COLORS[0])),
);
expect(
	"malformed input leaves the recent list untouched, by identity",
	(() => {
		const list = ["#ff3366"];
		return rememberObjectColor(list, "zzz") === list && rememberObjectColor(list, null) === list;
	})(),
);
expect(
	"a stored recent list is sanitised, so junk in storage cannot paint a swatch",
	rememberObjectColor(["nope", "#ABCDEF", 7, "#ff3366"], "#010203").join() === ["#010203", "#abcdef", "#ff3366"].join(),
	JSON.stringify(rememberObjectColor(["nope", "#ABCDEF", 7, "#ff3366"], "#010203")),
);

const visibleCube = createSceneObject("cube");
expect("a catalogue object starts visible", visibleCube.hidden === false);
expect("a cutout starts visible", createCutoutObject({ assetId: "pic", aspect: 1, height: 1 }).hidden === false);
expect(
	"a mesh starts visible",
	createMeshObject({ assetId: "mesh-asset-cooker", height: 1, footprint: { width: 1, depth: 1 } }).hidden === false,
);
const hiddenCube = updateSceneObject([visibleCube], visibleCube.id, { hidden: true })[0];
expect("updateSceneObject hides on a boolean true", hiddenCube.hidden === true);
const shownAgain = updateSceneObject([hiddenCube], hiddenCube.id, { hidden: false });
expect("updateSceneObject shows again on false", shownAgain[0].hidden === false);
const ignored = updateSceneObject([visibleCube], visibleCube.id, { hidden: "yes" });
expect("a non-boolean hidden is ignored", ignored[0] === visibleCube);
const normalizedHidden = normalizeSceneObject({ ...visibleCube, hidden: true });
expect("normalize keeps a true hidden flag", normalizedHidden.hidden === true);
const normalizedMissing = normalizeSceneObject({ id: "cube", renderer: "cube", name: "Cube" });
expect("normalize defaults a missing hidden flag to false", normalizedMissing.hidden === false);
const normalizedCutout = normalizeSceneObject({ ...createCutoutObject({ assetId: "pic", aspect: 1, height: 1 }), hidden: true });
expect("normalize keeps hidden on a cutout", normalizedCutout.hidden === true);
const normalizedMesh = normalizeSceneObject({ ...createMeshObject({ assetId: "mesh-asset-cooker", height: 1, footprint: { width: 1, depth: 1 } }), hidden: true });
expect("normalize keeps hidden on a mesh", normalizedMesh.hidden === true);
const duplicate = { ...hiddenCube, id: "cube-2", name: "Cube 2", x: hiddenCube.x + 0.5 };
expect("duplicating a hidden object keeps the flag", duplicate.hidden === true);

const parent = { id: "parent", hidden: true, parent: null };
const child = { id: "child", hidden: false, parent: "parent" };
const grandchild = { id: "grand", hidden: false, parent: "child" };
expect("own hidden is effectively hidden", isEffectivelyHidden(parent, [parent, child]) === true);
expect("a child of a hidden parent is effectively hidden", isEffectivelyHidden(child, [parent, child]) === true);
expect("a grandchild follows the hidden parent", isEffectivelyHidden(grandchild, [parent, child, grandchild]) === true);
const shownParent = { ...parent, hidden: false };
const stillHiddenChild = { ...child, hidden: true };
expect(
	"a child that is itself hidden stays hidden after the parent is shown",
	isEffectivelyHidden(stillHiddenChild, [shownParent, stillHiddenChild]) === true,
);
const hat = { id: "hat", hidden: false, attach: { characterId: "cast-2" } };
expect("a prop on a hidden character is effectively hidden", isEffectivelyHidden(hat, [hat], [{ id: "cast-2", hidden: true }]) === true);
expect("a prop on a visible character stays visible", isEffectivelyHidden(hat, [hat], [{ id: "cast-2", hidden: false }]) === false);
const cargo = { id: "cargo", hidden: false, parent: "hat" };
const hiddenCast = [{ id: "cast-2", hidden: true }];
expect(
	"a child of a prop on a hidden character is effectively hidden",
	isEffectivelyHidden(cargo, [hat, cargo], hiddenCast) === true,
);
expect(
	"a stale display copy still follows the stored hidden flag",
	isEffectivelyHidden({ id: "hat", hidden: false }, [{ ...hat, hidden: true }], []) === true,
);
const loopA = { id: "a", hidden: false, parent: "b" };
const loopB = { id: "b", hidden: false, parent: "a" };
const beforeLoop = JSON.stringify([loopA, loopB]);
expect("a parent cycle ends instead of hanging", isEffectivelyHidden(loopA, [loopA, loopB]) === false);
expect("the visibility walk does not mutate records", JSON.stringify([loopA, loopB]) === beforeLoop);

const hiddenTable = updateSceneObject([createSceneObject("cube")], "cube", { hidden: true })[0];
const falling = { ...createSceneObject("sphere", [hiddenTable]), y: 2 };
const landed = dropToSurfacePatch(falling, [hiddenTable]);
expect("a drop does not land on a hidden table", landed && landed.y === 0, JSON.stringify(landed));
const hiddenChild = { ...createSceneObject("cube", [hiddenTable]), id: "child", parent: hiddenTable.id, y: 1 };
const fallingOnChild = { ...createSceneObject("sphere", [hiddenTable, hiddenChild]), id: "ball", y: 3 };
const landedOnChild = dropToSurfacePatch(fallingOnChild, [hiddenTable, hiddenChild]);
expect("a drop does not land on a child of a hidden parent", landedOnChild && landedOnChild.y === 0, JSON.stringify(landedOnChild));

/* ------------------------------- retired kinds in an old project ---- */
// An old project can still carry a car, a chair or a small plane. Each opens
// as a plain cube with the same transform and the same standing size, so its
// blocking, route and children survive instead of the record vanishing.
const oldCar = { id: "car", name: "Car", renderer: "car", x: 2, y: 0, z: -3, rot: 30, rotX: 0, rotZ: 0, scaleX: 1, scaleY: 1, scaleZ: 2,
	color: "#d98770", parent: null, footprint: { width: 1.8, depth: 4.5 }, height: 1.4 };
const oldChair = { id: "chair", name: "Chair", renderer: "chair", x: -1, z: 1, rot: 90, scale: 2, parent: "car", footprint: { width: 0.6, depth: 0.6 }, height: 1.15, supportY: 0.495 };
const oldPlane = { id: "small-plane", name: "Plane (aircraft)", renderer: "small-plane", x: 5, z: 5 };
const retiredCar = normalizeSceneObject(oldCar);
expect("an old car opens as a cube", retiredCar?.renderer === "cube", JSON.stringify(retiredCar));
expect("the stand-in keeps id, name, colour and transform", retiredCar.id === "car" && retiredCar.name === "Car" && retiredCar.color === "#d98770" && retiredCar.x === 2 && retiredCar.z === -3 && retiredCar.rot === 30);
const carSize = objectSize(retiredCar);
expect("the stand-in keeps the car's size (scale included)", Math.abs(carSize.width - 1.8) < 1e-9 && Math.abs(carSize.depth - 9) < 1e-9 && Math.abs(carSize.height - 1.4) < 1e-9, JSON.stringify(carSize));
const retiredChair = normalizeSceneObject(oldChair);
const chairSize = objectSize(retiredChair);
expect("a single legacy scale still applies to the stand-in", retiredChair.renderer === "cube" && Math.abs(chairSize.width - 1.2) < 1e-9 && Math.abs(chairSize.height - 2.3) < 1e-9, JSON.stringify(chairSize));
expect("the stand-in keeps its parent", retiredChair.parent === "car");
expect("a small plane opens as a cube too", normalizeSceneObject(oldPlane)?.renderer === "cube");
expect("other records pass through retireObjectKind untouched", retireObjectKind(cube) === cube && retireObjectKind(null) === null);
const oldDocument = readSceneDocument(JSON.stringify({ version: 5, activeSceneId: "s1", scenes: [{ id: "s1", name: "Old", objects: [oldCar, oldChair, oldPlane], stage: {} }] }));
const oldObjects = oldDocument.document.scenes[0].objects;
expect("an old scene document keeps all three records", oldDocument.status === "valid" && oldObjects.length === 3, JSON.stringify(oldDocument.status));
expect("the scene reader maps every retired kind to a cube", oldObjects.every((object) => object.renderer === "cube"), JSON.stringify(oldObjects.map((object) => object.renderer)));
const readCarSize = objectSize(oldObjects[0]);
expect("the scene reader keeps the stored size", Math.abs(readCarSize.width - 1.8) < 1e-9 && Math.abs(readCarSize.depth - 9) < 1e-9 && Math.abs(readCarSize.height - 1.4) < 1e-9, JSON.stringify(readCarSize));

// The grouping and attachment sections run after the first gate above, so they
// need their own — otherwise a failure here would print FAIL and still exit 0.
if (failures) process.exit(1);
