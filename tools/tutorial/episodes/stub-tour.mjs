// Stub tour: proves the point-at-features format (cards, the install terminal,
// spotlights with callouts, a menu path) on a short path. The terminal lines
// are placeholders until the measured install output replaces them. Fixed
// holds keep it under a minute; a real episode lets reading time decide.
const OUTLINER = ".hierarchy-pane.v2-outliner";

export default {
	title: { ko: "CozyClay 둘러보기", en: "A tour of CozyClay" },
	subtitle: { ko: "설치부터 편집기까지", en: "From install to the editor" },
	firstChapter: 0,
	chapters: [
		{ id: "intro", steps: [{ id: "opening", card: "opening", hold: 2500 }] },
		{
			id: "install",
			title: { ko: "설치", en: "Install" },
			steps: [
				{ id: "install-card", hold: 2000, card: { title: { ko: "설치", en: "Install" }, subtitle: { ko: "터미널에서 한 줄이면 됩니다", en: "One line in a terminal" } } },
				{
					id: "install-run",
					narration: { ko: "터미널에서 npx cozyclay를 실행하세요.", en: "Run npx cozyclay in a terminal." },
					terminal: { type: "npx cozyclay" },
				},
				{ id: "install-output", terminal: { print: ["[placeholder] installing CozyClay", "[placeholder] CozyClay is running at http://127.0.0.1:5180/app/", "[placeholder] opening your browser"] } },
			],
		},
		{
			id: "start",
			title: { ko: "시작 화면", en: "Start screen" },
			steps: [
				{ id: "open-studio", studio: true },
				{ id: "start-card", hold: 2000, card: { title: { ko: "시작 화면", en: "Start screen" }, subtitle: { ko: "프로젝트를 만드는 곳", en: "Where a project begins" } } },
				{
					id: "spot-animation",
					narration: { ko: "먼저 프로젝트 모드를 고릅니다.", en: "First, pick the project mode." },
					spotlight: "[data-testid=start-previs-mode] [data-previs-mode=animation]",
					hold: 2600,
					label: { ko: "애니메이션", en: "Animation" },
					note: { ko: "움직임을 블로킹하고 샷을 찍는 모드", en: "Block continuous motion and shoot shots" },
				},
				{
					id: "spot-create",
					spotlight: "[data-testid=start-create]",
					hold: 2600,
					label: { ko: "생성", en: "Create" },
					note: { ko: "빈 무대로 새 프로젝트를 엽니다", en: "Opens a new project on an empty stage" },
				},
				{ id: "spot-clear-start", spotlight: null },
				{ id: "create", click: "[data-testid=start-create]", until: ".timeline" },
				{ id: "rig-load", hold: 1500 },
			],
		},
		{
			id: "editor",
			title: { ko: "편집기", en: "Editor" },
			steps: [
				{ id: "editor-card", hold: 2000, card: { title: { ko: "편집기", en: "Editor" }, subtitle: { ko: "장면, 모드, 타임라인", en: "Scene, modes and timeline" } } },
				{
					id: "spot-outliner",
					narration: { ko: "편집기의 세 부분을 차례로 봅니다.", en: "Three parts of the editor, one at a time." },
					spotlight: OUTLINER,
					label: { ko: "아웃라이너", en: "Outliner" },
					note: { ko: "장면에 있는 카메라, 조명, 캐릭터 목록", en: "Every camera, light and character in the scene" },
				},
				{
					id: "spot-modes",
					spotlight: ".vp-mode-keys",
					hold: 2600,
					label: { ko: "작업 모드", en: "Workflow modes" },
					note: { ko: "배치, 포즈, 카메라, 모션, 조형을 오갑니다", en: "Switch between Stage, Pose, Camera, Motion and Sculpt" },
				},
				{
					id: "spot-body",
					spotlight: "[data-lane-label=Body]",
					hold: 2600,
					label: { ko: "바디 레인", en: "Body lane" },
					note: { ko: "캐릭터의 동작 테이크가 올라오는 곳", en: "Where the character's motion takes land" },
				},
				{ id: "spot-clear-editor", spotlight: null },
				{
					id: "open-export",
					narration: { ko: "내보내기는 파일 메뉴에 있습니다.", en: "Exports live in the File menu." },
					menu: { open: "[data-testid=menu-file]", then: "[data-testid=topbar-export]" },
				},
				{
					id: "spot-keyframe-pack",
					spotlight: "[data-testid=export-keyframe-pack]",
					hold: 2600,
					label: { ko: "키프레임 팩 (zip)", en: "Keyframe pack (zip)" },
					note: { ko: "첫 프레임, 마지막 프레임, 참고 클립, 프롬프트", en: "First frame, last frame, reference clip and prompt" },
				},
				{ id: "spot-clear-export", spotlight: null },
				{ id: "close-menu", click: "[data-testid=menu-file]" },
			],
		},
		{ id: "outro", steps: [{ id: "closing", card: "closing", hold: 3000 }] },
	],
};
