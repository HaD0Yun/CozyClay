// The camera tutorial's content (camera-tutorial.jsx): the seven steps, and where the last three point.
import { ko } from "./locale.js";

/** Right-button + these six keys is one gesture, so the walk step only counts
 * once every key has actually been pressed (the landing page's rule). */
export const WALK_KEYS = ["w", "a", "s", "d", "q", "e"];

export const CAMERA_TUTORIAL_STEPS = [
	{
		kind: "fly",
		label: ko("Look", "보기"),
		how: () => ko(
			"Right-drag in the viewport to look around.",
			"뷰포트에서 오른쪽 버튼을 끌어 주위를 둘러보세요.",
		),
	},
	{
		kind: "walk",
		label: ko("Walk", "걷기"),
		how: ({ walked }) => {
			const keys = (
				<span className="camera-tutorial-keys">
					{WALK_KEYS.map((key) => (
						<kbd key={key} data-key={key} data-done={walked.has(key) ? 1 : 0}>{key.toUpperCase()}</kbd>
					))}
				</span>
			);
			return ko(
				<>Hold the right button and press each key once: {keys} W A S D walk, Q E crane.</>,
				<>오른쪽 버튼을 누른 채 각 키를 한 번씩 누르세요: {keys} W A S D 이동, Q E 크레인.</>,
			);
		},
	},
	{
		kind: "dolly",
		label: ko("Dolly", "돌리"),
		how: () => ko(
			"Scroll in the viewport to push in and pull out.",
			"뷰포트에서 스크롤해 앞뒤로 밀고 당겨 보세요.",
		),
	},
	{
		kind: "orbit",
		label: ko("Orbit", "궤도"),
		how: () => ko(
			<>Hold <kbd>Alt</kbd> (<kbd>⌥ Option</kbd> on Mac) and left-drag to circle the character.</>,
			<><kbd>Alt</kbd>(맥은 <kbd>⌥ Option</kbd>)을 누른 채 왼쪽 버튼을 끌어 캐릭터 주위를 도세요.</>,
		),
	},
	{
		kind: "shot",
		label: ko("Shot", "샷"),
		// The control lives in another region than the card, so the card says
		// which way to look before it says what to do.
		where: ko("↓ Timeline, Camera Cuts", "↓ 타임라인 Camera Cuts"),
		how: () => ko(
			<>In the timeline's Camera Cuts lane click <b>+ Add shot</b>. That is your cut.</>,
			<>타임라인의 Camera Cuts 레인에서 <b>+ 샷 추가</b>를 누르세요. 그게 컷입니다.</>,
		),
	},
	{
		kind: "rail",
		label: ko("Rail", "레일"),
		where: ko("↓ Timeline, Camera Cuts", "↓ 타임라인 Camera Cuts"),
		how: () => ko(
			<>Select the shot, click <b>Draw rail</b> in the camera bar, and drag a line across the top view. That line is the dolly move.</>,
			<>샷을 선택하고 카메라 바의 <b>레일 그리기</b>를 누른 뒤, 탑뷰에 선을 그으세요. 그 선이 돌리 이동입니다.</>,
		),
	},
	{
		kind: "play",
		label: ko("Play", "재생"),
		where: ko("↘ Shot Camera monitor", "↘ Shot Camera 모니터"),
		how: () => ko(
			<>Click <b>Look through</b> in the Shot monitor to fly the shot camera; <b>▶</b> rides the rail, <kbd>Esc</kbd> returns to the free camera.</>,
			<>Shot Camera 모니터의 <b>샷 시점</b>을 눌러 샷 카메라를 조종하세요. <b>▶</b>는 레일을 타고, <kbd>Esc</kbd>로 자유 카메라로 돌아옵니다.</>,
		),
	},
];

export const NAV_KINDS = new Set(["fly", "walk", "dolly", "orbit"]);
export const SIGNAL_KINDS = new Set(["shot", "rail"]);

// Where each of the last three steps actually happens (#211). The card names
// the gesture; these pin a numbered circle and a caption onto the control
// itself, so "click + Add shot" stops being a treasure hunt across two panes.
//
// `absent`/`requires` gate a beacon on the studio's own state instead of on
// tutorial bookkeeping: the camera bar (.tl-rail-draw) only exists once a shot
// is selected, which is exactly the moment the rail step's advice changes.
export const TUTORIAL_BEACONS = {
	shot: [
		{ role: "add-shot", selector: ".tl-track.shots .tl-track-add", label: () => ko("Click here", "여기를 클릭") },
	],
	rail: [
		{
			role: "select-shot",
			selector: ".tl-track.shots .tl-shot-block:not(.selected)",
			absent: ".tl-rail-draw",
			label: () => ko("1. Select the shot", "1. 샷을 선택"),
		},
		{ role: "draw-rail", selector: ".tl-rail-draw", label: () => ko("2. Draw rail, then drag across the top view", "2. 레일 그리기 후 탑뷰에 선 긋기") },
		// The Top-View becomes an active drawing surface after the tool is armed.
		{ role: "top-view", selector: ".vp-inset", requires: '[data-rail-draw="1"]', label: () => ko("Drag a line here", "여기에 선을 그으세요") },
	],
	play: [
		// The glass shell keeps the same action in the bottom dock while the
		// compact viewport card owns it in the classic shell.
		{ role: "look-through", selector: ".dock-shot-look, .vp-look-through", label: () => ko("Click to fly the shot camera", "클릭해 샷 카메라를 조종") },
	],
};
