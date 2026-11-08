import { useEffect, useState } from "react";
import { installClickFriction } from "../click-friction.js";
import { installWheelNumber } from "../wheel-number.js";
import { ko } from "../locale.js";
import { noteNavSwitch } from "../thrash-friction.js";
import { useStudioShell } from "./studio-shell-context.js";
import TopBar, { ProjectHead } from "./TopBar.jsx";
import OutlinerSlot from "./OutlinerSlot.jsx";
import DetailsSlot from "./DetailsSlot.jsx";
import BottomDock from "./BottomDock.jsx";
import StatusBar from "./StatusBar.jsx";
import PreferencesSlot from "./PreferencesSlot.jsx";
import "./shell.css";
import "./glass.css";
import "./glass-regions.css";
import "./agent-glass.css";
import "./type-scale.css";

const DOCK_TAB_KEY = "cozyclay.dock.tab.v1";
const LEFT_COLLAPSED_KEY = "cozyclay.shell.left-collapsed.v1";

function readLeftCollapsed() {
	try {
		return globalThis.localStorage?.getItem(LEFT_COLLAPSED_KEY) === "1";
	} catch {
		return false;
	}
}

function readDockTab() {
	try {
		return globalThis.localStorage?.getItem(DOCK_TAB_KEY) === "assets" ? "assets" : "animation";
	} catch {
		return "animation";
	}
}

// #570 floating-glass shell: the viewport fills the window and every region
// floats over it. Left: the Outliner. Right: Details over Agent. Bottom, from
// the left edge to the right column: the dock, switching between Animation
// (the Sequencer with the shot preview at its right end) and Assets.
export default function StudioShell({ viewport, children, ...props }) {
	const { beginWorkspaceResize } = useStudioShell();
	const [dockTab, setDockTab] = useState(readDockTab);
	// The Outliner column folds to a 44px rail (--shell-left in shell.css), and
	// the viewport's overlays follow it because they all hang off that width.
	const [leftCollapsed, setLeftCollapsed] = useState(readLeftCollapsed);
	// Embeds (playview, playground) keep the Sequencer-only dock.
	const embedded = Boolean(props["data-embed-mode"]);
	const shownTab = embedded ? "animation" : dockTab;
	// Rage and dead clicks on the primary controls (data-fid): one capture-phase listener for the whole shell.
	useEffect(() => installClickFriction(), []);
	useEffect(() => installWheelNumber(), []);
	function toggleLeft() {
		setLeftCollapsed((current) => {
			try {
				globalThis.localStorage?.setItem(LEFT_COLLAPSED_KEY, current ? "0" : "1");
			} catch (error) {
				console.warn(`[cozyclay] could not store ${LEFT_COLLAPSED_KEY}`, error);
			}
			return !current;
		});
	}
	function changeDockTab(next) {
		// A user's tab flip toward nav:thrash (thrash-friction.js).
		if (next !== dockTab) noteNavSwitch("dock_tab");
		setDockTab(next);
		try {
			globalThis.localStorage?.setItem(DOCK_TAB_KEY, next);
		} catch (error) {
			console.warn(`[cozyclay] could not store ${DOCK_TAB_KEY}`, error);
		}
	}
	return (
		<div {...props} data-shell="glass" data-dock-tab={shownTab} data-left-collapsed={!embedded && leftCollapsed ? "" : undefined}>
			<TopBar preferences={<PreferencesSlot />} />
			<div className="main">
				<div className="workspace">
					{viewport}
					<div className="studio-left-column">
						<button
							type="button"
							className="shell-left-toggle"
							data-testid="shell-left-toggle"
							aria-expanded={!leftCollapsed}
							aria-label={leftCollapsed ? ko("Expand Outliner", "아웃라이너 펼치기") : ko("Collapse Outliner", "아웃라이너 접기")}
							title={leftCollapsed ? ko("Expand Outliner", "아웃라이너 펼치기") : ko("Collapse Outliner", "아웃라이너 접기")}
							onClick={() => toggleLeft()}
						>
							<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M10 3.5 5.5 8l4.5 4.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
						</button>
						<div className="shell-left-body" hidden={leftCollapsed}>
							<ProjectHead />
							<OutlinerSlot />
						</div>
					</div>
					<div
						className="workspace-splitter shell-splitter shell-left-splitter"
						role="separator"
						aria-orientation="vertical"
						aria-label={ko("Resize hierarchy panel", "계층 패널 크기 조절")}
						onPointerDown={(event) => beginWorkspaceResize("left", event)}
					/>
					<div className="studio-right-column">
						<DetailsSlot />
					</div>
					<div
						className="workspace-splitter workspace-splitter-vertical shell-splitter shell-sidebar-splitter"
						role="separator"
						aria-orientation="vertical"
						aria-label={ko("Resize hierarchy and inspector panel", "계층 및 속성 패널 크기 조절")}
						onPointerDown={(event) => beginWorkspaceResize("sidebar", event)}
					/>
				</div>
				<div className="studio-dock-slot">
					<div
						className="workspace-splitter timeline-splitter"
						role="separator"
						aria-label={ko("Resize frame monitor", "프레임 모니터 크기 조절")}
						onPointerDown={(event) => beginWorkspaceResize("timeline", event)}
					/>
					<BottomDock tab={shownTab} onTabChange={changeDockTab} embedded={embedded} />
					<div
						className="workspace-splitter shell-splitter shell-camera-splitter"
						role="separator"
						aria-orientation="vertical"
						aria-label={ko("Resize shot preview", "샷 미리보기 크기 조절")}
						onPointerDown={(event) => beginWorkspaceResize("camera", event)}
					/>
				</div>
			</div>
			<StatusBar embedded={embedded} />
			{children}
		</div>
	);
}
