// Timeline notes on the selected character's Body lane: each pin is its range
// band with the pinned frame marked. A click reopens its chip; dragging a band
// edge sets a custom range (one undo entry on release); right-click removes
// it. The head's pin button drops one at the playhead, like the N key.
import { useRef, useState } from "react";
import { FiMapPin } from "react-icons/fi";
import { useStudioShell } from "../shell/studio-shell-context.js";
import { ko } from "../locale.js";
import { clampNoteRange } from "../timeline-notes.js";
import { dropNoteAtPlayhead, noteLabel, removeNote, reopenNote, setNoteRange } from "../context-chip-actions.js";
import "./timeline-notes.css";

const pct = (frame, count) => `${(count > 1 ? frame / (count - 1) : 0) * 100}%`;

export function NotePinButton() {
	const shell = useStudioShell();
	return (
		<button type="button" className="tl-btn tl-note-pin-add" data-testid="timeline-note-add" disabled={!shell?.activeChar}
			aria-label={ko("Pin a note at the playhead", "재생 헤드에 노트 꽂기")} title={ko("Pin a note for the agent at the playhead (N)", "재생 헤드에 에이전트용 노트 꽂기 (N)")}
			onClick={() => dropNoteAtPlayhead(shell)}>
			<FiMapPin size={11} aria-hidden="true" />
		</button>
	);
}

export function NotePins({ displayFrameCount }) {
	const shell = useStudioShell();
	const [drag, setDrag] = useState(null);
	const laneRef = useRef(null);
	const character = shell?.activeChar;
	const notes = character?.layer?.notes ?? [];
	if (!character || !notes.length) return <span ref={laneRef} hidden />;
	const frameCount = shell.tlFrameCount ?? displayFrameCount;
	const frameAt = (event) => {
		const lane = laneRef.current?.parentElement?.getBoundingClientRect();
		if (!lane?.width) return 0;
		return Math.round(((event.clientX - lane.left) / lane.width) * Math.max(1, displayFrameCount - 1));
	};
	const startEdge = (event, note, edge) => {
		if (event.button !== 0) return;
		event.preventDefault();
		event.stopPropagation();
		event.currentTarget.setPointerCapture?.(event.pointerId);
		setDrag({ id: note.id, edge, frameStart: note.frameStart, frameEnd: note.frameEnd });
	};
	const moveEdge = (event, note) => {
		if (!drag || drag.id !== note.id) return;
		const at = frameAt(event);
		setDrag({ ...drag, ...clampNoteRange(note.frame, drag.edge === "start" ? at : drag.frameStart, drag.edge === "end" ? at : drag.frameEnd, frameCount) });
	};
	const endEdge = (note) => {
		if (!drag || drag.id !== note.id) return;
		setDrag(null);
		setNoteRange(shell, character.id, note.id, { frameStart: drag.frameStart, frameEnd: drag.frameEnd });
	};
	return (
		<span ref={laneRef} className="tl-note-pins">
			{notes.map((note) => {
				const range = drag?.id === note.id ? { ...note, ...drag } : note;
				return (
					<span key={note.id} className={"tl-note-pin" + (drag?.id === note.id ? " dragging" : "")} data-note-id={note.id}
						style={{ left: pct(range.frameStart, displayFrameCount), width: `calc(${pct(range.frameEnd, displayFrameCount)} - ${pct(range.frameStart, displayFrameCount)})` }}
						title={noteLabel(range)} aria-label={noteLabel(range)}>
						<span className="tl-note-edge start" data-note-edge="start" onPointerDown={(event) => startEdge(event, note, "start")} onPointerMove={(event) => moveEdge(event, note)} onPointerUp={() => endEdge(note)} />
						<button type="button" className="tl-note-head" data-note-pin={note.id}
							style={{ left: `calc(${((note.frame - range.frameStart) / Math.max(1, range.frameEnd - range.frameStart)) * 100}% - 5px)` }}
							onPointerDown={(event) => event.stopPropagation()}
							onClick={() => reopenNote(shell, character.id, note)}
							onContextMenu={(event) => { event.preventDefault(); removeNote(shell, character.id, note.id); }}
							aria-label={ko("Open the note", "노트 열기")} />
						<span className="tl-note-edge end" data-note-edge="end" onPointerDown={(event) => startEdge(event, note, "end")} onPointerMove={(event) => moveEdge(event, note)} onPointerUp={() => endEdge(note)} />
					</span>
				);
			})}
		</span>
	);
}
