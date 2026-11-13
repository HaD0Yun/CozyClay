import { createContext, useContext, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useStudioShell } from "./studio-shell-context.js";
import SourceOffer from "../source-offer.jsx";
import { ko } from "../locale.js"; import { WORKFLOW_ENTRY_ENABLED } from "../workflow-entry.js";
import { noteShortcutsOpened } from "../shortcut-friction.js";
import { appVersion } from "../app-version.js";
import { useExportMenuTelemetry } from "../export-menu-telemetry.js";

const MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform ?? "");
const MOD = MAC ? "⌘" : "Ctrl+";
const SHIFT = MAC ? "⇧" : "Shift+";
const MARGIN = 8;

/** The items of one menu, not of a flyout nested inside it. */
function menuItems(menu) {
	return [...menu.querySelectorAll('[role^="menuitem"]')]
		.filter((item) => item.closest('[role="menu"]') === menu && !item.disabled);
}

// Fixed-position placement from an anchor rect, the portal Dropdown's
// geometry (src/ui.jsx): below the anchor, or beside it for a flyout, and
// always clamped inside the viewport so narrow windows keep every item.
function place(anchor, popup, side, align) {
	const a = anchor.getBoundingClientRect();
	const width = popup.offsetWidth;
	const vw = window.innerWidth;
	const vh = window.innerHeight;
	const clampX = (x) => Math.max(MARGIN, Math.min(x, vw - width - MARGIN));
	let left;
	let top;
	if (side === "right" && a.right + width + MARGIN <= vw) {
		left = a.right;
		top = a.top - 4;
	} else if (side === "right" && a.left - width - MARGIN >= 0) {
		left = a.left - width;
		top = a.top - 4;
	} else {
		left = clampX(align === "end" ? a.right - width : a.left);
		top = a.bottom + (side === "right" ? 0 : 4);
	}
	const maxHeight = Math.max(120, vh - top - MARGIN);
	return { left: clampX(left), top: Math.max(MARGIN, top), maxHeight };
}

// A flyout is placed from its trigger, which only has its final rect once the
// parent menu is placed; the parent's box is therefore a dependency.
const ParentBox = createContext(null);

function usePlacement(anchorRef, popupRef, side, align, ready) {
	const [box, setBox] = useState(null);
	useLayoutEffect(() => {
		if (!ready) return undefined;
		const update = () => {
			if (!anchorRef.current || !popupRef.current) return;
			const next = place(anchorRef.current, popupRef.current, side, align);
			setBox((prev) => (prev && prev.left === next.left && prev.top === next.top && prev.maxHeight === next.maxHeight ? prev : next));
		};
		update();
		const observer = new ResizeObserver(update);
		if (popupRef.current) observer.observe(popupRef.current);
		return () => observer.disconnect();
	}, [anchorRef, popupRef, side, align, ready]);
	return box;
}

/** Keyboard opening moves focus to the first item, once the menu is placed:
 * an unplaced menu is still visibility:hidden and cannot take focus. */
function useFirstItemFocus(ref, box, autoFocus, onAutoFocused) {
	useEffect(() => {
		if (!box || !autoFocus || !ref.current) return;
		menuItems(ref.current)[0]?.focus();
		onAutoFocused?.();
	}, [ref, box, autoFocus, onAutoFocused]);
}

/** One portaled menu. Outside presses, Escape and window resizes dismiss it;
 * arrow keys walk its items. `keepOpen` reports a nested flyout that owns
 * Escape first (App closes the Export flyout on the same key). */
