import { useStudioShell } from "./studio-shell-context.js";
import { ko } from "../locale.js";
import HierarchyPanel from "../hierarchy-panel.jsx";

export default function OutlinerSlot() {
	const {
		selectedHierarchyId, selectHierarchy,
		aimEditorAtKeyLight, characters,
		ikMode, rowIdForCharIndex, activeCharIndex, sceneObjects,
		scenes, activeSceneId, selectSceneDocument, createSceneDocumentFromUi, duplicateSceneDocumentFromUi,
		renameSceneDocumentFromUi, deleteSceneDocumentFromUi, addSceneObject, renameSceneObject, runStudioAction,
		deleteSceneObject, frameSelection, groupObjectUnderNewEmpty, renameRequest, toggleHierarchyHidden, propsDrop, hierarchyReparent,
		agentTouchedRows,
	} = useStudioShell();
	return (
		<aside className="panel hierarchy-left" aria-label={ko("Hierarchy", "계층")}>
		{/* 2a: no project row here — the project name and its unsaved dot
		    live in the top bar's project menu. */}
		<HierarchyPanel
			selectedId={selectedHierarchyId}
			onSelect={(id) => {
				selectHierarchy(id);
				if (id === "light") aimEditorAtKeyLight();
			}}
			characters={characters}
			ikMode={ikMode}
			ikRowId={rowIdForCharIndex(activeCharIndex)}
			sceneObjects={sceneObjects}
			scenes={scenes}
			activeSceneId={activeSceneId}
			onSceneSelect={selectSceneDocument}
			onSceneCreate={createSceneDocumentFromUi}
			onSceneDuplicate={duplicateSceneDocumentFromUi}
			onSceneRename={renameSceneDocumentFromUi}
			onSceneDelete={deleteSceneDocumentFromUi}
			onAddObject={addSceneObject}
			onRenameObject={renameSceneObject}
			onDuplicateObject={(objectId) => runStudioAction("object.duplicate", objectId ? { objectId } : {})}
			onDeleteObject={deleteSceneObject}
			onFrameObject={frameSelection}
			onGroupObject={groupObjectUnderNewEmpty}
			renameRequest={renameRequest}
			onToggleHidden={toggleHierarchyHidden}
			propsDrop={propsDrop}
			reparent={hierarchyReparent}
			touchedIds={agentTouchedRows}
		/>
		</aside>
	);
}
