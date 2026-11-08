import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { ko } from "./locale.js";
import { CHARACTER_MODEL_IDS, PROXY_FIGURE_MODEL } from "./scenes.js";
import { OBJECT_LIBRARY } from "./scene-objects.js";
import { displayObjectLabel } from "./object-catalog.jsx";
import { assetAspect, isImageAssetId, isMeshAssetId, isSupportedMeshType } from "./scene-assets.js";
import { assetKind, formatAssetBytes } from "./asset-shelf.js";
import { assetRecord } from "./scene-asset-cache.js";
import ResourceStatus from "./resource-status.jsx";
import { ContentTile, grabProps } from "./content-tile.jsx";
import SculptShelf from "./sculpt-shelf-tiles.jsx"; import { AllFolders } from "./asset-all-grid.jsx";
import { logStore } from "./shell/log-store.js";
import { SearchEmpty } from "./search-friction.js";
import "./asset-pane.css";

/** Casting assets offered in the Content browser's Characters folder. A rig's `id` doubles as
 * the FBX file stem and the ARDY wire rig name (see scenes.js); the capsule figure has no FBX. */
export const CHARACTER_ASSETS = [
	...CHARACTER_MODEL_IDS.map((id) => ({
		id,
		label: id === "y-bot-tpose" ? "Y Bot" : "X Bot",
	})),
	{ id: PROXY_FIGURE_MODEL, label: ko("Capsule figure", "캡슐 인물") },
];

function CharacterPreview({ model }) {
	if (model === PROXY_FIGURE_MODEL) {
		return (
			<svg className="asset-card-preview" viewBox="0 0 48 48" aria-hidden="true" data-preview="proxy-figure">
				<circle cx="24" cy="8.5" r="5.5" />
				<rect x="16" y="16" width="16" height="26" rx="8" />
			</svg>
		);
	}
	const yBot = model === "y-bot-tpose";
	return (
		<svg className="asset-card-preview" viewBox="0 0 48 48" aria-hidden="true">
			<circle cx="24" cy="8.5" r="5.5" />
			<path d="M18 15.5 15.5 29h17L30 15.5Z" />
			<path className="preview-limb" d={yBot ? "M18 18 10 25M30 18l8 7" : "M18 18 7 18M30 18h11"} />
			<path className="preview-limb" d="m20 29-4 12m12-12 4 12" />
		</svg>
	);
}

// #570: catalogue objects are drawn as line glyphs on a 24 grid, the same
// stroke family as the shell's icons; the tile tints them on selection.
const OBJECT_GLYPHS = {
	cube: "M12 3.5 19.5 7.75v8.5L12 20.5l-7.5-4.25v-8.5z M4.5 7.75 12 12l7.5-4.25 M12 12v8.5",
	sphere: "M12 4a8 8 0 1 1 0 16 8 8 0 1 1 0-16z M4 12c0 1.66 3.58 3 8 3s8-1.34 8-3",
	capsule: "M8 8a4 4 0 0 1 8 0v8a4 4 0 0 1-8 0z M8 9.5c0 1 1.8 1.6 4 1.6s4-.6 4-1.6",
	cylinder: "M5 7c0-1.38 3.13-2.5 7-2.5s7 1.12 7 2.5-3.13 2.5-7 2.5S5 8.38 5 7z M5 7v10c0 1.38 3.13 2.5 7 2.5s7-1.12 7-2.5V7",
	cone: "M12 3.5 5 17 M12 3.5 19 17 M5 17c0 1.38 3.13 2.5 7 2.5s7-1.12 7-2.5",
	plane: "M12 7.5 21 12l-9 4.5L3 12z",
};


function ObjectPreview({ kind }) {
	const d = OBJECT_GLYPHS[kind] ?? "M5 5h14v14H5z";
	return (
		<svg className="asset-card-preview content-object-glyph" viewBox="0 0 24 24" aria-hidden="true">
			<path d={d} />
		</svg>
	);
}

/** Generic isometric cube: a GLB has no cheap thumbnail, and inventing one
 * would mean running GLTFLoader on the shelf. The catalogue cube already
 * reads as "a 3D thing", so the shelf reuses that silhouette. */
