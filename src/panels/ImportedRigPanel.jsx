// The Rig panel of an imported character (character-import.js): what the skeleton adapter found, so a user can see a
// wrong guess and fix it. It shows the detected naming convention and its score, the bones the adapter had to make
// up, an estimated floor, the units and any scaled bones, and offers to force a convention. The file is adapted again
// and the new rig gets its own model id; the character's take was compiled on the old rig, which a reopened project no
// longer registers, so it is cleared (one more undo step) and the user compiles again.
import { useState } from "react";
import Foldout from "./Foldout.jsx";
import { ko } from "../locale.js";
import { useBus } from "../app-context.js";
import { RIG_TEMPLATE_IDS } from "../character-rig.js";
import { readaptCharacter } from "../character-import.js";

export default function ImportedRigPanel({ isCharacterSelection, activeChar }) {
	const { run } = useBus();
	const [error, setError] = useState(null);
	const { report, template, raw, unitsDetected, scaled = [], name } = activeChar.rigImport;
	const force = async (value) => {
		setError(null);
		try {
			const fields = await readaptCharacter(activeChar, value || null);
			run("character.update", { characterId: activeChar.id, patch: fields });
			run("motion.clear", { characterId: activeChar.id });
		} catch (failure) {
			setError(failure.message);
		}
	};
	return (
		<Foldout hidden={!isCharacterSelection} title={ko("Rig", "리그", "骨骼")}>
			<div className="imported-rig-report" data-rig-report={activeChar.model}>
				<p className="inspector-hint" data-rig-detected={report.detected.id}>
					{ko("Imported skeleton", "가져온 스켈레톤", "导入的骨骼")}{name ? ` ${name}` : ""}: {report.template}
					{template ? ` (${ko("forced", "직접 지정", "手动指定")})` : ` (${ko("detected", "자동 감지", "自动识别")}, ${Math.round(report.detected.score * 100)}%)`}
				</p>
				<p className="inspector-hint" data-rig-missing={report.missing.length}>
					{report.missing.length
						? `${ko("Bones estimated (not in the file)", "추정한 뼈 (파일에 없음)", "估算的骨骼（文件中没有）")}: ${report.missing.join(", ")}`
						: ko("Every body bone was found in the file.", "몸의 뼈를 모두 파일에서 찾았어요.", "文件中找到了全部身体骨骼。")}
				</p>
				<p className="inspector-hint" data-rig-grounded={report.grounded}>
					{report.grounded === "estimated"
						? ko("Floor estimated: the ankles are not near the file's floor, so the feet were placed from the body's height.",
							"바닥을 추정했어요: 발목이 파일의 바닥 근처에 없어 키로 발 높이를 정했어요.", "地面为估算：脚踝不在文件地面附近，因此按身高放置了双脚。")
						: ko("Floor read from the file.", "바닥은 파일에서 읽었어요.", "地面取自文件。")}
				</p>
				<p className="inspector-hint" data-rig-units={raw.units}>
					{`${ko("Units", "단위", "单位")}: ${raw.units}${unitsDetected ? ` (${ko("detected", "자동 감지", "自动识别")})` : ""}`}
					{scaled.length ? ` · ${ko("scaled bones are read at scale 1", "크기가 바뀐 뼈는 1배로 읽어요", "缩放的骨骼按 1 倍读取")}: ${scaled.join(", ")}` : ""}
				</p>
				<label className="inspector-hint">
					{ko("Naming convention", "이름 규칙", "命名规则")}{" "}
					<select data-rig-template value={template ?? ""} onChange={(event) => void force(event.target.value)}>
						<option value="">{ko("Detect", "자동 감지", "自动识别")}</option>
						{RIG_TEMPLATE_IDS.map((id) => <option key={id} value={id}>{id}</option>)}
					</select>
				</label>
				<p className="inspector-hint">{ko("Changing it clears the character's take: compile the motion again.", "바꾸면 인물의 테이크가 지워져요: 모션을 다시 컴파일하세요.", "更改后会清除角色的动作片段：请重新编译动作。")}</p>
				{error && <p className="inspector-hint" role="alert">{error}</p>}
			</div>
		</Foldout>
	);
}
