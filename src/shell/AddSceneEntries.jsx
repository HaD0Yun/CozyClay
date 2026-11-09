// The "Scene" group of every Add menu: the casting characters in the project's
// cast-style order, then a shot Camera. The viewport's + Add and the Outliner's
// right-click menu both render it after the object catalogue, so either menu
// offers everything the Assets tab can place. Outside the Studio shell (no
// context) it renders nothing.
import { useStudioShell } from "./studio-shell-context.js";
import { ko } from "../locale.js";
import { elementByPath } from "../studio-elements.js";
import { addCameraShot } from "./add-camera-shot.js";
import { addCharacterEntries } from "./add-character-entries.js";
import { addImportedCharacter } from "../character-import.js";

const CHARACTER_BOUNDS = elementByPath("character.position").gizmo;
const characterSpawnX = (count) => Math.min(CHARACTER_BOUNDS.max.x, Math.max(CHARACTER_BOUNDS.min.x, count));

export default function AddSceneEntries({ onDone }) {
	const shell = useStudioShell();
	if (!shell) return null;
	const { spawnCharacter, characters, castStyle, appContext, runStudioAction, setToast } = shell;
	return (
		<div className="add-object-group">
			<span className="add-object-heading">{ko("Scene", "장면")}</span>
			{addCharacterEntries(castStyle).map((entry) => (
				<button key={entry.add} type="button" role="menuitem" className="add-object-item" data-add={entry.add}
					onClick={() => { spawnCharacter(entry.model, characterSpawnX(characters.length), 0); onDone?.(); }}
				>
					<span className="add-object-swatch vp-add-swatch-cast" aria-hidden="true" />
					<span>{entry.label()}</span>
				</button>
			))}
			{/* A character file of the user's own (.glb or .fbx with a skeleton): it plays takes on its own bones. */}
			<label role="menuitem" className="add-object-item" data-add="import-character">
				<input type="file" accept=".glb,.fbx,model/gltf-binary" hidden data-import-character
					onChange={(event) => {
						const file = event.target.files?.[0];
						event.target.value = "";
						onDone?.();
						if (file) void addImportedCharacter(appContext, file, characterSpawnX(characters.length));
					}}
				/>
				<span className="add-object-swatch vp-add-swatch-cast" aria-hidden="true" />
				<span>{ko("Import character…", "캐릭터 가져오기…", "导入角色…")}</span>
			</label>
			<button type="button" role="menuitem" className="add-object-item" data-add="camera"
				onClick={() => { addCameraShot({ appContext, runStudioAction, setToast }); onDone?.(); }}
			>
				<span className="add-object-swatch vp-add-swatch-camera" aria-hidden="true" />
				<span>{ko("Camera", "카메라")}</span>
			</button>
		</div>
	);
}