function MeshPreview() {
	const fill = "#b8bec3";
	const common = { fill, stroke: "#d7dde0", strokeWidth: 1.2, strokeLinejoin: "round" };
	return (
		<svg className="asset-card-preview" viewBox="0 0 48 48" aria-hidden="true">
			<path {...common} d="m9 16 15-8 15 8-15 8Z" />
			<path {...common} d="m9 16 15 8v16L9 31Z" opacity=".82" />
			<path {...common} d="m39 16-15 8v16l15-9Z" opacity=".62" />
		</svg>
	);
}

/** Shelf thumbnail edge: enough pixels for a 108 px card on a 2x display. */
const THUMB_WIDTH = 96;

/**
 * id → Promise<{ url, aspect, name } | null>, for the session. Thumbnails are
 * derived data — the bytes are content-addressed, so an id's picture never
 * changes — which makes a module Map the whole cache story: a tab switch or a
 * re-render redraws nothing, and a reload just re-decodes 96 px thumbs.
 */
const thumbCache = new Map();

function loadThumb(id) {
	if (!thumbCache.has(id)) {
		thumbCache.set(id, (async () => {
			const record = await assetRecord(id);
			// A missing record means another tab swept it — undefined, so the
			// card hides. A present record whose bytes fail below resolves null
			// instead, and the card stays visible so it can be deleted.
			if (!record) return undefined;
			// An HDR environment file (hdr- id) is no picture either: it gets the same generic card.
			if (!isImageAssetId(record.id) || isSupportedMeshType(record.type)) {
				// A GLB is not a picture. Decoding it as one would mark every
				// model "unreadable" in Manage storage — show a generic cube
				// instead, using the same card preview the catalogue already has.
				return {
					name: record.name,
					bytesLabel: formatAssetBytes(record.bytes.byteLength),
					kind: isMeshAssetId(record.id) || isSupportedMeshType(record.type) ? "mesh" : "environment",
					mesh: true,
				};
			}
			const bitmap = await createImageBitmap(new Blob([record.bytes], { type: record.type }), {
				resizeWidth: THUMB_WIDTH,
				resizeQuality: "high",
			});
			const canvas = document.createElement("canvas");
			canvas.width = bitmap.width;
			canvas.height = bitmap.height;
			canvas.getContext("2d").drawImage(bitmap, 0, 0);
			bitmap.close?.();
			return {
				url: canvas.toDataURL(),
				aspect: assetAspect(record) ?? 1,
				name: record.name,
				bytesLabel: formatAssetBytes(record.bytes.byteLength),
				kind: assetKind(record),
			};
		})().catch(() => null));
	}
	return thumbCache.get(id);
}

