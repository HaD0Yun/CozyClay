import { loadAutoColor, saveAutoColor } from "../auto-color.js";
import { readStoredGridView, writeStoredGridView } from "../grid-view.js";
import { ko } from "../locale.js";
import ExportFolderPreference from "./ExportFolderPreference.jsx";
import {
	LanguageControls,
	PreferenceRow,
	PreferenceSection,
	ReadonlyHotkeys,
	ThemeControls,
	ToggleControl,
	WorldScaleControls,
} from "./preference-controls.jsx";

export function preferenceSection(section, props) {
	const { autoColor, setAutoColor, gridView, setGridView } = props;

	switch (section) {
		case "Appearance":
			return (
				<>
					<PreferenceSection title={ko("Display", "표시")}>
						<PreferenceRow title={ko("Language", "언어")} description={ko("Choose the labels used throughout the editor.", "에디터에서 사용할 언어를 선택하세요.")}>
							<LanguageControls />
						</PreferenceRow>
						<PreferenceRow title={ko("Theme", "테마")} description={ko("Dark keeps the studio dim around the stage; Light uses bright glass panels.", "다크는 무대 주변을 어둡게, 라이트는 밝은 유리 패널을 써요.")}>
							<ThemeControls />
						</PreferenceRow>
					</PreferenceSection>
					<PreferenceSection title={ko("Editor", "에디터")}>
						<PreferenceRow title={ko("Auto colour", "자동 색")} description={ko("Give scene objects stable display colours.", "씬 오브젝트에 고정된 표시 색을 사용해요.")}>
							<ToggleControl pressed={autoColor} onChange={(value) => { setAutoColor(value); saveAutoColor(value); }} label={ko("Auto colour", "자동 색")} testid="preferences-auto-color" />
						</PreferenceRow>
					</PreferenceSection>
				</>
			);
		case "Viewport":
			return (
				<PreferenceSection>
					<PreferenceRow title={ko("Reference grid", "기준 그리드")} description={ko("Use a dark reference grid instead of the clay deck.", "클레이 데크 대신 어두운 기준 그리드를 사용해요.")}>
						<ToggleControl pressed={gridView} onChange={(value) => { setGridView(value); writeStoredGridView(globalThis.localStorage, value); }} label={ko("Reference grid", "기준 그리드")} testid="preferences-grid" />
					</PreferenceRow>
					<PreferenceRow title={ko("World scale", "월드 크기", "世界尺度")} description={ko("Large lets a scene hold an exterior at full size: 3 km of floor, a 600 m crane and a 6 km lens. Switching reloads the editor.", "대형은 실외 세트를 실제 크기로 담아요: 바닥 3 km, 크레인 600 m, 렌즈 6 km. 바꾸면 에디터를 다시 불러와요.", "大场景可按实际尺寸容纳外景：3 公里地面、600 米摇臂和 6 公里镜头。切换后会重新加载编辑器。")}>
						<WorldScaleControls />
					</PreferenceRow>
				</PreferenceSection>
			);
		case "Export":
			return (
				<PreferenceSection>
					<ExportFolderPreference />
				</PreferenceSection>
			);
		case "Hotkeys":
			return (
				<PreferenceSection>
					<p className="v2-preferences__section-note">{ko("Shortcuts are read-only here. They stay active whenever focus is outside a text field.", "단축키는 여기서 읽기 전용이에요. 텍스트 입력란 밖에서 항상 사용할 수 있어요.")}</p>
					<ReadonlyHotkeys />
				</PreferenceSection>
			);
		default:
			return null;
	}
}

// Kept here so the dialog can load a new setting's initial value lazily.
export { loadAutoColor, readStoredGridView };
