import { ko } from "../locale.js";
import Foldout from "./Foldout.jsx";
import { Dropdown, Field, Slider } from "../ui.jsx";
import { createKeyLight, LIGHTING_PRESETS } from "../stage-lighting.js";
import { STAGE_BACKGROUND } from "../grid-view.js";
import { useStageTransaction } from "../domains/stage.js";
import HdrEnvironmentControls from "./HdrEnvironmentControls.jsx";

const LOOK_LABELS = { studio: ["Studio", "스튜디오"], day: ["Day", "낮"], overcast: ["Overcast", "흐린 날"], golden: ["Golden hour", "골든아워"],
	dusk: ["Dusk", "해 질 녘"], night: ["Night", "밤"], interior: ["Interior", "실내"], stage: ["Stage spotlight", "무대 조명"] };

export default function LightPanel({ keyLightSelected, keyLight, lighting }) {
	const { run, begin, commit, cancel } = useStageTransaction();
	// One look in one undo step; sky and exposure then tweak it like any slider.
	const setLighting = (patch) => run("run.update", { txId: begin("stage.set"), args: { lighting: patch } });
	return (
<Foldout hidden={!keyLightSelected} title={ko("Light", "조명")}>
						<p className="hint v2-details-hint">{ko("Drag the sun in the scene to move the light. Shadows and warmth follow it.", "씬의 해를 드래그해 조명을 옮깁니다. 그림자와 빛의 방향이 따라옵니다.")}</p>
						{lighting && <Field label={ko("Look", "조명 룩")}>
							<Dropdown value={lighting.preset} ariaLabel={ko("Lighting look", "조명 룩")} options={LIGHTING_PRESETS.map((value) => ({ value, label: ko(...LOOK_LABELS[value]) }))}
								onChange={(preset) => run("stage.applyLighting", { preset })} />
						</Field>}
						<div onPointerUp={commit} onPointerCancel={cancel} onKeyUp={commit} onBlur={commit}>
						<Slider label={ko("Brightness", "밝기")} min={0} max={4} step={0.05} value={keyLight.intensity} onChange={(value) => run("run.update", { txId: begin("stage.setKeyLight"), args: { keyLight: { intensity: value } } })} />
						<Slider label={ko("Cool ↔ Warm", "차가움 ↔ 따뜻함")} min={0} max={1} step={0.05} value={keyLight.warmth ?? 0.5} onChange={(value) => run("run.update", { txId: begin("stage.setKeyLight"), args: { keyLight: { warmth: value, color: null } } })} />
						{lighting && <>
							<Slider label={ko("Exposure", "노출")} min={0.2} max={3} step={0.05} value={lighting.exposure} onChange={(exposure) => setLighting({ exposure })} />
							<Slider label={ko("Sky light", "하늘빛")} min={0} max={2} step={0.05} value={lighting.envLight ?? 0} onChange={(envLight) => setLighting({ envLight })} />
							<Slider label={ko("Ambient occlusion", "앰비언트 오클루전")} min={0} max={1} step={0.05} value={lighting.ao ?? 0} onChange={(ao) => setLighting({ ao })} />
							<Field label={ko("Sky", "하늘")}>
								<input type="color" className="object-color object-color-free" value={lighting.sky ?? STAGE_BACKGROUND} title={ko("Sky colour", "하늘 색")} aria-label={ko("Sky colour", "하늘 색")}
									onChange={(event) => setLighting({ sky: event.target.value })} />
							</Field>
							<HdrEnvironmentControls lighting={lighting} run={run} setLighting={setLighting} />
						</>}
						</div>
						<div className="readout v2-details-readout">
							<span title={ko("light position", "조명 위치")}>{`x ${keyLight.x.toFixed(1)}  y ${keyLight.y.toFixed(1)}  z ${keyLight.z.toFixed(1)}`}</span>
						</div>
						<button className="btn ghost" onClick={() => run("stage.setKeyLight", { keyLight: createKeyLight(null) })}>
							{ko("Reset light", "조명 초기화")}
						</button>
					</Foldout>
	);
}