function StorageAssetRow({ id, onDelete, deleting, usageCount = 0, graphSignature }) {
	const [thumb, setThumb] = useState(null);
	// Capture the graph observed when the explicit confirmation opens. A render
	// caused by a concurrent scene edit must not silently update its authority.
	const [confirmation, setConfirmation] = useState(null);
	const inUse = usageCount > 0;
	useEffect(() => {
		let alive = true;
		loadThumb(id).then((result) => {
			if (alive) setThumb(result ?? undefined);
		});
		return () => {
			alive = false;
		};
	}, [id]);
	// Same rule as the shelf card: a decode failure must stay visible so the
	// one screen whose job is deleting broken assets can actually reach it.
	if (thumb === undefined) return null;
	const failed = thumb === null;
	const mesh = Boolean(thumb?.mesh);
	const name = thumb?.name || (failed ? ko("(unreadable image)", "(읽을 수 없는 이미지)") : mesh ? ko("Untitled model", "이름 없는 모델") : ko("Untitled image", "이름 없는 이미지"));
	const usageLabel = ko(`Used by ${usageCount} scene object${usageCount === 1 ? "" : "s"}`, `${usageCount}개 씬 오브젝트에서 사용 중`, `被 ${usageCount} 个场景物体使用`);
	const deleteLabel = ko(`Delete ${name} from storage`, `${name}을(를) 저장소에서 삭제`, `从存储中删除 ${name}`);
	const confirmationId = `asset-storage-warning-${id}`;
	const kindLabel = thumb?.kind === "mesh" ? ko("Model", "모델") : thumb?.kind === "environment" ? ko("HDR environment", "HDR 환경") : thumb?.kind === "matte" ? ko("Matte", "매트") : ko("Image", "이미지");
	return (
		<li className="asset-storage-row">
			{mesh ? (
				<span className="asset-storage-thumb" aria-hidden="true"><MeshPreview /></span>
			) : thumb?.url ? (
				<img className="asset-storage-thumb" src={thumb.url} alt="" />
			) : (
				<span className="asset-storage-thumb asset-card-thumb-skeleton" aria-hidden="true" />
			)}
			<div className="asset-storage-details">
				<strong title={name}>{name}</strong>
				<span>{thumb ? `${kindLabel} · ${thumb.bytesLabel}` : ko("Loading details…", "세부 정보 불러오는 중…")}</span>
				{inUse && <span className="asset-storage-usage">{usageLabel}</span>}
			</div>
			{confirmation ? (
				<div className="asset-storage-confirm">
					<span id={confirmationId} role="alert">{inUse
						? ko(`Permanently delete this image from storage? It is used by ${usageCount} scene object${usageCount === 1 ? "" : "s"} and those objects will lose it.`, `저장소에서 이 이미지를 영구 삭제할까요? ${usageCount}개 씬 오브젝트가 사용 중이며 해당 오브젝트에서 사라집니다.`, `要从存储中永久删除此图片吗？它正被 ${usageCount} 个场景物体使用，那些物体会失去它。`)
						: ko("Unused by every scene. Delete it?", "모든 씬에서 사용되지 않아요. 삭제할까요?")}</span>
					<button type="button" className="asset-storage-delete" aria-label={deleteLabel} aria-describedby={confirmationId} disabled={deleting} onClick={async () => {
						if (await onDelete(id, inUse ? usageCount : undefined, confirmation.graphSignature)) setConfirmation(null);
					}}>{ko("Delete", "삭제")}</button>
					<button type="button" className="asset-storage-cancel" disabled={deleting} onClick={() => setConfirmation(null)}>{ko("Cancel", "취소")}</button>
				</div>
			) : (
				<button type="button" className="asset-storage-delete" aria-label={deleteLabel} disabled={deleting || !thumb} onClick={() => setConfirmation({ graphSignature })}>
					{deleting ? ko("Deleting…", "삭제 중…") : ko("Delete", "삭제")}
				</button>
			)}
		</li>
	);
}

function StorageManager({ unusedAssetIds, usedAssetIds, usageCounts, graphSignature, trashCount, onDelete, onUndo, deletingAssetId }) {
	const loading = unusedAssetIds === null || usedAssetIds === null;
	const empty = !loading && unusedAssetIds.length === 0 && usedAssetIds.length === 0;
	return (
		<section className="asset-storage-manager" aria-label={ko("Manage storage", "저장 공간 관리")}>
			<div className="asset-storage-head">
				<div>
					<h3>{ko("Manage storage", "저장 공간 관리")}</h3>
					<p>{ko("Review unused and in-use stored images. Deleted images can be restored until this page is reloaded.", "사용하지 않는 이미지와 사용 중인 저장 이미지를 확인하세요. 삭제한 이미지는 이 페이지를 새로 고치기 전까지 복원할 수 있어요.")}</p>
				</div>
				{trashCount > 0 && <button type="button" className="asset-storage-undo" onClick={onUndo}>{ko(`Undo last delete (${trashCount})`, `마지막 삭제 실행 취소 (${trashCount})`, `撤销上次删除（${trashCount}）`)}</button>}
			</div>
			{loading ? (
				<div className="asset-storage-list" aria-busy="true">
					{[0, 1].map((n) => <span className="asset-storage-row asset-storage-row-skeleton" key={n} aria-hidden="true" />)}
				</div>
			) : empty ? (
				<p className="assets-empty">{ko("No stored image assets.", "저장된 이미지 에셋이 없어요.")}</p>
			) : <>
				<section className="asset-storage-section is-unused" aria-labelledby="asset-storage-unused-title">
					<h4 id="asset-storage-unused-title">{ko("Unused", "미사용")}</h4>
					{unusedAssetIds.length === 0 ? (
						<p className="assets-empty">{ko("No unused image assets. Every stored image is still used by a scene.", "사용되지 않는 이미지 에셋이 없어요. 저장된 모든 이미지를 씬에서 사용 중입니다.")}</p>
					) : (
						<ul className="asset-storage-list">
							{unusedAssetIds.map((id) => <StorageAssetRow key={id} id={id} onDelete={onDelete} deleting={deletingAssetId === id} graphSignature={graphSignature} />)}
						</ul>
					)}
				</section>
				<section className="asset-storage-section is-used" aria-labelledby="asset-storage-used-title">
					<h4 id="asset-storage-used-title">{ko("In use", "사용 중")}</h4>
					{usedAssetIds.length === 0 ? (
						<p className="assets-empty">{ko("No stored image assets are used by a scene.", "씬에서 사용하는 저장 이미지 에셋이 없어요.")}</p>
					) : (
						<ul className="asset-storage-list">
							{usedAssetIds.map((id) => <StorageAssetRow key={id} id={id} usageCount={usageCounts.get(id) ?? 0} onDelete={onDelete} deleting={deletingAssetId === id} graphSignature={graphSignature} />)}
						</ul>
					)}
				</section>
			</>}
		</section>
	);
}


