import { useEffect, useRef, useState } from "react";
import { useStudioShell } from "./studio-shell-context.js";
import { ko } from "../locale.js";
import { assetRecord, rememberAsset } from "../scene-asset-cache.js";
import { ASSET_MAX_SOURCE_BYTES, importImageFile } from "../scene-assets.js";
import { STILL_HOLD_MAX } from "../shot-authoring.js";
import { track } from "../analytics.js"; import { startExportAttempt } from "../export-attempt.js";
import { bytesToDataUrl, panelVideoPrompt, sendPanelToWorkflow } from "../workflow-send.js";
import { panelStylizeRequest, requestAgentImage, stylizedPngBytes, stylizeErrorMessage } from "../agent-image-client.js";

// A card's greybox is re-captured this long after the last document edit, so
// a drag or a typing burst costs one capture pass, not one per change.
const THUMB_DEBOUNCE_MS = 500;
const PANEL_DRAG_TYPE = "application/x-cozyclay-panel";

/** The stylized picture behind a panel, as an object URL for its lifetime. */
function useStylizedUrl(assetId) {
	const [url, setUrl] = useState(null);
	useEffect(() => {
		setUrl(null);
		if (!assetId) return undefined;
		let live = true;
		let objectUrl = null;
		assetRecord(assetId).then((record) => {
			if (!live || !record) return;
			objectUrl = URL.createObjectURL(new Blob([record.bytes], { type: record.type }));
			setUrl(objectUrl);
		}, (error) => console.warn(`[cozyclay] stylized panel ${assetId} could not be read`, error));
		return () => {
			live = false;
			if (objectUrl) URL.revokeObjectURL(objectUrl);
		};
	}, [assetId]);
	return url;
}

/** Board: the storyboard's stills as a strip of panel cards, in still order.
 * Every edit goes through the shot commands, so the Sequencer, undo and the
 * Agent see the same document. */
