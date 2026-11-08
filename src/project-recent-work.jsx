// The start screen's Recent work: every project this browser opened or saved,
// plus the projects in a stored folder. A row selects on click (the preview
// column then describes it), opens on double-click or Enter, and the list
// filters as you type. Arrow keys move the selection; Delete forgets a recent.
import { useEffect, useMemo, useRef, useState } from "react";
import { LOCALE, ko } from "./locale.js";
import { summarizeHandle } from "./project-summary.js";
import { loadProjectThumb } from "./project-thumbs.js";

const relative = new Intl.RelativeTimeFormat(LOCALE, { numeric: "auto" });
const STEPS = [["year", 31536000], ["month", 2592000], ["week", 604800], ["day", 86400], ["hour", 3600], ["minute", 60]];

function relativeTime(value, now = Date.now()) {
	const time = new Date(value).getTime();
	if (!Number.isFinite(time)) return ko("Recently", "최근");
	const seconds = Math.round((time - now) / 1000);
	for (const [unit, size] of STEPS) {
		if (Math.abs(seconds) >= size) return relative.format(Math.round(seconds / size), unit);
	}
	return ko("Just now", "방금");
}

const modeLabel = (mode) => (mode === "storyboard" ? ko("Storyboard", "스토리보드") : mode === "animation" ? ko("Animation", "애니메이션") : null);

function summaryParts(entry) {
	return [
		Number.isFinite(entry.scenes) ? ko(`${entry.scenes} ${entry.scenes === 1 ? "scene" : "scenes"}`, `장면 ${entry.scenes}`) : null,
		Number.isFinite(entry.shots) ? ko(`${entry.shots} ${entry.shots === 1 ? "shot" : "shots"}`, `샷 ${entry.shots}`) : null,
		modeLabel(entry.previsMode),
	].filter(Boolean);
}

// Each project's stored stage picture (project-thumbs.js) as an object URL.
function useThumbUrls(entries) {
	const [urls, setUrls] = useState({});
	useEffect(() => {
		let active = true;
		const made = [];
		void Promise.all(entries.map(async (entry) => {
			const blob = await loadProjectThumb(entry.name);
			if (!blob) return null;
			const url = URL.createObjectURL(blob);
			made.push(url);
			return [entry.name, url];
		})).then((pairs) => {
			if (active) setUrls(Object.fromEntries(pairs.filter(Boolean)));
		});
		return () => {
			active = false;
			made.forEach((url) => URL.revokeObjectURL(url));
		};
	}, [entries]);
	return urls;
}

// Older recents carry no summary; read it from the file when permission allows.
// Every entry also gains `thumb`, its stage picture when one was captured.
export function useRecentSummaries(entries) {
	const thumbs = useThumbUrls(entries);
	const [summaries, setSummaries] = useState({});
	useEffect(() => {
		let active = true;
		for (const entry of entries) {
			if (Number.isFinite(entry.scenes) || summaries[entry.key] !== undefined) continue;
			void summarizeHandle(entry.handle).then((summary) => {
				if (active) setSummaries((current) => ({ ...current, [entry.key]: summary }));
			});
		}
		return () => {
			active = false;
		};
	}, [entries]);
	return useMemo(() => entries.map((entry) => ({ ...summaries[entry.key], ...entry, thumb: thumbs[entry.name] ?? null })), [entries, summaries, thumbs]);
}

function Highlight({ text, query }) {
	const at = query ? text.toLowerCase().indexOf(query.toLowerCase()) : -1;
	if (at < 0) return text;
	return <>{text.slice(0, at)}<mark>{text.slice(at, at + query.length)}</mark>{text.slice(at + query.length)}</>;
}

