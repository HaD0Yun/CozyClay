import { useContext, useEffect, useRef, useSyncExternalStore } from "react";
import Foldout from "./Foldout.jsx";
import { AppContext } from "../app-context.js";
import { ko } from "../locale.js";
import { takeScaleOf } from "../lowvis/studio/figure.js";
import { Vector3Row, Slider } from "../ui.jsx";
import { useCastTransaction } from '../domains/cast.js';
import SampleMotionsPanel from "./SampleMotionsPanel.jsx";

const NONE = () => () => {}, ZERO = () => 0, two = v => Number(v.toFixed(2));
// A take is of one body size: on a body of another scale it plays scaled about the character's place, so what it touches
// no longer meets it. Nothing refits it by itself when the user changes the size here or with the scale knob; the
// motion tool of the agent does (bin/agent/motion-refit.mjs) when the take keeps its spec, else it writes it again.
const sizeHint = (made, scale, kept) => kept
	? ko(`This motion was made for scale ${two(made)}; the body is now ${two(scale)}, so the motion plays scaled and its contacts may be off. Ask the agent to fit the motion to this size.`, `이 모션은 크기 ${two(made)}에 맞춰 만든 거예요. 지금 몸은 ${two(scale)}이라 모션이 비율만 바뀐 채 재생되고 접촉이 어긋날 수 있어요. 에이전트에게 모션을 이 크기에 맞춰 달라고 요청하세요.`, `此动作是按大小 ${two(made)} 制作的；现在身体是 ${two(scale)}，所以动作只是按比例播放，接触可能对不上。请让代理把动作适配到这个大小。`)
	: ko(`This motion was made for scale ${two(made)}; the body is now ${two(scale)}, so the motion plays scaled and its contacts may be off. Ask the agent to make the motion again for this size.`, `이 모션은 크기 ${two(made)}에 맞춰 만든 거예요. 지금 몸은 ${two(scale)}이라 모션이 비율만 바뀐 채 재생되고 접촉이 어긋날 수 있어요. 에이전트에게 이 크기로 모션을 다시 만들어 달라고 요청하세요.`, `此动作是按大小 ${two(made)} 制作的；现在身体是 ${two(scale)}，所以动作只是按比例播放，接触可能对不上。请让代理按这个大小重新制作动作。`);
const sizeToast = kept => kept
	? ko("The motion was made for the old size. Ask the agent to fit it to the new one.", "모션은 이전 크기에 맞춰 만든 거예요. 에이전트에게 새 크기에 맞춰 달라고 요청하세요.", "动作是按原来的大小制作的。请让代理把它适配到新的大小。")
	: ko("The motion was made for the old size. Ask the agent to make it again for the new one.", "모션은 이전 크기에 맞춰 만든 거예요. 에이전트에게 새 크기로 다시 만들어 달라고 요청하세요.", "动作是按原来的大小制作的。请让代理按新的大小重新制作。");

export default function CharacterTransformPanel({ workflowMode, isCharacterSelection, activeChar }) {
	const { run, begin, commit } = useCastTransaction();
	const shown = activeChar;
	// the take the character plays, read from the motion domain and followed as it changes (a refit replaces it)
	const app = useContext(AppContext), motion = app?.storeDomain?.("motion") ?? null;
	useSyncExternalStore(motion?.documentStore?.subscribe ?? NONE, motion?.viewRevision ?? ZERO, motion?.viewRevision ?? ZERO);
	const source = motion?.read?.()?.find(layer => layer.id === activeChar?.id)?.take?.source ?? null;
	const made = takeScaleOf(source, activeChar?.model), scale = activeChar?.scale ?? 1, off = made !== null && Math.abs(made - scale) > 1e-4, kept = Boolean(source?.spec?.lowvis);
	// said once as a toast too when a size change of the selected character makes it so: the panel may be folded or out of sight
	const seen = useRef({ id: null, off: false });
	useEffect(() => {
		const was = seen.current;
		seen.current = { id: activeChar?.id ?? null, off };
		if (off && !was.off && was.id === activeChar?.id) app?.notify?.(sizeToast(kept));
	}, [off, activeChar?.id]); // eslint-disable-line react-hooks/exhaustive-deps
	return (<>
		{off && isCharacterSelection && <p className="inspector-hint" data-fid="motion_size_note">{sizeHint(made, scale, kept)}</p>}
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
						</>
					)}
				</Foldout>
		{/* Motion mode: takes that need no agent, so a character can move on the hosted Studio too. */}
		<SampleMotionsPanel hidden={!isCharacterSelection || workflowMode !== "motion"} activeChar={activeChar} />
	</>);
}
