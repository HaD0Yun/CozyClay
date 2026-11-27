import { useState } from "react";
import { ko } from "./locale.js";

const SETTING_KEY = "cozyclay.aiReference.setting";

function storedSetting() {
	try { return globalThis.localStorage?.getItem(SETTING_KEY) ?? ""; } catch { return ""; }
}

/**
 * Export → AI video reference asks one optional thing before it renders: the
 * place and look, in the operator's words. The camera moves, cuts, lens and
 * cast come from the scene; each shot's caption is its action. The text is
 * remembered on this browser so a re-export does not ask again from blank.
 */
export default function AiReferenceDialog({ open, shotCount, captionCount, onExport, onCancel }) {
	// Mounted only while open, so the remembered text is read once at open.
	const [setting, setSetting] = useState(storedSetting);
	if (!open) return null;
	const submit = () => {
		try { globalThis.localStorage?.setItem(SETTING_KEY, setting); } catch { /* private mode */ }
		onExport(setting);
	};
	return (
		<section
			className="ai-reference-ask"
			role="dialog"
			aria-modal="false"
			aria-labelledby="ai-reference-ask-title"
			data-testid="ai-reference-dialog"
			onKeyDown={(event) => {
				if (event.key === "Escape") onCancel();
				if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) submit();
			}}
		>
			<div className="ai-reference-ask-head">
				<strong id="ai-reference-ask-title">{ko("AI video reference", "AI 영상 레퍼런스", "AI 视频参考")}</strong>
				<button type="button" className="ai-reference-ask-close" aria-label={ko("Close", "닫기", "关闭")} onClick={onCancel}>×</button>
			</div>
			<label className="ai-reference-ask-label" htmlFor="ai-reference-setting">
				{ko("Place and look (optional)", "장소와 분위기 (선택)", "地点与氛围（可选）")}
			</label>
			<textarea
				id="ai-reference-setting"
				autoFocus
				rows={4}
				maxLength={1000}
				value={setting}
				placeholder={ko("e.g. New York, Lower East Side at night: old brick walk-ups with fire escapes, bodegas, parked cars, wet asphalt", "예: 밤의 뉴욕 로어이스트사이드, 비상계단 달린 오래된 벽돌 건물, 보데가, 주차된 차, 젖은 아스팔트", "例如：夜晚的纽约下东区，带消防梯的老砖楼、便利店、路边停车、湿漉漉的沥青路")}
				onChange={(event) => setSetting(event.target.value)}
			/>
			<p className="ai-reference-ask-note">
				{/* Shot documents v7 dropped the caption with the storyboard, so the caption line shows only once shots carry one again. */}
				{ko(`Camera moves, cuts, lens, cast and who or what is in frame when come from the scene (${shotCount} shot${shotCount === 1 ? "" : "s"}).${captionCount ? ` Each shot's caption is its action — ${captionCount} of ${shotCount} have one.` : ""} English works best for the video model.`,
					`카메라 무빙·컷·렌즈·캐스트와 언제 누가(무엇이) 화면에 있는지는 씬에서 읽어요 (샷 ${shotCount}개).${captionCount ? ` 샷 캡션이 그 샷의 행동이 돼요 — ${shotCount}개 중 ${captionCount}개에 캡션이 있어요.` : ""} 영상 모델에는 영어가 가장 잘 먹혀요.`,
					`机位运动、剪辑、镜头、演员以及何时谁（什么）在画面中，都从场景读取（${shotCount} 个镜头）。${captionCount ? `每个镜头的说明就是它的动作 — ${shotCount} 个中有 ${captionCount} 个有说明。` : ""}视频模型对英文效果最好。`)}
			</p>
			<div className="ai-reference-ask-actions">
				<button type="button" onClick={onCancel}>{ko("Cancel", "취소", "取消")}</button>
				<button type="button" className="primary" data-testid="ai-reference-export" onClick={submit}>{ko("Export", "내보내기", "导出")}</button>
			</div>
		</section>
	);
}
