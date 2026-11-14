// The Details panel's selection header: the selected item's name and its
// "Kind · detail" type line.
import { ko } from "../locale.js";
import { sceneObjectNameDisplayKo, HIERARCHY_INSPECTOR_TITLES, CHARACTER_MODEL_LABELS } from "../app-stage.jsx";
import { CUTOUT_KIND, EMPTY_KIND, SCULPT_KIND } from "../scene-objects.js";
import { TEXT_KIND } from "../text/text-record.js";
import { LIGHT_KIND } from "../object-look.js";
import { characterIdFromHierarchyId } from "../hierarchy-model.js";

const characterIndexForRow = (rowId, characters) => characters.findIndex(entry => entry.id === characterIdFromHierarchyId(rowId));
const characterTitle = (index) => ko(`Character ${index + 1}`, `인물 ${index + 1}`, `角色 ${index + 1}`);

/** The 2a selection header: the selected item's name and a "Kind · detail"
 * type line. Null when nothing that owns settings is selected. */
export function detailsSelection({ selectedHierarchyId: id, selectedSceneObject, rigSelection, characters, shot, inspectorHasContent }) {
	if (!inspectorHasContent) return null;
	if (selectedSceneObject) {
		const { renderer, light } = selectedSceneObject;
		if (renderer === LIGHT_KIND) return { name: sceneObjectNameDisplayKo(selectedSceneObject.name), type: `${ko("Light", "조명")} · ${light?.type === "spot" ? ko("Spot", "스포트") : ko("Point", "점")}` };
		const kind = renderer === CUTOUT_KIND ? ko("Cutout", "컷아웃") : renderer === EMPTY_KIND ? ko("Empty", "빈 오브젝트") : renderer === SCULPT_KIND ? ko("Sculpt", "조형") : renderer === TEXT_KIND ? ko("Text", "텍스트") : ko("Mesh", "메시");
		return { name: sceneObjectNameDisplayKo(selectedSceneObject.name), type: renderer === EMPTY_KIND ? kind : `${ko("Prop", "소품")} · ${kind}` };
	}
	if (rigSelection) {
		const index = characterIndexForRow(rigSelection.rowId, characters);
		const kind = rigSelection.token === "rig" ? ko("Rig", "리그") : ko("Bone", "본");
		return { name: HIERARCHY_INSPECTOR_TITLES[rigSelection.token] ?? kind, type: index >= 0 ? `${kind} · ${characterTitle(index)}` : kind };
	}
	if (id === "camera") return { name: HIERARCHY_INSPECTOR_TITLES.camera, type: `${ko("Camera", "카메라")} · ${shot.focalMm}mm` };
	if (id.startsWith("character:")) {
		const index = characterIndexForRow(id, characters);
		const model = CHARACTER_MODEL_LABELS[characters[index]?.model];
		return { name: characterTitle(Math.max(index, 0)), type: model ? `${ko("Character", "인물")} · ${model}` : ko("Character", "인물") };
	}
	const types = {
		shot: ko("Scene", "장면"),
		light: ko("Light", "조명"),
		characters: ko("Folder", "폴더"),
		environment: ko("Environment", "환경"),
		props: ko("Folder", "폴더"),
	};
	return { name: HIERARCHY_INSPECTOR_TITLES[id] ?? ko("Selection", "선택 항목"), type: types[id] ?? "" };
}