function useThumb(id) {
	// null = decoding (skeleton), undefined = record gone, object = ready.
	const [thumb, setThumb] = useState(null);
	useEffect(() => {
		let alive = true;
		loadThumb(id).then((result) => {
			if (alive) setThumb(result ?? undefined);
		});
		return () => {
			alive = false;
		};
	}, [id]);
	return thumb;
}

/** One imported picture. The tile renders immediately as a skeleton and the
 * thumbnail lands when the decode does; the grid never waits on a decode. */
function ImageAssetTile({ id, onAssetGrab, onAssetPlace, selectedKey, onSelect, query }) {
	const thumb = useThumb(id);
	// undefined = another tab swept the record: show nothing. null = the bytes
	// did not decode: the tile MUST stay visible so storage can delete it.
	if (thumb === undefined) return null;
	const label = thumb?.name?.replace(/\.[^.]+$/, "") || ko("Image", "이미지");
	if (!matchesQuery(label, query)) return null;
	const failed = thumb === null;
	const payload = { kind: "image", assetId: id, label, aspect: thumb?.aspect ?? 1, thumb: thumb?.url ?? null };
	const key = `image:${id}`;
	return (
		<ContentTile
			assetKey={key}
			label={label}
			type={failed ? ko("Unreadable", "읽을 수 없음") : ko("Image", "이미지")}
			failed={failed}
			title={failed
				? ko(`${label} — could not decode; delete it from Manage storage`, `${label} — 불러오지 못했어요. 저장소 관리에서 삭제할 수 있어요`, `${label} — 无法解码；请在存储管理中删除`)
				: ko(`Drag ${label} into the scene, or double-click to place it at the origin`, `${label}을(를) 씬에 드래그하거나 더블클릭해 원점에 놓으세요`, `将 ${label} 拖入场景，或双击将其放在原点`)}
			preview={thumb
				? <img className="content-tile-img" src={thumb.url} alt="" draggable={false} />
				: <span className="content-tile-skeleton" aria-hidden="true" />}
			selected={selectedKey === key}
			onSelect={onSelect}
			grab={failed ? null : grabProps(onAssetGrab, payload)}
			onPlace={failed ? null : () => onAssetPlace?.(payload)}
		/>
	);
}

function MeshAssetTile({ id, onAssetGrab, onAssetPlace, selectedKey, onSelect, query }) {
	const thumb = useThumb(id);
	if (thumb === undefined) return null;
	const label = thumb?.name?.replace(/\.[^.]+$/, "") || ko("Model", "모델");
	if (!matchesQuery(label, query)) return null;
	const failed = thumb === null;
	const payload = { kind: "mesh", assetId: id, label };
	const key = `mesh:${id}`;
	return (
		<ContentTile
			assetKey={key}
			label={label}
			type={failed ? ko("Unreadable", "읽을 수 없음") : ko("Model", "모델")}
			failed={failed}
			title={failed
				? ko(`${label} — could not read; delete it from Manage storage`, `${label} — 불러오지 못했어요. 저장소 관리에서 삭제할 수 있어요`, `${label} — 无法读取；请在存储管理中删除`)
				: ko(`Drag ${label} into the scene, or double-click to place it at the origin`, `${label}을(를) 씬에 드래그하거나 더블클릭해 원점에 놓으세요`, `将 ${label} 拖入场景，或双击将其放在原点`)}
			preview={failed ? <span className="content-tile-skeleton" aria-hidden="true" /> : <MeshPreview />}
			selected={selectedKey === key}
			onSelect={onSelect}
			grab={failed ? null : grabProps(onAssetGrab, payload)}
			onPlace={failed ? null : () => onAssetPlace?.(payload)}
		/>
	);
}

