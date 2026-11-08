import AddSceneEntries from "./shell/AddSceneEntries.jsx"; import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ko } from "./locale.js";
import { buildHierarchyNodes } from "./hierarchy-model.js";
import { sceneObjectIdFromHierarchy } from "./scene-objects.js";
import { CatalogueEntries, displayObjectLabel } from "./object-catalog.jsx";
import { Dropdown } from "./ui.jsx";
import { usePopover } from "./popover.js";
import { isImeComposing } from "./ime.js";
import { SearchEmpty } from "./search-friction.js";
import "./hierarchy-panel.css";

const HIERARCHY_LABELS_KO = {
	"SCENE 01": "장면 01",
	Camera: "카메라",
	Characters: "캐릭터",
	"Character 1": "캐릭터 1",
	"Character 2": "캐릭터 2",
	Rig: "리그",
	Torso: "몸통",
	"Root / Hips": "루트 / 골반",
	Spine: "척추",
	Chest: "가슴",
	Neck: "목",
	Head: "머리",
	"Left Arm": "왼팔",
	"Left Shoulder": "왼쪽 어깨",
	"Left Elbow": "왼쪽 팔꿈치",
	"Left Hand": "왼손",
	"Right Arm": "오른팔",
	"Right Shoulder": "오른쪽 어깨",
	"Right Elbow": "오른쪽 팔꿈치",
	"Right Hand": "오른손",
	"Left Leg": "왼다리",
	"Left Knee": "왼쪽 무릎",
	"Left Foot": "왼발",
	"Right Leg": "오른다리",
	"Right Knee": "오른쪽 무릎",
	"Right Foot": "오른발",
	Environment: "환경",
	Props: "소품",
	Light: "조명",
	"Scene structure": "장면 구조",
	"Scene hierarchy": "장면 계층",
};

const FALLBACK_SCENES = [{ id: "current-scene", name: "SCENE 01" }];

/** The tree root row IS the active scene document (hierarchy-model.js keeps
 *  the legacy `shot` id for selection routing). */
const SCENE_ROOT_ID = "shot";
/** Sentinel option value: the scene list ends with "+ New scene". */
const NEW_SCENE_OPTION = "__new-scene__";

/**
 * The drag payload for a hierarchy ROW moved onto another row (attach a prop
 * to a character, regroup it under another prop, drop it back on Props). A
 * private MIME keeps it apart from the file/picture drop that shares these
 * rows: a Files drag never carries this type, so the two never collide.
 */
export const HIERARCHY_DRAG_MIME = "application/x-cclay-hierarchy";

const carriesHierarchyRow = (event) => !!event.dataTransfer?.types?.includes?.(HIERARCHY_DRAG_MIME);

function displaySceneName(name) {
	const generatedName = /^SCENE\s+(\d+)$/i.exec(name);
	return generatedName ? ko(name, `장면 ${generatedName[1]}`, `场景 ${generatedName[1]}`) : name;
}

/**
 * Scene document boundary contract:
 * - `scenes` contains lightweight `{ id, name }` records.
 * - callbacks request document changes; this panel never owns or mutates scenes.
 *
 * The selector lives ON the tree root row, because the root row already IS the
 * active scene document: one line of chrome instead of a separate Scenes block
 * repeating the same name. The list is the portaled `Dropdown` — the hierarchy
 * column clips its overflow, so an in-place menu would be cut off.
 */
function ScenePill({ scenes, activeSceneId, onSceneSelect, onSceneCreate, onRenameStart }) {
	const options = [
		...scenes.map((scene) => ({ value: scene.id, label: displaySceneName(scene.name) })),
		{ value: NEW_SCENE_OPTION, label: ko("+ New scene", "+ 새 장면") },
	];
	return (
		// The pill sits beside the expand caret but is a different control: its
		// clicks never reach the row, so picking a scene cannot fold the tree.
		<span
			className="hierarchy-scene-pill"
			onClick={(event) => event.stopPropagation()}
			// The pill carries the scene name, so a double-click on it renames the
			// document — the same gesture the row label used to answer.
			onDoubleClick={(event) => {
				event.stopPropagation();
				onRenameStart?.();
			}}
		>
			<Dropdown
				value={activeSceneId}
				options={options}
				ariaLabel={ko("Select scene", "장면 선택")}
				menuClassName="hierarchy-scene-menu"
				onChange={(value) => {
					if (value === NEW_SCENE_OPTION) onSceneCreate?.();
					else if (value !== activeSceneId) onSceneSelect?.(value);
				}}
			/>
		</span>
	);
}

