import { useEffect, useMemo, useRef, useState } from "react";
import packageInfo from "../package.json";
import { ko } from "./locale.js";
import {
	hasDirectoryPicker,
	hasFileSystemAccess,
	listProjectsInDirectory,
	loadProjectsDirectory,
	loadRecentProjects,
	pickProjectsDirectory,
	queryHandlePermission,
	removeRecentProject,
	requestHandlePermission,
	storeProjectsDirectory,
	DEFAULT_PREVIS_MODE,
	DEFAULT_CAST_STYLE,
} from "./project.js";
import { BrandMark, TemplateThumb } from "./project-browser-art.jsx";
import { RecentArt, RecentPreview, RecentWork, useRecentSummaries } from "./project-recent-work.jsx";
import { captureProjectThumb, removeProjectThumb } from "./project-thumbs.js";
import "./project-browser.css";

const APP_VERSION = packageInfo.version;
// The "+" card is the one blank entry: an empty stage under a fresh name (no
// starterId, so Create takes the blank path). Its preview is the blank-stage render.
const NEW_PROJECT = Object.freeze({ id: "new-project", thumbId: "blank-stage", kind: "blank", defaultName: "Untitled Project", get name() { return ko("New project", "새 프로젝트"); }, get description() { return ko("Start from an empty stage.", "빈 무대에서 시작합니다."); } });

// App.jsx keeps the project mutation behind its named requestNewProject/newProject
// path. The v2 chooser already has the name, so this short-lived handoff seeds
// the existing ProjectNameDialog and lets its normal submit path commit it.
let pendingProjectName = null;
function stagePendingProjectName(name) {
	pendingProjectName = name;
}

function sampleTemplate(scene) {
	return {
		id: `sample-${scene.id}`,
		starterId: scene.id,
		name: scene.name,
		description: scene.blurb,
		kind: "sample",
	};
}

export function ProjectNameDialog({ open, initialName = "My Project", onCancel, onSubmit }) {
	const [value, setValue] = useState(initialName);
	useEffect(() => {
		if (!open) return;
		if (pendingProjectName !== null) {
			const name = pendingProjectName;
			pendingProjectName = null;
			setValue(name);
			onSubmit(name);
			return;
		}
		setValue(initialName);
	}, [open, initialName]);
	if (!open) return null;
	const submit = (event) => {
		event.preventDefault();
		const name = value.trim() || "My Project";
		onSubmit(name);
	};
	return (
		<div className="v2-project-name-dialog-backdrop project-name-dialog-backdrop" role="presentation">
			<form className="v2-project-name-dialog project-name-dialog" role="dialog" aria-modal="true" aria-labelledby="project-name-dialog-title" onSubmit={submit}>
				<strong id="project-name-dialog-title">{ko("Project name", "프로젝트 이름")}</strong>
				<label>
					<span>{ko("Name", "이름")}</span>
					<input autoFocus value={value} onChange={(event) => setValue(event.target.value)} aria-label={ko("Project name", "프로젝트 이름")} />
				</label>
				<div className="v2-project-name-dialog-actions project-name-dialog-actions">
					<button type="button" className="v2-dialog-secondary btn ghost" onClick={onCancel}>{ko("Cancel", "취소")}</button>
					<button type="submit" className="v2-dialog-primary btn primary">{ko("Create", "생성")}</button>
				</div>
			</form>
		</div>
	);
}

/**
 * v2 start / project screen. Recent projects still come from the browser-local
 * project store, while the bundled starter scenes (none today) become template
 * cards before the "+" card.
 */