export function RecentWork({ entries, selectedKey, currentName, onSelect, onOpen, onRemove, onOpenFile, onRefresh }) {
	const [query, setQuery] = useState("");
	const listRef = useRef(null);
	const shown = query.trim() ? entries.filter((entry) => entry.name.toLowerCase().includes(query.trim().toLowerCase())) : entries;
	useEffect(() => {
		listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
	}, [selectedKey]);

	const onKeyDown = (event) => {
		const index = shown.findIndex((entry) => entry.key === selectedKey);
		if (event.key === "ArrowDown" || event.key === "ArrowUp") {
			event.preventDefault();
			const next = shown[Math.min(shown.length - 1, Math.max(0, index + (event.key === "ArrowDown" ? 1 : -1)))];
			if (next) onSelect(next);
		} else if (event.key === "Enter" && shown[index]) {
			event.preventDefault();
			onOpen(shown[index]);
		} else if ((event.key === "Delete" || event.key === "Backspace") && shown[index]?.removable && event.target === listRef.current) {
			event.preventDefault();
			onRemove(shown[index]);
		}
	};

	return (
		<section className="v2-start-work" data-testid="start-recent-work" aria-label={ko("Recent work", "최근 작업")}>
			<div className="v2-start-work-head">
				<span className="v2-start-work-title">{ko("Recent work", "최근 작업")}{entries.length > 0 && <small>{entries.length}</small>}</span>
				<div className="v2-start-work-tools">
					{entries.length > 0 && <input type="search" className="v2-start-work-search" data-testid="start-recent-search" placeholder={ko("Search projects", "프로젝트 검색")} aria-label={ko("Search projects", "프로젝트 검색")} value={query} onChange={(event) => setQuery(event.target.value)} />}
					{onRefresh && <button type="button" className="v2-start-work-tool" onClick={onRefresh}>{ko("Refresh", "새로고침")}</button>}
				</div>
			</div>
			{entries.length === 0 ? (
				<div className="v2-start-work-empty">
					<div className="v2-start-work-ghosts" aria-hidden="true"><span /><span /><span /></div>
					<p>{ko("Projects you save or open show up here, newest first.", "저장하거나 연 프로젝트가 최신순으로 여기 쌓입니다.")}</p>
					<button type="button" className="v2-start-empty-open" onClick={onOpenFile}>{ko("Open a project file…", "프로젝트 파일 열기…")}</button>
				</div>
			) : shown.length === 0 ? (
				<p className="v2-start-work-none">{ko(`No project matches “${query}”.`, `“${query}”와 일치하는 프로젝트가 없어요.`)}</p>
			) : (
				<div ref={listRef} className="v2-start-work-list" role="listbox" tabIndex={0} aria-label={ko("Recent work", "최근 작업")} onKeyDown={onKeyDown}>
					{shown.map((entry) => {
						const parts = summaryParts(entry);
						return (
							<div
								key={entry.key}
								role="option"
								aria-selected={entry.key === selectedKey}
								className={`v2-start-work-row${entry.key === selectedKey ? " selected" : ""}${entry.name === currentName ? " current" : ""}`}
								data-recent-key={entry.key}
								onClick={() => onSelect(entry)}
								onDoubleClick={() => onOpen(entry)}
							>
								<span className={`v2-start-work-badge ${entry.previsMode || "unknown"}${entry.thumb ? " has-thumb" : ""}`} aria-hidden="true">{entry.thumb ? <img src={entry.thumb} alt="" draggable="false" /> : (entry.name.trim()[0] || "?").toUpperCase()}</span>
								<span className="v2-start-work-copy">
									<strong><Highlight text={entry.name} query={query.trim()} /></strong>
									<span>{parts.length ? parts.join(" · ") : ko("Details appear after it is opened", "열고 나면 정보가 표시돼요")}</span>
								</span>
								<span className="v2-start-work-source">{entry.removable ? ko("Browser", "브라우저") : ko("Folder", "폴더")}</span>
								<time className="v2-start-work-time" dateTime={new Date(entry.date || 0).toISOString()}>{relativeTime(entry.date)}</time>
								<span className="v2-start-work-actions">
									<button type="button" className="v2-start-work-open" onClick={(event) => { event.stopPropagation(); onOpen(entry); }}>{ko("Open", "열기")}</button>
									{entry.removable && <button type="button" className="v2-start-recent-remove" aria-label={ko(`Remove ${entry.name} from recent projects`, `최근 프로젝트에서 ${entry.name} 제거`, `从最近项目中移除 ${entry.name}`)} title={ko("Remove from list", "목록에서 제거")} onClick={(event) => { event.stopPropagation(); onRemove(entry); }}>×</button>}
								</span>
							</div>
						);
					})}
				</div>
			)}
		</section>
	);
}

// The preview art for a selected recent project: its own stage, or a tile that
// says the picture arrives with the next open or save.
export function RecentArt({ entry }) {
	if (entry.thumb) return <img className="v2-start-art" data-testid="start-recent-thumb" src={entry.thumb} alt="" aria-hidden="true" draggable="false" />;
	return (
		<span className="v2-start-recent-noart" data-testid="start-recent-noart">
			<strong>{(entry.name.trim()[0] || "?").toUpperCase()}</strong>
			<span>{ko("Preview appears after you open or save it", "열거나 저장하면 미리보기가 생겨요")}</span>
		</span>
	);
}

// The preview column for a selected recent project.
export function RecentPreview({ entry, onOpen, onRemove, onBack }) {
	const parts = summaryParts(entry);
	return (
		<div className="v2-start-recent-preview" data-testid="start-recent-preview">
			<div className="v2-start-preview-copy">
				<strong>{entry.name}</strong>
				<span>{ko(`Last opened ${relativeTime(entry.date)}`, `마지막으로 연 시간: ${relativeTime(entry.date)}`)}</span>
			</div>
			<dl className="v2-start-recent-facts">
				<div><dt>{ko("Contents", "내용")}</dt><dd>{parts.length ? parts.join(" · ") : "—"}</dd></div>
				<div><dt>{ko("Cast", "캐스트")}</dt><dd>{entry.castStyle === "hybrid" ? ko("Hybrid", "하이브리드") : entry.castStyle === "rig" ? ko("Humanoid", "휴머노이드") : entry.castStyle === "capsule" ? ko("Capsule", "캡슐") : "—"}</dd></div>
				<div><dt>{ko("Stored in", "저장 위치")}</dt><dd>{entry.removable ? ko("This browser's recents", "이 브라우저 최근 목록") : ko("Projects folder", "프로젝트 폴더")}</dd></div>
			</dl>
			<div className="v2-start-preview-actions">
				{entry.removable && <button type="button" className="v2-start-cancel" onClick={() => onRemove(entry)}>{ko("Remove", "목록에서 제거")}</button>}
				<button type="button" className="v2-start-cancel" onClick={onBack}>{ko("New instead", "새로 만들기")}</button>
				<button type="button" className="v2-start-create btn primary" data-testid="start-open-recent" onClick={() => onOpen(entry)}>{ko("Open", "열기")}</button>
			</div>
		</div>
	);
}