function CameraPreview() {
	return (
		<svg className="asset-card-preview content-glyph is-camera" viewBox="0 0 48 48" aria-hidden="true">
			<rect x="7" y="16" width="24" height="18" rx="3" />
			<path d="m31 22 10-5v16l-10-5Z" />
			<circle cx="14" cy="11" r="4" />
			<circle cx="24" cy="11" r="4" />
		</svg>
	);
}

function MotionPreview() {
	return (
		<svg className="asset-card-preview content-glyph is-motion" viewBox="0 0 48 48" aria-hidden="true">
			<path d="M6 32c6 0 7-14 13-14s7 14 13 14 6-10 10-10" />
			<circle cx="6" cy="32" r="2.5" />
			<circle cx="42" cy="22" r="2.5" />
		</svg>
	);
}

function matchesQuery(label, query) {
	return !query || String(label).toLowerCase().includes(query);
}

/** Folder ids in display order. Basic Shapes holds the object catalogue's
 * primitives; Props holds what the user imported. */
const FOLDERS = [
	{ id: "all", label: () => ko("All", "전체") },
	{ id: "basic", label: () => ko("Basic Shapes", "기본 도형") }, { id: "characters", label: () => ko("Characters", "인물") },
	{ id: "props", label: () => ko("Props", "소품") },
	{ id: "cameras", label: () => ko("Cameras", "카메라") },
	{ id: "motions", label: () => ko("Motions", "모션") },
	{ id: "poses", label: () => ko("Poses", "포즈") },
	{ id: "sculpts", label: () => ko("Sculpts", "조형물", "雕塑") },
];

function catalogueTile(entry, props) {
	const label = displayObjectLabel(entry.label);
	const key = `object:${entry.kind}`;
	const payload = { kind: "object", objectKind: entry.kind, label, color: entry.color };
	return (
		<ContentTile
			key={key}
			assetKey={key}
			label={label}
			type={ko("Shape", "도형")}
			title={ko(`Drag ${entry.label} into the scene, or double-click to place it at the origin`, `${label}을(를) 씬에 드래그하거나 더블클릭해 원점에 놓으세요`, `将 ${entry.label} 拖入场景，或双击将其放在原点`)}
			preview={<ObjectPreview kind={entry.kind} color={entry.color} />}
			selected={props.selectedKey === key}
			onSelect={props.onSelect}
			grab={grabProps(props.onAssetGrab, payload)}
			onPlace={() => props.onAssetPlace?.(payload)}
		/>
	);
}

const EmptyNote = ({ children }) => <p className="content-empty">{children}</p>;

