// The Hierarchy lists what EXISTS in the 3D scene — camera, characters
// (with their rig groups, which have viewport handles), environment, props.
// It is also the Inspector's only router: the sidebar has no tabs, so the
// selected node decides which panels App.jsx shows. Workflow surfaces are
// filed under the node that owns them — the generation prompt under the
// scene, the lens under the camera, and motion (capture, motion3, prompt
// blocks, root path) under the character it animates.
/**
 * One character row's rig subtree, every node id namespaced under the row id
 * (#76): `character:<id>.rig`, `character:<id>.rig.leftArm`…
 * The BONE TOKEN (`rig.leftArm`) stays the shared vocabulary: labels, IK
 * focus routing and attachment naming key off the token, never the full id,
 * so per-character trees can coexist without colliding selections.
 */
const RIG_TEMPLATE = [
	["rig.torso", "Torso", [["rig.hips", "Root / Hips"], ["rig.spine", "Spine"], ["rig.chest", "Chest"], ["rig.neck", "Neck"], ["rig.head", "Head"]]],
	["rig.leftArm", "Left Arm", [["rig.leftShoulder", "Left Shoulder"], ["rig.leftElbow", "Left Elbow"], ["rig.leftHand", "Left Hand"]]],
	["rig.rightArm", "Right Arm", [["rig.rightShoulder", "Right Shoulder"], ["rig.rightElbow", "Right Elbow"], ["rig.rightHand", "Right Hand"]]],
	["rig.leftLeg", "Left Leg", [["rig.leftKnee", "Left Knee"], ["rig.leftFoot", "Left Foot"]]],
	["rig.rightLeg", "Right Leg", [["rig.rightKnee", "Right Knee"], ["rig.rightFoot", "Right Foot"]]],
];

export function rigSubtree(rowId) {
	return {
		id: `${rowId}.rig`,
		label: "Rig",
		kind: "rig",
		children: RIG_TEMPLATE.map(([token, label, bones]) => ({
			id: `${rowId}.${token}`,
			label,
			kind: "rig",
			children: bones.map(([boneToken, boneLabel]) => ({ id: `${rowId}.${boneToken}`, label: boneLabel, kind: "bone" })),
		})),
	};
}

/** `character:cast-2.rig.leftArm` → { rowId: "character:cast-2", token: "rig.leftArm" };
 * anything that is not a namespaced rig node id returns null. */
export function parseRigNodeId(id) {
	if (typeof id !== "string") return null;
	const match = id.match(/^(character:[^.]+)\.(rig(?:\.[A-Za-z]+)?)$/);
	return match ? { rowId: match[1], token: match[2] } : null;
}

// A member's punctuation cannot become a rig namespace separator.
export const characterRowId = id => typeof id === "string" && id ? `character:${encodeURIComponent(id).replaceAll(".", "%2E")}` : null;

export function characterIdFromHierarchyId(id) {
	const row = parseRigNodeId(id)?.rowId ?? id;
	return typeof row === "string" && row.startsWith("character:") ? decodeURIComponent(row.slice(10)) : null;
}

/** True only when the row or its rig belongs to a member of this cast. */
export function characterRowExists(id, characters = []) {
	const characterId = characterIdFromHierarchyId(id);
	return characters.some(entry => entry.id === characterId);
}

export const HIERARCHY_NODES = [
	{
		// Keep the legacy selection id until App wiring moves to the document
		// model; its visible role is a Scene, never an editorial Shot.
		id: "shot",
		label: "SCENE 01",
		kind: "scene",
		children: [
			{ id: "camera", label: "Camera", kind: "camera" },
			{ id: "light", label: "Light", kind: "light" },
			{
				id: "characters",
				label: "Characters",
				kind: "group",
				children: [],
			},
			{ id: "environment", label: "Environment", kind: "environment" },
			{ id: "props", label: "Props", kind: "props" },
		],
	},
];

/**
 * A rig track id ("rightHand", "hips") as a row-readable English label —
 * "Right Hand", "Hips". Attachment labels are built from the SAME track ids
 * the store writes, so a new bone key needs no table entry here.
 * Localization happens in the panel, not in the model.
 */
export function attachBoneLabel(bone) {
	if (typeof bone !== "string") return null;
	const key = bone.trim();
	if (!key) return null;
	return key
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.replace(/[_-]+/g, " ")
		.split(" ")
		.filter(Boolean)
		.map((word) => word[0].toUpperCase() + word.slice(1))
		.join(" ");
}

/** Every cast member as `characterId → row id`, including hidden ones.
 *  A prop attached to a hidden character stays under that row. An unknown
 *  characterId still has no row and falls back to Props. */
