// Chapter 4 · Motion: the agent's sign-in card, a walk take, playback and the lanes.
import { skeletonFor } from "../../../../src/motion3/rigs/index.js";
import { chapterCard, clear, spot, spots, t } from "./steps.mjs";

// The walk from first-video.mjs, started where the character stands.
const skeleton = skeletonFor("y-bot-tpose");
const rest = (bone) => skeleton.restWorldPos[skeleton.index[bone]];
const ankle = rest("LeftFoot")[1];
const WALK = {
	schema: "cozyclay.motion-spec.v1",
	fps: 24,
	frames: 240,
	keys: [{ f: 0, set: { root: [0, rest("Hips")[1] - 0.01, 0], yaw: 0, foot_l: [0.09, ankle, -0.03], foot_r: [-0.09, ankle, 0.03], fyaw_l: 0, fyaw_r: 0, armw_r: 0 } }],
	generators: [{ type: "walk", f0: 6, steps: 8, heading: [0, 0] }],
};
const COMPILE_WALK = `(() => {
	const character = window.__cozyclay.characters[0], { x, z } = character;
	const spec = ${JSON.stringify(WALK)};
	const set = spec.keys[0].set;
	for (const name of ["root", "foot_l", "foot_r"]) set[name] = [set[name][0] + x, set[name][1], set[name][2] + z];
	return window.__cozyclay.runStudioAction("motion.compile", { characterId: character.id, spec });
})()`;
const BODY_LANE = ".tl-track:has(.tl-track-chip.body)";
// Root path's data-lane-label is translated in the Korean UI ("루트 경로"); its class is not.
const point = (expression) => ({ js: `(() => { const box = ${expression}.getBoundingClientRect(); return { x: box.left + box.width / 2, y: box.top + box.height / 2 }; })()` });

