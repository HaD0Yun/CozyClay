// Chapter 6 · Export: the seven exports, then the keyframe pack itself.
import { chapterCard, clear, spot, spots, t } from "./steps.mjs";

const item = (id) => `[data-testid="${id}"]`;

export default {
	id: "export",
	title: t("6 · 내보내기", "6 · Export"),
	steps: [
		chapterCard("6.0", t("6 · 내보내기", "6 · Export"), t("키프레임 팩과 영상 모델", "The keyframe pack and the video model")),
		{
			id: "6.1",
			narration: t("내보내기는 파일 메뉴에 있습니다. 일곱 가지를 차례로 봅니다.", "Export lives under File. Seven kinds, in order."),
			menu: { open: item("menu-file"), then: item("topbar-export") },
		},
		spot("6.1b", item("topbar-export"), t("파일 › 내보내기", "File › Export"), t("일곱 가지", "Seven exports")),
		spot("6.2", item("export-keyframe-pack"), t("키프레임 팩 (zip) ⌘E", "Keyframe pack (zip) ⌘E"), t("첫·끝 프레임, 클립, 카메라, 프롬프트", "First and last frames, clip, camera and prompt"), {
			caption: t("키프레임 팩은 영상 모델에 줄 참조 묶음입니다. Shift를 누른 채 고르면 모든 샷을 내보냅니다.", "The keyframe pack is the reference bundle for a video model. Hold Shift to export every shot."),
		}),
		...spots("6.3", [item("export-video"), item("export-video-shot")], t("영상 (mp4)", "Video (mp4)"), t("타임라인 전체 또는 이 샷만", "Whole timeline or this shot only"), {
			caption: t("영상은 타임라인 전체를 한 mp4로, 또는 샷 하나만 렌더합니다. 에디터 UI 없이 카메라와 모션만 나옵니다.", "Video renders the whole timeline to one mp4, or one shot. Camera and motion only, no editor chrome."),
		}),
		...spots("6.4", [item("export-render-passes"), item("export-depth-video")], t("뎁스 + 노멀", "Depth + normal"), t("영상 모델 컨디셔닝용", "Conditioning plates for a video model"), {
			caption: t("뎁스와 노멀 패스는 현재 프레이밍의 컨디셔닝 이미지이고, 뎁스 mp4는 샷 전체의 뎁스 영상입니다.", "Depth and normal passes are conditioning plates of the framing; Depth mp4 is the depth pass of the whole shot."),
		}),
		...spots("6.5", [item("export-storyboard"), item("export-otio")], t("스토리보드 / OTIO", "Storyboard / OTIO"), t("샷별 콘택트 시트 / 컷 목록", "A contact sheet per shot / the cut list"), {
			caption: t("스토리보드는 모든 샷과 프롬프트를 한 장에 모은 PNG, OTIO는 편집 프로그램용 컷 목록입니다.", "Storyboard is one PNG of every shot with its prompt; OTIO is the cut list for an editing app."),
		}),
		clear("6.6a"),
		{
			id: "6.6",
			narration: t("키프레임 팩이 다운로드 폴더에 내려갑니다. zip 하나에 여섯 파일이 들어 있습니다.", "The keyframe pack lands in your downloads. One zip, six files."),
			click: item("export-keyframe-pack"),
			until: ".toast",
		},
		// The toast unmounts after 2.2 s (src/ui.jsx), so the ring shows at once and only as long.
		spot("6.6b", ".toast", t("내보내기 완료", "Export completed"), t("zip 하나에 6개 파일", "One zip, six files"), { hold: 2000, glide: false }),
		clear("6.6c"),
		{
			id: "6.7",
			narration: t("first.png와 last.png는 시작·끝 모습, clip.mp4는 따라야 할 움직임, camera.json은 렌즈와 화면비, prompt.txt는 샷 설명, README.txt는 사용법입니다.", "first.png and last.png are the start and end looks, clip.mp4 the motion to follow, camera.json the lens and aspect, prompt.txt the shot description, README.txt the how-to."),
			hold: 7000,
		},
		{
			id: "6.8",
			narration: t("이 묶음을 Seedance 같은 영상 모델에 참조로 넣으면 모델이 추측 대신 여러분의 블로킹을 따라갑니다.", "Feed this bundle to a video model such as Seedance as references, and it follows your blocking instead of guessing."),
			hold: 6000,
		},
		{
			id: "closing",
			card: {
				title: t("끝", "That's the loop"),
				subtitle: t("배치 → 모션 → 카메라 → 내보내기 · 문서: github.com/HaD0Yun/CozyClay", "Stage → Motion → Camera → Export · Docs: github.com/HaD0Yun/CozyClay"),
				chapters: true,
			},
			hold: 4000,
		},
	],
};