function characterRows(characters) {
	const rows = new Map();
	if (!Array.isArray(characters)) return rows;
	characters.forEach((entry) => {
		if (!entry || typeof entry.id !== "string") return;
		rows.set(entry.id, characterRowId(entry.id));
	});
	return rows;
}

function objectRow(object, label) {
	return {
		id: `object:${object.id}`,
		label,
		kind: "object",
		hidden: object.hidden === true,
		// The record's kind, so a row can say it is a node with nothing to draw.
		...(object.renderer === "empty" || object.renderer === "light" ? { renderer: object.renderer } : {}),
	};
}

export function buildHierarchyNodes(sceneObjects = [], characters = []) {
	// An attached prop is carried BY a character, so it reads under that
	// character rather than in the flat Props list it no longer follows.
	const characterRowsById = characterRows(characters);
	const attachedRows = new Map(); // character row id → attached object rows
	const attachedIds = new Set();
	for (const object of sceneObjects) {
		const attach = object?.attach;
		if (!attach || typeof attach !== "object") continue;
		const rowId = characterRowsById.get(attach.characterId);
		// A dangling characterId keeps the object in Props: a prop that
		// vanishes from the tree is worse than one filed in the wrong place.
		// A hidden character still has a row, so the prop stays under it.
		if (!rowId) continue;
		attachedIds.add(object.id);
		const boneLabel = attachBoneLabel(attach.bone);
		const row = objectRow(object, boneLabel ? `${object.name} · ${boneLabel}` : object.name);
		if (attachedRows.has(rowId)) attachedRows.get(rowId).push(row);
		else attachedRows.set(rowId, [row]);
	}
	// Attaching clears `parent` in the store; the model clears it again so a
	// stale record cannot hide a group's children behind an attached row.
	const listed = sceneObjects.filter((object) => !attachedIds.has(object.id));

	// One row per cast member, built once: a character grouped under a listed
	// object reads under that object's row (it rides the object), every other
	// one stays in the cast. A parent that is missing or carried leaves the
	// character in the cast, as an orphaned prop stays at the top of Props.
	const listedIds = new Set(listed.map((object) => object.id));
	const castRows = [];
	const groupedCharacters = new Map(); // object id → character rows
	if (Array.isArray(characters)) {
		characters.forEach((entry, listIndex) => {
			if (!entry) return;
			const id = characterRowId(entry.id);
			// Every cast member carries its own rig subtree (#78) — ids are
			// namespaced per row (#76) and IK state is per character (#77), so
			// the tree no longer needs the primary-only gate. Carried props
			// follow the rig so the body reads first and the luggage after it.
			const children = [
				...(entry.model === "proxy-figure" ? [] : [rigSubtree(id)]),
				...(attachedRows.get(id) ?? []),
			];
			const parent = typeof entry.parent === "string" && listedIds.has(entry.parent) ? entry.parent : null;
			const row = {
				id,
				label: `Character ${listIndex + 1}`,
				kind: "character",
				hidden: entry.hidden === true,
				...(parent ? { grouped: true } : {}),
				...(children.length ? { children } : {}),
			};
			if (!parent) castRows.push(row);
			else if (groupedCharacters.has(parent)) groupedCharacters.get(parent).push(row);
			else groupedCharacters.set(parent, [row]);
		});
	}
	// An object row's children: the parts grouped under it, then the cast
	// members riding it.
	const withRiders = (row, objectId, nested) => {
		const children = [...nested, ...(groupedCharacters.get(objectId) ?? [])];
		if (children.length) row.children = children;
		return row;
	};

	const clone = (node) => {
		const next = { ...node };
		if (node.id === "props") {
			// Grouped props nest under their parent, so a rocket built from ten
			// primitives reads as one thing in the tree instead of ten siblings.
			const childrenOf = (parentId) =>
				listed
					.filter((object) => (object.parent ?? null) === parentId)
					.map((object) => withRiders(objectRow(object, object.name), object.id, childrenOf(object.id)));
			// An object whose parent is missing still has to appear somewhere, so
			// anything unreachable from the top level is shown at the top level.
			// An attached object is not a grouping parent, so its children are
			// unreachable from the top level and surface there, as orphans do.
			const ids = new Set(listed.map((object) => object.id));
			const rooted = listed.filter(
				(object) => (object.parent ?? null) === null || !ids.has(object.parent),
			);
			next.children = rooted.map((object) => withRiders(objectRow(object, object.name), object.id, childrenOf(object.id)));
		} else if (node.children) {
			next.children = node.children.map(clone);
		}
		return next;
	};
	const nodes = HIERARCHY_NODES.map(clone);
	// Hidden members and visible members keep the same stable identity.
	if (Array.isArray(characters)) {
		const group = nodes[0]?.children?.find((node) => node.id === "characters");
		if (group) group.children = castRows;
	}
	return nodes;
}