function displayHierarchyLabel(node) {
	if (node.kind === "object") return displayObjectLabel(node.label);
	if (node.kind === "scene") return displaySceneName(node.label);
	return HIERARCHY_LABELS_KO[node.label] ? ko(node.label, HIERARCHY_LABELS_KO[node.label]) : node.label;
}

const OUTLINER_TYPES = {
	empty: "Empty",
	folder: "Folder",
	mesh: "Mesh",
	cast: "Cast",
	cam: "Cam",
	light: "Light",
};

function outlinerTypeFor(node) {
	const key = node.kind === "object"
		? node.renderer === "empty" ? "empty" : node.renderer === "light" ? "light" : "mesh"
		: node.kind === "character" || node.kind === "bone"
			? "cast"
			: node.kind === "camera"
				? "cam"
				: node.kind === "light"
					? "light"
					: "folder";
	const label = key === "empty"
		? ko(OUTLINER_TYPES[key], "빈 오브젝트")
		: key === "folder"
		? ko(OUTLINER_TYPES[key], "폴더")
		: key === "mesh"
			? ko(OUTLINER_TYPES[key], "메시")
			: key === "cast"
				? ko(OUTLINER_TYPES[key], "캐스트")
				: key === "cam"
					? ko(OUTLINER_TYPES[key], "카메라")
					: ko(OUTLINER_TYPES[key], "조명");
	return { key, label };
}

function OutlinerChip({ type }) {
	return <span className={`v2-outliner-chip ${type}`} aria-hidden="true" />;
}

function countHierarchyNodes(nodes) {
	return nodes.reduce((count, node) => count + 1 + countHierarchyNodes(node.children ?? []), 0);
}

function filterHierarchyNodes(nodes, query, showB) {
	const normalized = query.trim().toLocaleLowerCase();
	const filterNode = (node) => {
		if (node.optional === "showB" && !showB) return null;
		if (!normalized) return node;
		const label = displayHierarchyLabel(node).toLocaleLowerCase();
		const children = (node.children ?? []).map(filterNode).filter(Boolean);
		if (!label.includes(normalized) && children.length === 0) return null;
		return children.length ? { ...node, children } : { ...node, children: undefined };
	};
	return nodes.map(filterNode).filter(Boolean);
}

function indexParents(nodes, parent = null, parents = new Map()) {
	for (const node of nodes) {
		if (parent) parents.set(node.id, parent);
		if (node.children) indexParents(node.children, node.id, parents);
	}
	return parents;
}

/** Fixed-position menu at the pointer: the object-row actions
 * (Rename / Duplicate / Delete / Frame) or the create catalogue, matching
 * Unity's Hierarchy right-click menu (docs/unity-reference.md §9.7).
 * Closes on Escape, on any outside mousedown, and after a pick. */
function findHierarchyNode(nodes, id) {
	for (const node of nodes ?? []) {
		if (node.id === id) return node;
		const nested = findHierarchyNode(node.children, id);
		if (nested) return nested;
	}
	return null;
}

