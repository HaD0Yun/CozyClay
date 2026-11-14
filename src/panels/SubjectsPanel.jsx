import Foldout from "./Foldout.jsx";
import { ko } from "../locale.js";
import { defaultCharacterTint } from "../app-stage.jsx";
import SubjectBox from "./SubjectBox.jsx";
import { useCastTransaction } from '../domains/cast.js';
import { CHARACTER_MODEL_LABELS } from "../stage-startup-defaults.js";
import { DEFAULT_POSE } from "../poses.js";

// The body as one letter (X Bot, Y Bot); the full name is the tooltip. A capsule figure shows its glyph only.
const modelLetter = (model) => CHARACTER_MODEL_LABELS[model]?.[0] ?? null;

export default function SubjectsPanel({
	isCharacterSelection, characters, openStudio, posing,
}) {
	const { run, begin, commit, cancel } = useCastTransaction();
	const multiple = characters.filter(entry => !entry.hidden).length > 1;
	return (
<Foldout hidden={!isCharacterSelection} title={ko("Character", "인물", "角色")}>
						<div className={"subjects-row v2-details-subjects" + (multiple ? "" : " single")} onBlur={commit} onPointerUp={commit} onPointerCancel={cancel}>
							{characters.map((entry, index) => entry.hidden ? null : (
								<SubjectBox
									key={entry.id}
									label={ko(`Character ${index + 1}`, `인물 ${index + 1}`, `角色 ${index + 1}`)}
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
							<button type="button" className="add-subject" onClick={() => run('character.add', { character: { x: characters.length * 1.15, z: characters.length ? 0.1 : 0, rot: characters.length ? -14 : 0, pose: DEFAULT_POSE } })}>
								<span className="as-plus">＋</span>
								<span>{ko("Add character", "인물 추가", "添加角色")}</span>
							</button>
					</Foldout>
	);
}
