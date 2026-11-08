import Foldout from "./Foldout.jsx";
import { ko } from "../locale.js";
import { defaultCharacterTint } from "../app-stage.jsx";
import SubjectBox from "./SubjectBox.jsx";
import { useCastTransaction } from '../domains/cast.js';
import { CHARACTER_MODEL_LABELS } from "../stage-startup-defaults.js";

// The body as one letter (X Bot, Y Bot); the full name is the tooltip. A capsule figure shows its glyph only.
const modelLetter = (model) => CHARACTER_MODEL_LABELS[model]?.[0] ?? null;

export default function SubjectsPanel({
	isCharacterSelection, showB, characters, openStudio, posing,
}) {
	const { run, begin, commit, cancel } = useCastTransaction();
	return (
<Foldout hidden={!isCharacterSelection} title={showB ? ko("Subjects", "인물들") : ko("Subject", "인물")}>
						<div className={"subjects-row v2-details-subjects" + (showB ? "" : " single")} onBlur={commit} onPointerUp={commit} onPointerCancel={cancel}>
							{characters.map((entry, index) => entry.hidden ? null : (
								<SubjectBox
									key={entry.id}
									label={ko(`Subject ${index + 1}`, `인물 ${index + 1}`, `角色 ${index + 1}`)}
									model={modelLetter(entry.model)}
									modelTitle={CHARACTER_MODEL_LABELS[entry.model]}
									modelId={entry.model}
									onPose={() => openStudio(entry.id)}
									posing={posing === entry.id}
									onRemove={() => run('character.remove', { characterId: entry.id })}
									color={entry.tint ?? defaultCharacterTint(entry, index)}
									/* A colour picker streams values while it is open, so the
									   whole picking session is one Ctrl+Z entry. */
									onColorEditStart={begin}
									onColorChange={(tint) => run('character.update', { characterId: entry.id, patch: { tint } })}
								/>
							))}
						</div>
						{!showB && (
							<button type="button" className="add-subject" onClick={() => run('cast.showExtras', { show: true })}>
								<span className="as-plus">＋</span>
								<span>{ko("Add second subject", "두 번째 인물 추가")}</span>
							</button>
						)}
					</Foldout>
	);
}
