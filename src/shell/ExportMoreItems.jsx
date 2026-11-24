import { ko } from "../locale.js";

// The Export menu's other formats: the keyframe pack, one shot's video, the still passes, the storyboard sheet and the
// cut list. The menu shows them only when it is opened with Alt (Option) held; plainly opened it has three items
// (MenuBar.jsx). Its own file so the menu bar stays short.
export default function ExportMoreItems({ shots, recording, packReason, shotIdRef, shortcut, close, select, runStudioAction, exportKeyframePacks, exportRenderPasses, exportStoryboard, downloadOtioCutList }) {
	return (
		<>
			<hr className="menubar-separator" />
			<button
				type="button"
				role="menuitem"
				className="menubar-item"
				data-testid="export-keyframe-pack" data-fid="export_keyframe_pack"
				disabled={!shots.length || recording}
				data-disabled-reason={shots.length ? undefined : "no-shots"}
				title={shots.length
					? ko("First/last frames, clip, camera and prompt as one zip — hold Shift for every shot", "첫/마지막 프레임·클립·카메라·프롬프트를 zip 하나로 — Shift를 누르면 모든 샷")
					: packReason}
				onClick={(event) => {
					const every = event.shiftKey;
					const shotId = shotIdRef.current;
					close();
					void exportKeyframePacks(every, shotId);
				}}
			>
				<span className="menubar-item-label">{ko("Keyframe pack (zip)", "키프레임 팩 (zip)")}</span>
				{shortcut}
			</button>
			{shots.length > 0 && (
				<button
					type="button"
					role="menuitem"
					className="menubar-item"
					data-testid="export-video-shot" data-fid="export_video_shot"
					disabled={recording}
					title={ko("Render one shot to its own MP4 — the shot you opened the menu from, or the one under the playhead", "샷 하나만 MP4로 — 메뉴를 연 샷, 아니면 재생 위치의 샷")}
					onClick={() => {
						const shotId = shotIdRef.current;
						close();
						void runStudioAction("export.shotVideo", shotId ? { shotId, scope: "shot" } : { scope: "shot" });
					}}
				>
					<span className="menubar-item-label">{ko("Video — this shot only (mp4)", "영상 — 이 샷만 (mp4)")}</span>
				</button>
			)}
			<button
				type="button"
				role="menuitem"
				className="menubar-item"
				data-testid="export-render-passes" data-fid="export_render_passes"
				disabled={recording}
				title={ko("Depth and normal conditioning plates of the current framing", "현재 프레이밍의 뎁스·노멀 컨디션 플레이트")}
				onClick={select(exportRenderPasses)}
			>
				<span className="menubar-item-label">{ko("Depth + normal passes", "뎁스 + 노멀 패스")}</span>
			</button>
			<button
				type="button"
				role="menuitem"
				className="menubar-item"
				data-testid="export-storyboard" data-fid="export_storyboard"
				disabled={!shots.length || recording}
				data-disabled-reason={shots.length ? undefined : "no-shots"}
				title={shots.length
					? ko("Contact sheet of every shot with its prompt", "모든 샷과 프롬프트를 담은 콘택트 시트")
					: ko("Add a shot first — a storyboard is one row per shot", "샷을 먼저 추가하세요 — 스토리보드는 샷마다 한 줄입니다")}
				onClick={select(() => void exportStoryboard())}
			>
				<span className="menubar-item-label">{ko("Storyboard (PNG)", "스토리보드 (PNG)")}</span>
			</button>
			{shots.length > 0 && (
				<button
					type="button"
					role="menuitem"
					className="menubar-item"
					data-testid="export-otio" data-fid="export_otio"
					title={ko("Download OTIO cut list", "OTIO 컷 목록 다운로드")}
					onClick={select(downloadOtioCutList)}
				>
					<span className="menubar-item-label">{ko("OTIO cut list", "OTIO 컷 목록")}</span>
				</button>
			)}
		</>
	);
}