function RowContextMenu({ menu, onClose, onAction, onAddObject }) {
	const rootRef = useRef(null);
	// Deleting a scene document is not undoable, so Delete arms first and only
	// the second click on the same item commits (the switcher behaved this way).
	const [deleteArmed, setDeleteArmed] = useState(false);
	useEffect(() => setDeleteArmed(false), [menu]);

	usePopover(menu, onClose, [rootRef]);
	useEffect(() => {
		if (!menu) return undefined;
		const onKey = (event) => {
			if (event.key !== "Escape") return;
			// Capture phase + stopImmediatePropagation: closing the menu must
			// not also run the app's window-level Escape (clear selection).
			event.stopImmediatePropagation();
			onClose();
		};
		window.addEventListener("keydown", onKey, true);
		return () => window.removeEventListener("keydown", onKey, true);
	}, [menu, onClose]);

	if (!menu) return null;
	// Keep the menu inside the window; `height` is an upper bound per kind,
	// so a short menu never sits below the pointer that opened it.
	const style = {
		left: Math.max(4, Math.min(menu.x, window.innerWidth - 244)),
		top: Math.max(4, Math.min(menu.y, window.innerHeight - menu.height)),
	};
	// Portaled: the glass column clips and blurs its children, so an in-place
	// menu was cut at the column edge and sat under body-level popovers. The
	// display:contents layer keeps the `.v2-outliner` style scope.
	return createPortal(
		<div className="v2-outliner v2-outliner-layer"><div className="hierarchy-context-menu" role="menu" style={style} ref={rootRef}>
			{menu.kind === "scene" ? (
				<>
					<button type="button" role="menuitem" className="hierarchy-context-item" onClick={() => onAction("rename", menu.id)}>
						{ko("Rename", "이름 바꾸기")}
					</button>
					<button type="button" role="menuitem" className="hierarchy-context-item" onClick={() => onAction("scene-duplicate", menu.id)}>
						{ko("Duplicate", "복제")}
					</button>
					{menu.canDelete && (
						<button
							type="button"
							role="menuitem"
							className={"hierarchy-context-item" + (deleteArmed ? " danger" : "")}
							title={deleteArmed ? ko("Click again to permanently delete this scene", "한 번 더 누르면 이 장면을 완전히 삭제합니다") : undefined}
							onClick={() => {
								if (!deleteArmed) {
									setDeleteArmed(true);
									return;
								}
								onAction("scene-delete", menu.id);
							}}
						>
							{deleteArmed ? ko("Confirm delete", "삭제 확인") : ko("Delete", "삭제")}
						</button>
					)}
					<button type="button" role="menuitem" className="hierarchy-context-item" onClick={() => onAction("scene-create", menu.id)}>
						{ko("+ New scene", "+ 새 장면")}
					</button>
				</>
			) : menu.kind === "character" ? (
				<>
					<button type="button" role="menuitem" className="hierarchy-context-item" onClick={() => onAction("visibility", menu.id)}>
						{menu.hidden ? ko("Show", "표시") : ko("Hide", "숨기기")}
					</button>
					{menu.grouped && (
						<button type="button" role="menuitem" className="hierarchy-context-item" onClick={() => onAction("ungroup-character", menu.id)}>
							{ko("Remove from group", "그룹에서 빼기")}
						</button>
					)}
				</>
			) : menu.kind === "object" ? (
				<>
					<button type="button" role="menuitem" className="hierarchy-context-item" onClick={() => onAction("visibility", menu.id)}>
						{menu.hidden ? ko("Show", "표시") : ko("Hide", "숨기기")}
					</button>
					<button type="button" role="menuitem" className="hierarchy-context-item" onClick={() => onAction("rename", menu.id)}>
						{ko("Rename", "이름 바꾸기")}
					</button>
					<button type="button" role="menuitem" className="hierarchy-context-item" onClick={() => onAction("duplicate", menu.id)}>
						{ko("Duplicate", "복제")}
					</button>
					<button type="button" role="menuitem" className="hierarchy-context-item" onClick={() => onAction("delete", menu.id)}>
						{ko("Delete", "삭제")}
					</button>
					<button type="button" role="menuitem" className="hierarchy-context-item" onClick={() => onAction("frame", menu.id)}>
						{ko("Frame", "프레임 맞추기")}
					</button>
					<button type="button" role="menuitem" className="hierarchy-context-item" data-action="group-under-empty" onClick={() => onAction("group-under-empty", menu.id)}>
						{ko("Group under new Empty", "빈 오브젝트로 묶기")}
					</button>
					{menu.grouped && (
						<button type="button" role="menuitem" className="hierarchy-context-item" data-action="ungroup-object" onClick={() => onAction("ungroup-object", menu.id)}>
							{ko("Move out to Props", "그룹에서 빼기 (Props로)")}
						</button>
					)}
				</>
			) : (
				<><CatalogueEntries onPick={onAddObject} /><AddSceneEntries onDone={onClose} /></>
			)}
		</div></div>,
		document.body,
	);
}

