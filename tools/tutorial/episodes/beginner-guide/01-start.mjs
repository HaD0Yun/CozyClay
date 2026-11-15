// Chapter 1 · Start screen: project kind and settings, then Create.
import { castFirstCharacter } from "../cast.mjs";
import { chapterCard, clear, spot, t } from "./steps.mjs";

export default {
	id: "start",
	title: t("1 · 시작 화면", "1 · Start screen"),
	steps: [
		{ id: "1.0", studio: true },
		chapterCard("1.0b", t("1 · 시작 화면", "1 · Start screen"), t("프로젝트 종류와 설정", "Project kind and settings")),
		{
			id: "1.1",
			narration: t("브라우저에 시작 화면이 열립니다. 왼쪽은 최근 프로젝트·새 프로젝트·배우기, 가운데가 새 프로젝트 설정입니다.", "The start screen opens. Left: Recent, New Project, Learn. Center: the new project settings."),
			wait: ".v2-start-screen",
		},
		spot("1.3", "[data-testid=\"start-new-project-card\"]", t("새 프로젝트", "New project"), t("빈 무대에서 시작", "Start from an empty stage"), {
			caption: t("새 프로젝트는 빈 무대에서 시작합니다. 캐릭터 한 명, 카메라, 조명이 들어 있습니다.", "New project starts from an empty stage with one character, a camera and a light."),
		}),
		spot("1.4", "[data-testid=\"start-open-project-card\"]", t("프로젝트 열기", "Open project"), t("저장한 .cclayproject 파일", "A saved .cclayproject file"), {
			hold: 3000,
			caption: t("저장해 둔 .cclayproject 파일은 여기서 엽니다.", "Open project loads a saved .cclayproject file."),
		}),
		spot("1.5", "[data-testid=\"start-project-name\"]", t("이름", "Name"), t("비우면 생성 버튼이 꺼집니다", "Empty name disables Create"), {
			caption: t("프로젝트 이름을 적습니다.", "Name the project."),
		}),
		{ id: "1.5b", type: { into: "[data-testid=\"start-project-name\"]", text: "my_first_video" } },
		spot("1.6", "button.v2-start-location", t("위치", "Location"), t("기본은 브라우저 프로젝트 저장소", "Default: Browser project store"), {
			hold: 3000,
			caption: t("저장 위치입니다. 기본은 이 브라우저 안의 저장소이고, 폴더를 고를 수도 있습니다.", "Where the project is stored. The default is this browser; you can pick a folder instead."),
		}),
		spot("1.7", t("select[aria-label=\"프레임 레이트\"]", "select[aria-label=\"Frame rate\"]"), t("프레임 레이트", "Frame rate"), t("24 fps 또는 30 fps", "24 fps or 30 fps"), {
			hold: 3000,
			caption: t("프레임 레이트는 24 또는 30입니다. 영화 느낌은 24를 씁니다.", "Frame rate is 24 or 30. Film-style motion uses 24."),
		}),
		spot("1.8", t("select[aria-label=\"단위\"]", "select[aria-label=\"Units\"]"), t("단위", "Units"), t("미터 또는 피트", "Meters or Feet"), {
			hold: 3000,
			caption: t("단위는 미터가 기본입니다.", "Units default to meters."),
		}),
		spot("1.9", "[data-testid=\"start-create\"]", t("생성", "Create"), t("프로젝트를 만들고 에디터를 엽니다", "Creates the project and opens the editor"), {
			caption: t("생성을 누르면 에디터가 열립니다.", "Press Create and the editor opens."),
		}),
		clear("1.9b"),
		{ id: "1.9c", click: "[data-testid=\"start-create\"]", until: "[data-testid=\"sequencer\"]" },
		{ id: "1.9d", hold: 1500 },
		...castFirstCharacter("1.10", t("새 프로젝트는 빈 무대입니다. 장면 보기의 \"추가\"에서 Y Bot을 골라 캐릭터를 놓으세요.", "A new project is an empty stage. Open Add in the Scene view and pick Y Bot to place a character.")),
	],
};
