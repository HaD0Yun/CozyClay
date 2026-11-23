import { ko } from "../locale.js";

// Export → AI video reference (zip). Its own file so the menu bar stays short.
export default function AiReferenceMenuItem({ disabled, onClick }) {
	return (
		<button
			type="button"
			role="menuitem"
			className="menubar-item"
			data-testid="export-ai-reference" data-fid="export_ai_reference"
			disabled={disabled}
			title={ko("Your shots as a reference video for AI video models (Seedance etc.): light mosaic and heavy blur, so the model keeps camera, cuts and blocking but not the mannequin look", "샷들을 AI 영상 모델(Seedance 등)용 레퍼런스 영상으로 — 옅은 모자이크와 강한 블러라서 카메라·컷·동선은 지키고 마네킹 느낌은 따라오지 않아요")}
			onClick={onClick}
		>
			<span className="menubar-item-label">{ko("AI video reference (zip)", "AI 영상 레퍼런스 (zip)")}</span>
		</button>
	);
}