export default {
	id: "motion",
	title: t("4 · 모션", "4 · Motion"),
	steps: [
		chapterCard("4.0", t("4 · 모션", "4 · Motion"), t("에이전트에게 요청하고, 재생하고, 확인하기", "Ask the agent, play, check")),
		{
			id: "4.1",
			narration: t("에이전트 패널입니다. Sign in with ChatGPT를 누르거나 다른 제공자의 키로 로그인합니다. 토큰은 이 페이지에 저장되지 않습니다.", "The Agent panel. Press Sign in with ChatGPT, or log in with another provider's key. No token is stored in the page."),
			key: "Mod+B",
			until: "[data-agent-card=signed-out]",
		},
		spot("4.1b", "[data-agent-card=signed-out]", t("모델 연결", "Connect a model"), t("ChatGPT 로그인 또는 다른 제공자", "Sign in with ChatGPT, or another provider")),
		spot("4.2", "button.agent-primary-button.agent-signin", t("Sign in with ChatGPT", "Sign in with ChatGPT"), t("브라우저에서 로그인", "Signs in through your browser"), {
			hold: 3000,
			caption: t("로그인하면 아래 입력창에 \"캐릭터가 앞으로 걷는다\"처럼 적기만 하면 됩니다.", "Once signed in, you just type a request like \"the character walks forward\"."),
		}),
		clear("4.3a"),
		{
			id: "4.3",
			narration: t("에이전트는 모션 스펙을 쓰고, 브라우저 안의 컴파일러가 모든 프레임을 계산합니다. 이 영상에서는 완성된 걷기 테이크를 바로 불러왔습니다.", "The agent writes a motion spec and a compiler in the browser bakes every frame. This video loads a finished walk take directly."),
			key: "Mod+B",
		},
		{ id: "4.3b", eval: COMPILE_WALK, until: `${BODY_LANE} .tl-motion-clip` },
		spot("4.4", BODY_LANE, t("바디", "Body"), t("모션 테이크가 놓이는 레인", "The lane where the motion take lands"), {
			caption: t("테이크가 바디 레인에 클립으로 올라왔습니다.", "The take landed on the Body lane as a clip."),
		}),
		spot("4.6", "[data-fid=\"tl_play\"]", t("재생 (Space)", "Play (Space)"), t("재생·정지", "Play and pause"), {
			caption: t("Space로 재생하고 다시 Space로 멈춥니다.", "Space plays, Space again pauses."),
		}),
		{ id: "4.6b", key: "Space", until: ".tl-btn.play.on" },
		{ id: "4.6c", hold: 1500 },
		{ id: "4.6d", key: "Space" },
		spot("4.7", "[data-testid=\"sequencer-frame-readout\"]", t("프레임", "Frame"), t("현재 / 전체 · fps", "Current / total · fps"), {
			hold: 3000,
			caption: t("현재 프레임, 전체 프레임, 프레임 레이트입니다.", "Current frame, total frames and frame rate."),
		}),
		spot("4.8", ".tl-ruler-lane", t("타임라인 탐색", "Scrub timeline"), t("눈금자를 끌어 재생 헤드 이동", "Drag the ruler to move the playhead"), {
			caption: t("눈금자를 끌면 재생 헤드가 따라옵니다. 프레임 0으로 되감아 둡니다.", "Drag the ruler to move the playhead. We rewind to frame 0."),
		}),
		{
			id: "4.8b",
			drag: { from: point("document.querySelector('.tl-ruler-lane .tl-frame-box')"), to: { js: "(() => { const box = document.querySelector('.tl-ruler-lane').getBoundingClientRect(); return { x: box.left + 1, y: box.top + box.height / 2 }; })()" } },
			until: { css: "[data-testid=\"sequencer-frame-readout\"]", text: "0000 /" },
		},
		spot("4.9", ".tl-transport", t("한 프레임 (J / K)", "One frame (J / K)"), t("뒤로 K, 앞으로 J", "Back K, forward J"), {
			hold: 3000,
			caption: t("J와 K로 한 프레임씩 움직입니다.", "J and K step one frame."),
		}),
		...spots("4.10", ["[data-lane-label=\"Pins\"]", "[data-lane-label=\"IK keys\"]", ".tl-track-chip.root"], t("핀 / IK 키 / 루트 경로", "Pins / IK keys / Root path"), t("팔다리 고정 / 손으로 고친 포즈 키 / 바닥 경로", "Limb holds / hand-fixed pose keys / the floor path"), {
			caption: t("핀은 팔다리를 한 지점에 붙잡고, IK 키는 포즈 모드에서 고친 자세를, 루트 경로는 캐릭터가 걸을 바닥 경로를 둡니다.", "Pins hold a limb on a spot, IK keys store poses fixed in Pose mode, Root path is the floor path the character walks."),
		}),
		spot("4.11", ".tl-btn.clear", t("모션 지우기", "Clear motion"), t("테이크를 지우고 블로킹 포즈로", "Clears the take and restores the blocking pose"), {
			hold: 3000,
			caption: t("모션 지우기는 테이크를 지우고 원래 포즈로 돌아갑니다.", "Clear motion removes the take and restores the pose."),
		}),
		spot("4.12", ".tl-btn.zoom", t("타임라인 확대", "Timeline zoom"), t("재생 속도가 아님. 클릭하면 1×", "Not playback speed; click resets to 1×"), {
			hold: 3000,
			caption: t("1.00×는 눈금자 확대 비율입니다. 재생 속도가 아닙니다.", "1.00× is the ruler zoom, not the playback speed."),
		}),
		clear("4.13a"),
		{ id: "4.13", narration: t("포즈 모드는 모션 위에서 IK로 자세를 고칩니다. 발 스냅은 발을 바닥에 붙이고, 바닥 접촉은 몸이 바닥을 뚫지 않게 합니다.", "Pose mode fixes a pose on top of the motion with IK. Foot snap keeps the feet planted, Body contact keeps the body above the floor."), key: "2" },
		spot("4.13b", ".vp-overlay-left", t("포즈 모드 (2)", "Pose mode (2)"), t("포즈 수정 W, 고정 R, 발 스냅, 바닥 접촉", "Pose fix W, Pin R, Foot snap, Body contact")),
		clear("4.14a"),
		{ id: "4.14", narration: t("모션 모드는 테이크를 자르고, 끝을 트림하고, 구간 배속을 바꿉니다.", "Motion mode cuts the take, trims its ends and retimes segments."), key: "4" },
		spot("4.14b", [".tl-transport", "[data-testid=\"sequencer-cut\"]"], t("모션 모드 (4)", "Motion mode (4)"), t("자르기, 트림, 배속", "Cut, trim, retime")),
		clear("4.15a"),
		{ id: "4.15", narration: t("배치 모드로 돌아갑니다.", "Back to Stage mode."), key: "1" },
	],
};