function TreeRow({
	node,
	depth,
	selectedId,
	expanded,
	onSelect,
	onToggle,
	badge,
	status,
	editing,
	onRenameCommit,
	onRenameCancel,
	onRowContextMenu,
	onToggleHidden,
	onRenameStart,
	// The scene root row hands its name to the pill in `rowExtra`; printing it
	// twice on one row is the duplication this panel just removed.
	showLabel = true,
	// An agent receipt named this row as something it just changed; the row
	// says so for a beat without becoming the selection.
	touched = false,
	// A row that owns children still does not always earn a fold caret: the
	// scene ROOT would fold the whole scene away, which no workflow needs
	// (docs/studio-ui-ia.md R6).
	foldable = true,
	rowExtra,
	dropHandlers,
	reparent,
	dragSourceId,
	onDragSourceChange,
}) {
	const branch = !!node.children?.length;
	// The drop BEHAVIOUR is shared by every row that accepts a picture; the
	// highlight is not. One row lit under the cursor says where the file will
	// land; a whole branch lighting up says nothing.
	const [dropOver, setDropOver] = useState(false);
	const dropDepth = useRef(0);
	const drop = dropHandlers && {
		onDragEnter: (event) => {
			dropHandlers.onDragEnter(event);
			if (!event.dataTransfer?.types?.includes?.("Files")) return;
			dropDepth.current += 1;
			setDropOver(true);
		},
		onDragOver: dropHandlers.onDragOver,
		onDragLeave: (event) => {
			dropHandlers.onDragLeave(event);
			dropDepth.current = Math.max(0, dropDepth.current - 1);
			if (!dropDepth.current) setDropOver(false);
		},
		onDrop: (event) => {
			dropDepth.current = 0;
			setDropOver(false);
			dropHandlers.onDrop(event);
		},
	};
	// Row drag: an object or character row is the handle, ANY row can be the
	// landing spot — the panel holds no policy, the caller's canDrop decides
	// every rule.
	const [rowDropOver, setRowDropOver] = useState(false);
	const draggableRow = (node.kind === "object" || node.kind === "character") && !editing;
	const rowDropTarget = !!(reparent && dragSourceId && reparent.canDrop?.(dragSourceId, node.id));
	const rowDrag = (reparent || draggableRow) && {
		...(draggableRow
			? {
					onDragStart: (event) => {
						// The eye and the fold caret sit inside the draggable row.
						// A press on either must not start a move, or the click is
						// swallowed and a small slip reparents the row.
						if (event.target instanceof Element && event.target.closest(".hierarchy-eye, .hierarchy-toggle")) {
							event.preventDefault();
							event.stopPropagation();
							return;
						}
						event.stopPropagation();
						event.dataTransfer.setData(HIERARCHY_DRAG_MIME, node.id);
						event.dataTransfer.effectAllowed = "move";
						onDragSourceChange?.(node.id);
					},
					onDragEnd: () => {
						setRowDropOver(false);
						onDragSourceChange?.(null);
					},
				}
			: {}),
		onDragEnter: (event) => {
			drop?.onDragEnter(event);
			if (!rowDropTarget || !carriesHierarchyRow(event)) return;
			event.preventDefault();
			setRowDropOver(true);
		},
		// Chrome hands back an EMPTY getData() during dragover, so the source id
		// travels in panel state (set at dragstart) and the payload itself is
		// only read at drop time, where it is readable again.
		onDragOver: (event) => {
			drop?.onDragOver(event);
			if (!rowDropTarget || !carriesHierarchyRow(event)) return;
			event.preventDefault();
			event.dataTransfer.dropEffect = "move";
			if (!rowDropOver) setRowDropOver(true);
		},
		onDragLeave: (event) => {
			drop?.onDragLeave(event);
			setRowDropOver(false);
		},
		onDrop: (event) => {
			if (carriesHierarchyRow(event)) {
				setRowDropOver(false);
				const source = event.dataTransfer.getData(HIERARCHY_DRAG_MIME) || dragSourceId;
				if (!source || !reparent?.canDrop?.(source, node.id)) return;
				event.preventDefault();
				event.stopPropagation();
				onDragSourceChange?.(null);
				reparent.onDrop?.(source, node.id);
				return;
			}
			drop?.onDrop(event);
		},
	};
	// A Files drag keeps the exact handlers it always had; the row-drag wrapper
	// only exists when the caller asked for reparenting.
	const dropEvents = rowDrag || drop || null;
	const label = displayHierarchyLabel(node);
	const outlinerType = outlinerTypeFor(node);
	const rowWrapRef = useRef(null);
	const inputRef = useRef(null);
	// A commit/cancel may race the blur that follows the input unmounting;
	// the flag ends the edit session exactly once. It is per SESSION, not per
	// row: the row outlives its renames, and a flag left standing would make
	// every later rename on that row uncommittable.
	const doneRef = useRef(false);
	useEffect(() => {
		if (editing) doneRef.current = false;
	}, [editing]);

	const finish = () => {
		if (doneRef.current) return;
		doneRef.current = true;
		const name = (inputRef.current?.value ?? "").trim();
		if (name) onRenameCommit(name);
		else onRenameCancel(); // an empty name is a cancel, like Unity
		rowWrapRef.current?.focus();
	};
	const cancel = () => {
		if (doneRef.current) return;
		doneRef.current = true;
		onRenameCancel();
	};

	return (
		<div
			ref={rowWrapRef}
			className={"hierarchy-row-wrap" + (selectedId === node.id ? " selected" : "")}
			style={{ "--hierarchy-depth": depth }}
			data-node-id={node.id}
			data-own-hidden={node.hidden ? "true" : undefined}
			data-drop={drop || rowDropTarget ? (dropOver || rowDropOver ? "over" : "target") : undefined}
			draggable={draggableRow || undefined}
			{...(dropEvents ?? {})}
			role="treeitem"
			tabIndex={-1}
			aria-selected={selectedId === node.id}
			aria-expanded={branch ? expanded : undefined}
			onContextMenu={(event) => onRowContextMenu(event, node.id)}
		>
			{branch && foldable ? (
				<button
					type="button"
					className="hierarchy-toggle"
					aria-label={ko(`${expanded ? "Collapse" : "Expand"} ${label}`, `${label} ${expanded ? "접기" : "펼치기"}`, `${expanded ? "折叠" : "展开"} ${label}`)}
					onClick={() => onToggle(node.id)}
				>
					{expanded ? "▾" : "▸"}
				</button>
			) : (
				// A leaf has nothing to fold and the root must not fold; both keep the
				// caret column so every row's icon stays on the same line.
				<span className={foldable ? "hierarchy-toggle placeholder" : "hierarchy-fold-space"} />
			)}
			{editing ? (
				// In-place rename, Unity-style: Enter commits, Escape reverts,
				// blur commits (docs/unity-reference.md §9.7). A div, not the
				// row button — an input inside a button is invalid HTML.
				<div className={"hierarchy-row" + (touched ? " agent-touched" : "")}>
					<OutlinerChip type={outlinerType.key} />
					<input
						ref={inputRef}
						className="hierarchy-rename-input"
						defaultValue={node.label}
						aria-label={ko(`Rename ${label}`, `${label} 이름 바꾸기`, `重命名 ${label}`)}
						autoFocus
						onFocus={(event) => event.currentTarget.select()}
						onKeyDown={(event) => {
							if (event.key === "Enter" && !isImeComposing(event)) {
								event.preventDefault();
								event.stopPropagation(); // keep the tree hotkey quiet
								finish();
							} else if (event.key === "Escape") {
								event.stopPropagation(); // revert only, not clear-selection
								cancel();
							}
						}}
						onBlur={finish}
					/>
				</div>
			) : (
				<button
					type="button" data-kind={node.kind}
					className={"hierarchy-row" + (showLabel ? "" : " icon-only") + (touched ? " agent-touched" : "")}
					aria-label={showLabel ? undefined : label}
					onClick={() => onSelect(node.id)}
					onDoubleClick={onRenameStart ?? undefined}
				>
					<OutlinerChip type={outlinerType.key} />
					{showLabel && <span className="hierarchy-label">{label}</span>}
					{status && <span className="hierarchy-status">{status}</span>}
					{badge !== null && badge !== undefined && badge !== 0 && <span className="hierarchy-badge">{badge}</span>}
					<span className="v2-outliner-type">{outlinerType.label}</span>
				</button>
			)}
			{(node.kind === "object" || node.kind === "character") && onToggleHidden && (
				<button
					type="button"
					className="hierarchy-eye"
					data-hidden={node.hidden ? "true" : undefined}
					aria-pressed={node.hidden === true}
					aria-label={node.hidden ? ko(`Show ${label}`, `${label} 표시`, `显示 ${label}`) : ko(`Hide ${label}`, `${label} 숨기기`, `隐藏 ${label}`)}
					onClick={(event) => {
						event.preventDefault();
						event.stopPropagation();
						onToggleHidden(node.id);
					}}
				>
					<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
						<path d="M1.5 8s2.5-4 6.5-4 6.5 4 6.5 4-2.5 4-6.5 4S1.5 8 1.5 8z" fill="none" stroke="currentColor" strokeWidth="1.3" />
						<circle cx="8" cy="8" r="1.7" fill="currentColor" />
						{node.hidden && <path d="M3 13 13 3" stroke="currentColor" strokeWidth="1.3" />}
					</svg>
				</button>
			)}
			{rowExtra}
		</div>
	);
}

