// The rail's Annotate cell: no selection needed. It arms the pen for marking
// any part of the stage for the agent (context-chip-tools.jsx): a click marks
// a point, a loop rings what is inside it, a stroke runs along a body, an
// object or the floor. Esc or the cell again leaves it. The N key
// pins a timeline note at the playhead. The cell also hands the stage the
// live scene it names marks from.
import { useEffect, useRef } from "react";
import { FiEdit3 } from "react-icons/fi";
import { useStudioShell } from "./studio-shell-context.js";
import { ko } from "../locale.js";
import { registerAnnotateWorld, setAnnotateTool, useViewportSketch } from "../viewport-sketch.js";
import { dropNoteAtPlayhead } from "../context-chip-actions.js";
import "./annotate.css";

const typing = (target) => Boolean(target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(String(target.tagName ?? ""))));

export default function AnnotateCell() {
	const shell = useStudioShell();
	const sketch = useViewportSketch();
	const shellRef = useRef(shell);
	useEffect(() => { shellRef.current = shell; });
	useEffect(() => {
		registerAnnotateWorld(() => { const current = shellRef.current; return current?.appContext ? { ...current.appContext.live.state, shell: current } : null; });
		const onKey = (event) => {
			if (event.code !== "KeyN" || event.repeat || event.metaKey || event.ctrlKey || event.altKey || typing(event.target) || typing(document.activeElement)) return;
			event.preventDefault();
			dropNoteAtPlayhead(shellRef.current);
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, []);
	if (!shell) return null;
	const armed = Boolean(sketch.tool);
	return (
		<button
			type="button"
			className={"vp-tool-key vp-annotate-cell" + (armed ? " active" : "")}
			data-testid="annotate"
			aria-pressed={armed}
			aria-label={ko("Annotate", "주석")}
			title={ko("Annotate — click, ring or draw over any part of the stage for the agent; Esc leaves", "주석 — 무대 어디든 클릭하거나 두르거나 그어 에이전트에게 표시; Esc로 나가기")}
			onClick={() => setAnnotateTool(armed ? null : "pen")}
		>
			<FiEdit3 className="vp-icon" size={13} aria-hidden="true" />
		</button>
	);
}
