// The composer's mark chips (context-chips.js): one per annotation mark on the
// stage, on one compact row. Hovering a chip lights its mark in the view; x
// drops it; a pen stroke that starts on a character offers "Apply as walk".
import { useSyncExternalStore } from "react";
import { FiNavigation2, FiX } from "react-icons/fi";
import { highlightMark, readMarks, removeMark, subscribeMarks } from "../context-chips.js";
import { applyRouteAsWalk, markLabel, markTitle } from "../context-chip-actions.js";
import { useStudioShell } from "../shell/studio-shell-context.js";
import { ko } from "../locale.js";

export function ContextChips() {
	const marks = useSyncExternalStore(subscribeMarks, readMarks, readMarks);
	const shell = useStudioShell();
	if (!marks.length) return null;
	return (
		<ul className="agent-context-chips" aria-label={ko("Marks for the next message", "다음 메시지에 담을 표시")}>
			{marks.map((mark) => (
				<li key={mark.id} className="agent-context-chip" data-chip-kind={mark.kind} data-mark={mark.n} title={markTitle(mark)}
					onPointerEnter={() => highlightMark(mark.n)} onPointerLeave={() => highlightMark(null)}>
					<span className="agent-context-chip-label">{markLabel(mark)}</span>
					{mark.local?.walk && shell && <button type="button" className="agent-context-chip-action" data-testid="chip-apply-walk" aria-label={ko("Apply as walk", "걷기로 적용")} title={ko("Suggestion: walk this character along the stroke", "제안: 이 인물을 선을 따라 걷게 하기")} onClick={() => applyRouteAsWalk(shell, mark)}><FiNavigation2 size={9} aria-hidden="true" /></button>}
					<button type="button" className="agent-context-chip-remove" aria-label={ko("Remove the mark", "표시 제거")} onClick={() => { highlightMark(null); removeMark(mark.id); }}><FiX size={9} aria-hidden="true" /></button>
				</li>
			))}
		</ul>
	);
}
