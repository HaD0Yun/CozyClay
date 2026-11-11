// The camera tutorial's gesture cue: the mouse and the keys a navigation step wants, drawn the way the hand moves.
import { ko } from "./locale.js";
import { WALK_KEYS } from "./camera-tutorial-steps.jsx";

// Steps 1–4 have no control to point at: the gesture IS the interface. The cue
// draws the mouse and the keys the step wants, animated the way the hand is
// supposed to move, and sits centre-bottom of the viewport where the eye
// already is while flying.
const GESTURE_CAPTIONS = {
	fly: () => ko("Right-drag to look", "오른쪽 끌어 둘러보기"),
	walk: () => ko("Hold right, press keys", "오른쪽 누른 채 키 입력"),
	dolly: () => ko("Scroll to push in", "스크롤로 밀고 당기기"),
	orbit: () => ko("Alt + left-drag to circle", "Alt+왼쪽 끌어 돌기"),
};

function MouseGlyph() {
	return (
		<svg className="tutorial-cue-mouse" viewBox="0 0 40 58" aria-hidden="true">
			<rect className="cue-mouse-body" x="4" y="3" width="32" height="52" rx="16" />
			<path className="cue-mouse-left" d="M20 3 A16 16 0 0 0 4 19 L20 19 Z" />
			<path className="cue-mouse-right" d="M20 3 A16 16 0 0 1 36 19 L20 19 Z" />
			<rect className="cue-mouse-wheel" x="17.5" y="8" width="5" height="11" rx="2.5" />
		</svg>
	);
}

/**
 * The animated gesture glyph for one nav step. `leaving` starts the fade; the
 * parent unmounts it when the opacity transition ends, so the cue never blinks
 * out mid-step. Under prefers-reduced-motion the glyph is static (styles.css)
 * and the parent drops it outright.
 */
export function GestureCue({ kind, walked, leaving = false, onLeft }) {
	const caption = GESTURE_CAPTIONS[kind]?.() ?? "";
	return (
		<div
			className="tutorial-cue"
			data-testid="camera-tutorial-gesture"
			data-kind={kind}
			data-leaving={leaving ? 1 : 0}
			aria-hidden="true"
			onTransitionEnd={(event) => {
				if (leaving && event.propertyName === "opacity" && event.target === event.currentTarget) onLeft?.();
			}}
		>
			<div className="tutorial-cue-stage">
				{kind === "orbit" && <span className="tutorial-cue-key">Alt</span>}
				<span className="tutorial-cue-arm">
					<MouseGlyph />
					{kind === "fly" && (
						<svg className="tutorial-cue-arc" viewBox="0 0 64 20" aria-hidden="true">
							<path className="cue-arc-line" d="M8 14 Q32 3 56 14" />
							<path className="cue-arc-head" d="M13 9 L7 14 L14 17" />
							<path className="cue-arc-head" d="M51 9 L57 14 L50 17" />
						</svg>
					)}
				</span>
				{kind === "orbit" && <span className="tutorial-cue-pivot" />}
				{kind === "dolly" && (
					<svg className="tutorial-cue-updown" viewBox="0 0 14 44" aria-hidden="true">
						<path className="cue-up" d="M7 16 L7 4 M3 8 L7 4 L11 8" />
						<path className="cue-down" d="M7 28 L7 40 M3 36 L7 40 L11 36" />
					</svg>
				)}
			</div>
			{kind === "walk" && (
				<span className="tutorial-cue-keys">
					{WALK_KEYS.map((walkKey) => (
						<kbd key={walkKey} data-done={walked?.has(walkKey) ? 1 : 0}>{walkKey.toUpperCase()}</kbd>
					))}
				</span>
			)}
			<span className="tutorial-cue-caption">{caption}</span>
		</div>
	);
}