function MenuPopover({ anchorRef, ignoreRef, onClose, align = "start", label, className = "", keepOpen, onKeyDown, autoFocus, onAutoFocused, children, menuRef: externalRef, ...props }) {
	const ownRef = useRef(null);
	const menuRef = externalRef ?? ownRef;
	const box = usePlacement(anchorRef, menuRef, "below", align, true);
	useFirstItemFocus(menuRef, box, autoFocus, onAutoFocused);
	const close = useRef(onClose);
	close.current = onClose;
	const keep = useRef(keepOpen);
	keep.current = keepOpen;
	useEffect(() => {
		const onPointerDown = (event) => {
			const target = event.target;
			if (!(target instanceof Node)) return;
			if (menuRef.current?.contains(target) || anchorRef.current?.contains(target) || ignoreRef?.current?.contains(target)) return;
			close.current(false);
		};
		const onKey = (event) => {
			if (event.key !== "Escape" || keep.current?.()) return;
			event.preventDefault();
			close.current(true);
		};
		const onResize = () => close.current(false);
		document.addEventListener("pointerdown", onPointerDown);
		document.addEventListener("keydown", onKey);
		window.addEventListener("resize", onResize);
		return () => {
			document.removeEventListener("pointerdown", onPointerDown);
			document.removeEventListener("keydown", onKey);
			window.removeEventListener("resize", onResize);
		};
	}, [anchorRef, ignoreRef, menuRef]);
	const walk = (event) => {
		onKeyDown?.(event);
		if (event.defaultPrevented || !["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
		const menu = document.activeElement?.closest?.('[role="menu"]') ?? menuRef.current;
		const items = menuItems(menu);
		if (!items.length) return;
		event.preventDefault();
		const at = items.indexOf(document.activeElement);
		const next = event.key === "Home" ? 0
			: event.key === "End" ? items.length - 1
				: event.key === "ArrowDown" ? (at + 1) % items.length
					: (at - 1 + items.length) % items.length;
		items[next].focus();
	};
	return createPortal(
		<div
			{...props}
			ref={menuRef}
			role="menu"
			tabIndex={-1}
			aria-label={label}
			className={"menubar-menu " + className}
			style={{ position: "fixed", left: box?.left ?? -9999, top: box?.top ?? 0, maxHeight: box?.maxHeight, visibility: box ? "visible" : "hidden" }}
			onKeyDown={walk}
		>
			<ParentBox.Provider value={box}>{children}</ParentBox.Provider>
		</div>,
		document.body,
	);
}

/** The Export flyout. It stays a child of `.export-menu-wrap` (App dismisses it
 * on presses outside that wrap) but is fixed beside its trigger. */
function ExportFlyout({ anchorRef, autoFocus, onAutoFocused, children }) {
	const ref = useRef(null);
	const parent = useContext(ParentBox);
	const box = usePlacement(anchorRef, ref, "right", "start", parent);
	useFirstItemFocus(ref, box, autoFocus, onAutoFocused);
	return (
		<div
			ref={ref}
			className="menubar-menu export-menu"
			role="menu"
			aria-label={ko("Export", "내보내기")}
			style={{ position: "fixed", left: box?.left ?? -9999, top: box?.top ?? 0, right: "auto", maxHeight: box?.maxHeight, visibility: box ? "visible" : "hidden" }}
		>
			{children}
		</div>
	);
}

function Shortcut({ keys }) {
	return <kbd className="menubar-item-key">{keys}</kbd>;
}

const MENUS = [
	{ id: "file", label: () => ko("File", "파일") },
	{ id: "edit", label: () => ko("Edit", "편집") },
	{ id: "window", label: () => ko("Window", "창") },
	{ id: "help", label: () => ko("Help", "도움말") },
];

export default function MenuBar({ preferences }) {
	const shell = useStudioShell();
	const {
		runStudioAction, projectSaveState, previsMode, recState, exportMenuTriggerRef, exportMenuOpen,
		exportShotIdRef, setExportMenuOpen, shots, exportKeyframePacks, hasCameraKeys, motion,
		exportRenderPasses, exportDepthVideo, exportStoryboard, downloadOtioCutList,
		exportContactSheet, exportPanelPacks, exportAnimatic,
		castDomain, preferencesOpen, setPreferencesOpen, agentOpen, toggleAgent,
		setToast, embedMode, setProjectStartupOpen, setProjectBrowserOpen,
	} = shell;
	const [open, setOpen] = useState(null);
	const [focusFirst, setFocusFirst] = useState(false);
	const [dialog, setDialog] = useState(null);
	const rootRef = useRef(null);
	const menuRef = useRef(null);
	const triggerRefs = useRef({});
	const anchorRef = useRef(null);
	anchorRef.current = open ? triggerRefs.current[open] : null;
	const exportOpenRef = useRef(exportMenuOpen);
	exportOpenRef.current = exportMenuOpen;
	const recording = recState === "recording";
	// A storyboard project exports panels (its stills), never clip packs or shot video.
	const storyboard = previsMode === "storyboard";
	const panelCount = storyboard ? shots.filter((entry) => entry.kind === "still").length : 0;
	const noPanels = ko("Add a panel first — storyboard exports describe panels", "패널을 먼저 추가하세요 — 스토리보드 내보내기는 패널을 담습니다");
	const packReason = storyboard
		? panelCount ? "" : noPanels
		: shots.length ? "" : ko("Add a shot first — a pack describes one cut", "샷을 먼저 추가하세요 — 팩은 컷 하나를 설명합니다");

	// Export's flyout lives in File, so an open Export menu opens File; each open is counted.
	useEffect(() => { if (exportMenuOpen) setOpen("file"); }, [exportMenuOpen]);
	useExportMenuTelemetry(exportMenuOpen, shell);

	const closeMenus = (focusTrigger) => {
		const was = open;
		if (exportOpenRef.current) {
			exportShotIdRef.current = null;
			setExportMenuOpen(false);
		}
		setOpen(null);
		setFlyoutFocus(false);
		if (focusTrigger && was) triggerRefs.current[was]?.focus();
	};

	// Keyboard focus follows the Export flyout into its first item.
	const [flyoutFocus, setFlyoutFocus] = useState(false);
	const focusedFirst = useRef(() => setFocusFirst(false)).current;
	const focusedFlyout = useRef(() => setFlyoutFocus(false)).current;

	// The Preferences dialog's own Settings trigger is not part of the 2a bar;
	// when the dialog closes with focus nowhere, focus returns to Edit.
	const preferencesWasOpen = useRef(preferencesOpen);
	useEffect(() => {
		const was = preferencesWasOpen.current;
		preferencesWasOpen.current = preferencesOpen;
		if (!was || preferencesOpen) return;
		const active = document.activeElement;
		if (!active || active === document.body || !active.isConnected) triggerRefs.current.edit?.focus();
	}, [preferencesOpen]);

	// ⌘S saves and ⌘E exports the keyframe pack (G7), from anywhere in the studio.
	const keys = useRef(null);
	keys.current = { runStudioAction, projectSaveState, recording, packReason, exportKeyframePacks: storyboard ? exportPanelPacks : exportKeyframePacks, setToast };
	useEffect(() => {
		if (embedMode) return undefined;
		const onKeyDown = (event) => {
			if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
			const current = keys.current;
			if (event.code === "KeyS" && !event.shiftKey) {
				event.preventDefault();
				if (current.projectSaveState !== "saving") void current.runStudioAction("project.save");
			} else if (event.code === "KeyE") {
				event.preventDefault();
				if (current.recording) return;
				if (current.packReason) current.setToast(current.packReason);
				else void current.exportKeyframePacks(event.shiftKey, null);
			}
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [embedMode]);

	const move = (step) => {
		const at = MENUS.findIndex((menu) => menu.id === open);
		const next = MENUS[(at + step + MENUS.length) % MENUS.length].id;
		closeMenus(false);
		setOpen(next);
		setFocusFirst(true);
		triggerRefs.current[next]?.focus();
	};
	const onMenuKey = (event) => {
		const inFlyout = document.activeElement?.closest?.(".export-menu");
		if (event.key === "ArrowRight") {
			event.preventDefault();
			if (document.activeElement?.id === "export-menu-trigger") {
				if (exportMenuOpen) {
					const flyout = menuRef.current?.querySelector(".export-menu");
					if (flyout) menuItems(flyout)[0]?.focus();
				} else {
					setFlyoutFocus(true);
					setExportMenuOpen(true);
				}
			} else if (!inFlyout) move(1);
		} else if (event.key === "ArrowLeft") {
			event.preventDefault();
			if (inFlyout) {
				exportShotIdRef.current = null;
				setExportMenuOpen(false);
				exportMenuTriggerRef.current?.focus();
			} else move(-1);
		}
	};
	const item = (onSelect) => () => {
		closeMenus(false);
		onSelect();
	};
	const panelItem = (testId, label, title, onSelect, shortcut = null) => (
		<button
			type="button"
			role="menuitem"
			className="menubar-item"
			data-testid={testId}
			disabled={!panelCount || recording}
			data-disabled-reason={panelCount ? undefined : "no-panels"}
			title={panelCount ? title : noPanels}
			onClick={() => {
				const shotId = exportShotIdRef.current;
				closeMenus(false);
				onSelect(shotId);
			}}
		>
			<span className="menubar-item-label">{label}</span>
			{shortcut && <Shortcut keys={shortcut} />}
		</button>
	);
	const storyboardExports = (
		<>
			{panelItem("export-contact-sheet", ko("Contact sheet (PNG)", "콘택트 시트 (PNG)"),
				ko("Every panel with its caption on one sheet", "모든 패널과 캡션을 한 장에"), () => void exportContactSheet())}
			{panelItem("export-panel-pack", ko("Panel pack (zip)", "패널 팩 (zip)"),
				ko("The selected panel's frame, stylized image, camera and prompt as one zip", "선택한 패널의 프레임·스타일 이미지·카메라·프롬프트를 zip 하나로"),
				(shotId) => void exportPanelPacks(false, shotId), `${MOD}E`)}
			{panelItem("export-all-panels", ko("All panels (zip)", "모든 패널 (zip)"),
				ko("One zip with a folder per panel", "패널마다 폴더 하나씩 담은 zip"), () => void exportPanelPacks(true, null))}
			{panelItem("export-animatic", ko("Animatic (mp4)", "애니매틱 (mp4)"),
				ko("Every panel held for its hold, as one MP4", "모든 패널을 홀드만큼 이어 MP4 하나로"), () => void exportAnimatic())}
			{panelItem("export-otio", ko("Cut list (OTIO)", "컷 목록 (OTIO)"),
				ko("Download the OTIO cut list; each panel is a clip as long as its hold", "OTIO 컷 목록 다운로드 — 패널마다 홀드 길이의 클립"), () => downloadOtioCutList())}
			{panelItem("export-render-passes", ko("Depth + normal (PNG)", "뎁스 + 노멀 (PNG)"),
				ko("Depth and normal conditioning plates of the current framing", "현재 프레이밍의 뎁스·노멀 컨디션 플레이트"), () => exportRenderPasses())}
		</>
	);

	const content = {
		file: (
			<>
				{/* New opens the 2b start screen, the same one first launch shows. Its
				    Create runs project.new, which still asks before discarding unsaved changes. */}
				<button type="button" role="menuitem" className="menubar-item" data-testid="menubar-new" onClick={item(() => { setProjectBrowserOpen(false); setProjectStartupOpen(true); })}>
					<span className="menubar-item-label">{ko("New", "새로 만들기")}</span>
				</button>
				<button type="button" role="menuitem" className="menubar-item" onClick={item(() => runStudioAction("project.browse"))}>
					<span className="menubar-item-label">{ko("Open…", "열기…")}</span>
				</button>
				<button
					type="button"
					role="menuitem"
					className="menubar-item"
					data-testid="topbar-save"
					disabled={projectSaveState === "saving"}
					onClick={item(() => runStudioAction("project.save"))}
				>
					<span className="menubar-item-label">{projectSaveState === "saving" ? ko("Saving…", "저장 중…") : ko("Save", "저장")}</span>
					<Shortcut keys={`${MOD}S`} />
				</button>
				<button type="button" role="menuitem" className="menubar-item" onClick={item(() => runStudioAction("project.saveAs"))}>
					<span className="menubar-item-label">{ko("Save As…", "다른 이름으로 저장…")}</span>
				</button>
				{previsMode === "storyboard" && (
					<button
						type="button"
						role="menuitem"
						className="menubar-item"
						data-testid="export-animation-project" data-fid="export_animation_project"
						onClick={item(() => runStudioAction("project.exportAsAnimation"))}
					>
						<span className="menubar-item-label">{ko("Export as Animation project…", "애니메이션 프로젝트로 내보내기…")}</span>
					</button>
				)}
				<hr className="menubar-separator" />
				{/* One Export menu for every delivery this studio makes (#193,
				    R4). The keyframe pack leads because it is the pack an AI video
				    tool is fed. One element cannot carry two data-testids: the
				    topbar contract keeps the attribute, the menu contract gets the
				    same handle as an id, so both selectors reach this trigger. */}
				<div className="export-menu-wrap">
					<button
						type="button"
						role="menuitem"
						className={"menubar-item" + (recording ? " recording" : "")}
						data-testid="topbar-export"
						id="export-menu-trigger"
						ref={exportMenuTriggerRef}
						aria-haspopup="menu"
						aria-expanded={exportMenuOpen}
						title={ko("Exports: keyframe pack, video, passes, storyboard, cut list", "내보내기: 키프레임 팩·영상·패스·스토리보드·컷 목록")}
						onClick={() => {
							exportShotIdRef.current = null;
							setExportMenuOpen((value) => !value);
						}}
					>
						<span className="menubar-item-label">{ko("Export", "내보내기")}</span>
						<span className="menubar-item-sub" aria-hidden="true">▸</span>
					</button>
					{exportMenuOpen && (
						<ExportFlyout anchorRef={exportMenuTriggerRef} autoFocus={flyoutFocus} onAutoFocused={focusedFlyout}>
							{storyboard ? storyboardExports : (<>
							<button
								type="button"
								role="menuitem"
								className="menubar-item export-menu-primary"
								data-testid="export-keyframe-pack" data-fid="export_keyframe_pack"
								disabled={!shots.length || recording}
								data-disabled-reason={shots.length ? undefined : "no-shots"}
								title={shots.length
									? ko("First/last frames, clip, camera and prompt as one zip — hold Shift for every shot", "첫/마지막 프레임·클립·카메라·프롬프트를 zip 하나로 — Shift를 누르면 모든 샷")
									: packReason}
								onClick={(event) => {
									const every = event.shiftKey;
									const shotId = exportShotIdRef.current;
									closeMenus(false);
									void exportKeyframePacks(every, shotId);
								}}
							>
								<span className="menubar-item-label">{ko("Keyframe pack (zip)", "키프레임 팩 (zip)")}</span>
								<Shortcut keys={`${MOD}E`} />
							</button>
							{(shots.length > 0 || hasCameraKeys || motion) && (
								<button
									type="button"
									role="menuitem"
									className="menubar-item"
									data-testid="export-video" data-fid="export_video"
									disabled={recording}
									title={ko("Render the whole timeline to one MP4 — every shot back to back, camera and motion, no editor chrome", "타임라인 전체를 MP4 하나로 — 모든 샷을 이어서, 카메라·모션만, 편집 UI 제외")}
									onClick={() => {
										closeMenus(false);
										void runStudioAction("export.shotVideo", { scope: "timeline" });
									}}
								>
									<span className="menubar-item-label">{ko("Video — whole timeline (mp4)", "영상 — 타임라인 전체 (mp4)")}</span>
								</button>
							)}
							{shots.length > 0 && (
								<button
									type="button"
									role="menuitem"
									className="menubar-item"
									data-testid="export-video-shot" data-fid="export_video_shot"
									disabled={recording}
									title={ko("Render one shot to its own MP4 — the shot you opened the menu from, or the one under the playhead", "샷 하나만 MP4로 — 메뉴를 연 샷, 아니면 재생 위치의 샷")}
									onClick={() => {
										const shotId = exportShotIdRef.current;
										closeMenus(false);
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
								onClick={item(exportRenderPasses)}
							>
								<span className="menubar-item-label">{ko("Depth + normal passes", "뎁스 + 노멀 패스")}</span>
							</button>
							<button
								type="button"
								role="menuitem"
								className="menubar-item"
								data-testid="export-depth-video" data-fid="export_depth_video"
								disabled={!shots.length || recording}
								data-disabled-reason={shots.length ? undefined : "no-shots"}
								title={ko("Depth pass of the whole shot as an mp4 for video-model conditioning", "샷 전체의 뎁스 패스를 mp4로 — 영상 모델 컨디셔닝용")}
								onClick={() => {
									const shotId = exportShotIdRef.current;
									closeMenus(false);
									void exportDepthVideo(shotId);
								}}
							>
								<span className="menubar-item-label">{ko("Depth (mp4)", "뎁스 (mp4)")}</span>
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
								onClick={item(() => void exportStoryboard())}
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
									onClick={item(downloadOtioCutList)}
								>
									<span className="menubar-item-label">{ko("OTIO cut list", "OTIO 컷 목록")}</span>
								</button>
							)}
							{!shots.length && (
								<p className="export-menu-hint">
									{hasCameraKeys || motion
										? ko("Add a shot to export OTIO", "OTIO를 내보내려면 샷을 추가하세요")
										: ko("Add a shot to export video or OTIO", "영상·OTIO를 내보내려면 샷을 추가하세요")}
								</p>
							)}
							</>)}
						</ExportFlyout>
					)}
				</div>
			</>
		),
		edit: (
			<>
				<button type="button" role="menuitem" className="menubar-item" data-fid="menu_undo" onClick={item(() => castDomain.undoScene("menu"))}>
					<span className="menubar-item-label">{ko("Undo", "실행 취소")}</span>
					<Shortcut keys={`${MOD}Z`} />
				</button>
				<button type="button" role="menuitem" className="menubar-item" data-fid="menu_redo" onClick={item(() => castDomain.redoScene())}>
					<span className="menubar-item-label">{ko("Redo", "다시 실행")}</span>
					<Shortcut keys={`${SHIFT}${MOD}Z`} />
				</button>
				<hr className="menubar-separator" />
				<button type="button" role="menuitem" className="menubar-item" data-testid="menu-preferences" onClick={item(() => setPreferencesOpen(true))}>
					<span className="menubar-item-label">{ko("Preferences…", "환경설정…")}</span>
				</button>
			</>
		),
		window: (
			<>
				<button type="button" role="menuitemcheckbox" aria-checked={agentOpen} className="menubar-item" data-testid="menu-agent" onClick={item(toggleAgent)}>
					<span className="menubar-item-label">{ko("Agent", "에이전트")}</span>
					<Shortcut keys={`${MOD}B`} />
				</button>
				{WORKFLOW_ENTRY_ENABLED && <><hr className="menubar-separator" />
				<a role="menuitem" className="menubar-item workflow-topbar-link" href="/workflow/" aria-label={ko("Open Workflow", "워크플로 열기")}>
					<span className="menubar-item-label">{ko("Workflow", "워크플로우")}</span>
				</a></>}
			</>
		),
		help: (
			<>
				<button type="button" role="menuitem" className="menubar-item" onClick={item(() => { setDialog("shortcuts"); noteShortcutsOpened(); })}>
					<span className="menubar-item-label">{ko("Keyboard shortcuts", "단축키")}</span></button>
				<button type="button" role="menuitem" className="menubar-item" onClick={item(() => setDialog("about"))}>
					<span className="menubar-item-label">{ko("About Cozy Clay", "Cozy Clay 정보")}</span>
				</button>
			</>
		),
	};

	return (
		<nav className="menubar" aria-label={ko("Menu bar", "메뉴 막대")} ref={rootRef}>
			{MENUS.map((menu) => (
				<div className="menubar-slot" key={menu.id}>
					<button
						type="button"
						className="menubar-trigger"
						data-testid={`menu-${menu.id}`}
						ref={(node) => { triggerRefs.current[menu.id] = node; }}
						aria-haspopup="menu"
						aria-expanded={open === menu.id}
						onPointerEnter={() => {
							if (open && open !== menu.id) {
								closeMenus(false);
								setOpen(menu.id);
							}
						}}
						onKeyDown={(event) => {
							if (event.key !== "ArrowDown") return;
							event.preventDefault();
							setOpen(menu.id);
							setFocusFirst(true);
						}}
						onClick={(event) => {
							if (open === menu.id) closeMenus(false);
							else {
								closeMenus(false);
								setOpen(menu.id);
								// Keyboard activation (detail 0) moves focus into the menu.
								if (event.detail === 0) setFocusFirst(true);
							}
						}}
					>
						{menu.label()}
					</button>
					{menu.id === "edit" && <span className="menubar-preferences-host">{preferences}</span>}
				</div>
			))}
			{open && (
				<MenuPopover
					key={open}
					menuRef={menuRef}
					anchorRef={anchorRef}
					ignoreRef={rootRef}
					data-menu={open}
					label={MENUS.find((menu) => menu.id === open).label()}
					keepOpen={() => exportOpenRef.current}
					onClose={closeMenus}
					onKeyDown={onMenuKey}
					autoFocus={focusFirst}
					onAutoFocused={focusedFirst}
				>
					{content[open]}
				</MenuPopover>
			)}
			{dialog && <MenuDialog kind={dialog} onClose={() => setDialog(null)} />}
		</nav>
	);
}

const SHORTCUTS = [
	["1 2 3 4", () => ko("Stage / Pose / Camera / Motion mode", "배치 / 포즈 / 카메라 / 모션 모드")],
	["W E R", () => ko("Pick the tool of the current mode", "현재 모드의 도구 선택")],
	["F", () => ko("Frame the selection", "선택 항목으로 화면 맞춤")],
	["Space", () => ko("Play / pause", "재생 / 일시정지")],
	["J K", () => ko("Step one frame", "한 프레임 이동")],
	[`${MOD}Z`, () => ko("Undo", "실행 취소")],
	[`${SHIFT}${MOD}Z`, () => ko("Redo", "다시 실행")],
	[`${MOD}S`, () => ko("Save", "저장")],
	[`${MOD}E`, () => ko("Export keyframe pack", "키프레임 팩 내보내기")],
	[`${MOD}D`, () => ko("Duplicate object", "오브젝트 복제")],
	[`${MOD}B`, () => ko("Agent", "에이전트")],
	["Delete", () => ko("Delete the selection", "선택 항목 삭제")],
];

function MenuDialog({ kind, onClose }) {
	const closeRef = useRef(null);
	const titleId = useId();
	useEffect(() => {
		closeRef.current?.focus();
		const onKey = (event) => {
			if (event.key !== "Escape") return;
			event.preventDefault();
			onClose();
		};
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, [onClose]);
	return createPortal(
		<div className="menubar-dialog-backdrop" onPointerDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
			<div className="menubar-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} data-dialog={kind}>
				<header className="menubar-dialog-head">
					<h2 id={titleId}>{kind === "about" ? <span className="menubar-dialog-brand">Cozy <span>Clay</span></span> : ko("Keyboard shortcuts", "단축키")}</h2>
					<button type="button" ref={closeRef} className="menubar-dialog-close" aria-label={ko("Close", "닫기")} onClick={onClose}>
						<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
					</button>
				</header>
				{kind === "about" ? (
					<div className="menubar-dialog-body">
						<p>{ko("Previs studio: stage, pose, camera and motion.", "프리비즈 스튜디오: 배치, 포즈, 카메라, 모션.")}</p>
						<p className="menubar-dialog-meta">{ko("Version", "버전")} {appVersion()}</p>
						<SourceOffer />
					</div>
				) : (
					<dl className="menubar-dialog-body menubar-shortcuts">
						{SHORTCUTS.map(([keys, label]) => (
							<div className="menubar-shortcut" key={keys}>
								<dt>{label()}</dt>
								<dd><kbd>{keys}</kbd></dd>
							</div>
						))}
					</dl>
				)}
			</div>
		</div>,
		document.body,
	);
}