export default function HierarchyPanel({
	selectedId,
	onSelect,
	showB,
	characters = null,
	motionFrames,
	ikMode,
	// The ACTIVE character's row id (#76): IK badges and the IK-mode
	// auto-expand follow whichever cast member owns the session.
	ikRowId = "characterA",
	sceneObjects = [],
	onAddObject,
	onRenameObject,
	onDuplicateObject,
	onDeleteObject,
	onFrameObject,
	onGroupObject,
	renameRequest = null,
	onToggleHidden,
	propsDrop = null,
	reparent = null,
	// Hierarchy ids an agent receipt just changed. The host owns how long they
	// stay lit; the panel only draws them and brings the first one into view.
	touchedIds = [],
	scenes,
	activeSceneId,
	onSceneSelect,
	onSceneCreate,
	onSceneDuplicate,
	onSceneRename,
	onSceneDelete,
}) {
	const [expanded, setExpanded] = useState(() => new Set(["shot", "characterA"]));
	const [search, setSearch] = useState("");
	const [contextMenu, setContextMenu] = useState(null);
	// Row currently in in-place rename. The panel owns it: F2/Return and the
	// row context menu are the only ways in, so app state stays out of it.
	const [editingId, setEditingId] = useState(null);
	// A freshly made Empty asks to be named: open its row's rename field.
	useEffect(() => {
		if (renameRequest?.id) setEditingId(renameRequest.id);
	}, [renameRequest?.id, renameRequest?.nonce]);
	// The row being dragged. dataTransfer.getData() is deliberately blank during
	// dragover in Chrome, so canDrop could never gate the highlight from the
	// payload alone — the id lives here from dragstart until dragend/drop.
	const [dragSourceId, setDragSourceId] = useState(null);
	const treeRef = useRef(null);
	const lastTreeSelectRef = useRef(null);
	const firstRenderRef = useRef(true);
	const pendingScrollRef = useRef(false);
	// Refused scene edits (the last scene cannot be deleted) explain themselves
	// in the panel rather than failing silently.
	const [sceneHint, setSceneHint] = useState(null);
	const availableScenes = scenes?.length ? scenes : FALLBACK_SCENES;
	const activeScene = availableScenes.find((scene) => scene.id === activeSceneId) ?? availableScenes[0];
	const activeSceneName = activeScene.name;
	const hierarchyNodes = useMemo(() => {
		const nodes = buildHierarchyNodes(sceneObjects, characters);
		// The model keeps the `characters` GROUP so every id selection, the
		// inspector and IK already route to stays exactly where it was; the
		// RENDERED tree drops that row. One heading over one character row cost
		// two controls (the row and its caret) and its badge only repeated the
		// number of rows underneath it (docs/studio-ui-ia.md R6), so the cast
		// sits directly under the root beside Camera/Light/Environment/Props.
		return nodes.map((node) => ({
			...node,
			...(node.kind === "scene" ? { label: activeSceneName } : {}),
			...(node.children
				? { children: node.children.flatMap((child) => (child.id === "characters" ? (child.children ?? []) : [child])) }
				: {}),
		}));
	}, [activeSceneName, sceneObjects, characters]);
	const parents = useMemo(() => indexParents(hierarchyNodes), [hierarchyNodes]);
	const filteredHierarchyNodes = useMemo(
		() => filterHierarchyNodes(hierarchyNodes, search, showB),
		[hierarchyNodes, search, showB],
	);
	const outlinerCount = useMemo(
		() => countHierarchyNodes(filteredHierarchyNodes),
		[filteredHierarchyNodes],
	);

	useEffect(() => {
		setExpanded((current) => {
			const next = new Set(current);
			let id = selectedId;
			while (parents.has(id)) {
				id = parents.get(id);
				next.add(id);
			}
			if (ikMode) {
				next.add(ikRowId);
				next.add(`${ikRowId}.rig`);
			}
			return next;
		});
	}, [ikMode, ikRowId, parents, selectedId]);

	// Selection made outside the tree (viewport click, plan board, inspector)
	// scrolls the row into view (docs/unity-reference.md §9.6). Tree-originated
	// selections skip this — the browser already scrolls the clicked row. The
	// tab may be hidden at selection time (selecting switches to the inspector),
	// so a hidden-tree selection is remembered and scrolled once the tree shows.
	useEffect(() => {
		if (firstRenderRef.current) {
			firstRenderRef.current = false;
			return;
		}
		if (lastTreeSelectRef.current !== selectedId) pendingScrollRef.current = true;
	}, [selectedId]);

	useEffect(() => {
		const tree = treeRef.current;
		if (!tree || tree.offsetParent === null) return;
		if (!pendingScrollRef.current) return;
		pendingScrollRef.current = false;
		if (!selectedId) return;
		const row = tree.querySelector(`[data-node-id="${CSS.escape(selectedId)}"]`);
		row?.scrollIntoView({ block: "nearest" });
	});

	const toggle = (id) => {
		setExpanded((current) => {
			const next = new Set(current);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});
	};
	const badgeFor = (id) => {
		if (id === "props") return sceneObjects.length;
		return null;
	};
	const statusFor = (id) => {
		if (id === ikRowId && ikMode) return ko("IK ON", "IK 켜짐");
		return null;
	};

	const handleSelect = (id) => {
		lastTreeSelectRef.current = id;
		onSelect(id);
	};

	const touched = useMemo(() => new Set(touchedIds), [touchedIds]);
	// A highlight nobody can see is not a receipt: the first row an agent edit
	// touched is brought into view, exactly like a selection made outside the
	// tree. Scrolling a hidden tree would do nothing, so it waits for the tab.
	useEffect(() => {
		const first = touchedIds[0];
		const tree = treeRef.current;
		if (!first || !tree || tree.offsetParent === null) return;
		tree.querySelector(`[data-node-id="${CSS.escape(first)}"]`)?.scrollIntoView({ block: "nearest" });
	}, [touchedIds]);

	const openRowMenu = (event, id) => {
		event.preventDefault();
		event.stopPropagation(); // a row pick must not also open the create menu
		const node = findHierarchyNode(hierarchyNodes, id);
		if (node?.kind === "object" || node?.kind === "character") {
			// A grouped object can leave its group from the menu too, not only by
			// dragging its row onto Props.
			const objectId = node.kind === "object" ? sceneObjectIdFromHierarchy(id) : null;
			const inGroup = objectId ? Boolean(sceneObjects.find((entry) => entry.id === objectId)?.parent) : false;
			setContextMenu({
				x: event.clientX,
				y: event.clientY,
				height: node.kind === "object" ? (inGroup ? 248 : 212) : node.grouped ? 80 : 44,
				kind: node.kind,
				id,
				hidden: node.hidden === true,
				grouped: node.grouped === true || inGroup,
			});
		} else if (id === SCENE_ROOT_ID) {
			// The root row is the scene document: its own verbs, never the
			// Add-Object catalogue.
			setContextMenu({
				x: event.clientX,
				y: event.clientY,
				height: availableScenes.length > 1 ? 148 : 116,
				kind: "scene",
				id,
				canDelete: availableScenes.length > 1,
			});
		} else {
			setContextMenu({ x: event.clientX, y: event.clientY, height: 376, kind: "create" });
		}
	};

	const openCreateMenu = (event) => {
		event.preventDefault(); // suppress the browser menu on the tree only
		setContextMenu({ x: event.clientX, y: event.clientY, height: 376, kind: "create" });
	};

	const deleteActiveScene = () => {
		if (availableScenes.length <= 1) {
			setSceneHint(ko("At least one scene is required", "장면은 최소 하나 필요합니다"));
			return;
		}
		setSceneHint(null);
		onSceneDelete?.(activeScene.id);
	};

	const handleMenuAction = (action, hierarchyId) => {
		setContextMenu(null);
		if (action === "rename") {
			setEditingId(hierarchyId);
			return;
		}
		if (action === "scene-duplicate") {
			onSceneDuplicate?.(activeScene.id);
			return;
		}
		if (action === "scene-delete") {
			deleteActiveScene();
			return;
		}
		if (action === "scene-create") {
			onSceneCreate?.();
			return;
		}
		if (action === "visibility") {
			onToggleHidden?.(hierarchyId);
			return;
		}
		if (action === "ungroup-object") {
			// The same door as dropping the row on Props: out of its group, kept where it is.
			if (reparent?.canDrop?.(hierarchyId, "props")) reparent.onDrop?.(hierarchyId, "props");
			return;
		}
		if (action === "ungroup-character") {
			// Out of the group is a drop on the scene root: the same policy door.
			if (reparent?.canDrop?.(hierarchyId, SCENE_ROOT_ID)) reparent.onDrop?.(hierarchyId, SCENE_ROOT_ID);
			return;
		}
		const objectId = sceneObjectIdFromHierarchy(hierarchyId);
		if (!objectId) return;
		if (action === "duplicate") onDuplicateObject?.(objectId);
		else if (action === "delete") onDeleteObject?.(objectId);
		else if (action === "frame") onFrameObject?.(objectId);
		else if (action === "group-under-empty") onGroupObject?.(objectId);
	};

	const commitRename = (hierarchyId, name) => {
		setEditingId(null);
		if (hierarchyId === SCENE_ROOT_ID) {
			if (name !== activeScene.name) onSceneRename?.(activeScene.id, name);
			return;
		}
		const objectId = sceneObjectIdFromHierarchy(hierarchyId);
		if (objectId) onRenameObject?.(objectId, name);
	};

	const cancelRename = () => {
		setEditingId(null);
	};

	// F2 / Return rename the selected row in place while focus is in the
	// tree (docs/unity-reference.md §9.2). The rename input stops its own
	// Enter/Escape, so an active edit never re-triggers this.
	const onTreeKeyDown = (event) => {
		if (editingId) return;
		if (event.key !== "F2" && event.key !== "Enter") return;
		if (selectedId !== SCENE_ROOT_ID && sceneObjectIdFromHierarchy(selectedId) === null) return;
		event.preventDefault();
		setEditingId(selectedId);
	};

	const renderNodes = (nodes, depth = 0) =>
		nodes.flatMap((node) => {
			if (node.optional === "showB" && !showB) return [];
			const sceneRoot = node.id === SCENE_ROOT_ID;
			// Search opens only the filtered branches. The stored expansion set is
			// left untouched so clearing the query restores the author's tree.
			const open = sceneRoot || expanded.has(node.id) || Boolean(search.trim());
			const editing = editingId === node.id;
			return [
				<TreeRow
					key={node.id}
					node={node}
					depth={depth}
					selectedId={selectedId}
					expanded={open}
					onSelect={handleSelect}
					onToggle={toggle}
					badge={badgeFor(node.id)}
					status={statusFor(node.id)}
					touched={touched.has(node.id)}
					editing={editing}
					onRenameCommit={(name) => commitRename(node.id, name)}
					onRenameCancel={cancelRename}
					onRowContextMenu={openRowMenu}
					onToggleHidden={onToggleHidden}
					// The root row names the scene document, and a double-click on a
					// document name is where every file browser puts rename.
					onRenameStart={sceneRoot ? () => setEditingId(node.id) : null}
					// On the root row the pill IS the name: the row keeps its icon,
					// and the rename input takes the pill's place while editing.
					showLabel={!sceneRoot}
					foldable={!sceneRoot}
					rowExtra={sceneRoot && !editing ? (
						<ScenePill
							scenes={availableScenes}
							activeSceneId={activeScene.id}
							onSceneSelect={onSceneSelect}
							onSceneCreate={onSceneCreate}
							onRenameStart={() => setEditingId(node.id)}
						/>
					) : null}
					// A picture dropped on Props — or on any prop already in it —
					// becomes a cutout in the set. Dropping ON an object is the
					// same gesture as dropping on the group it lives in: people
					// aim at the list, not at the heading.
					dropHandlers={propsDrop && (node.kind === "props" || node.kind === "object") ? propsDrop.handlers : null}
					reparent={reparent}
					dragSourceId={dragSourceId}
					onDragSourceChange={setDragSourceId}
				/>,
				...(node.children && open ? renderNodes(node.children, depth + 1) : []),
			];
		});

	return (
		<section className="hierarchy-pane v2-outliner" aria-label={ko("Outliner", "아웃라이너")}>
			<div className="hierarchy-heading">
				<strong>{ko("Outliner", "아웃라이너")}</strong>
				<span className="v2-outliner-count" data-testid="outliner-count">{outlinerCount}</span>
			</div>
			<label className="v2-outliner-search-wrap">
				<span className="v2-outliner-search-icon" aria-hidden="true">⌕</span>
				<input
					className="v2-outliner-search"
					type="search"
					value={search}
					placeholder={ko("Search", "검색")}
					aria-label={ko("Search Outliner", "아웃라이너 검색")}
					onChange={(event) => setSearch(event.target.value)}
				/>
			</label>
			<div className="hierarchy-tree" role="tree" ref={treeRef} onKeyDown={onTreeKeyDown} onContextMenu={openCreateMenu}>
				{filteredHierarchyNodes.length > 0 ? renderNodes(filteredHierarchyNodes) : (
					<SearchEmpty surface="outliner" query={search}><div className="v2-outliner-empty" role="status">{ko("No matches", "일치하는 항목 없음")}</div></SearchEmpty>
				)}
			</div>
			{sceneHint && (
				<p className="hierarchy-scene-hint" role="status">{sceneHint}</p>
			)}
			<RowContextMenu
				menu={contextMenu}
				onClose={() => setContextMenu(null)}
				onAction={handleMenuAction}
				onAddObject={(kind) => {
					setContextMenu(null);
					onAddObject?.(kind);
				}}
			/>
		</section>
	);
}
