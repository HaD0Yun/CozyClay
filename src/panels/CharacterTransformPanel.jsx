import Foldout from "./Foldout.jsx";
import { ko } from "../locale.js";
import { Vector3Row, Slider } from "../ui.jsx";
import { useCastTransaction } from '../domains/cast.js';
import { useContext } from "react";
import { AppContext } from "../app-context.js";
import { shotAtFrame } from "../cuts.js";
import SampleMotionsPanel from "./SampleMotionsPanel.jsx";

export default function CharacterTransformPanel({ workflowMode, isCharacterSelection, activeChar }) {
	const { run, begin, commit } = useCastTransaction();
	const app = useContext(AppContext);
	const live = app?.ports.read?.();
	const still = live ? shotAtFrame(live.shots, live.view.frame) : null;
	const shown = live?.targets?.get?.(activeChar.id)?.motion || activeChar.layer?.waypoints?.length
		? activeChar : { ...activeChar, ...(still?.cast?.[activeChar.id] ?? {}) };
	return (<>
<Foldout
					key={workflowMode === "motion" ? "placement" : "transform"}
					hidden={!isCharacterSelection}
					defaultOpen={workflowMode === "motion"}
					title={workflowMode === "motion" ? ko("Placement", "배치") : ko("Transform", "변환")}
				>
					{workflowMode === "motion" ? (
						<div className="placement-fields v2-details-panel">
							<p className="inspector-hint">
								{ko("Stage position — does not change the take", "무대 위치 — 테이크는 바꾸지 않습니다")}
							</p>
							<Vector3Row
								label={ko("Position", "위치")}
								fields={[
									{ axis: "X", value: shown.x, step: 0.05, precision: 2, scrubRange: 5, onChange: (x) => run('character.update', { characterId: activeChar.id, patch: { x } }), onScrubStart: begin, onScrubEnd: commit },
									{ axis: "Z", value: shown.z, step: 0.05, precision: 2, scrubRange: 5, onChange: (z) => run('character.update', { characterId: activeChar.id, patch: { z } }), onScrubStart: begin, onScrubEnd: commit },
								]}
							/>
							<Slider compact label={ko("Rotation", "회전")} min={-180} max={180} step={1} value={shown.rot ?? 0} unit="°" onChange={(rot) => run('character.update', { characterId: activeChar.id, patch: { rot } })} />
							{still?.kind === "still" && (
								<button type="button" className="secondary-button" onClick={() => run("shot.setCastOverride", { shotId: still.id, characterId: activeChar.id, override: null })}>
									{ko("Use stage placement", "무대 배치 사용")}
								</button>
							)}
						</div>
					) : (
						<>
							<p className="inspector-hint">
								{ko("Edit the selected subject's placement, turn and size. Drag the Transform tool in the viewport for direct manipulation.", "선택한 인물의 위치·회전·크기를 편집합니다. 뷰포트의 변환 도구를 드래그해 바로 조작할 수도 있어요.")}
							</p>
							<Vector3Row
								label={ko("Position", "위치")}
								fields={[
									{ axis: "X", value: shown.x, step: 0.05, precision: 2, scrubRange: 5, onChange: (x) => run('character.update', { characterId: activeChar.id, patch: { x } }), onScrubStart: begin, onScrubEnd: commit },
									{ axis: "Y", value: activeChar.y ?? 0, step: 0.05, precision: 2, scrubRange: 5, onChange: (y) => run('character.update', { characterId: activeChar.id, patch: { y } }), onScrubStart: begin, onScrubEnd: commit },
									{ axis: "Z", value: shown.z, step: 0.05, precision: 2, scrubRange: 5, onChange: (z) => run('character.update', { characterId: activeChar.id, patch: { z } }), onScrubStart: begin, onScrubEnd: commit },
								]}
							/>
							<Slider compact label={ko("Rotation", "회전")} min={-180} max={180} step={1} value={shown.rot ?? 0} unit="°" onChange={(rot) => run('character.update', { characterId: activeChar.id, patch: { rot } })} />
							<Slider compact label={ko("Scale", "크기")} min={0.2} max={3} step={0.05} value={activeChar.scale ?? 1} unit="×" onChange={(scale) => run('character.update', { characterId: activeChar.id, patch: { scale } })} />
							{still?.kind === "still" && (
								<button type="button" className="secondary-button" onClick={() => run("shot.setCastOverride", { shotId: still.id, characterId: activeChar.id, override: null })}>
									{ko("Use stage placement", "무대 배치 사용")}
								</button>
							)}
						</>
					)}
				</Foldout>
		{/* Motion mode: takes that need no agent, so a character can move on the hosted Studio too. */}
		<SampleMotionsPanel hidden={!isCharacterSelection || workflowMode !== "motion"} activeChar={activeChar} />
	</>);
}