const FolderView = ({ folder, ...props }) => (folder === "all" ? <AllFolders folders={FOLDERS.slice(1)} Grid={FolderGrid} {...props} /> : <FolderGrid folder={folder} {...props} />); export function FolderGrid({ folder, query, ...props }) {
	const { imageAssetIds, meshAssetIds, shots = [], takeVersions = [], poses = [], onShotOpen, onTakeOpen, selectedKey, onSelect } = props;
	let tiles = [];
	let empty = null;
	if (folder === "sculpts") return <SculptShelf query={query} {...props} />;
	if (folder === "basic") {
		tiles = OBJECT_LIBRARY
			.filter((entry) => entry.group === "Primitives" && matchesQuery(displayObjectLabel(entry.label), query))
			.map((entry) => catalogueTile(entry, props));
	} else if (folder === "characters") {
		tiles = CHARACTER_ASSETS.filter((asset) => matchesQuery(asset.label, query)).map((asset) => {
			const key = `character:${asset.id}`;
			const payload = { kind: "character", id: asset.id, label: asset.label };
			return (
				<ContentTile
					key={key}
					assetKey={key}
					label={asset.label}
					type={ko("Character", "인물")}
					title={ko(`Drag ${asset.label} into the scene, or double-click to place it at the origin`, `${asset.label}을(를) 씬에 드래그하거나 더블클릭해 원점에 놓으세요`, `将 ${asset.label} 拖入场景，或双击将其放在原点`)}
					preview={<CharacterPreview model={asset.id} />}
					selected={selectedKey === key}
					onSelect={onSelect}
					grab={grabProps(props.onAssetGrab, payload)}
					onPlace={() => props.onAssetPlace?.(payload)}
				/>
			);
		});
	} else if (folder === "props") {
		if (imageAssetIds === null || meshAssetIds === null) {
			tiles = [0, 1, 2].map((n) => (
				<span className="content-tile is-loading" key={`loading-${n}`} aria-hidden="true">
					<span className="content-tile-thumb"><span className="content-tile-skeleton" /></span>
				</span>
			));
		} else {
			tiles = [
				...imageAssetIds.map((id) => <ImageAssetTile key={`image:${id}`} id={id} query={query} {...props} />),
				...meshAssetIds.map((id) => <MeshAssetTile key={`mesh:${id}`} id={id} query={query} {...props} />),
			];
			if (!tiles.length) empty = ko(
				"No imported props yet. Drop or paste a picture, or drop a .glb, .obj or .fbx into the studio.",
				"아직 가져온 소품이 없어요. 이미지를 드래그하거나 붙여넣고, .glb·.obj·.fbx 파일을 스튜디오에 끌어다 놓으세요.",
			);
		}
	} else if (folder === "cameras") {
		tiles = shots.filter((shot) => matchesQuery(shot.name ?? shot.id, query)).map((shot) => {
			const key = `shot:${shot.id}`;
			const label = shot.name || shot.id;
			return (
				<ContentTile
					key={key}
					assetKey={key}
					label={label}
					type={ko("Camera", "카메라")}
					title={ko(`${label} — double-click to open it in Camera mode`, `${label} — 더블클릭하면 카메라 모드에서 엽니다`, `${label} — 双击可在摄影机模式中打开`)}
					preview={<CameraPreview />}
					selected={selectedKey === key}
					onSelect={onSelect}
					onPlace={onShotOpen ? () => onShotOpen(shot.id) : null}
				/>
			);
		});
		if (!shots.length) empty = ko("No shot cameras yet. Use + Add › Camera in the viewport.", "아직 샷 카메라가 없어요. 뷰포트의 + Add › 카메라를 사용하세요.");
	} else if (folder === "motions") {
		tiles = takeVersions.map((entry, index) => ({ entry, index, label: `v${index + 1}${entry.label ? ` · ${entry.label}` : ""}` }))
			.filter(({ label }) => matchesQuery(label, query))
			.map(({ entry, index, label }) => {
				const key = `take:${index}`;
				return (
					<ContentTile
						key={key}
						assetKey={key}
						label={label}
						type={ko("Motion", "모션")}
						title={ko(`${label} — double-click to load this take`, `${label} — 더블클릭하면 이 테이크를 불러옵니다`, `${label} — 双击加载此动作片段`)}
						preview={<MotionPreview />}
						selected={selectedKey === key}
						onSelect={onSelect}
						onPlace={onTakeOpen ? () => onTakeOpen(entry) : null}
					/>
				);
			});
		if (!takeVersions.length) empty = ko("No takes for this character yet. Ask the agent to compile one.", "이 인물의 테이크가 아직 없어요. 에이전트에게 모션 컴파일을 요청하세요.");
	} else if (folder === "poses") {
		tiles = poses.map((pose, index) => ({ pose, index, label: pose?.name || pose?.label || ko(`Pose ${index + 1}`, `포즈 ${index + 1}`, `姿势 ${index + 1}`) }))
			.filter(({ label }) => matchesQuery(label, query))
			.map(({ pose, index, label }) => {
				const key = `pose:${pose?.id ?? index}`;
				return (
					<ContentTile
						key={key}
						assetKey={key}
						label={label}
						type={ko("Pose", "포즈")}
						title={label}
						preview={<CharacterPreview model="y-bot-tpose" />}
						selected={selectedKey === key}
						onSelect={onSelect}
					/>
				);
			});
		if (!poses.length) empty = ko("No saved poses yet. Save one from the pose studio.", "저장된 포즈가 아직 없어요. 포즈 스튜디오에서 저장하세요.");
	}
	if (empty) return <EmptyNote>{empty}</EmptyNote>;
	if (query && folder !== "props" && !tiles.length) return <SearchEmpty surface="assets" query={query}><EmptyNote>{ko("Nothing matches this search.", "검색 결과가 없어요.")}</EmptyNote></SearchEmpty>;
	return <div className="content-grid" role="list">{tiles}</div>;
}

const LOG_KIND_LABEL = {
	toast: () => ko("Note", "알림"),
	generation: () => ko("Generate", "생성"),
	export: () => ko("Export", "내보내기"),
	info: () => ko("Info", "정보"),
};

