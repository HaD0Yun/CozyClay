import { ko } from "../locale.js";

// The pose button draws the subject's body, so no two bodies share a glyph: an old Y Bot raises its arms in a Y, the
// block figure (an X Bot row) is a stack of boxes, a capsule figure is a capsule. Unknown bodies keep the plain figure.
const BODY_GLYPHS = {
	"y-bot-tpose": "M8 1.75a1.4 1.4 0 1 1 0 2.8 1.4 1.4 0 1 1 0-2.8z M4.5 5.25 8 8.25l3.5-3 M8 8.25v2.5 M6.25 14 8 10.75 9.75 14",
	"x-bot-tpose": "M6.6 1.75h2.8v2.8H6.6z M5.25 5.75h5.5v4.5h-5.5z M6.25 10.25v3.75 M9.75 10.25v3.75",
	"proxy-figure": "M8 2.5a2.25 2.25 0 0 1 2.25 2.25v6.5a2.25 2.25 0 0 1-4.5 0v-6.5A2.25 2.25 0 0 1 8 2.5z",
};
const PLAIN_FIGURE = "M8 2.25a1.5 1.5 0 1 1 0 3 1.5 1.5 0 1 1 0-3z M5 7.25h6 M8 7.25v3.5 M6.25 13.75 8 10.75l1.75 3";

export default function SubjectBox({ label, model, modelTitle, modelId, onRemove, onPose, posing, color, onColorChange, onColorEditStart }) {
	return (
		<div className="subject-box v2-subject-box">
			<div className="subject-box-head">
				<span className="sb-name">{label}</span>
				{/* Which body this subject is, as its letter (Y, X): the subjects read apart at a glance. */}
				{model && <span className="sb-model" title={modelTitle}>{model}</span>}
				<div className="sb-actions">
					{onColorChange && (
						<input
							type="color"
							className="sb-color"
							title={ko("Character color", "인물 색상")}
							aria-label={ko("Character color", "인물 색상")}
							value={color}
							/* Focus opens the session for keyboard/eyedropper use; the
							   native swatch dialog can drive onChange without focus, so the
							   first change of a session opens it too (the handler is
							   session-idempotent). */
							onFocus={onColorEditStart}
							onChange={(e) => {
								onColorEditStart?.();
								onColorChange(e.target.value);
							}}
						/>
					)}
					{onPose && (
						<button
							type="button"
							className={"cam-toggle" + (posing ? " active" : "")}
							aria-label={ko(`Open pose studio for ${label}`, `${label} 포즈 열기`, `打开 ${label} 的姿势工作室`)}
							title={ko(`Pose ${label}`, `${label} 포즈`, `${label} 姿势`)}
							onClick={onPose}
						>
							{/* The Pose mode figure in the subject's own body shape, not a keyboard glyph. */}
							<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" data-body={modelId ?? undefined}>
								<path d={BODY_GLYPHS[modelId] ?? PLAIN_FIGURE} />
							</svg>
						</button>
					)}
					{onRemove && (
						<button type="button" className="sb-remove" title={ko("Remove character", "인물 제거", "删除角色")} onClick={onRemove}>
							✕
						</button>
					)}
				</div>
			</div>
		</div>
	);
}