export default function BoardSlot({ active = true }) {
	const { shots, activeShot, tlFps, runStudioAction, selectTimelineShot, capturePanelThumbnail, packMetaForShot, setToast, sceneRevision, exportPanelPacks, recState } = useStudioShell();
	const [stylizing, setStylizing] = useState({});
	const stills = shots.filter((entry) => entry.kind === "still").sort((a, b) => a.startFrame - b.startFrame);
	const [thumbs, setThumbs] = useState({});
	const [dragId, setDragId] = useState(null);
	const [drop, setDrop] = useState(null);
	const stillsRef = useRef(stills);
	stillsRef.current = stills;
	const captureRef = useRef(capturePanelThumbnail);
	captureRef.current = capturePanelThumbnail;
	const stripRef = useRef(null);
	const countRef = useRef(stills.length);

	const stillsKey = stills.map((entry) => `${entry.id}:${entry.startFrame}`).join(",");
	useEffect(() => {
		if (!active || !stillsKey) return undefined;
		const timer = setTimeout(() => {
			const next = {};
			for (const entry of stillsRef.current) {
				try {
					next[entry.id] = captureRef.current(entry);
				} catch (error) {
					console.warn(`[cozyclay] panel ${entry.id} thumbnail failed`, error);
					next[entry.id] = null;
				}
			}
			setThumbs(next);
		}, THUMB_DEBOUNCE_MS);
		return () => clearTimeout(timer);
	}, [active, sceneRevision, stillsKey]);

	// A new panel lands at the end of the strip: bring it into view.
	useEffect(() => {
		if (stills.length > countRef.current) stripRef.current?.lastElementChild?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
		countRef.current = stills.length;
	}, [stills.length]);

	const fps = tlFps || 24;
	const addPanel = () => runStudioAction("shot.createStill", {});

	// Append the panel picture (greybox, or the stylized image) and a Video
	// node wired to it to the Workflow draft, then open the canvas. Nothing runs.
	async function sendToWorkflow(entry, source) {
		const attempt = startExportAttempt({ export_kind: "workflow_send", format: "png", surface: "studio" });
		try {
			let dataUrl;
			let mimeType = "image/png";
			if (source === "stylized") {
				const record = await assetRecord(entry.stylizedAssetId);
				if (!record) throw new Error(ko("the stylized image is missing", "스타일화 이미지를 찾을 수 없어요"));
				mimeType = record.type || "image/png";
				dataUrl = bytesToDataUrl(record.bytes, mimeType);
			} else {
				dataUrl = capturePanelThumbnail(entry);
			}
			if (!dataUrl) throw new Error(ko("the shot renderer is not ready", "샷 렌더러가 아직 준비되지 않았어요"));
			const index = shots.findIndex((candidate) => candidate.id === entry.id);
			const prompt = panelVideoPrompt(packMetaForShot(entry, index), entry.caption);
			sendPanelToWorkflow({ dataUrl, mimeType, fileName: `panel-${stills.findIndex((candidate) => candidate.id === entry.id) + 1}.${mimeType.split("/")[1] || "png"}`, prompt });
			attempt.succeed();
			setToast(ko("Panel sent to Workflow", "패널을 워크플로로 보냈어요"));
			window.open("/workflow/", "_blank", "noopener,noreferrer");
		} catch (error) {
			attempt.fail(error);
			console.warn(`[cozyclay] panel ${entry.id} could not be sent to Workflow`, error);
			setToast(/quota/i.test(error?.name || "") ? ko("The Workflow draft is full. Remove pictures from the Workflow canvas, or save the project, then send the panel again.", "워크플로 초안이 가득 찼어요. 워크플로 캔버스에서 그림을 지우거나 프로젝트를 저장한 뒤 패널을 다시 보내 주세요.", "工作流草稿已满。请从工作流画布中删除图片，或保存项目，然后重新发送面板。") : ko(`Could not send the panel to Workflow: ${error?.message || error}`,`패널을 워크플로로 보내지 못했어요: ${error?.message || error}`, `无法将面板发送到工作流：${error?.message || error}`));
		}
	}

	// Stylize: the panel's full-size frame through /agent/image. The picture is
	// stored as an image asset first, then one shot.setStylized names it, so a
	// failure anywhere leaves the panel as it was. Never runs on its own.
	async function stylize(entry) {
		if (stylizing[entry.id]) return;
		setStylizing((current) => ({ ...current, [entry.id]: true }));
		try {
			// The thumbnail capture is the full-size export frame at the shot camera.
			const imageDataUrl = capturePanelThumbnail(entry);
			if (!imageDataUrl) throw new Error(ko("the shot renderer is not ready yet", "샷 렌더러가 아직 준비되지 않았어요"));
			const meta = packMetaForShot(entry, shots.findIndex((candidate) => candidate.id === entry.id));
			const result = await requestAgentImage(panelStylizeRequest({ meta, caption: entry.caption, imageDataUrl }));
			const bytes = stylizedPngBytes(result?.dataUrl, ASSET_MAX_SOURCE_BYTES);
			const asset = await rememberAsset(await importImageFile(new File([bytes], `${entry.name || "panel"} stylized.png`, { type: "image/png" })));
			if (!runStudioAction("shot.setStylized", { shotId: entry.id, assetId: asset.id })) throw new Error(ko("the panel is no longer on the board", "패널이 보드에 더 이상 없어요"));
			track("storyboard:panel_stylized", { outcome: "ok" });
		} catch (error) {
			track("storyboard:panel_stylized", { outcome: "error" });
			console.warn(`[cozyclay] panel ${entry.id} stylize failed`, error);
			setToast(stylizeErrorMessage(error));
		} finally {
			setStylizing(({ [entry.id]: _done, ...rest }) => rest);
		}
	}

	function dropTarget(event, entry) {
		const box = event.currentTarget.getBoundingClientRect();
		return { id: entry.id, after: event.clientX > box.left + box.width / 2 };
	}

	function reorderTo(target) {
		const moving = dragId;
		setDragId(null);
		setDrop(null);
		if (!moving || !target || moving === target.id) return;
		const others = stills.filter((entry) => entry.id !== moving);
		const index = others.findIndex((entry) => entry.id === target.id) + (target.after ? 1 : 0);
		if (stills.findIndex((entry) => entry.id === moving) === index) return;
		runStudioAction("shot.reorder", { shotId: moving, index });
	}

	return (
		<section className="dock-board" aria-label={ko("Board", "보드")} data-testid="dock-board" hidden={!active}>
			<header className="dock-board-head">
				<span className="dock-board-count">{ko(`${stills.length} panels`, `패널 ${stills.length}개`, `${stills.length} 个面板`)}</span>
				{/* An empty board offers + Panel once, in its empty state. */}
				{stills.length > 0 && (
					<button type="button" className="dock-board-add" data-testid="board-add-panel" title={ko("Add a panel after the last one, framed by the current camera", "현재 카메라 구도로 마지막 패널 뒤에 패널 추가")} onClick={addPanel}>
						{ko("+ Panel", "+ 패널")}
					</button>
				)}
			</header>
			{stills.length === 0 ? (
				<div className="dock-board-empty" data-testid="board-empty">
					<p>{ko("No panels yet. Each panel is one held picture of the scene through the shot camera.", "아직 패널이 없어요. 패널 하나는 샷 카메라로 본 장면 한 장을 일정 시간 보여 줍니다.")}</p>
					<button type="button" className="dock-board-add" data-testid="board-empty-add" title={ko("Add the first panel, framed by the current camera", "현재 카메라 구도로 첫 패널 추가")} onClick={addPanel}>{ko("+ Panel", "+ 패널")}</button>
				</div>
			) : (
				<ol className="dock-board-strip" ref={stripRef} data-testid="board-strip">
					{stills.map((entry, index) => (
						<PanelCard
							key={entry.id}
							shot={entry}
							index={index}
							fps={fps}
							thumb={thumbs[entry.id] ?? null}
							stylizing={Boolean(stylizing[entry.id])}
							onStylize={() => stylize(entry)}
							onUnstylize={() => runStudioAction("shot.setStylized", { shotId: entry.id, assetId: null })}
							selected={activeShot?.id === entry.id}
							dragging={dragId === entry.id}
							dropSide={drop?.id === entry.id ? (drop.after ? "after" : "before") : null}
							onSelect={() => selectTimelineShot(entry.id)}
							onRemove={() => runStudioAction("shot.remove", { shotId: entry.id })}
							onDuplicate={() => runStudioAction("shot.duplicate", { shotId: entry.id })}
							onCaption={(caption) => runStudioAction("shot.setCaption", { shotId: entry.id, caption })}
							onHold={(hold) => runStudioAction("shot.setHold", { shotId: entry.id, hold })}
							onSendToWorkflow={(source) => sendToWorkflow(entry, source)}
						exporting={recState === "recording"}
						onExport={() => exportPanelPacks(false, entry.id)}
							onDragStart={(event) => {
								event.dataTransfer.effectAllowed = "move";
								event.dataTransfer.setData(PANEL_DRAG_TYPE, entry.id);
								setDragId(entry.id);
							}}
							onDragOver={(event) => {
								if (!dragId) return;
								event.preventDefault();
								event.dataTransfer.dropEffect = "move";
								const next = dropTarget(event, entry);
								if (drop?.id !== next.id || drop?.after !== next.after) setDrop(next);
							}}
							onDrop={(event) => {
								event.preventDefault();
								reorderTo(dropTarget(event, entry));
							}}
							onDragEnd={() => { setDragId(null); setDrop(null); }}
						/>
					))}
				</ol>
			)}
		</section>
	);
}