function formatLogTime(at) {
	const date = new Date(at);
	return [date.getHours(), date.getMinutes(), date.getSeconds()].map((n) => String(n).padStart(2, "0")).join(":");
}

/** The Log tab: every session event the log store collected, newest last,
 * pinned to the bottom while new events arrive. */
function LogView({ query }) {
	const entries = useSyncExternalStore(logStore.subscribe, logStore.getEntries, logStore.getEntries);
	const listRef = useRef(null);
	const visible = query ? entries.filter((entry) => entry.text.toLowerCase().includes(query)) : entries;
	useLayoutEffect(() => {
		const list = listRef.current;
		if (list) list.scrollTop = list.scrollHeight;
	}, [visible.length, visible[visible.length - 1]?.text]);
	if (!entries.length) return <EmptyNote>{ko("No events yet this session. Notices, generation jobs and exports appear here.", "이번 세션의 기록이 아직 없어요. 알림, 생성 작업, 내보내기가 여기에 표시됩니다.")}</EmptyNote>;
	if (!visible.length) return <SearchEmpty surface="assets" query={query}><EmptyNote>{ko("Nothing matches this search.", "검색 결과가 없어요.")}</EmptyNote></SearchEmpty>;
	return (
		<ol className="content-log" ref={listRef} data-testid="content-log" aria-live="polite">
			{visible.map((entry) => (
				<li className="content-log-row" key={entry.id} data-kind={entry.kind} data-testid="content-log-entry">
					<time className="content-log-time" dateTime={new Date(entry.at).toISOString()}>{formatLogTime(entry.at)}</time>
					<span className="content-log-kind">{(LOG_KIND_LABEL[entry.kind] ?? LOG_KIND_LABEL.info)()}</span>
					<span className="content-log-text" title={entry.text}>{entry.text}</span>
				</li>
			))}
		</ol>
	);
}

function Chevron({ open }) {
	return (
		<svg className="content-chevron" viewBox="0 0 12 12" aria-hidden="true" data-open={open || undefined}>
			<path d="m4 2.5 3.5 3.5L4 9.5" />
		</svg>
	);
}

/**
 * The bottom dock's Content | Log pane (v2 2a, G10/G11).
 *
 * Content lists everything placeable under seven folders; the drag itself is
 * owned by App (ghost overlay + ground raycast on drop), the pane only reports
 * the grab with a discriminated payload, and double-click hands the same
 * payload to `onAssetPlace` for an origin placement.
 *
 * `imageAssetIds` / `meshAssetIds` are null while App's asset scan is in
 * flight, then the SOURCE ids (see asset-shelf.js). `onShelfVisibleChange`
 * tells App when the imported-asset folder is on screen so it scans only then.
 */
