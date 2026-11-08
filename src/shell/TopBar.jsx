import { useStudioShell } from "./studio-shell-context.js";
import ProjectPanel from "../panels/ProjectPanel.jsx";
import MenuBar from "./MenuBar.jsx";
import { SaveState } from "./StatusBar.jsx";
import { ko } from "../locale.js";
import UpdateChip from "../update/UpdateChip.jsx";
import "./topbar.css";

// 2a top bar: File/Edit/Window/Help. The MCP state is no longer shown; its
// element stays hidden so the live workspace handle (data-live-workspace)
// remains readable by the agent harness and QA. Motion is authored by the
// agent (motion.compile), so there is no generate button. Save and Export live in File (G7). #570: the project name
// and its save state head the left column (ProjectHead below).
export default function TopBar({ preferences }) {
	const { recState, liveHubStatus, liveWorkspaceHandle } = useStudioShell();
	const connected = liveHubStatus === "connected";
	return (
		<header className="topbar v2-topbar" data-rec-state={recState}>
			<MenuBar preferences={preferences} />
			<div className="topbar-spacer" />
			<UpdateChip />
			<span
				hidden
				style={{ display: "none" }}
				className={"topbar-mcp" + (liveWorkspaceHandle ? " live-workspace-handle" : "")}
				data-state={connected ? "connected" : "disconnected"}
				data-live-workspace={liveWorkspaceHandle || undefined}
				title={liveWorkspaceHandle || ko("No MCP client is attached to this studio", "이 스튜디오에 연결된 MCP 클라이언트가 없어요")}
			>
				<i className="topbar-mcp-dot" aria-hidden="true" />
				<span className="topbar-mcp-text">{connected ? ko("MCP connected", "MCP 연결됨") : ko("MCP offline", "MCP 꺼짐")}</span>
			</span>
		</header>
	);
}

// #570: the project heads the left column — its name opens the project menu,
// the line under it is the save state.
export function ProjectHead() {
	const {
		projectMenuOpen, setProjectMenuOpen, projectDirty, projectName, projectStartupOpen,
		projectManifest, saveStatus, previsMode,
	} = useStudioShell();
	return (
		<div className="topbar-project studio-project-head">
			<ProjectPanel
				projectMenuOpen={projectMenuOpen}
				setProjectMenuOpen={setProjectMenuOpen}
				projectDirty={projectDirty}
				projectName={projectName}
				projectStartupOpen={projectStartupOpen}
				projectManifest={projectManifest}
			/>
			<SaveState status={saveStatus} />
			<PrevisModeBadge mode={previsMode} />
		</div>
	);
}

// The project's previs mode, a quiet label under the save state.
function previsModeLabel(mode) {
	return mode === "storyboard" ? ko("Storyboard", "스토리보드") : ko("Animation", "애니메이션");
}

function PrevisModeBadge({ mode }) {
	return (
		<span className="topbar-previs-mode" data-testid="topbar-previs-mode" data-previs-mode={mode}>
			{previsModeLabel(mode)}
		</span>
	);
}
