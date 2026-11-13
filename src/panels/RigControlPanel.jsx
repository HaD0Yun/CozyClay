import Foldout from "./Foldout.jsx";
import { ko } from "../locale.js";
import { HIERARCHY_INSPECTOR_TITLES } from "../app-stage.jsx";
import { RangePinPanel } from "../range-pin-panel.jsx";
import FingerPanel from "./FingerPanel.jsx";
import PoserPanel from "../poser/ui/PoserPanel.jsx";
import "./pose.css";

export default function RigControlPanel({
 isRigSelection, rigSelection, ikChains, ikFocus, footSnap, ikMode, poseObjectOpacity = 0.2, setPoseObjectOpacity,
 motion, tlFrame, ikEditTool, setIkEditTool, pendingIkEdit = null, applyPendingIkEdit, cancelPendingIkEdit, onResetPose, fingerPanel = null,
 rangePins = [], rangePinResiduals = new Map(), rangePinSelection = null, rangePinPartPick = null,
 rangePinPreview = null, objects = [], setRangePinSelection, setRangePinPartPick,
 previewRangePinDraft, applyRangePinDraft, deleteRangePin,
}) {
 const activeTool = ikEditTool === "pin" ? ko("Pin", "고정") : ikEditTool === "poser" ? ko("Auto Pose", "자동 포즈", "自动姿势") : ko("IK", "IK");
 return <Foldout hidden={!isRigSelection} title={ko("Pose", "포즈")}>
  <div className="pose-details" data-testid="pose-details">
   <section className="pose-section">
    <h4>{ko("Pose", "포즈")}</h4>
    <div className="pose-row"><span>{ko("Foot lock", "발 고정")}</span><b>{footSnap ? ko("On", "켜짐") : ko("Off", "꺼짐")}</b></div>
    <div className="pose-row"><span>{ko("Body contact", "몸 접촉")}</span><b>{ikChains ? ko("Ready", "준비됨") : ko("Unavailable", "사용 불가")}</b></div>
    <div className="pose-row"><span>{ko("Influence", "영향")}</span><b>{ikFocus ?? ko("All", "전체")}</b></div>
    {setPoseObjectOpacity && <div className="pose-row pose-object-opacity">
     <span>{ko("Object opacity", "오브젝트 투명도")}</span>
     <input type="range" min={0} max={100} step={5} value={Math.round(poseObjectOpacity * 100)}
      data-testid="pose-object-opacity" aria-label={ko("Scene object opacity while posing", "포즈 편집 중 오브젝트 불투명도")}
      onChange={(event) => setPoseObjectOpacity(Number(event.target.value) / 100)} />
     <b>{Math.round(poseObjectOpacity * 100)}%</b>
    </div>}
    {onResetPose && <div className="pose-actions">
     <button type="button" className="btn" data-testid="pose-reset-default" onClick={onResetPose}
      title={motion ? ko("Remove every IK edit; the motion plays as it was", "IK 수정을 모두 지워요. 모션은 원래대로 재생돼요") : ko("Back to the default pose", "기본 포즈로 되돌려요")}>
      {motion ? ko("Clear pose edits", "포즈 수정 지우기") : ko("Reset to default pose", "기본 포즈로")}
     </button>
    </div>}
    <p className="inspector-hint">{rigSelection && rigSelection.token !== "rig" ? ko(`${HIERARCHY_INSPECTOR_TITLES[rigSelection.token]} is the active control group.`, `${HIERARCHY_INSPECTOR_TITLES[rigSelection.token]}이 활성 제어 그룹입니다.`, `${HIERARCHY_INSPECTOR_TITLES[rigSelection.token]}是当前控制组。`) : ko("Select a body group to pose it in the viewport.", "몸 그룹을 선택해 뷰포트에서 포즈를 잡으세요.")}</p>
   </section>
   {ikMode && <section className="pose-section" data-testid="pose-active-tool">
    <h4>{ko("Active tool", "활성 도구")} · {activeTool}</h4>
    <div className="pose-actions">
     {[["ik", ko("IK", "IK")], ["poser", ko("Auto Pose", "자동 포즈", "自动姿势"), "poser-tool"]].map(([tool, label, testId]) => <button key={tool} type="button" data-testid={testId} className={"btn" + (ikEditTool === tool ? " primary" : "")} aria-pressed={ikEditTool === tool} onClick={() => setIkEditTool(tool)}>{label}</button>)}
     <button type="button" data-testid="range-pin-tool" className={"btn" + (ikEditTool === "pin" ? " primary" : "")} aria-pressed={ikEditTool === "pin"} disabled={!motion} onClick={() => { setIkEditTool("pin"); setRangePinPartPick?.(null); }}>{ko("Pin", "고정")}</button>
    </div>
    {pendingIkEdit && <div className="pose-section" data-testid="ik-pending-edit">
     <div className="pose-row"><span>{ko("IK preview", "IK 미리보기")}</span><b>{pendingIkEdit.startFrame}–{pendingIkEdit.endFrame}</b></div>
     <p className="inspector-hint">{ko("The drag is previewed. Apply it to the selected motion block or cancel it.", "드래그를 미리 보고 있어요. 선택한 모션 블록에 적용하거나 취소하세요.")}</p>
     <div className="pose-actions">
      <button type="button" className="btn primary" data-testid="ik-apply-range" onClick={applyPendingIkEdit}>{ko("Apply range", "구간 적용")}</button>
      <button type="button" className="btn" data-testid="ik-cancel-preview" onClick={cancelPendingIkEdit}>{ko("Cancel", "취소")}</button>
     </div>
    </div>}
    {ikEditTool === "pin" && <RangePinPanel active motion={motion} frame={tlFrame} frameCount={motion?.frames ?? 1} fps={motion?.fps ?? 24} pins={rangePins} residuals={rangePinResiduals} objects={objects} selectedPinId={rangePinSelection} partPick={rangePinPartPick} conflictFrames={rangePinPreview?.conflictFrames ?? []} overlapError={rangePinPreview?.overlapError ?? ""} onSelectPin={(id) => { setRangePinSelection?.(id); if (id) setIkEditTool("pin"); }} onApply={applyRangePinDraft} onCancel={() => { setRangePinSelection?.(null); setIkEditTool("ik"); }} onDelete={deleteRangePin} onPreviewTarget={previewRangePinDraft} />}
    {ikEditTool === "poser" ? <PoserPanel /> : ikEditTool === "ik" && <p className="inspector-hint">{ko("Grab a hand, foot, elbow or knee handle in the viewport.", "뷰포트에서 손·발·팔꿈치·무릎 핸들을 잡으세요.")}</p>}
   </section>}
   {ikMode && ikEditTool === "ik" && fingerPanel && <FingerPanel {...fingerPanel} />}
  </div>
 </Foldout>;
}
