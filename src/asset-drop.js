// Where a Content tile lands: one spawner per payload kind, the same table for
// the drag onto the stage (App's floor raycast) and the double-click placement
// at the origin (LibrarySlot). Characters keep their tighter stage clamp (the
// rig walks, a prop does not); objects, cutouts, meshes and sculpts take the
// ROOM_LIMIT clamp their creators already apply.
import { elementByPath } from "./studio-elements.js";
import { NEW_CHARACTER_MODEL } from "./scenes.js";

const CHARACTER_BOUNDS = elementByPath("character.position").gizmo;
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

const DROPS = {
	character: (payload, at, spawn) => spawn.spawnCharacter(payload.id ?? NEW_CHARACTER_MODEL,
		clamp(at.x, CHARACTER_BOUNDS.min.x, CHARACTER_BOUNDS.max.x),
		clamp(at.z, CHARACTER_BOUNDS.min.z, CHARACTER_BOUNDS.max.z)),
	object: (payload, at, spawn) => spawn.addSceneObject(payload.objectKind, at),
	image: (payload, at, spawn) => spawn.spawnCutoutAt(payload.assetId, at),
	mesh: (payload, at, spawn) => spawn.spawnMeshAt(payload.assetId, at),
	// A shelf card carries its recipe: object.sculpt makes it through
	// createSculptObject as one undo step, and the new sculpt is selected.
	sculpt: (payload, at, spawn) => {
		const receipt = spawn.runStudioAction("object.sculpt", { recipe: payload.recipe, ...(payload.name ? { name: payload.name } : {}), placement: at });
		const id = receipt?.affectedIds?.[0];
		if (id) spawn.select?.(`object:${id}`);
		return receipt;
	},
};

/**
 * Spawn `payload` at the floor point `hit` ({ x, z }; y is ignored). `spawn`
 * names the creators: spawnCharacter, addSceneObject, spawnCutoutAt,
 * spawnMeshAt, runStudioAction and select. An unknown kind does nothing and
 * answers false.
 */
export function dropAssetAt(payload, hit, spawn) {
	const drop = DROPS[payload?.kind];
	if (!drop) return false;
	drop(payload, { x: hit.x, z: hit.z }, spawn);
	return true;
}
