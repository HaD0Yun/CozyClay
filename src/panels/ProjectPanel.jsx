import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ko } from "../locale.js";
import { usePopover } from "../popover.js";
import ResourceStatus from "../resource-status.jsx";
import { useBus } from "../app-context.js";
import GuestStart from "../guest-start-mount.jsx";
import "./details.css";

export default function ProjectPanel({
	projectMenuOpen, setProjectMenuOpen, projectDirty, projectName, projectStartupOpen, projectManifest,
}) {
	const { run } = useBus();
	const triggerRef = useRef(null);
	const [menuBox, setMenuBox] = useState(null);
	usePopover(projectMenuOpen, () => setProjectMenuOpen(false));
	// The menu is portaled and fixed under the trigger: the glass column clips
	// and blurs its children, so an in-place menu was cut at the column edge
	// and read the column's transparent panel fill. App.jsx closes it on an
	// outside pointerdown via `.closest(".project-menu-wrap")`, so the portal
	// layer carries that class (display:contents, no box of its own).
	useLayoutEffect(() => {
		const rect = projectMenuOpen ? triggerRef.current?.getBoundingClientRect() : null;
		setMenuBox(rect ? { left: rect.left, top: rect.bottom + 6 } : null);
	}, [projectMenuOpen]);
	// Hidden until the layout effect has placed it, so it never paints at the
	// wrong spot; without a document (server render) it stays in place.
	const menu = projectMenuOpen && (
		<div className="project-menu-wrap v2-project-menu project-menu-layer">
			<div className="project-menu" role="menu" style={menuBox ?? { visibility: "hidden" }} onClick={() => setProjectMenuOpen(false)}>
				<button type="button" role="menuitem" onClick={() => run("project.new")}>{ko("New Project", "새 프로젝트")}</button>
				<button type="button" role="menuitem" onClick={() => run("project.browse")}>{ko("Open Project…", "프로젝트 열기…")}</button>
				<button type="button" role="menuitem" onClick={() => run("project.save")}>{ko("Save Project", "프로젝트 저장")}</button>
				<button type="button" role="menuitem" onClick={() => run("project.saveAs")}>{ko("Save Project As…", "다른 이름으로 저장…")}</button>
				<ResourceStatus manifest={projectManifest} compact />
			</div>
		</div>
	);
	return (
		<div className="project-menu-wrap v2-project-menu">
			<button
				type="button"
				className="project-menu-trigger"
				ref={triggerRef}
				aria-expanded={projectMenuOpen}
				onClick={() => setProjectMenuOpen((open) => !open)}
			>
				{projectDirty && <i className="project-dirty-dot" aria-label={ko("Unsaved changes", "저장되지 않은 변경사항")} />}
				{projectName ?? (projectStartupOpen ? ko("Choose Project", "프로젝트 선택") : ko("Untitled Project", "제목 없는 프로젝트"))}
				<span className="caret">▾</span>
			</button>
			{menu && (globalThis.document ? createPortal(menu, globalThis.document.body) : menu)}
			<GuestStart />
		</div>
	);
}
