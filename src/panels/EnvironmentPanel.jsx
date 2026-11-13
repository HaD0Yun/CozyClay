import { ko } from "../locale.js";
import { useStageTransaction } from "../domains/stage.js";
import Foldout from "./Foldout.jsx";
import { Field } from "../ui.jsx";
import ReferenceImageField from "./ReferenceImageField.jsx";

export default function EnvironmentPanel(props) {
	const { run, begin, commit } = useStageTransaction();
	return (
<Foldout hidden={props.selectedHierarchyId !== "environment"} title={ko("Environment", "환경")}>
						<label className="check details-toggle-row">
							<span>{ko("I have an environment sheet", "환경 시트가 있어요")}</span>
							<input type="checkbox" checked={props.hasEnvSheet} onChange={(event) => run("stage.setEnvironment", { hasEnvSheet: event.target.checked })} />
						</label>
						{!props.hasEnvSheet && (
						<Field label={ko("Environment description", "환경 설명")}>
								<input type="text" value={props.environment} onChange={(event) => run("run.update", { txId: begin("stage.setEnvironment"), args: { environment: event.target.value } })} onBlur={commit} />
							</Field>
						)}
					<Field label={ko("Look / style", "룩 / 스타일")}>
							<input type="text" value={props.style} onChange={(event) => run("run.update", { txId: begin("stage.setStyle"), args: { style: event.target.value } })} onBlur={commit} />
						</Field>
						<ReferenceImageField
							label={ko("Environment reference", "환경 참고 이미지")}
							hint={ko(
								"A picture of this location. It travels with every framing capture so a render takes its materials, palette and lighting from the real place.",
								"이 장소의 사진입니다. 모든 프레이밍 캡처에 함께 실려 재질·색감·조명을 실제 장소에서 가져옵니다.",
							)}
							value={props.environmentImage}
							alt={ko("Environment reference", "환경 참고 이미지")}
							inputProps={{ "data-environment-image-input": "" }}
							onPick={(dataUrl) => {
								run("stage.setEnvironment", { environmentImage: dataUrl });
								props.setToast(ko("Environment reference set", "환경 참고 이미지를 설정했어요"));
							}}
							onClear={() => run("stage.setEnvironment", { environmentImage: null })}
						/>
					</Foldout>
	);
}
