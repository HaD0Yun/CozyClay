// Chapter 2 · Layout tour: five regions, five modes, the shortcut list.
import { chapterCard, clear, spot, t } from "./steps.mjs";

// The WebGL canvas and its containers fill the whole window behind the
// panels, so the Scene view is the gap the panels leave around it.
const SCENE_VIEW = {
	js: `(() => {
		const box = (selector) => document.querySelector(selector).getBoundingClientRect();
		const left = box(".studio-left-column"), right = box(".studio-right-column"), top = box("header.topbar"), dock = box(".studio-dock-slot");
		return { x: left.right + 6, y: top.bottom + 6, width: right.left - left.right - 12, height: dock.top - top.bottom - 12 };
	})()`,
};

export default {
	id: "layout",
	title: t("2 · 화면 둘러보기", "2 · Layout tour"),
	steps: [
		chapterCard("2.0", t("2 · 화면 둘러보기", "2 · Layout tour"), t("다섯 영역과 다섯 모드", "Five regions, five modes")),
		spot("2.1", ".v2-first-success-guide", t("첫 60초", "Your first 60 seconds"), t("네 단계 체크리스트", "A four-step checklist"), {
			caption: t("처음 열면 네 단계 체크리스트가 뜹니다. 이 가이드가 같은 내용을 더 자세히 다루므로 닫겠습니다.", "A four-step checklist appears on first open. This guide covers the same ground in more detail, so we close it."),
		}),
		clear("2.2a"),
		{ id: "2.2", click: ".v2-first-success-guide-close" },
		spot("2.3", ".topbar-project.studio-project-head", t("프로젝트", "Project"), t("이름, 저장 상태, 프로젝트 종류", "Name, save status, project kind"), {
			caption: t("왼쪽 위는 프로젝트 이름과 저장 상태입니다. 편집하면 \"저장되지 않은 변경사항\"으로 바뀝니다.", "Top left: the project name and save status. It reads \"Unsaved changes\" after any edit."),
		}),
		spot("2.4", "nav.menubar", t("메뉴", "Menus"), t("파일·편집·창·도움말", "File, Edit, Window, Help"), {
			caption: t("파일은 새로 만들기·열기·저장·내보내기, 편집은 되돌리기·다시 실행, 창은 에이전트·워크플로, 도움말은 단축키와 정보입니다.", "File: New, Open, Save, Export. Edit: Undo, Redo. Window: Agent, Workflow. Help: Keyboard shortcuts, About."),
		}),
		spot("2.5", "[data-testid=\"mode-toolbar\"]", t("모드", "Modes"), t("배치 1 · 포즈 2 · 카메라 3 · 모션 4 · 조형 5", "Stage 1, Pose 2, Camera 3, Motion 4, Sculpt 5"), {
			caption: t("다섯 모드는 숫자 키 1~5로 바꿉니다. 배치에서 놓고, 포즈로 고치고, 카메라로 찍고, 모션으로 다듬고, 조형으로 만듭니다.", "Five modes, keys 1 to 5. Stage places, Pose fixes, Camera shoots, Motion trims, Sculpt builds."),
		}),
		spot("2.6", "section.hierarchy-pane.v2-outliner", t("아웃라이너", "Outliner"), t("장면 트리: 카메라, 조명, 캐릭터, 환경, 소품", "The scene tree: camera, light, character, environment, props"), {
			caption: t("왼쪽 아웃라이너는 장면에 있는 모든 것의 목록입니다. 줄을 누르면 선택됩니다.", "The Outliner on the left lists everything in the scene. Click a row to select it."),
		}),
		spot("2.7", SCENE_VIEW, t("장면 보기", "Scene view"), t("우클릭 드래그로 둘러보기, 휠로 확대", "Right-drag to look around, wheel to zoom"), {
			caption: t("가운데가 3D 장면 보기입니다. 우클릭 드래그로 둘러보고 휠로 확대합니다.", "The center is the 3D Scene view. Right-drag to look around, wheel to zoom."),
		}),
		spot("2.8", ".vp-overlay-left", t("도구", "Tools"), t("추가 +, 이동 W, 회전 E, 크기 R, 스냅 5cm·5°", "Add +, Move W, Rotate E, Scale R, snap 5cm·5°"), {
			caption: t("왼쪽 세로 도구 열입니다. 오브젝트 추가와 이동·회전·크기 기즈모, 격자 스냅이 있습니다.", "The tool column: add objects, the move, rotate and scale gizmos, and grid snapping."),
		}),
		spot("2.9", ".vp-overlay-right", t("보기", "View"), t("원근/샷 카메라, 셰이딩, 표시 토글, 비행 속도", "Views, shading, display toggles, fly speed"), {
			caption: t("오른쪽 알약은 시점, 셰이딩, 격자나 가이드 표시, 카메라 비행 속도입니다.", "The pills on the right: viewpoint, shading, display toggles and fly speed."),
		}),
		spot("2.10", ".dock-tabs", t("애니메이션 / 에셋", "Animation / Assets"), t("타임라인 또는 콘텐츠 선반", "The timeline or the content shelf"), {
			caption: t("아래 도크는 애니메이션 탭이면 타임라인, 에셋 탭이면 도형과 카드가 있는 선반입니다.", "The bottom dock shows the timeline on the Animation tab and the content shelf on Assets."),
		}),
		spot("2.11", "[data-testid=\"sequencer\"]", t("타임라인", "Timeline"), t("재생 컨트롤, 레인, 샷", "Transport, lanes, shots"), {
			caption: t("타임라인에는 재생 컨트롤과 레인이 있습니다. 바디 레인에 모션이, 카메라 컷 레인에 샷이 놓입니다.", "The timeline holds the transport and the lanes. Motion goes on Body, shots go on Camera Cuts."),
		}),
		spot("2.12", ".vp-pane.vp-shot-preview", t("샷 카메라", "Shot Camera"), t("샷 카메라가 보는 화면과 화면비", "What the shot camera sees, and the aspect ratio"), {
			caption: t("오른쪽 아래는 샷 카메라 미리보기입니다. 최종 영상은 이 화면으로 나갑니다.", "Bottom right is the Shot Camera preview. The final video is what this camera sees."),
		}),
		spot("2.13", "[data-testid=\"studio-agent-bar\"]", t("에이전트", "Agent"), t("Cmd/Ctrl+B로 열기", "Open with Cmd/Ctrl+B"), {
			caption: t("에이전트는 말로 요청을 받아 장면을 바꿉니다. Cmd/Ctrl+B로 엽니다. 4장에서 씁니다.", "The Agent takes requests in plain words and edits the scene. Cmd/Ctrl+B opens it. Chapter 4 uses it."),
		}),
		clear("2.14a"),
		{
			id: "2.14",
			narration: t("단축키 목록은 도움말 메뉴에 있습니다. 모드 1~4, 도구 W E R, 재생 Space, 저장 ⌘S, 키프레임 팩 ⌘E, 에이전트 ⌘B.", "The shortcut list is under Help. Modes 1 to 4, tools W E R, play Space, save ⌘S, keyframe pack ⌘E, agent ⌘B."),
			menu: { open: "[data-testid=\"menu-help\"]", then: { css: ".menubar-menu .menubar-item", text: t("단축키", "Keyboard shortcuts") } },
		},
		spot("2.14b", ".menubar-dialog[data-dialog=\"shortcuts\"]", t("단축키", "Keyboard shortcuts"), t("도움말 메뉴에서 언제든", "From the Help menu, any time"), { hold: 5000 }),
		{ id: "2.14c", key: "Escape" },
		clear("2.14d"),
	],
};