export default function AssetPane({
	onAssetGrab, onAssetPlace, imageAssetIds, meshAssetIds = null, manageStorage, onManageStorageToggle,
	unusedAssetIds, usedAssetIds, usageCounts, graphSignature, trashCount, onDeleteUnusedAsset, onUndoDelete,
	deletingAssetId, resourceManifest, shots, takeVersions, poses, onShotOpen, onTakeOpen,
	collapsed, onCollapsedChange, onShelfVisibleChange,
}) {
	const [tab, setTab] = useState("content");
	const [folder, setFolder] = useState("all");
	const [search, setSearch] = useState("");
	const [selectedKey, setSelectedKey] = useState(null);
	const query = search.trim().toLowerCase();
	const shelfVisible = !collapsed && tab === "content" && (folder === "props" || folder === "all" || manageStorage);
	useEffect(() => {
		onShelfVisibleChange?.(shelfVisible);
	}, [shelfVisible, onShelfVisibleChange]);
	const folderLabel = manageStorage ? ko("Manage storage", "저장 공간 관리") : FOLDERS.find((entry) => entry.id === folder).label();
	const openFolder = (id) => {
		setFolder(id);
		setSelectedKey(null);
		if (manageStorage) onManageStorageToggle();
	};
	return (
		<section className="content-browser" data-testid="content-browser" data-collapsed={collapsed || undefined} aria-label={ko("Content", "콘텐츠")}>
			<header className="content-head">
				<button
					type="button"
					className="content-collapse"
					data-testid="content-collapse"
					aria-expanded={!collapsed}
					aria-label={collapsed ? ko("Expand content", "콘텐츠 펼치기") : ko("Collapse content", "콘텐츠 접기")}
					title={collapsed ? ko("Expand Content", "콘텐츠 펼치기") : ko("Collapse Content — the Sequencer takes the full width", "콘텐츠 접기 — 시퀀서가 전체 너비를 씁니다")}
					onClick={() => onCollapsedChange(!collapsed)}
				>
					<Chevron open={!collapsed} />
				</button>
				<div className="content-tabs" role="tablist" aria-label={ko("Content and Log", "콘텐츠와 로그")}>
					<button type="button" role="tab" data-testid="content-tab-content" aria-selected={tab === "content"} onClick={() => { setTab("content"); if (collapsed) onCollapsedChange(false); }}>{ko("Content", "콘텐츠")}</button>
					<button type="button" role="tab" data-testid="content-tab-log" aria-selected={tab === "log"} onClick={() => { setTab("log"); if (collapsed) onCollapsedChange(false); }}>{ko("Log", "로그")}</button>
				</div>
				{/* No folder picker: Content shows every folder on one scroll (asset-all-grid.jsx). */}
				{tab === "content" && !collapsed && <button type="button" className="content-storage-toggle" data-testid="content-storage-toggle" aria-pressed={!!manageStorage} onClick={() => { if (manageStorage) openFolder("all"); else onManageStorageToggle(); }}>{manageStorage ? ko("Back to content", "콘텐츠로") : ko("Manage storage", "저장 공간 관리")}</button>}
				<nav className="content-breadcrumb" aria-label={ko("Location", "위치")}>
					{tab === "content" ? <>
						<span>{ko("Content", "콘텐츠")}</span><span aria-hidden="true">/</span><span className="is-leaf">{folderLabel}</span>
					</> : <>
						<span>{ko("Log", "로그")}</span><span aria-hidden="true">/</span><span className="is-leaf">{ko("This session", "이번 세션")}</span>
					</>}
				</nav>
				<input
					type="search"
					className="content-search"
					data-testid="content-search"
					value={search}
					placeholder={tab === "content" ? ko("Search objects", "오브젝트 검색") : ko("Search", "검색")}
					aria-label={tab === "content" ? ko(`Search ${folderLabel}`, `${folderLabel} 검색`, `搜索 ${folderLabel}`) : ko("Search the log", "로그 검색")}
					onChange={(event) => setSearch(event.target.value)}
				/>
			</header>
			{collapsed ? null : tab === "log" ? (
				<div className="content-body is-log"><LogView query={query} /></div>
			) : (
				<div className="content-body">
					<nav className="content-folders" aria-label={ko("Folders", "폴더")}>
						{FOLDERS.map((entry) => (
							<button
								type="button"
								key={entry.id}
								className="content-folder"
								data-testid={`content-folder-${entry.id}`}
								aria-current={!manageStorage && folder === entry.id ? "true" : undefined}
								onClick={() => openFolder(entry.id)}
							>
								{entry.label()}
							</button>
						))}
						<button type="button" className="content-folder is-utility" aria-pressed={manageStorage} onClick={onManageStorageToggle}>
							{ko("Manage storage", "저장 공간 관리")}
						</button>
					</nav>
					<div className="content-main">
						{resourceManifest?.items?.length ? <ResourceStatus manifest={resourceManifest} compact /> : null}
						{manageStorage ? (
							<StorageManager unusedAssetIds={unusedAssetIds} usedAssetIds={usedAssetIds} usageCounts={usageCounts} graphSignature={graphSignature} trashCount={trashCount} onDelete={onDeleteUnusedAsset} onUndo={onUndoDelete} deletingAssetId={deletingAssetId} />
						) : (
							<FolderView
								folder={folder}
								query={query}
								onAssetGrab={onAssetGrab}
								onAssetPlace={onAssetPlace}
								imageAssetIds={imageAssetIds}
								meshAssetIds={meshAssetIds}
								shots={shots}
								takeVersions={takeVersions}
								poses={poses}
								onShotOpen={onShotOpen}
								onTakeOpen={onTakeOpen}
								selectedKey={selectedKey}
								onSelect={setSelectedKey}
							/>
						)}
					</div>
					{!manageStorage && <p className="content-hint">{ko("Drag into the scene to place", "장면으로 끌어 놓으세요")}</p>}
				</div>
			)}
		</section>
	);
}
