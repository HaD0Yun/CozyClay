import Foldout from "./Foldout.jsx";
import { ko } from "../locale.js";
import { NEW_CHARACTER_MODEL, isProxyFigure } from "../scenes.js";
import { FIGURE_LABEL } from "../character-name.js";
import { useBus } from '../app-context.js';
import { isImportedCharacter } from "../character-rig.js";
import ImportedRigPanel from "./ImportedRigPanel.jsx";

// Every new character is the rig figure (the X Bot skeleton, drawn in the Studio's figure look), so an X Bot row has
// nothing to pick here. A Y Bot row from an older project gets one button that changes it to that figure.
export default function RigPanel({ isCharacterSelection, activeChar }) {
	const { run } = useBus();
	if (isProxyFigure(activeChar)) return null;
	if (isImportedCharacter(activeChar)) return <ImportedRigPanel isCharacterSelection={isCharacterSelection} activeChar={activeChar} />;
	if (activeChar.model === NEW_CHARACTER_MODEL) return null;
	return (
<Foldout hidden={!isCharacterSelection} defaultOpen={false} title={ko("Rig", "리그")}>
					<button
						type="button"
						className="btn full"
						data-rig-change={NEW_CHARACTER_MODEL}
						onClick={() => run('character.update', { characterId: activeChar.id, patch: { model: NEW_CHARACTER_MODEL } })}
					>
						{ko(`Change to ${FIGURE_LABEL.toLowerCase()}`, `${FIGURE_LABEL}으로 바꾸기`, `改为${FIGURE_LABEL}`)}
					</button>
				</Foldout>
	);
}
