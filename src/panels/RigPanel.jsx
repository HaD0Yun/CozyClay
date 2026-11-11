import Foldout from "./Foldout.jsx";
import { ko } from "../locale.js";
import { CHARACTER_MODEL_IDS, isProxyFigure } from "../scenes.js";
import { PoseThumbPreview } from "../posestudio.jsx";
import { DEFAULT_POSE } from "../poses.js";
import { CHARACTER_MODEL_LABELS } from "../app-stage.jsx";
import { useBus } from '../app-context.js';
import { isImportedCharacter } from "../character-rig.js";
import ImportedRigPanel from "./ImportedRigPanel.jsx";

export default function RigPanel({ isCharacterSelection, activeChar }) {
	const { run } = useBus();
	if (isProxyFigure(activeChar)) return null;
	if (isImportedCharacter(activeChar)) return <ImportedRigPanel isCharacterSelection={isCharacterSelection} activeChar={activeChar} />;
	return (
<Foldout hidden={!isCharacterSelection} defaultOpen={false} title={ko("Rig", "리그")}>
					{/* The rig is a property of the character, and swapping it is a
					    look decision made while blocking — so it belongs beside the
					    subject, not buried in the project file. */}
					<div className="rig-picker v2-details-rig-picker" role="radiogroup" aria-label={ko("Character rig", "캐릭터 리그")}>
						{CHARACTER_MODEL_IDS.map((id) => (
							<button
								type="button"
								key={id}
								role="radio"
								aria-checked={activeChar.model === id}
								className={"rig-option" + (activeChar.model === id ? " active" : "")}
								data-rig-id={id}
								onClick={() => {
									if (activeChar.model === id) return;
									run('character.update', { characterId: activeChar.id, patch: { model: id } });
								}}
							>
								<PoseThumbPreview model={id} pose={activeChar.pose ?? DEFAULT_POSE} alt={CHARACTER_MODEL_LABELS[id]} />
								<span>{CHARACTER_MODEL_LABELS[id]}</span>
							</button>
						))}
					</div>
				</Foldout>
	);
}
