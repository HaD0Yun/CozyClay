import { useState } from "react";
import Foldout from "./Foldout.jsx";
import { ko } from "../locale.js";
import { emptyReview, reviewAtFrame } from "../shot-review.js";
import { useStudioShell } from "../shell/studio-shell-context.js";
import { toggleViewportTool, useViewportTools } from "../viewport-tools.js";

const id = prefix => `${prefix}-${globalThis.crypto?.randomUUID?.() ?? Date.now()}`;

export default function ReviewPanel({ hidden = false }) {
	const { activeShot, tlFrame, runStudioAction } = useStudioShell();
	const { annotate } = useViewportTools();
	// The draft belongs to the frame it was typed on: another shot or frame starts empty. Kept with its frame and
	// dropped while rendering, not from an effect: an effect that sets state on every frame adds a second commit to
	// each playhead move, and React counts a train of those as an update loop ("Maximum update depth exceeded").
	const at = `${activeShot?.id ?? ""}:${tlFrame}`;
	const [typed, setTyped] = useState({ at, text: "" });
	if (typed.at !== at) setTyped({ at, text: "" });
	const draft = typed.at === at ? typed.text : "", setDraft = text => setTyped({ at, text });
	const review = activeShot?.review ?? emptyReview();
	const current = reviewAtFrame(review, tlFrame);
	if (hidden || !activeShot) return null;
	const write = next => runStudioAction("shot.setReview", { shotId: activeShot.id, review: next });
	const add = () => {
		if (!draft.trim()) return;
		write({ ...review, comments: [...review.comments ?? [], { id: id("comment"), frame: tlFrame, text: draft, resolved: false }] });
		setDraft("");
	};
	return <Foldout hidden={false} defaultOpen={false} title={ko("Review", "리뷰")}>
		<label className="review-toggle"><input type="checkbox" data-testid="review-burn-in" checked={review.burnIn === true}
			onChange={event => write({ ...review, burnIn: event.target.checked })} />{ko("Burn shot metadata into MP4", "MP4에 샷 메타데이터 번인")}</label>
		<button type="button" className={"btn full" + (annotate ? " active" : "")} data-testid="review-annotate" aria-pressed={annotate}
			onClick={() => toggleViewportTool("annotate")}>{annotate ? ko("Finish annotation", "주석 완료") : ko("Draw on this frame", "이 프레임에 주석 그리기")}</button>
		<div className="review-comment-editor">
			<textarea aria-label={ko("Frame comment", "프레임 코멘트")} rows={2} value={draft} onChange={event => setDraft(event.target.value)}
				placeholder={ko(`Comment on frame ${tlFrame}`, `${tlFrame}프레임 코멘트`)} />
			<button type="button" className="btn full" data-testid="review-comment-add" disabled={!draft.trim()} onClick={add}>{ko("Add frame comment", "프레임 코멘트 추가")}</button>
		</div>
		{current.comments.map(comment => <div className={"review-comment" + (comment.resolved ? " resolved" : "")} key={comment.id} data-comment-id={comment.id}>
			<button type="button" title={ko("Resolve or reopen", "해결 또는 다시 열기")} onClick={() => write({ ...review, comments: review.comments.map(row => row.id === comment.id ? { ...row, resolved: !row.resolved } : row) })}>{comment.resolved ? "✓" : "○"}</button>
			<span>{comment.text}</span>
			<button type="button" aria-label={ko("Delete comment", "코멘트 삭제")} onClick={() => write({ ...review, comments: review.comments.filter(row => row.id !== comment.id) })}>×</button>
		</div>)}
		<p className="inspector-hint">{ko(`${current.annotations.length} stroke(s) on this frame · ${review.comments?.length ?? 0} comment(s) in this shot`, `이 프레임 주석 ${current.annotations.length}개 · 이 샷 코멘트 ${review.comments?.length ?? 0}개`)}</p>
	</Foldout>;
}