export default function ProjectBrowser({ currentName, onOpen, onOpenFile, onNew, onClose, startup = false, starters = [], onStarter }) {
	const starterTemplates = useMemo(() => starters.map(sampleTemplate), [starters]);
	// Every new project is an Animation project with the Hybrid cast; both
	// bodies stay reachable from Add > Character.
	const templates = starterTemplates;
	const defaultTemplate = starterTemplates[0] ?? NEW_PROJECT;
	const [activeNav, setActiveNav] = useState(startup ? "new" : "recent");
	const [selectedTemplateId, setSelectedTemplateId] = useState(defaultTemplate.id);
	const [name, setName] = useState(currentName || defaultTemplate.defaultName || defaultTemplate.name || "My Project");
	const [recents, setRecents] = useState([]);
	const [folder, setFolder] = useState(null);
	const [folderProjects, setFolderProjects] = useState([]);
	const [folderDenied, setFolderDenied] = useState(false);
	const [lostFolder, setLostFolder] = useState(null);
	const [selectedRecentKey, setSelectedRecentKey] = useState(null);
	const nameInputRef = useRef(null);

	useEffect(() => {
		let active = true;
		loadRecentProjects().then((entries) => {
			if (active) setRecents(Array.isArray(entries) ? entries : []);
		});
		loadProjectsDirectory().then(async (handle) => {
			if (!active || !handle) return;
			const permission = await queryHandlePermission(handle);
			if (!active) return;
			if (permission !== "granted") {
				setFolderDenied(true);
				if (permission === "prompt") setLostFolder(handle);
				return;
			}
			setFolder(handle);
			setFolderProjects(await listProjectsInDirectory(handle));
		}).catch(() => {
			if (active) setFolderDenied(true);
		});
		return () => {
			active = false;
		};
	}, []);

	useEffect(() => {
		if (startup) nameInputRef.current?.focus();
		// The open project's stage is still in the canvas under this screen.
		else if (currentName) void captureProjectThumb(currentName);
	}, [startup]);

	// File › New reaches this screen with unsaved work, so Create can be refused
	// by the discard confirmation. A name left behind then must not seed a later
	// Save's name dialog once the screen closes. The clear waits for the end of
	// the commit: a Create that closes this screen opens the name dialog in the
	// same commit, and its effect takes the name first.
	useEffect(() => () => {
		queueMicrotask(() => stagePendingProjectName(null));
	}, []);

	const selectedTemplate = templates.find((template) => template.id === selectedTemplateId) ?? NEW_PROJECT;
	const canCreate = name.trim().length > 0;
	const createReason = ko("Enter a project name to create a project", "프로젝트를 만들려면 이름을 입력하세요");
	const locationLabel = folder?.name || ko("Browser project store", "브라우저 프로젝트 저장소");
	const canChooseFolder = hasFileSystemAccess() && hasDirectoryPicker();

	const reauthorizeFolder = async () => {
		if (!lostFolder) return;
		if ((await requestHandlePermission(lostFolder)) !== "granted") return;
		const handle = lostFolder;
		setLostFolder(null);
		setFolderDenied(false);
		setFolder(handle);
		setFolderProjects(await listProjectsInDirectory(handle));
	};

	const chooseFolder = async () => {
		if (!canChooseFolder) return;
		try {
			const handle = await pickProjectsDirectory();
			await storeProjectsDirectory(handle);
			setFolder(handle);
			setFolderDenied(false);
			setLostFolder(null);
			setFolderProjects(await listProjectsInDirectory(handle));
		} catch (error) {
			if (error?.name !== "AbortError") setFolderDenied(true);
		}
	};

	const refreshFolder = async () => {
		if (folder) setFolderProjects(await listProjectsInDirectory(folder));
	};

	const selectTemplate = (template) => {
		setSelectedRecentKey(null);
		setSelectedTemplateId(template.id);
		// A name the previous card (or the open project) filled in follows the new card; a typed one stays.
		setName((current) => !current.trim() || [selectedTemplate?.name, selectedTemplate?.defaultName, currentName].includes(current.trim()) ? template.defaultName ?? template.name : current);
	};

	const createProject = (event) => {
		event.preventDefault();
		const projectName = name.trim();
		if (!projectName) return;
		if (selectedTemplate?.starterId) {
			onStarter?.(selectedTemplate.starterId, projectName, { previsMode: DEFAULT_PREVIS_MODE, castStyle: DEFAULT_CAST_STYLE });
			return;
		}
		stagePendingProjectName(projectName);
		onNew(projectName, { previsMode: DEFAULT_PREVIS_MODE, castStyle: DEFAULT_CAST_STYLE });
	};

	const recentEntries = useRecentSummaries(useMemo(() => [
		...recents.map((entry) => ({ ...entry, key: `recent-${entry.name}`, removable: true, date: entry.openedAt })),
		...folderProjects.map((entry) => ({ ...entry, key: `folder-${entry.name}`, removable: false, date: entry.lastModified })),
	], [recents, folderProjects]));
	const selectedRecent = recentEntries.find((entry) => entry.key === selectedRecentKey) ?? null;
	const forgetRecent = async (entry) => {
		await removeRecentProject(entry.name);
		await removeProjectThumb(entry.name);
		if (entry.key === selectedRecentKey) setSelectedRecentKey(null);
		setRecents(await loadRecentProjects());
	};
	const recentWork = <RecentWork entries={recentEntries} selectedKey={selectedRecentKey} currentName={currentName} onSelect={(entry) => setSelectedRecentKey(entry.key)} onOpen={onOpen} onRemove={forgetRecent} onOpenFile={onOpenFile} onRefresh={folder ? refreshFolder : null} />;

	const navItems = [
		{ id: "recent", label: ko("Recent", "최근") },
		{ id: "new", label: ko("New Project", "새 프로젝트") },
		{ id: "learn", label: ko("Learn", "배우기") },
	];

	return (
		<div className={`v2-start-screen project-browser-backdrop${startup ? " startup" : ""}`} onPointerDown={(event) => { if (!startup && event.target === event.currentTarget) onClose?.(); }}>
			<div className={`v2-start-window project-browser${startup ? " startup" : ""}`} role="dialog" aria-modal="true" aria-label={ko("Choose project", "프로젝트 선택")}>
				<nav className="v2-start-nav" aria-label={ko("Project navigation", "프로젝트 탐색")}>
					<div className="v2-start-brand">
						<BrandMark />
						<strong>CozyClay</strong>
					</div>
					<div className="v2-start-nav-list">
						{navItems.map((item) => (
							<button
								type="button"
								key={item.id}
								className={`v2-start-nav-item${activeNav === item.id ? " active" : ""}`}
								aria-current={activeNav === item.id ? "page" : undefined}
								onClick={() => setActiveNav(item.id)}
							>
								{item.label}
							</button>
						))}
					</div>
					<div className="v2-start-version">v{APP_VERSION}</div>
				</nav>

				<main className="v2-start-main">
					<div className="v2-start-main-head">
						<div className="v2-start-title-row">
							<h1>{activeNav === "recent" ? ko("Recent", "최근") : activeNav === "learn" ? ko("Learn", "배우기") : ko("New Project", "새 프로젝트")}</h1>
							{activeNav !== "new" && <button type="button" className="v2-start-close x" onClick={onClose} aria-label={ko("Close", "닫기")}>×</button>}
						</div>
					</div>

					{activeNav === "learn" ? (
						<div className="v2-start-learn">
							<strong>{ko("Block a shot in three moves", "세 단계로 샷을 블로킹하세요")}</strong>
							<p>{ko("Choose a template, name the project, then place a character and frame the camera in the editor.", "템플릿을 고르고 프로젝트 이름을 정한 다음 편집기에서 인물을 배치하고 카메라를 잡아 보세요.")}</p>
							<button type="button" className="v2-start-learn-action" onClick={() => setActiveNav("new")}>{ko("Start a new project", "새 프로젝트 시작")}</button>
						</div>
					) : activeNav === "recent" ? (
						<div className="v2-start-recent-page">{recentWork}</div>
					) : (
						<>
							<div className="v2-start-template-grid" role="list" aria-label={ko("Project templates", "프로젝트 템플릿")}>
								{templates.map((template) => (
									<button
										type="button"
										role="listitem"
										key={template.id}
										className={`v2-start-template${selectedTemplate?.id === template.id ? " selected" : ""}`}
										data-template-id={template.id}
										onClick={() => selectTemplate(template)}
										onDoubleClick={() => template.starterId && onStarter?.(template.starterId)}
									>
										<span className={`v2-start-template-art ${template.kind}`}><TemplateThumb id={template.starterId ?? template.id} /></span>
										<span className="v2-start-template-copy">
											<strong>{template.name}</strong>
											<span>{template.description}</span>
										</span>
									</button>
								))}
								<button type="button" role="listitem" className={`v2-start-add-card${selectedTemplate?.id === NEW_PROJECT.id && !selectedRecent ? " selected" : ""}`} data-testid="start-new-project-card" onClick={() => { selectTemplate(NEW_PROJECT); requestAnimationFrame(() => nameInputRef.current?.select()); }}>
									<span className="v2-start-add-art" aria-hidden="true"><svg viewBox="0 0 20 20" width="20" height="20"><path d="M10 3.5v13M3.5 10h13" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg></span>
									<span className="v2-start-template-copy">
										<strong>{ko("New project", "새 프로젝트")}</strong>
										<span>{ko("Start from an empty stage", "빈 무대에서 시작")}</span>
									</span>
								</button>
								<button type="button" role="listitem" className="v2-start-add-card v2-start-open-card" data-testid="start-open-project-card" onClick={onOpenFile}><span className="v2-start-add-art" aria-hidden="true"><svg viewBox="0 0 20 20" width="20" height="20"><path d="M2.5 6.5V15a1 1 0 0 0 1 1h13a1 1 0 0 0 1-1V8a1 1 0 0 0-1-1H10L8.5 5H3.5a1 1 0 0 0-1 1.5Z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" /></svg></span><span className="v2-start-template-copy"><strong>{ko("Open project", "프로젝트 열기")}</strong><span>{ko("A saved .cclayproject file", "저장한 .cclayproject 파일")}</span></span></button>
							</div>

							{recentWork}
						</>
					)}
				</main>

				<aside className="v2-start-preview" data-testid="start-project-preview" aria-label={ko("Project preview", "프로젝트 미리보기")}>
					<div className={`v2-start-preview-art ${selectedRecent ? "recent" : selectedTemplate?.kind || "blank"}`}>{selectedRecent ? <RecentArt entry={selectedRecent} /> : <TemplateThumb id={selectedTemplate.starterId ?? selectedTemplate.thumbId} />}</div>
					{selectedRecent ? <RecentPreview entry={selectedRecent} onOpen={onOpen} onRemove={forgetRecent} onBack={() => selectTemplate(NEW_PROJECT)} /> : <>
					<div className="v2-start-preview-copy">
						<strong>{selectedTemplate?.name}</strong>
						<span>{selectedTemplate?.description}</span>
					</div>
					<form className="v2-start-project-form" onSubmit={createProject}>
						<label className="v2-start-field">
							<span>{ko("Name", "이름")}</span>
							<input ref={nameInputRef} data-testid="start-project-name" aria-label={ko("Name", "이름")} value={name} onChange={(event) => setName(event.target.value)} />
						</label>
						<label className="v2-start-field">
							<span>{ko("Location", "위치")}</span>
							<button type="button" className="v2-start-location" onClick={chooseFolder} disabled={!canChooseFolder} title={canChooseFolder ? ko("Choose the project storage folder", "프로젝트 저장 폴더 선택") : ko("Projects are stored in this browser", "프로젝트는 이 브라우저에 저장됩니다")}>
								<span>{locationLabel}</span><span aria-hidden="true">⌄</span>
							</button>
						</label>
						{folderDenied && (
							<p className="v2-start-location-status" role="status">
								{lostFolder ? ko("Folder access needs to be re-allowed.", "폴더 접근을 다시 허용해야 해요.") : ko("Using the browser project store.", "브라우저 프로젝트 저장소를 사용합니다.")}
								{lostFolder && <button type="button" onClick={reauthorizeFolder}>{ko("Re-allow", "다시 허용")}</button>}
							</p>
						)}
						<div className="v2-start-preview-actions">
							<button type="button" className="v2-start-cancel" onClick={onClose}>{ko("Cancel", "취소")}</button>
							<button type="submit" className="v2-start-create btn primary" data-testid="start-create" disabled={!canCreate} title={canCreate ? ko("Create project", "프로젝트 만들기") : createReason}>{ko("Create", "생성")}</button>
						</div>
					</form>
					</>}
				</aside>
			</div>
		</div>
	);
}