function PanelCard({ shot, index, fps, thumb, stylizing, onStylize, onUnstylize, selected, dragging, dropSide, onSelect, onRemove, onDuplicate, onCaption, onHold, onSendToWorkflow, exporting, onExport, onDragStart, onDragOver, onDrop, onDragEnd }) {
	const stylized = useStylizedUrl(shot.stylizedAssetId);
	const [sendMenu, setSendMenu] = useState(false);
	const hold = shot.endFrame - shot.startFrame + 1;
	const seconds = Number((hold / fps).toFixed(2));
	const stop = (event) => event.stopPropagation();

	function commitCaption(event) {
		const next = event.currentTarget.value.trim();
		if (next !== (shot.caption ?? "")) onCaption(next);
	}

	function commitHold(event) {
		const value = Number(event.currentTarget.value);
		const frames = Math.round(value * fps);
		if (!Number.isFinite(value) || frames < 1 || frames > STILL_HOLD_MAX) {
			event.currentTarget.value = String(seconds);
			return;
		}
		if (frames !== hold) onHold(frames);
	}

	return (
		<li
			className="dock-board-card"
			data-testid="board-card"
			data-shot-id={shot.id}
			data-selected={selected || undefined}
			data-dragging={dragging || undefined}
			data-drop={dropSide ?? undefined}
			data-stylizing={stylizing || undefined}
			tabIndex={0}
			draggable
			aria-label={ko(`Panel ${index + 1}`, `패널 ${index + 1}`, `面板 ${index + 1}`)}
			aria-current={selected ? "true" : undefined}
			onClick={onSelect}
			onKeyDown={(event) => {
				if (event.target !== event.currentTarget) return;
				if (event.key === "Delete") {
					event.preventDefault();
					event.stopPropagation();
					onRemove();
				} else if (event.key === "Enter") {
					onSelect();
				}
			}}
			onDragStart={onDragStart}
			onDragOver={onDragOver}
			onDrop={onDrop}
			onDragEnd={onDragEnd}
		>
			<div className="dock-board-actions">
				<button type="button" data-action="duplicate" title={ko("Duplicate this panel after itself", "이 패널을 바로 뒤에 복제")} onClick={(event) => { stop(event); onDuplicate(); }}>{ko("Duplicate", "복제")}</button>
				<button type="button" data-action="delete" className="danger" title={ko("Delete this panel (Delete)", "이 패널 삭제 (Delete)")} onClick={(event) => { stop(event); onRemove(); }}>{ko("Delete", "삭제")}</button>
				<button type="button" data-action="stylize" data-fid="board_stylize" disabled={stylizing}
					title={shot.stylizedAssetId
						? ko("Generate a new stylized picture from this panel's frame and caption (replaces the current one)", "이 패널의 프레임과 캡션으로 스타일화 그림을 새로 생성 (지금 그림을 바꿔요)")
						: ko("Generate a stylized picture from this panel's frame and caption", "이 패널의 프레임과 캡션으로 스타일화 그림 생성")}
					onClick={(event) => { stop(event); onStylize(); }}>
					{stylizing ? ko("Stylizing...", "스타일화 중...") : shot.stylizedAssetId ? ko("Re-stylize", "다시 스타일화") : ko("Stylize", "스타일화")}
				</button>
				{shot.stylizedAssetId && !stylizing && (
					<button type="button" data-action="unstylize" title={ko("Remove the stylized picture; the greybox stays", "스타일화 그림 제거 (그레이박스는 남아요)")} onClick={(event) => { stop(event); onUnstylize(); }}>{ko("Remove", "제거")}</button>
				)}
				<button
					type="button"
					data-action="workflow"
					title={ko("Send this panel to a Workflow video node", "이 패널을 워크플로 비디오 노드로 보내기")}
					aria-haspopup={shot.stylizedAssetId ? "menu" : undefined}
					aria-expanded={shot.stylizedAssetId ? sendMenu : undefined}
					onClick={(event) => {
						stop(event);
						// Only a stylized panel has a choice to make.
						if (shot.stylizedAssetId) setSendMenu((open) => !open);
						else onSendToWorkflow("greybox");
					}}
				>{ko("Send to Workflow", "워크플로로")}</button>
				{sendMenu && shot.stylizedAssetId && (
					<div className="dock-board-menu" role="menu" aria-label={ko("Send to Workflow", "워크플로로 보내기")} onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); setSendMenu(false); } }}>
						<button type="button" role="menuitem" data-send-source="stylized" autoFocus onClick={(event) => { stop(event); setSendMenu(false); onSendToWorkflow("stylized"); }}>{ko("Stylized image", "스타일화 이미지")}</button>
						<button type="button" role="menuitem" data-send-source="greybox" onClick={(event) => { stop(event); setSendMenu(false); onSendToWorkflow("greybox"); }}>{ko("Greybox", "그레이박스")}</button>
					</div>
				)}
				<button type="button" data-action="export" data-fid="board_export" disabled={exporting} title={exporting ? ko("Export — another export is running", "내보내기 — 다른 내보내기가 진행 중입니다") : ko("Export this panel as a pack (zip)", "이 패널을 팩(zip)으로 내보내기")} data-disabled-reason={exporting ? "export-running" : undefined} onClick={(event) => { stop(event); onExport(); }}>{ko("Export", "내보내기")}</button>
			</div>
			<div className="dock-board-thumb" data-stylized={stylized ? "true" : undefined}>
				{stylized ? <img className="dock-board-image" src={stylized} alt="" draggable={false} /> : thumb && <img className="dock-board-image" src={thumb} alt="" draggable={false} />}
				{stylized && thumb && <img className="dock-board-inset" src={thumb} alt="" draggable={false} />}
				<span className="dock-board-index" data-testid="board-card-index">{index + 1}</span>
				{stylizing && (
					<span data-testid="board-card-stylizing" role="status"
						style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", background: "rgba(0, 0, 0, .45)", color: "#fff", font: "500 11px var(--sans)" }}>
						{ko("Stylizing...", "스타일화 중...")}
					</span>
				)}
			</div>
			<textarea
				key={`caption:${shot.caption ?? ""}`}
				className="dock-board-caption"
				data-testid="board-card-caption"
				aria-label={ko(`Panel ${index + 1} caption`, `패널 ${index + 1} 캡션`, `面板 ${index + 1} 说明`)}
				placeholder={ko("Action or dialogue", "동작 또는 대사")}
				defaultValue={shot.caption ?? ""}
				maxLength={500}
				rows={2}
				onClick={stop}
				onBlur={commitCaption}
			/>
			<label className="dock-board-hold" onClick={stop}>
				<span>{ko("Hold", "홀드")}</span>
				<input
					key={`hold:${hold}`}
					type="number"
					data-testid="board-card-hold"
					min={1 / fps}
					max={STILL_HOLD_MAX / fps}
					step={0.5}
					defaultValue={seconds}
					aria-label={ko(`Panel ${index + 1} hold in seconds`, `패널 ${index + 1} 홀드 (초)`, `面板 ${index + 1} 停留秒数`)}
					onBlur={commitHold}
					onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }}
				/>
				<span>{ko("s", "초")}</span>
			</label>
		</li>
	);
}
