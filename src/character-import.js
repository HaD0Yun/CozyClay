// Import a character file (a .glb or an .fbx with a skeleton) as a cast member that plays takes on its own bones.
// The skeleton is read from the parsed three.js scene (rigs/read-skeleton.js) and adapted (rigs/adapt.js); only then do
// the bytes go to the asset store, as an imported prop's do (scene-mesh.js importMeshFile, putAsset). The entry keeps
// the rig and the adapter's report (character-rig.js). A file the player could not drive is refused with a sentence for
// a toast, and is not stored: no bones, two bones of one name, a node that is not a bone between two bones, or a joint
// with a scale. three's FBXLoader nests a copy of each bone that two skinned meshes share under the bone, with its name
// and an identity transform: that copy is not a joint (sharedBoneCopy), so the copy follows the bone it sits under.
import { importMeshFile } from "./scene-mesh.js";
import { openAssetDb, putAsset } from "./scene-assets.js";
import { loadMeshScene } from "./scene-mesh-cache.js";
import { readThreeSkeleton } from "./motion3/rigs/read-skeleton.js";
import { adaptRig } from "./motion3/rigs/adapt.js";
import { importedModelId, registerCastRigs } from "./character-rig.js";
import { nextCharacterId } from "./stage-startup-defaults.js";
import { ko } from "./locale.js";

const refuse = message => { throw Object.assign(new Error(message), { code: "INVALID_ARGUMENT" }); };
const IDENTITY = 1e-9;

/** A bone under a bone of its own name, at the parent's place and turn (FBXLoader's copy for a second skinned mesh). */
const sharedBoneCopy = o => o.parent?.isBone && o.parent.name === o.name && o.position.lengthSq() < IDENTITY
	&& Math.abs(Math.abs(o.quaternion.w) - 1) < IDENTITY;

/** The character fields of the skeleton in a parsed scene: { model, adaptedRig, rigImport } (character-rig.js). */
export function adaptCharacterScene(scene, { assetId, name = "", template = null }) {
	const bones = [];
	scene.traverse(o => { if (o.isBone && !sharedBoneCopy(o)) bones.push(o); });
	if (!bones.length) refuse("That file has no skeleton: import it as a prop instead");
	const read = readThreeSkeleton(scene, { bones }), names = new Set(read.sources);
	if (names.size !== read.sources.length) refuse("That skeleton has two bones with the same name");
	read.raw.bones.forEach((b, i) => {
		if (b.parent >= 0 && bones[i].parent !== bones[b.parent]) refuse(`The bone ${read.sources[i]} hangs under a node that is not a bone`);
	});
	// the player writes the file's own rotations and offsets and never a joint's scale, so a scaled joint would draw off size
	if (read.scaled.length) refuse(`The bone ${read.scaled[0]} has a scale: apply the scale in the modelling tool and export again`);
	const model = importedModelId(assetId, template);
	let adapted;
	try {
		adapted = adaptRig({ ...read.raw, model }, template ? { template } : {});
	} catch (error) {
		refuse(`That skeleton cannot be driven: ${error.message}`);
	}
	return { model, adaptedRig: adapted.rig, rigImport: { assetId, name, template: template ?? null, raw: read.raw, sources: read.sources,
		report: adapted.report, unitsDetected: read.unitsDetected } };
}

/** Reads the file's skeleton, then stores the file (a refused file is not stored): the new character's fields, its rig registered. */
async function importCharacterFile(file) {
	const { asset } = await importMeshFile(file);
	const scene = await loadMeshScene(asset.id, asset);
	if (!scene) refuse("That model could not be read");
	const fields = adaptCharacterScene(scene, { assetId: asset.id, name: String(asset.name ?? "").replace(/\.[^.]+$/, "") });
	const db = await openAssetDb();
	try {
		await putAsset(db, asset);
	} finally {
		db.close?.();
	}
	registerCastRigs([fields]);
	return fields;
}

/** The same character adapted with a template the user forced (null: detected again), its rig registered. */
export async function readaptCharacter(entry, template) {
	const scene = await loadMeshScene(entry.rigImport.assetId);
	if (!scene) refuse("The character's file is no longer stored");
	const fields = adaptCharacterScene(scene, { assetId: entry.rigImport.assetId, name: entry.rigImport.name, template });
	registerCastRigs([fields]);
	return fields;
}

/**
 * The Add menu's "Import character": stores and adapts `file`, then adds it to the cast in one undoable step
 * (cast.replace through the cast domain, as spawnCharacter's character.add) and selects it. Errors become a notice.
 * Returns the new character's id, or null.
 */
export async function addImportedCharacter(appContext, file, x = 0) {
	try {
		const fields = await importCharacterFile(file), cast = appContext.storeDomain("cast"), rows = cast.read(), id = nextCharacterId(rows);
		cast.run("cast.replace", { characters: [...rows, { id, x, z: 0, subject: fields.rigImport.name || "a person", ...fields }] });
		appContext.shared?.setSelectedHierarchyId?.(`character:${id}`);
		const { detected, missing } = fields.rigImport.report;
		appContext.notify?.(ko(`Character imported: ${detected.id} skeleton${missing.length ? `, ${missing.length} bones estimated` : ""}`,
			`캐릭터를 가져왔어요: ${detected.id} 스켈레톤${missing.length ? `, 뼈 ${missing.length}개 추정` : ""}`,
			`已导入角色：${detected.id} 骨骼${missing.length ? `，估算了 ${missing.length} 根骨骼` : ""}`));
		return id;
	} catch (error) {
		console.warn("[cozyclay] character import failed", error);
		appContext.notify?.(ko(`Could not import that character: ${error.message}`, `캐릭터를 가져오지 못했어요: ${error.message}`, `无法导入该角色：${error.message}`));
		return null;
	}
}
