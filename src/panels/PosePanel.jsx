import Foldout from "./Foldout.jsx";
import { ko } from "../locale.js";
import { PoseTileGrid } from "../posestudio.jsx";
import { DEFAULT_POSE } from "../poses.js";
import { poseLabelKo } from "../app-stage.jsx";
import ReferenceImageField from "./ReferenceImageField.jsx";
import { useBus } from '../app-context.js';

export default function PosePanel({
	isCharacterSelection, activeCharIndex,
	selectablePoses, activeChar, ikMode, ikApplyPoseAsKey, motion,
	setStudioPick, setToast,
}) {
	const { run } = useBus();
	return (
<Foldout hidden={!isCharacterSelection} defaultOpen={false} title={ko("Pose", "포즈")}>
					{/* Tiles, not a dropdown: a pose read out of a photograph has no
					    name worth reading — it is recognisable only as a shape. This
					    is the same grid the studio shows, applied to whichever
					    character the hierarchy has selected. */}
					<p className="inspector-hint v2-details-hint">
						{ko(`The pose on Subject ${activeCharIndex + 1}.`, `인물 ${activeCharIndex + 1}의 자세입니다.`, `角色 ${activeCharIndex + 1} 的姿势。`)}
					</p>
					<PoseTileGrid
						poses={selectablePoses}
						model={activeChar.model}
						selectedId={(activeChar.pose ?? DEFAULT_POSE)?.id}
						onSelect={(id) => {
							const pose = selectablePoses.find((entry) => entry.id === id);
							if (!pose) return;
							// IK mode over a take: the pick is a mid-clip correction, so it
							// keys onto the Full-Body lane instead of erasing the motion.
							if (ikMode && ikApplyPoseAsKey(pose)) return;
							// A running take drives the same bones a pose writes, so the
							// pick would otherwise land invisibly underneath it.
							const hadMotion = Boolean(motion);
							if (!run('character.setPose', { characterId: activeChar.id, pose: pose.id, clearMotion: hadMotion }).ok) return;
							setStudioPick(pose.id);
							setToast(hadMotion
								? ko("Cleared the current motion and applied the pose", "현재 모션을 지우고 포즈를 적용했어요")
								: ko("Pose applied", "포즈를 적용했어요"));
						}}
						labelOf={poseLabelKo}
					/>
					{/* Identity sits beside "Pose from photo" on purpose: both take a
					    picture of a person, but that one reads a SHAPE off it while
					    this one keeps the picture itself as who the character is. */}
					<ReferenceImageField
						label={ko("Identity image", "인물 이미지")}
						hint={ko(
							"A character sheet or photo of this person. It travels with every framing capture so a render keeps the same face, hair and wardrobe.",
							"이 인물의 캐릭터 시트나 사진입니다. 모든 프레이밍 캡처에 함께 실려 얼굴·머리·의상을 유지합니다.",
						)}
						value={activeChar.identityImage ?? null}
						alt={ko("Identity reference", "인물 참고 이미지")}
						inputProps={{ "data-identity-image-input": "" }}
						onPick={(dataUrl) => {
							run('character.update', { characterId: activeChar.id, patch: { identityImage: dataUrl } });
							setToast(ko("Identity image set", "인물 이미지를 설정했어요"));
						}}
						onClear={() => run('character.update', { characterId: activeChar.id, patch: { identityImage: null } })}
					/>
				</Foldout>
	);
}
